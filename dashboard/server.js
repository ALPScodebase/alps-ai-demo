require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { ethers } = require("ethers");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// Poll interval in milliseconds.
const POLL_INTERVAL = 5000;
const PORT = process.env.PORT || 49999;
const aggregatorAbi = ["function manager() view returns (address)"];
const royaltyManagerAbi = require("../chain/artifacts/contracts/RoyaltyManager.sol/RoyaltyManager.json").abi;

let provider;
let aggregator;
let royaltyManager;

// ---------------------------------------------------------
// In-memory state
// ---------------------------------------------------------
const state = {
    holders: [],
    balances: {},
    rewardEvents: [], // Last 100 RewardsDistributed events (jobId + timestamp).
};

// Prints the top N holders by balance to the console.
function printTopHolders(topN = 5) {
    const sortedHolders = Object.entries(state.balances)
        .sort((a, b) => parseFloat(b[1]) - parseFloat(a[1]))
        .slice(0, topN);
    console.log(`[DASHBOARD] Current top ${topN} holders:`);
    sortedHolders.forEach(([holder, balance], index) => {
        console.log(`${index + 1}. ${holder}: ${balance} ETH`);
    });
}

// ---------------------------------------------------------
// Load holders and balances
// ---------------------------------------------------------
async function refreshBalances() {
    const balances = {};
    const numHolders = await royaltyManager.getNumHolders();
    for (let index = 0; index < numHolders; index++) {
        try {
            const holder = await royaltyManager.holders(index);
            const balance = await royaltyManager.balances(holder);
            balances[holder] = ethers.formatEther(balance);
        }
        catch (err) {
            console.error("[DASHBOARD] Error while fetching holder or balance:", err);
            break;
        }
    }
    state.holders = Object.keys(balances);
    state.balances = balances;
    console.log("[DASHBOARD] Balances updated.");
}

// ---------------------------------------------------------
// Initial load
// ---------------------------------------------------------
async function init() {
    await refreshBalances();

    // Periodically refresh balances from the chain.
    setInterval(async () => {
        try {
            await refreshBalances();
            printTopHolders();
        } catch (err) {
            console.error("[DASHBOARD] Error during periodic balance refresh:", err);
        }
    }, POLL_INTERVAL);

    console.log("[DASHBOARD] Listening for RewardsDistributed events...");
    royaltyManager.on("RewardsDistributed", (jobId) => {
        const event = { jobId: jobId.toString(), timestamp: Date.now() };
        console.log(`[DASHBOARD] RewardsDistributed event received for Job ID ${jobId}`);
        // Prepend and keep only the last 100 events.
        state.rewardEvents.unshift(event);
        if (state.rewardEvents.length > 100) state.rewardEvents.pop();
    });
}

// ---------------------------------------------------------
// REST API
// ---------------------------------------------------------
app.get("/api/state", async (req, res) => {
    res.json(state);
});

// ---------------------------------------------------------
// Start server
// ---------------------------------------------------------
app.listen(PORT, "0.0.0.0", async () => {
    console.log(`[DASHBOARD] Server started. Connecting to the chain...`);
    provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    aggregator = new ethers.Contract(process.env.AGGREGATOR_ADDRESS, aggregatorAbi, provider);
    console.log("[DASHBOARD] Fetching RoyaltyManager address...");
    const royaltyManagerAddress = await aggregator.manager();
    console.log("[DASHBOARD] RoyaltyManager address:", royaltyManagerAddress);
    royaltyManager = new ethers.Contract(royaltyManagerAddress, royaltyManagerAbi, provider);
    console.log(`[DASHBOARD] Server is now running at http://localhost:${PORT}.`);
    await init();
});
