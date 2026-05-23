require("dotenv").config();

const hre = require("hardhat");
const TelegramBot = require("node-telegram-bot-api");
const { resolveCustomerSigner } = require("./lib/signers");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const AGGREGATOR_ADDRESS = process.env.AGGREGATOR_ADDRESS;

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// ===============================================================================
// Global shared instances (read-only after init, safe to share)
// ===============================================================================
let ipfs;
let aggregatorContract;
let queueContract;
let verifierContract;

async function init() {
    const { create } = await import("kubo-rpc-client");
    ipfs = create({ url: process.env.IPFS_API_URL || "http://127.0.0.1:5001" });
    const { signer: customerWallet } = await resolveCustomerSigner(hre, AGGREGATOR_ADDRESS);
    aggregatorContract = await hre.ethers.getContractAt("Aggregator", AGGREGATOR_ADDRESS, customerWallet);
    const queueAddress = await aggregatorContract.queue();
    const verifierAddress = await aggregatorContract.verifier();
    queueContract = await hre.ethers.getContractAt("OracleQueue", queueAddress);
    verifierContract = await hre.ethers.getContractAt("OracleVerifier", verifierAddress);
}

// ===============================================================================
// Per-request polling for the off-chain result server
// ===============================================================================
async function pollForResult(jobId, chatId) {
    const MAX_ATTEMPTS = 150; // 150 attempts * 2s interval = 5 minutes max wait time
    const INTERVAL_MS  = 2000;
    let attempts = 0;

    return new Promise((resolve) => {
        const interval = setInterval(async () => {
            attempts++;
            try {
                console.log(`[BOT] [Chat ${chatId}] [Job ${jobId}] Polling attempt ${attempts}...`);
                const res = await fetch(`http://localhost:9090/output/${jobId}`);
                if (!res.ok) {
                    console.warn(`[BOT] [Chat ${chatId}] [Job ${jobId}] HTTP ${res.status}`);
                    return;
                }
                const data = await res.json();
                if (data?.status === "completed") {
                    clearInterval(interval);
                    console.log(`[BOT] [Chat ${chatId}] [Job ${jobId}] Result ready.`);
                    await bot.sendMessage(chatId, `✅ Result ready (Job ${jobId})!\n\n${data.result}`);
                    resolve("completed");
                    return;
                }
                console.log(`[BOT] [Chat ${chatId}] [Job ${jobId}] Not ready yet.`);
            } catch (err) {
                console.error(`[BOT] [Chat ${chatId}] [Job ${jobId}] Polling error: ${err.message}`);
            }

            if (attempts >= MAX_ATTEMPTS) {
                clearInterval(interval);
                console.warn(`[BOT] [Chat ${chatId}] [Job ${jobId}] Polling timed out.`);
                await bot.sendMessage(chatId, `❌ Timeout waiting for result (Job ${jobId})`);
                resolve("timeout");
            }
        }, INTERVAL_MS);
    });
}

// ===============================================================================
// Generic buffered event waiter factory.
//
// Arms a listener on `contract` for `eventName` immediately. Events that
// arrive before wait(jobId) is called are buffered; wait(jobId) checks the
// buffer first so a fast chain can never cause a missed-event timeout.
//
// jobFromArgs(args) extracts the job ID string from the event argument list,
// resolveWith(args) builds the value the wait() promise resolves with.
// ===============================================================================
function createEventWaiter(contract, eventName, jobFromArgs, resolveWith, timeoutMs) {
    const buffer  = []; // { key, args }[] for early arrivals
    const pending = new Map(); // key -> { resolve, reject, timer }

    const listener = (...args) => {
        const key = jobFromArgs(args).toString();
        if (pending.has(key)) {
            const { resolve, timer } = pending.get(key);
            clearTimeout(timer);
            pending.delete(key);
            if (pending.size === 0) contract.off(eventName, listener);
            resolve(resolveWith(args));
        } else {
            buffer.push({ key, args });
        }
    };

    contract.on(eventName, listener);

    return {
        wait(expectedJobId) {
            const key = expectedJobId.toString();

            // Check buffer for an event that arrived before this call.
            const idx = buffer.findIndex((e) => e.key === key);
            if (idx !== -1) {
                const { args } = buffer.splice(idx, 1)[0];
                if (pending.size === 0) contract.off(eventName, listener);
                return Promise.resolve(resolveWith(args));
            }

            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(key);
                    if (pending.size === 0) contract.off(eventName, listener);
                    reject(new Error(`Timeout waiting for ${eventName} (Job ${expectedJobId})`));
                }, timeoutMs);
                pending.set(key, { resolve, timer });
            });
        },
        cancel() {
            contract.off(eventName, listener);
            for (const { timer } of pending.values()) clearTimeout(timer);
            pending.clear();
        },
    };
}

