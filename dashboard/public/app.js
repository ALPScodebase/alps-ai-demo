async function loadState() {

    const res = await fetch("/api/state");

    const data = await res.json();

    render(data);
}

function render(state) {

    // --------------------------------------------------
    // Job ID
    // --------------------------------------------------

    document.getElementById("jobId").innerText =
        state.lastJobId || "None";

    // --------------------------------------------------
    // Balances table
    // --------------------------------------------------

    const table = document.getElementById(
        "balancesTable"
    );

    table.innerHTML = "";

    for (const holder of state.holders) {

        const row = document.createElement("tr");

        row.innerHTML = `
            <td>${holder}</td>
            <td>${state.balances[holder]}</td>
        `;

        table.appendChild(row);
    }

    // --------------------------------------------------
    // History
    // --------------------------------------------------

    const history = document.getElementById(
        "history"
    );

    history.innerHTML = "";

    const reversed = [...state.history].reverse();

    for (const item of reversed) {

        const div = document.createElement("div");

        div.className = "history-item";

        let html = `
            <strong>Job ${item.jobId}</strong><br>
            ${new Date(item.timestamp).toLocaleString()}<br><br>
        `;

        for (const holder in item.balances) {

            html += `
                ${holder}: ${item.balances[holder]} ETH<br>
            `;
        }

        div.innerHTML = html;

        history.appendChild(div);
    }
}

// ------------------------------------------------------
// Poll backend every 3 seconds
// ------------------------------------------------------

setInterval(loadState, 3000);

loadState();