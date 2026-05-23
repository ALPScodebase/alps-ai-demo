require("dotenv").config();

const hre = require("hardhat");
const TelegramBot = require("node-telegram-bot-api");
const { resolveCustomerSigner } = require("./lib/signers");
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const AGGREGATOR_ADDRESS = process.env.AGGREGATOR_ADDRESS;
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {polling: true});

//
// GLOBAL SHARED INSTANCES
//
let ipfs;
let aggregatorContract;
let queueContract;
let verifierContract;

// Bot initialization.
async function init() {
    const { create } = await import("kubo-rpc-client");
    ipfs = create({
        url: process.env.IPFS_API_URL || "http://127.0.0.1:5001",
    });
    const { signer: customerWallet } = await resolveCustomerSigner(hre, AGGREGATOR_ADDRESS);
    aggregatorContract = await hre.ethers.getContractAt("Aggregator", AGGREGATOR_ADDRESS, customerWallet);
    const queueAddress = await aggregatorContract.queue();
    const verifierAddress = await aggregatorContract.verifier();
    queueContract = await hre.ethers.getContractAt("OracleQueue", queueAddress);
    verifierContract = await hre.ethers.getContractAt("OracleVerifier", verifierAddress);
}

async function pollForResult(jobId, chatId, bot) {
    const MAX_ATTEMPTS = 50;
    const INTERVAL_MS = 1000;
    let attempts = 0;
    const interval = setInterval(async () => {
        attempts++;
        try {
            console.log(`[BOT] [Chat ID: ${chatId}] Querying status for ${jobId}...`)
            const res = await fetch(`http://localhost:9090/output/${jobId}`);
            if (!res.ok) {
                console.log("HTTP error:", res.status);
                return;
            }
            const data = await res.json();
            // Adjust condition depending on your API shape
            if (data && data.status === "completed") {
                console.log(`[BOT] [Chat ID: ${chatId}] Output for Job ID ${jobId} generated.`)
                clearInterval(interval);
                await bot.sendMessage(chatId, `✅ Result ready (Job ID ${jobId})!\n\n${data.result}`);
                return;
            }
            console.log(`[BOT] [Chat ID: ${chatId}] Output for Job ID ${jobId} not ready yet.`)
        } catch (err) {
            console.error(`[BOT] [Chat ID: ${chatId}] [ERROR] Polling error for Job ID ${jobId}: ${err.message}`);
        }

        if (attempts >= MAX_ATTEMPTS) {
            clearInterval(interval);
            await bot.sendMessage(chatId, `❌ Timeout waiting for result (Job ID ${jobId})`);
        }

    }, INTERVAL_MS);
}

