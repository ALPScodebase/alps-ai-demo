require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { ethers } = require("ethers");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const BALANCE_REFRESH_INTERVAL = 60_000; // ms between balance refreshes
const RETRY_DELAY = 5_000;  // ms before retrying after a failure
const MAX_RETRIES = 3;
const PORT = process.env.PORT || 49999;

const aggregatorAbi     = ["function manager() view returns (address)"];
const royaltyManagerAbi = require("../chain/artifacts/contracts/RoyaltyManager.sol/RoyaltyManager.json").abi;

// Resolved once at startup never changes.
let royaltyManagerAddress;

// ---------------------------------------------------------
// In-memory state
// ---------------------------------------------------------
const state = {
    holders:      [],
    balances:     {},
    rewardEvents: [], // last 100 RewardsDistributed events (jobId + timestamp)
};

// ---------------------------------------------------------
// Prints the top N holders by balance to the console.
// ---------------------------------------------------------
function printTopHolders(topN = 5) {
    const sorted = Object.entries(state.balances)
        .sort((a, b) => parseFloat(b[1]) - parseFloat(a[1]))
        .slice(0, topN);
    console.log(`[DASHBOARD] Current top ${topN} holders:`);
    sorted.forEach(([holder, balance], i) => {
        console.log(`  ${i + 1}. ${holder}: ${balance} ETH`);
    });
}

// ---------------------------------------------------------
// Core balance fetch — fresh provider per call to avoid
// stale TCP sockets between poll intervals.
// ---------------------------------------------------------
async function refreshBalances() {
    console.log("[DASHBOARD] Refreshing balances from the chain...");
    // Initialize provider and contract instance to ensure a fresh connection.
    const provider       = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const royaltyManager = new ethers.Contract(royaltyManagerAddress, royaltyManagerAbi, provider);
    try {
        // First, read the number of holders.
        const numHolders = await royaltyManager.getNumHolders();
        // Then fetch all holder addresses and their balances.
        const holders = await Promise.all(
            Array.from({ length: Number(numHolders) }, (_, i) => royaltyManager.holders(i))
        );
        const rawBalances = await Promise.all(holders.map((h) => royaltyManager.balances(h)));
        // Convert all balances from raw BigNumber to human-readable string.
        const balances = {};
        for (let i = 0; i < holders.length; i++) {
            balances[holders[i]] = ethers.formatEther(rawBalances[i]);
        }
        // Update the in-memory state.
        state.holders  = holders;
        state.balances = balances;
        console.log(`[DASHBOARD] Balances updated (${holders.length} holders).`);
    } finally {
        provider.destroy();
    }
}

// ---------------------------------------------------------
// Wraps the balance refresh with retry logic to handle transient errors gracefully.
// ---------------------------------------------------------
async function refreshBalancesWithRetry() {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            await refreshBalances();
            return;
        } catch (err) {
            console.error(`[DASHBOARD] Balance refresh failed (attempt ${attempt}/${MAX_RETRIES}): ${err.message}`);
            if (attempt < MAX_RETRIES) {
                console.log(`[DASHBOARD] Retrying balance refresh in ${RETRY_DELAY / 1000}s...`);
                await new Promise((res) => setTimeout(res, RETRY_DELAY));
            } else {
                console.error("[DASHBOARD] All balance refresh retry attempts exhausted. Will try again next interval.");
            }
        }
    }
}

// ---------------------------------------------------------
// RewardsDistributed event listener
// ---------------------------------------------------------
function startEventListener() {
    console.log("[DASHBOARD] Starting RewardsDistributed event listener...");

    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const royaltyManager = new ethers.Contract(royaltyManagerAddress, royaltyManagerAbi, provider);

    royaltyManager.on("RewardsDistributed", (jobId) => {
        const event = { jobId: jobId.toString(), timestamp: Date.now() };
        console.log(`[DASHBOARD] RewardsDistributed received for Job ID ${jobId}`);
        state.rewardEvents.unshift(event);
        if (state.rewardEvents.length > 100) state.rewardEvents.pop();
    });

    provider.on("error", (err) => {
        console.error(`[DASHBOARD] Event provider error (${err.message}), reconnecting in ${RETRY_DELAY / 1000}s...`);
        provider.destroy();
        setTimeout(startEventListener, RETRY_DELAY);
    });

    console.log("[DASHBOARD] RewardsDistributed event listener ready.");
}

// ---------------------------------------------------------
// Initialization function
// ---------------------------------------------------------
async function init() {
    // Fetch the balances immediately on startup.
    await refreshBalancesWithRetry();
    // Set up periodic balance refresh.
    setInterval(async () => {
        console.log("[DASHBOARD] Periodic balance refresh triggered.");
        await refreshBalancesWithRetry();
        printTopHolders();
    }, BALANCE_REFRESH_INTERVAL);
    // Start listening for RewardsDistributed events.
    startEventListener();
}

// ---------------------------------------------------------
// REST API
// ---------------------------------------------------------
app.get("/api/state", (req, res) => {
    res.json(state);
});

// ---------------------------------------------------------
// Start server
// ---------------------------------------------------------
app.listen(PORT, "0.0.0.0", async () => {
    console.log("[DASHBOARD] Server started.");
    console.log("[DASHBOARD] Connecting to the chain...");
    const bootstrapProvider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    try {
        const aggregator = new ethers.Contract(
            process.env.AGGREGATOR_ADDRESS, 
            aggregatorAbi, 
            bootstrapProvider
        );
        royaltyManagerAddress = await aggregator.manager();
        console.log("[DASHBOARD] RoyaltyManager address:", royaltyManagerAddress);
    } finally {
        bootstrapProvider.destroy();
    }
    console.log(`[DASHBOARD] Server ready at http://localhost:${PORT}.`);
    await init();
});