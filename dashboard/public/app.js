// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────
const SYNC_INTERVAL = 60_000; // 60 seconds

// ─────────────────────────────────────────────────────────────
// DOM refs
// ─────────────────────────────────────────────────────────────
const syncStatus  = document.getElementById("syncStatus");
const refreshBtn  = document.getElementById("refreshBtn");
const holderCount = document.getElementById("holderCount");
const totalEvents = document.getElementById("totalEvents");
const eventsList  = document.getElementById("eventsList");

// ─────────────────────────────────────────────────────────────
// Fetch state from the backend
// ─────────────────────────────────────────────────────────────
async function loadState() {
    refreshBtn.disabled = true;
    setSyncStatus("syncing");
    try {
        const res  = await fetch("/api/state");
        const data = await res.json();
        render(data);
        setSyncStatus("ok");
    } catch (err) {
        console.error("[DASHBOARD] Fetch error:", err);
        setSyncStatus("error");
    } finally {
        refreshBtn.disabled = false;
    }
}

// ─────────────────────────────────────────────────────────────
// Sync status indicator
// ─────────────────────────────────────────────────────────────
function setSyncStatus(status) {
    if (status === "ok") {
        syncStatus.innerHTML = `<span class="dot"></span>Last sync: ${new Date().toLocaleTimeString()}`;
    } else if (status === "syncing") {
        syncStatus.innerHTML = `<span class="dot"></span>Syncing...`;
    } else {
        syncStatus.innerHTML = `<span class="dot stale"></span>Sync failed`;
    }
}

// ─────────────────────────────────────────────────────────────
// Master render
// ─────────────────────────────────────────────────────────────
function render(state) {
    const { holders = [], balances = {}, rewardEvents = [], jobEvents = [] } = state;

    holderCount.textContent = `${holders.length} holders`;
    totalEvents.textContent = `${rewardEvents.length} total`;

    drawBalancesTable(balances);
    drawEventsList(rewardEvents, jobEvents);
}

// ─────────────────────────────────────────────────────────────
// Table — Top 10 Holders
// ─────────────────────────────────────────────────────────────
function drawBalancesTable(balances) {
    const container = document.getElementById("balancesTable");

    const top10 = Object.entries(balances)
        .map(([addr, bal]) => ({ addr, bal: parseFloat(bal) }))
        .sort((a, b) => b.bal - a.bal)
        .slice(0, 10);

    if (top10.length === 0) {
        container.innerHTML = `<div class="empty-state">No holder data yet.</div>`;
        return;
    }

    const rows = top10.map((entry, i) => `
        <tr>
            <td class="rank">${i + 1}</td>
            <td class="address">${entry.addr}</td>
            <td class="balance">${entry.bal.toFixed(6)} ETH</td>
        </tr>
    `).join("");

    container.innerHTML = `
        <table class="holders-table">
            <thead>
                <tr>
                    <th>#</th>
                    <th>Address</th>
                    <th>Balance</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    `;
}

// ─────────────────────────────────────────────────────────────
// Events list — last 10 rewarded jobs
//
// Each row combines a rewardEvent (jobId, submitter, timestamp)
// with its matching jobEvent (ipfsCid, promptText) looked up by
// jobId. Fields shown: job ID, date, submitter, prompt text.
// ─────────────────────────────────────────────────────────────
function drawEventsList(rewardEvents, jobEvents) {
    eventsList.innerHTML = "";

    if (rewardEvents.length === 0) {
        eventsList.innerHTML = `<div class="empty-state">Waiting for reward events...</div>`;
        return;
    }

    // Build a lookup map from jobId → jobEvent for O(1) access.
    const jobMap = new Map(jobEvents.map((e) => [e.jobId, e]));

    const recent = rewardEvents.slice(0, 10);

    for (const ev of recent) {
        const job  = jobMap.get(ev.jobId);
        const ts   = new Date(ev.timestamp);
        const date = ts.toLocaleDateString([], { month: "short", day: "numeric" });
        const time = ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

        const row = document.createElement("div");
        row.className = "event-row";
        row.innerHTML = `
            <div class="event-main">
                <div class="event-top">
                    <span class="job"><span class="job-label">JOB</span>${ev.jobId}</span>
                    <span class="ts">${date} · ${time}</span>
                </div>
                <div class="event-detail">
                    <span class="detail-label">Submitter</span>
                    <span class="detail-value address">${ev.submitter ?? "—"}</span>
                </div>
                <div class="event-detail">
                    <span class="detail-label">Prompt</span>
                    <span class="detail-value prompt">${job?.promptText ?? "—"}</span>
                </div>
            </div>
        `;
        eventsList.appendChild(row);
    }
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function shortenAddress(addr) {
    if (!addr || addr.length < 10) return addr;
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// ─────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────
refreshBtn.addEventListener("click", loadState);
setInterval(loadState, SYNC_INTERVAL);
loadState();