async function processPrompt(chatId, promptText) {
    try {
        console.log(`[BOT] [Chat ID: ${chatId}] Uploading prompt to IPFS...`);
        // await bot.sendMessage(chatId, "Uploading prompt to IPFS...");

        // ------------------------------------------------------------
        // PHASE 1 — Upload prompt to IPFS
        // ------------------------------------------------------------
        const { cid } = await ipfs.add(promptText);
        const cidString = cid.toString();
        console.log(`[BOT] [Chat ID: ${chatId}] Prompt uploaded. CID: ${cidString}`);
        //await bot.sendMessage(chatId, `Prompt uploaded.\nCID: ${cidString}`);

        // ------------------------------------------------------------
        // PHASE 2 — Submit request on-chain
        // ------------------------------------------------------------
        const approvalPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error("Approval timeout"));
            }, 45000);

            queueContract.once("LogNewJobForOracles", (jobId) => {
                clearTimeout(timeout);
                resolve(jobId);
            });
        });

        // Create a transaction to submit the attribution request.
        const paymentAmount = await aggregatorContract.queryFee();
        console.log(`[BOT] [Chat ID: ${chatId}] Submitting request to blockchain...`);
        //await bot.sendMessage(chatId, "Submitting request to blockchain...");
        const tx = await aggregatorContract.requestAttribution(
            cidString,
            {
                value: paymentAmount,
            }
        );
        const receipt = await tx.wait();
        let currentJobId = null;
        for (const log of receipt.logs) {
            try {
                const parsed = queueContract.interface.parseLog(log);
                if (parsed.name === "LogNewCustomerRequest") {
                    currentJobId = parsed.args[0];
                    break;
                }
            } catch (e) {}
        }

        console.log(`[BOT] [Chat ID: ${chatId}] Request submitted. Job ID: ${currentJobId}`);
        await bot.sendMessage(chatId, `Request submitted. Job ID: ${currentJobId}`);

        // ------------------------------------------------------------
        // PHASE 3 — Wait for approval
        // ------------------------------------------------------------
        console.log(`[BOT] [Chat ID: ${chatId}] Waiting for model creator approval...`);
        //await bot.sendMessage(chatId, "Waiting for model creator approval...");
        const approvedJobId = await approvalPromise;
        console.log(`[BOT] [Chat ID: ${chatId}] Request approved. Job ID: ${approvedJobId}`);
        await bot.sendMessage(chatId, `Request approved. Job ID: ${approvedJobId}`);

        // Start the background polling process (non-blocking).
        Promise.resolve().then(() => pollForResult(approvedJobId, chatId, bot)).catch((pollErr) => {
            console.error(
                `[BOT] [Chat ID: ${chatId}] [ERROR] Poller for job ${approvedJobId} failed:`, pollErr
            );
        });

        // ------------------------------------------------------------
        // PHASE 4 — Wait for DON fulfillment
        // ------------------------------------------------------------
        console.log(`[BOT] [Chat ID: ${chatId}] Waiting for OCR / AI fulfillment...`);
        //await bot.sendMessage(chatId, "Waiting for OCR / AI fulfillment...");
        const fulfillment = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error("Fulfillment timeout"));
            }, 600000);
            const listener = async (jobId, submitter) => {
                if (approvedJobId.toString() === jobId.toString()) {
                    clearTimeout(timeout);
                    verifierContract.off("JobCompleted", listener);
                    resolve({
                        jobId: jobId.toString(),
                        submitter,
                    });
                }
            };
            verifierContract.on("JobCompleted", listener);
        });

        // ------------------------------------------------------------
        // FINAL RESPONSE TO USER
        // ------------------------------------------------------------
        console.log(
            `[BOT] [Chat ID: ${chatId}] Job ${fulfillment.jobId} completed successfully! Submitter node: ${fulfillment.submitter}`
        );
        await bot.sendMessage(
            chatId,
            [
                `Job ${fulfillment.jobId} completed successfully!`,
                `Submitter node: ${fulfillment.submitter}`,
            ].join("\n")
        );

    } catch (error) {
        console.error(`[BOT] [Chat ID: ${chatId}] [ERROR] ${error}`);
        await bot.sendMessage(chatId, `Error: ${error.message}`);
    }
}

// Telegram Bot Handlers
bot.onText(/\/start/, async (msg) => {
    await bot.sendMessage(
        msg.chat.id, 
        `Hello ${msg.from.first_name}! Send me a prompt for the model!`
    );
});

bot.on("message", async (msg) => {
    const text = msg.text;
    // Ignore commands
    if (!text || text.startsWith("/")) {return;}
    console.log(`[BOT] New prompt from ${msg.chat.id}: ${text}`);
    await processPrompt(msg.chat.id, text);
});

// This is the main function of the bot.
(async () => {
    try {
        console.log("[BOT] Initializing Telegram bot...");
        await init();
        console.log("[BOT] Initialization complete.");
        console.log(`[BOT] Aggregator address: ${AGGREGATOR_ADDRESS}`);
        console.log(`[BOT] Telegram token: ${TELEGRAM_BOT_TOKEN}`);
        console.log("[BOT] Telegram bot is listening...");
    } catch (error) {
        console.error("[BOT] Initialization failed:", error);
        process.exit(1);
    }
})();
