import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 49999;

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const aggregatorAbi = ["function manager() view returns (address)"];
const aggregator = new ethers.Contract(process.env.AGGREGATOR_ADDRESS, aggregatorAbi, provider);
console.log("[DASHBOARD] Fetching RoyaltyManager address...");
const royaltyManagerAddress = await aggregator.manager();
console.log("[DASHBOARD] RoyaltyManager address:", royaltyManagerAddress);
const royaltyManagerAbi = JSON.parse(fs.readFileSync(path.join(__dirname, "abi", "RoyaltyManager.json"), "utf8"));
const royaltyManager = new ethers.Contract(royaltyManagerAddress, royaltyManagerAbi, provider);

// ---------------------------------------------------------
// In-memory state
// ---------------------------------------------------------
const state = {
    holders: [],
    balances: {},
    history: [],
    lastJobId: null,
};

// ---------------------------------------------------------
// Load holders and balances
// ---------------------------------------------------------
async function refreshBalances(jobId = null) {
    const balances = {};
    let index = 0;
    while (true) {
        try {
            const holder = await royaltyManager.holders(index);
            const balance = await royaltyManager.balances(holder);
            balances[holder] = ethers.formatEther(balance);
            index++;
        } 
        catch (err) {break;}
    }
    state.holders = Object.keys(balances);
    state.balances = balances;
    if (jobId !== null) {
        state.lastJobId = jobId.toString();
        state.history.push({
            timestamp: Date.now(), 
            jobId: jobId.toString(), 
            balances,
        });
    }
    console.log("[DASHBOARD] Balances updated.");
}

// ---------------------------------------------------------
// Initial load
// ---------------------------------------------------------

async function init() {
    await refreshBalances();
    console.log("[DASHBOARD] Listening for RewardsDistributed events...");
    royaltyManager.on(
        "RewardsDistributed",
        async (jobId) => {
            console.log(`[DASHBOARD] RewardsDistributed for Job ID ${jobId}`);
            await refreshBalances(jobId);
        }
    );
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
    console.log(`[DASHBOARD] Server running at http://localhost:${PORT}`);
    await init();
});