function createApprovalWaiter() {
    return createEventWaiter(
        queueContract,
        "LogNewJobForOracles",
        (args) => args[0],          // jobId is the first (and only) argument
        (args) => args[0],          // resolve with the jobId itself
        45_000
    );
}

function createFulfillmentWaiter() {
    return createEventWaiter(
        verifierContract,
        "JobCompleted",
        (args) => args[0],          // jobId is the first argument
        (args) => ({ jobId: args[0].toString(), submitter: args[1] }),
        600_000
    );
}

// ===============================================================================
// Full pipeline for a single prompt. All state is local to this call frame so
// any number of concurrent invocations are fully isolated from each other.
// ===============================================================================
async function processPrompt(chatId, promptText) {
    const tag = `[BOT] [Chat ${chatId}]`;

    // Both waiters are armed NOW, before any await, so their listeners are
    // already attached before the transaction (and any resulting events) hits
    // the chain. This prevents missed-event timeouts on fast local nodes.
    const approvalWaiter = createApprovalWaiter();
    const fulfillmentWaiter = createFulfillmentWaiter();

    try {
        // Phase 1: Upload to IPFS
        console.log(`${tag} Uploading prompt to IPFS...`);
        const { cid } = await ipfs.add(promptText);
        const cidString = cid.toString();
        console.log(`${tag} Prompt uploaded. CID: ${cidString}`);

        // Phase 2: Submit on-chain
        const paymentAmount = await aggregatorContract.queryFee();
        console.log(`${tag} Submitting request to blockchain...`);
        const tx = await aggregatorContract.requestAttribution(cidString, { value: paymentAmount });
        const receipt = await tx.wait();

        // Parse the job ID from the receipt — isolated per-call, no shared state.
        let jobId = null;
        for (const log of receipt.logs) {
            try {
                const parsed = queueContract.interface.parseLog(log);
                if (parsed.name === "LogNewCustomerRequest") {
                    jobId = parsed.args[0];
                    break;
                }
            } catch (_) {}
        }

        if (jobId === null) {
            throw new Error("Could not extract Job ID from transaction receipt.");
        }

        console.log(`${tag} Request submitted. Job ID: ${jobId}`);
        await bot.sendMessage(chatId, `Request submitted. Job ID: ${jobId}`);

        // ── Phase 3: Wait for model-creator approval ──────────────────────────
        console.log(`${tag} [Job ${jobId}] Waiting for approval...`);
        const approvedJobId = await approvalWaiter.wait(jobId);
        console.log(`${tag} [Job ${jobId}] Approved.`);
        await bot.sendMessage(chatId, `Request approved. Job ID: ${approvedJobId}`);

        // ── Phase 4a: Start background polling (non-blocking) ─────────────────
        pollForResult(approvedJobId, chatId).catch((err) =>
            console.error(`${tag} [Job ${approvedJobId}] Poller crashed: ${err.message}`)
        );

        // ── Phase 4b: Wait for on-chain DON fulfillment ───────────────────────
        // fulfillmentWaiter was armed before Phase 2, so even if JobCompleted
        // fired before we reached this line it will have been buffered.
        console.log(`${tag} [Job ${approvedJobId}] Waiting for OCR/AI fulfillment...`);
        const fulfillment = await fulfillmentWaiter.wait(approvedJobId);

        console.log(`${tag} [Job ${fulfillment.jobId}] Completed. Submitter: ${fulfillment.submitter}`);
        await bot.sendMessage(
            chatId,
            `Job ${fulfillment.jobId} completed successfully!\nSubmitter node: ${fulfillment.submitter}`
        );

    } catch (error) {
        approvalWaiter.cancel();
        fulfillmentWaiter.cancel();
        console.error(`${tag} [ERROR] ${error}`);
        await bot.sendMessage(chatId, `❌ Error: ${error.message}`);
    }
}

// ===============================================================================
// Telegram handlers
// ===============================================================================
bot.onText(/\/start/, async (msg) => {
    await bot.sendMessage(
        msg.chat.id,
        `Hello ${msg.from.first_name}! Send me a prompt for the model!`
    );
});

bot.on("message", async (msg) => {
    const text = msg.text;
    if (!text || text.startsWith("/")) return;
    console.log(`[BOT] New prompt from chat ${msg.chat.id}: ${text}`);
    // Not awaited — each message runs its own independent pipeline.
    processPrompt(msg.chat.id, text).catch((err) =>
        console.error(`[BOT] Unhandled error for chat ${msg.chat.id}: ${err.message}`)
    );
});

// ===============================================================================
// Entry point
// ===============================================================================
(async () => {
    try {
        console.log("[BOT] Initializing...");
        await init();
        console.log("[BOT] Initialization complete.");
        console.log(`[BOT] Aggregator: ${AGGREGATOR_ADDRESS}`);
        console.log("[BOT] Listening for messages...");
    } catch (error) {
        console.error("[BOT] Initialization failed:", error);
        process.exit(1);
    }
})();
