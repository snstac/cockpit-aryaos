/* Generic management page for AryaOS gateways without a dedicated plugin. */
/* global cockpit */
"use strict";

const GATEWAYS = Object.freeze({
    acarscot: { label: "ACARS to TAK", config: "/etc/default/acarscot" },
    gdlcot: { label: "TAK to GDL90", config: "/etc/default/gdlcot" },
    sikw00fcot: { label: "SiK telemetry to TAK", config: "/etc/default/sikw00fcot" },
    gutcheck: { label: "GutCheck tactical discovery", config: "/etc/default/gutcheck" },
});

const requested = document.body.dataset.gateway || "";
const gateway = GATEWAYS[requested];
let followProcess = null;

function byId(id) {
    return document.getElementById(id);
}

function errorMessage(ex) {
    return String((ex && ex.message) || ex || "unknown error").trim();
}

function renderState(properties) {
    const active = properties.ActiveState || "unknown";
    const enabled = properties.UnitFileState || "unknown";
    const result = properties.Result || "";
    let state = active;
    if (result === "exec-condition" && active === "inactive") state = "unavailable (hardware not present)";
    byId("gateway-state").textContent = state;
    byId("gateway-enabled").textContent = enabled;
    byId("gateway-result").textContent = result || "none";
}

function refresh() {
    if (!gateway) return Promise.resolve();
    return cockpit.spawn([
        "systemctl", "show", requested + ".service", "--no-pager",
        "--property=LoadState,ActiveState,SubState,UnitFileState,Result,NRestarts",
    ], { err: "message" }).then((output) => {
        const properties = {};
        output.trim().split("\n").forEach((line) => {
            const split = line.indexOf("=");
            if (split > 0) properties[line.slice(0, split)] = line.slice(split + 1);
        });
        renderState(properties);
        byId("gateway-restarts").textContent = properties.NRestarts || "0";
    }).catch((ex) => {
        byId("gateway-state").textContent = "not installed";
        byId("gateway-action-status").textContent = errorMessage(ex);
    });
}

function runAction(action) {
    if (!gateway) return;
    const args = action === "enable"
        ? ["systemctl", "enable", "--now", requested + ".service"]
        : action === "disable"
            ? ["systemctl", "disable", "--now", requested + ".service"]
            : ["systemctl", action, requested + ".service"];
    byId("gateway-action-status").textContent = "Working...";
    cockpit.spawn(args, { superuser: "require", err: "message" })
        .then(() => {
            byId("gateway-action-status").textContent = "Done.";
            return refresh();
        })
        .catch((ex) => { byId("gateway-action-status").textContent = "Failed: " + errorMessage(ex); });
}

function showLogs() {
    if (!gateway) return;
    cockpit.spawn(["journalctl", "-u", requested + ".service", "-n", "200", "--no-pager"], {
        err: "message",
    }).then((output) => { byId("gateway-logs").textContent = output || "No logs found."; })
        .catch((ex) => { byId("gateway-logs").textContent = "Failed: " + errorMessage(ex); });
}

function followLogs() {
    if (!gateway || followProcess) return;
    byId("gateway-logs").textContent = "";
    followProcess = cockpit.spawn(["journalctl", "-u", requested + ".service", "-f", "--no-pager"], {
        err: "message",
    });
    followProcess.stream((data) => { byId("gateway-logs").textContent += data; });
    followProcess.always(() => { followProcess = null; });
}

function stopLogs() {
    if (followProcess) followProcess.close();
    followProcess = null;
}

document.addEventListener("DOMContentLoaded", () => {
    if (!gateway) {
        byId("gateway-title").textContent = "Unsupported gateway";
        byId("gateway-action-status").textContent = "This page does not name an approved AryaOS service.";
        document.querySelectorAll("button").forEach((button) => { button.disabled = true; });
        return;
    }
    byId("gateway-title").textContent = gateway.label;
    byId("gateway-service").textContent = requested + ".service";
    byId("gateway-config").textContent = gateway.config;
    document.querySelectorAll("button[data-action]").forEach((button) => {
        button.addEventListener("click", () => runAction(button.dataset.action));
    });
    byId("gateway-refresh").addEventListener("click", refresh);
    byId("gateway-show-logs").addEventListener("click", showLogs);
    byId("gateway-follow-logs").addEventListener("click", followLogs);
    byId("gateway-stop-logs").addEventListener("click", stopLogs);
    refresh();
    showLogs();
});

window.addEventListener("unload", stopLogs);
