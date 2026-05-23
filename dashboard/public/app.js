// ─────────────────────────────────────────────────────────────
// Google Charts loader
// ─────────────────────────────────────────────────────────────
google.charts.load("current", { packages: ["corechart", "bar"] });

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────
const SYNC_INTERVAL = 30_000; // 30 seconds

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
        console.log("Fetched state:", data);
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
function setSyncStatus(state) {
    const dot = syncStatus.querySelector(".dot");
    if (state === "ok") {
        dot.className = "dot";
        syncStatus.innerHTML = `<span class="dot"></span>Last sync: ${new Date().toLocaleTimeString()}`;
    } else if (state === "syncing") {
        dot.className = "dot";
        syncStatus.innerHTML = `<span class="dot"></span>Syncing…`;
    } else {
        dot.className = "dot stale";
        syncStatus.innerHTML = `<span class="dot stale"></span>Sync failed`;
    }
}

// ─────────────────────────────────────────────────────────────
// Master render
// ─────────────────────────────────────────────────────────────
function render(state) {
    const { holders = [], balances = {}, rewardEvents = [] } = state;

    holderCount.textContent = `${holders.length} holders`;
    totalEvents.textContent = `${rewardEvents.length} total`;

    drawBalancesTable(balances);

    google.charts.setOnLoadCallback(() => {
        drawActivityChart(rewardEvents);
    });

    // In case charts are already loaded (subsequent renders)
    if (google.visualization) {
        drawActivityChart(rewardEvents);
    }

    drawEventsList(rewardEvents);
}

// ─────────────────────────────────────────────────────────────
// Table — Top 10 Holders
// ─────────────────────────────────────────────────────────────
function drawBalancesTable(balances) {
    const container = document.getElementById("balancesChart");

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
// Chart — Rewarded Requests Over Time (Column, 1-minute buckets)
// ─────────────────────────────────────────────────────────────
function drawActivityChart(rewardEvents) {
    const container = document.getElementById("activityChart");

    if (rewardEvents.length === 0) {
        container.innerHTML = `<div class="empty-state">No reward events recorded yet.</div>`;
        return;
    }

    // Bucket events into 1-minute intervals
    const BUCKET_MS = 60 * 1000;
    const buckets   = {};

    for (const ev of rewardEvents) {
        const bucket = Math.floor(ev.timestamp / BUCKET_MS) * BUCKET_MS;
        buckets[bucket] = (buckets[bucket] || 0) + 1;
    }

    const sorted = Object.entries(buckets)
        .sort((a, b) => Number(a[0]) - Number(b[0]));

    const data = new google.visualization.DataTable();
    data.addColumn("string", "Time");
    data.addColumn("number", "Requests");

    for (const [ts, count] of sorted) {
        const label = new Date(Number(ts)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        data.addRow([label, count]);
    }

    const options = {
        backgroundColor: "transparent",
        chartArea:       { left: 56, top: 16, width: "92%", height: "78%" },
        bar:             { groupWidth: "60%" },
        legend:          { position: "none" },
        hAxis: {
            textStyle:     { color: "#4a5060", fontName: "Space Mono", fontSize: 10 },
            gridlines:     { color: "transparent" },
            baselineColor: "#1e2229",
        },
        vAxis: {
            textStyle:     { color: "#4a5060", fontName: "Space Mono", fontSize: 10 },
            gridlines:     { color: "#1e2229" },
            baselineColor: "#1e2229",
            minValue: 0,
            format: "#",
        },
        colors:  ["#7b61ff"],
        tooltip: { textStyle: { fontName: "Space Mono", fontSize: 11, color: "#e8eaf0" } },
    };

    const chart = new google.visualization.ColumnChart(container);
    chart.draw(data, options);
}

// ─────────────────────────────────────────────────────────────
// Recent events list — last 10
// ─────────────────────────────────────────────────────────────
function drawEventsList(rewardEvents) {
    eventsList.innerHTML = "";

    if (rewardEvents.length === 0) {
        eventsList.innerHTML = `<div class="empty-state">Waiting for reward events…</div>`;
        return;
    }

    const recent = rewardEvents.slice(0, 10);

    for (const ev of recent) {
        const row  = document.createElement("div");
        row.className = "event-row";
        const ts   = new Date(ev.timestamp);
        const date = ts.toLocaleDateString([], { month: "short", day: "numeric" });
        const time = ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        row.innerHTML = `
            <div class="job"><span>JOB</span>${ev.jobId}</div>
            <div class="ts">${date} · ${time}</div>
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
google.charts.setOnLoadCallback(loadState);
