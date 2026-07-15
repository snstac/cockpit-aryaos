/*
 * AryaOS Site — site-wide TAK configuration Cockpit plugin.
 * Edits /etc/aryaos/aryaos-config.txt (inherited by every PyTAK gateway via
 * EnvironmentFile), installs site-wide TLS certs, restarts the sensor fleet.
 *
 * Copyright Sensors & Signals LLC https://www.snstac.com/
 * SPDX-License-Identifier: Apache-2.0
 */
/* global cockpit */
"use strict";

const CONFIG_PATH = "/etc/aryaos/aryaos-config.txt";
const TLS_DIR = "/etc/aryaos/tls";
const TLS_GROUP = "tak-certs";
// Gateways shown in the services card and restarted on save. AOS_SERVICES in
// the site config wins when set.
const DEFAULT_SERVICES = ["charontak", "adsbcot", "aiscot", "dronecot", "lincot", "readsb", "ais-catcher"];

const $ = (id) => document.getElementById(id);
const configFile = cockpit.file(CONFIG_PATH, { superuser: "try" });
let configText = "";

function setStatus(el, msg, ok) {
    el.textContent = msg;
    el.className = "aos-status " + (ok ? "ok" : "err");
    if (ok) setTimeout(() => { el.textContent = ""; }, 6000);
}

/* --- KEY=VALUE editing that preserves comments and unknown lines --- */
function getKey(text, key) {
    const m = text.match(new RegExp("^" + key + "=(.*)$", "m"));
    if (!m) return null;
    return m[1].replace(/^["']|["']$/g, "");
}

function setKey(text, key, value) {
    const line = key + "=" + value;
    const re = new RegExp("^#?\\s*" + key + "=.*$", "m");
    if (re.test(text)) return text.replace(re, line);
    return text.replace(/\n*$/, "\n") + line + "\n";
}

function serviceList(text) {
    const raw = getKey(text || "", "AOS_SERVICES");
    if (!raw) return DEFAULT_SERVICES;
    return raw.trim().split(/\s+/);
}

/* --- Config card --- */
function renderForm(text) {
    $("cot-url").value = getKey(text, "COT_URL") || "";
    const dec = getKey(text, "ARYAOS_ADSB_DECODER");
    if (dec) $("adsb-decoder").value = dec;
    $("uat-serial").value = getKey(text, "ARYAOS_UAT_RTL_SERIAL") || "";
    $("tls-dont-verify").checked = (getKey(text, "PYTAK_TLS_DONT_VERIFY") || "") === "1";
    $("raw-config").value = text;
}

function collectForm(text) {
    let out = $("raw-config").value !== configText ? $("raw-config").value : text;
    out = setKey(out, "COT_URL", $("cot-url").value.trim());
    if ($("adsb-decoder").value) out = setKey(out, "ARYAOS_ADSB_DECODER", $("adsb-decoder").value);
    if ($("uat-serial").value.trim()) out = setKey(out, "ARYAOS_UAT_RTL_SERIAL", $("uat-serial").value.trim());
    if ($("tls-dont-verify").checked) out = setKey(out, "PYTAK_TLS_DONT_VERIFY", "1");
    else if (getKey(out, "PYTAK_TLS_DONT_VERIFY") !== null) out = setKey(out, "PYTAK_TLS_DONT_VERIFY", "0");
    return out;
}

function saveConfig(restart) {
    const next = collectForm(configText);
    const el = $("save-status");
    cockpit.file(CONFIG_PATH, { superuser: "require" }).replace(next)
        .then(() => {
            configText = next;
            renderForm(next);
            if (!restart) {
                setStatus(el, "Saved.", true);
                return;
            }
            const units = serviceList(next);
            return cockpit.spawn(["systemctl", "try-restart", "--"].concat(units),
                { superuser: "require", err: "message" })
                .then(() => setStatus(el, "Saved; sensor services restarted.", true))
                .then(refreshServices);
        })
        .catch((ex) => setStatus(el, "Failed: " + (ex.message || ex), false));
}

/* --- TLS card --- */
function readPem(input, label) {
    return new Promise((resolve, reject) => {
        const f = input.files && input.files[0];
        if (!f) return resolve(null);
        const r = new FileReader();
        r.onerror = () => reject(new Error("could not read " + label));
        r.onload = () => {
            const text = String(r.result);
            if (!text.includes("-----BEGIN"))
                return reject(new Error(label + " is not PEM (convert .p12 with openssl pkcs12 first)"));
            resolve(text);
        };
        r.readAsText(f);
    });
}

function installTls() {
    const el = $("tls-status");
    Promise.all([
        readPem($("tls-cert"), "client certificate"),
        readPem($("tls-key"), "client key"),
        readPem($("tls-ca"), "CA chain"),
    ]).then(([cert, key, ca]) => {
        if (!cert && !key && !ca)
            throw new Error("choose at least one PEM file");
        if ((cert && !key && !tlsConfigured("KEY")) || (key && !cert && !tlsConfigured("CERT")))
            throw new Error("client certificate and key must both be present");

        const writes = [];
        const put = (name, content, mode) => {
            const path = TLS_DIR + "/" + name;
            writes.push(() =>
                cockpit.file(path, { superuser: "require" }).replace(content)
                    .then(() => cockpit.spawn(
                        ["/bin/sh", "-c",
                         "chmod " + mode + " '" + path + "'; " +
                         "chgrp " + TLS_GROUP + " '" + path + "' 2>/dev/null || true"],
                        { superuser: "require", err: "message" })));
            return path;
        };

        let next = configText;
        if (cert) next = setKey(next, "PYTAK_TLS_CLIENT_CERT", put("client.pem", cert, "0644"));
        if (key) next = setKey(next, "PYTAK_TLS_CLIENT_KEY", put("client.key", key, "0640"));
        if (ca) next = setKey(next, "PYTAK_TLS_CLIENT_CAFILE", put("ca.pem", ca, "0644"));

        return cockpit.spawn(["mkdir", "-p", TLS_DIR], { superuser: "require", err: "message" })
            .then(() => writes.reduce((p, w) => p.then(w), Promise.resolve()))
            .then(() => cockpit.file(CONFIG_PATH, { superuser: "require" }).replace(next))
            .then(() => {
                configText = next;
                renderForm(next);
                setStatus(el, "Certificates installed. Save & restart sensors to apply.", true);
                showCurrentTls();
            });
    }).catch((ex) => setStatus(el, "Failed: " + (ex.message || ex), false));
}

function tlsConfigured(which) {
    return getKey(configText, "PYTAK_TLS_CLIENT_" + which) !== null;
}

function showCurrentTls() {
    cockpit.spawn(["ls", "-l", TLS_DIR], { superuser: "try", err: "ignore" })
        .then((out) => {
            const files = out.split("\n").filter((l) => l.includes(".pem") || l.includes(".key"));
            $("tls-current").textContent = files.length
                ? "Installed: " + files.map((l) => l.trim().split(/\s+/).pop()).join(", ")
                : "";
        })
        .catch(() => { $("tls-current").textContent = ""; });
}

/* --- TAK connection import and enrollment status --- */
function renderTakEnrollmentStatus(payload) {
    const tbody = $("tak-enrollment-table").querySelector("tbody");
    const status = payload && payload.enrollment_status ? payload.enrollment_status : {};
    const bool = (value) => value ? "yes" : "no";
    const configured = Boolean(status.configured);
    const serviceReady = Boolean(status.import_service_ready);
    const rows = [
        ["Enrollment", configured ? "configured" : "not configured"],
        ["Import service", serviceReady ? "ready" : "not ready"],
        ["TAK target", status.cot_url || "not set"],
        ["TLS material", [
            "cert " + bool(status.tls && status.tls.client_cert),
            "key " + bool(status.tls && status.tls.client_key),
            "CA " + bool(status.tls && status.tls.ca),
        ].join(", ")],
    ];
    if (status.last_updated) rows.push(["Last updated", status.last_updated]);
    if (status.detail) rows.push(["Detail", status.detail]);
    tbody.innerHTML = "";
    rows.forEach(([name, value], idx) => {
        const tr = document.createElement("tr");
        const tdName = document.createElement("td");
        const dot = document.createElement("span");
        if (idx === 0) dot.className = "aos-dot " + (configured ? "active" : "inactive");
        else if (idx === 1) dot.className = "aos-dot " + (serviceReady ? "active" : "unknown");
        else dot.className = "aos-dot unknown";
        tdName.appendChild(dot);
        tdName.appendChild(document.createTextNode(name));
        const tdValue = document.createElement("td");
        tdValue.textContent = value;
        tr.appendChild(tdName);
        tr.appendChild(tdValue);
        tbody.appendChild(tr);
    });
}

function refreshTakEnrollmentStatus() {
    return fetch("/cgi-bin/aryaos-tak-dp-upload", {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
    })
        .then((r) => r.json().then((payload) => {
            if (!r.ok || !payload.ok) throw new Error(payload.error || ("HTTP " + r.status));
            return payload;
        }))
        .then(renderTakEnrollmentStatus)
        .catch((ex) => {
            renderTakEnrollmentStatus({
                enrollment_status: {
                    configured: false,
                    import_service_ready: false,
                    detail: ex.message || String(ex),
                    tls: {},
                },
            });
        });
}

function importDataPackage() {
    const el = $("dp-status");
    const fileInput = $("dp-file");
    const file = fileInput && fileInput.files && fileInput.files[0];
    if (!file) {
        setStatus(el, "Choose a .zip or .dpk connection package first.", false);
        return;
    }
    const body = new FormData();
    body.append("package", file);
    el.textContent = "Importing package...";
    el.className = "aos-status";
    fetch("/cgi-bin/aryaos-tak-dp-upload", {
        method: "POST",
        body,
        credentials: "same-origin",
        cache: "no-store",
    })
        .then((r) => r.json().then((payload) => {
            if (!r.ok || !payload.ok) throw new Error(payload.error || ("HTTP " + r.status));
            return payload;
        }))
        .then((payload) => {
            const target = payload.cot_url || "TAK Server";
            setStatus(el, "Imported " + target + "; Charontak forwarding updated.", true);
            showCurrentTls();
            refreshServices();
            refreshTakEnrollmentStatus();
        })
        .catch((ex) => setStatus(el, "Import failed: " + (ex.message || ex), false));
}

function importEnrollmentUrl() {
    const el = $("dp-status");
    const input = $("dp-enrollment-url");
    const enrollmentUrl = input && input.value ? input.value.trim() : "";
    if (!enrollmentUrl) {
        setStatus(el, "Paste a tak:// enrollment URL first.", false);
        return;
    }
    if (!/^tak:\/\//i.test(enrollmentUrl)) {
        setStatus(el, "Enrollment URL must start with tak://.", false);
        return;
    }
    const body = new FormData();
    body.append("enrollment_url", enrollmentUrl);
    el.textContent = "Enrolling...";
    el.className = "aos-status";
    fetch("/cgi-bin/aryaos-tak-dp-upload", {
        method: "POST",
        body,
        credentials: "same-origin",
        cache: "no-store",
    })
        .then((r) => r.json().then((payload) => {
            if (!r.ok || !payload.ok) throw new Error(payload.error || ("HTTP " + r.status));
            return payload;
        }))
        .then((payload) => {
            const target = payload.cot_url || "TAK Server";
            setStatus(el, "Enrolled " + target + "; Charontak forwarding updated.", true);
            input.value = "";
            showCurrentTls();
            refreshServices();
            refreshTakEnrollmentStatus();
        })
        .catch((ex) => setStatus(el, "Enrollment failed: " + (ex.message || ex), false));
}

/* --- Services card --- */
function refreshServices() {
    const units = serviceList(configText);
    const tbody = $("svc-table").querySelector("tbody");
    tbody.innerHTML = "";
    units.forEach((u) => {
        const tr = document.createElement("tr");
        const dot = document.createElement("span");
        dot.className = "aos-dot unknown";
        const tdDot = document.createElement("td");
        tdDot.appendChild(dot);
        tdDot.appendChild(document.createTextNode(u));
        const tdState = document.createElement("td");
        tr.appendChild(tdDot);
        tr.appendChild(tdState);
        tbody.appendChild(tr);
        cockpit.spawn(["systemctl", "is-active", u + ".service"], { err: "ignore" })
            .then((out) => { dot.className = "aos-dot active"; tdState.textContent = out.trim(); })
            .catch((ex) => {
                const state = (ex.message || "").trim() || "not installed";
                dot.className = state === "inactive" || state === "failed" ? "aos-dot inactive" : "aos-dot unknown";
                tdState.textContent = state;
            });
    });
}

/* --- Software updates card --- */
// Preferred path: the aryaos-update helper + oneshot unit shipped by
// aryaos-overlay >= 2.1 (upgrade survives a closed browser session). Older
// images fall back to plain apt under a transient systemd unit.
const UPDATE_HELPER = "/usr/local/sbin/aryaos-update";
const UPDATE_UNIT = "aryaos-update.service";
const APT_APPLY_CMD =
    "DEBIAN_FRONTEND=noninteractive apt-get -y " +
    "-o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold full-upgrade";
let updateRunning = false;
let updatePoller = null;

function updateRow(cells, muted) {
    const tr = document.createElement("tr");
    cells.forEach((text) => {
        const td = document.createElement("td");
        td.textContent = text;
        if (muted) td.className = "aos-muted-cell";
        tr.appendChild(td);
    });
    return tr;
}

function renderUpdateCheck(check) {
    const tbody = $("update-table").querySelector("tbody");
    const summary = $("update-summary");
    tbody.innerHTML = "";
    if (!check) {
        summary.textContent = "Update state unknown — check for updates.";
        $("btn-update-apply").disabled = true;
        return;
    }
    const list = Array.isArray(check.upgradable) ? check.upgradable : [];
    const when = check.checked_at ? " (checked " + check.checked_at + ")" : "";
    if (!list.length) {
        summary.textContent = "Everything is up to date" + when + ".";
        $("btn-update-apply").disabled = true;
    } else {
        summary.textContent = list.length + " update" + (list.length === 1 ? "" : "s") +
            " available" + when + ".";
        $("btn-update-apply").disabled = updateRunning;
    }
    list.slice(0, 30).forEach((p) => {
        tbody.appendChild(updateRow([p.name, (p.current || "?") + " → " + (p.candidate || "?")]));
    });
    if (list.length > 30)
        tbody.appendChild(updateRow(["…", (list.length - 30) + " more"], true));
    if (check.held && check.held.length)
        tbody.appendChild(updateRow(["held back", check.held.join(", ")], true));
}

function refreshUpdateStatus() {
    // status subcommand needs no privileges; absent helper = pre-2.1 image.
    cockpit.spawn([UPDATE_HELPER, "status"], { err: "message" })
        .then((out) => {
            const st = JSON.parse(out);
            $("update-version").textContent = st.aryaos_version ? "AryaOS " + st.aryaos_version : "";
            renderUpdateCheck(st.last_check);
            if (st.reboot_required)
                $("update-summary").textContent += " Reboot required to finish earlier updates.";
        })
        .catch(() => { $("update-version").textContent = ""; });
}

function parseAptUpgradable(out) {
    const list = [];
    out.split("\n").forEach((line) => {
        if (!line.includes("[upgradable from:")) return;
        const name = line.split("/", 1)[0];
        const parts = line.trim().split(/\s+/);
        const m = line.match(/\[upgradable from: ([^\]]+)\]/);
        list.push({ name, current: m ? m[1] : "", candidate: parts[1] || "" });
    });
    return { count: list.length, upgradable: list, held: [] };
}

function checkUpdates() {
    const el = $("update-status");
    $("btn-update-check").disabled = true;
    el.textContent = "Refreshing package lists...";
    el.className = "aos-status";
    cockpit.spawn([UPDATE_HELPER, "check"], { superuser: "require", err: "message" })
        .then((out) => {
            renderUpdateCheck(JSON.parse(out));
            setStatus(el, "Check complete.", true);
        })
        .catch((ex) => {
            if (ex.problem !== "not-found")
                throw ex;
            return cockpit.spawn(
                ["/bin/sh", "-c", "apt-get -qq update >&2 && apt list --upgradable 2>/dev/null"],
                { superuser: "require", err: "message" })
                .then((out) => {
                    renderUpdateCheck(parseAptUpgradable(out));
                    setStatus(el, "Check complete.", true);
                });
        })
        .catch((ex) => setStatus(el, "Check failed: " + (ex.message || ex), false))
        .finally(() => { $("btn-update-check").disabled = false; });
}

function showUpdateLog(unit) {
    return cockpit.spawn(
        ["journalctl", "-u", unit, "--boot", "--no-pager", "-o", "cat", "-n", "400"],
        { superuser: "try", err: "ignore" })
        .then((out) => {
            const log = $("update-log");
            log.hidden = false;
            log.textContent = out;
            log.scrollTop = log.scrollHeight;
        })
        .catch(() => { /* journal may be unreadable for this user */ });
}

function finishApply(el, ok) {
    if (updatePoller) { clearInterval(updatePoller); updatePoller = null; }
    updateRunning = false;
    $("btn-update-check").disabled = false;
    setStatus(el, ok ? "Updates installed." : "Update run failed — see log below.", ok);
    refreshUpdateStatus();
    refreshServices();
}

function pollApply(unit, el, state) {
    state.polls += 1;
    showUpdateLog(unit);
    cockpit.spawn(["systemctl", "is-active", unit], { err: "ignore" })
        .then(() => { state.sawRunning = true; })
        .catch((ex) => {
            const s = (ex.message || "").trim();
            if (s === "activating") {
                state.sawRunning = true;
            } else if (s === "failed") {
                finishApply(el, false);
            } else if (s === "inactive" && (state.sawRunning || state.polls > 10)) {
                // oneshot finished (or never observed running after ~30s)
                finishApply(el, true);
            }
        });
}

function applyUpdates() {
    if (updateRunning) return;
    const el = $("update-status");
    updateRunning = true;
    $("btn-update-apply").disabled = true;
    $("btn-update-check").disabled = true;
    el.textContent = "Installing updates (safe to leave this page)...";
    el.className = "aos-status";
    cockpit.spawn(["systemctl", "cat", UPDATE_UNIT], { err: "ignore" })
        .then(() => cockpit.spawn(["systemctl", "start", "--no-block", UPDATE_UNIT],
            { superuser: "require", err: "message" })
            .then(() => UPDATE_UNIT))
        .catch(() => cockpit.spawn(
            ["systemd-run", "--unit=aryaos-update-run", "--collect", "/bin/sh", "-c", APT_APPLY_CMD],
            { superuser: "require", err: "message" })
            .then(() => "aryaos-update-run.service"))
        .then((unit) => {
            const state = { polls: 0, sawRunning: false };
            updatePoller = setInterval(() => pollApply(unit, el, state), 3000);
        })
        .catch((ex) => {
            updateRunning = false;
            $("btn-update-check").disabled = false;
            $("btn-update-apply").disabled = false;
            setStatus(el, "Could not start update: " + (ex.message || ex), false);
        });
}

/* --- AryaOS neighbor discovery --- */
function truthy(value) {
    return value === true || value === "true" || value === "1" || value === 1;
}

function fmtAge(seconds) {
    const n = Number(seconds);
    if (!Number.isFinite(n) || n < 0) return "-";
    if (n < 60) return Math.round(n) + "s";
    if (n < 3600) return Math.round(n / 60) + "m";
    return Math.round(n / 3600) + "h";
}

function fmtNum(value, digits) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return n.toFixed(digits);
}

function roleText(roles) {
    const out = [];
    if (truthy(roles && roles.adsb)) out.push("ADS-B");
    if (truthy(roles && roles.ais)) out.push("AIS");
    if (truthy(roles && roles.uas)) out.push("UAS");
    return out.length ? out.join(" / ") : "base";
}

function healthText(item) {
    const sys = item.system || {};
    const svc = item.services || {};
    const parts = [];
    if (sys.load1) parts.push("load " + sys.load1);
    if (sys.mem_pct) parts.push("mem " + sys.mem_pct + "%");
    if (sys.temp_c) parts.push(sys.temp_c + " C");
    const keys = Object.keys(svc);
    if (keys.length) {
        const active = keys.filter((k) => svc[k] === "active").length;
        parts.push(active + "/" + keys.length + " svc");
    }
    return parts.join(" | ") || "-";
}

function positionText(point) {
    if (!point) return "-";
    const ce = Number(point.ce);
    const le = Number(point.le);
    if (ce >= 999000 || le >= 999000) return "no fix";
    const lat = fmtNum(point.lat, 4);
    const lon = fmtNum(point.lon, 4);
    if (lat === null || lon === null) return "-";
    return lat + ", " + lon;
}

function renderNeighbors(payload) {
    const tbody = $("neighbors-table").querySelector("tbody");
    const summary = $("neighbors-summary");
    const status = $("neighbors-status");
    tbody.innerHTML = "";
    status.textContent = "";
    status.className = "aos-status";

    if (!payload || payload.ok === false) {
        summary.textContent = "Neighbor cache unavailable.";
        setStatus(status, payload && payload.error ? payload.error : "Could not load neighbors.", false);
        return;
    }

    const items = Array.isArray(payload.items) ? payload.items : [];
    summary.textContent = items.length
        ? items.length + " node" + (items.length === 1 ? "" : "s") + " heard on Mesh SA"
        : "Listening for AryaOS CoT beacons...";

    items.forEach((item) => {
        const host = item.host || {};
        const tr = document.createElement("tr");
        [
            host.name || item.uid || item.source_ip || "-",
            roleText(item.roles || {}),
            healthText(item),
            positionText(item.point || {}),
            fmtAge(item.age_s),
        ].forEach((text) => {
            const td = document.createElement("td");
            td.textContent = text;
            tr.appendChild(td);
        });
        const td = document.createElement("td");
        if (host.admin_url) {
            const a = document.createElement("a");
            a.href = host.admin_url;
            a.rel = "noopener noreferrer";
            a.textContent = "Open";
            td.appendChild(a);
        } else {
            td.textContent = "-";
        }
        tr.appendChild(td);
        tbody.appendChild(tr);
    });
}

function refreshNeighbors() {
    return fetch("/cgi-bin/aryaos-neighbors", {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
    })
        .then((r) => r.json().then((payload) => {
            if (!r.ok || payload.ok === false) throw new Error(payload.error || ("HTTP " + r.status));
            return payload;
        }))
        .then(renderNeighbors)
        .catch((ex) => renderNeighbors({ ok: false, error: ex.message || String(ex) }));
}

/* --- Radios (RTL-SDR) card --- */
const RADIO_SERIAL_RE = /^[A-Za-z0-9:._-]{1,32}$/;

function renderRadios(payload) {
    const tbody = $("radios-table").querySelector("tbody");
    tbody.textContent = "";
    const devices = (payload && payload.devices) || [];
    if (!devices.length) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 5;
        td.textContent = "No RTL-SDR dongles detected.";
        tr.appendChild(td);
        tbody.appendChild(tr);
        return;
    }
    devices.forEach((dev) => {
        const tr = document.createElement("tr");
        [String(dev.index), (dev.vendor + " " + dev.product).trim(), dev.serial || "-"].forEach((text) => {
            const td = document.createElement("td");
            td.textContent = text;
            tr.appendChild(td);
        });
        const tdInput = document.createElement("td");
        const input = document.createElement("input");
        input.type = "text";
        input.placeholder = "stx:1090:0";
        input.setAttribute("list", "radio-serials");
        tdInput.appendChild(input);
        tr.appendChild(tdInput);
        const tdBtn = document.createElement("td");
        const btn = document.createElement("button");
        btn.className = "aos-btn";
        btn.textContent = "Write";
        btn.addEventListener("click", () => writeRadioSerial(dev, input.value.trim(), btn));
        tdBtn.appendChild(btn);
        tr.appendChild(tdBtn);
        tbody.appendChild(tr);
    });
}

function refreshRadios() {
    const el = $("radios-status");
    cockpit.spawn(["/usr/local/sbin/aryaos-sdr", "list"], { superuser: "try", err: "message" })
        .then((out) => renderRadios(JSON.parse(out)))
        .catch((ex) => {
            renderRadios(null);
            setStatus(el, "Scan failed: " + (ex.message || ex), false);
        });
}

function writeRadioSerial(dev, serial, btn) {
    const el = $("radios-status");
    if (!RADIO_SERIAL_RE.test(serial))
        return setStatus(el, "Serial must be 1-32 chars of letters, digits, : . _ -", false);
    if (!window.confirm("Write serial '" + serial + "' to radio #" + dev.index +
        " (" + (dev.serial || "no serial") + ")? SDR services stop briefly; replug the dongle afterwards."))
        return;
    btn.disabled = true;
    cockpit.spawn(["/usr/local/sbin/aryaos-sdr", "set-serial", String(dev.index), serial],
        { superuser: "require", err: "message" })
        .then(() => {
            btn.disabled = false;
            setStatus(el, "Serial written. Replug the dongle (or reboot), then rescan.", true);
            refreshRadios();
        })
        .catch((ex) => {
            btn.disabled = false;
            setStatus(el, "Failed: " + (ex.message || ex), false);
        });
}

/* --- Support bundle card --- */
const SUPPORT_STATE = "/var/lib/aryaos/support-bundle.json";
let supportBundlePath = null;

function fmtSize(bytes) {
    if (!bytes && bytes !== 0) return "";
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
    if (bytes >= 1024) return (bytes / 1024).toFixed(0) + " kB";
    return bytes + " B";
}

function renderSupportState(state) {
    if (!state || !state.path) {
        supportBundlePath = null;
        $("btn-support-download").hidden = true;
        $("support-last").textContent = "";
        return;
    }
    supportBundlePath = state.path;
    $("btn-support-download").hidden = false;
    $("support-last").textContent =
        "Last bundle: " + state.path.split("/").pop() +
        " (" + fmtSize(state.size) + ", " + (state.generated_at || "") + ")";
}

function refreshSupportState() {
    cockpit.file(SUPPORT_STATE, { superuser: "try", syntax: JSON }).read()
        .then(renderSupportState)
        .catch(() => renderSupportState(null));
}

function generateSupportBundle() {
    const el = $("support-status");
    const btn = $("btn-support-generate");
    btn.disabled = true;
    setStatus(el, "Collecting diagnostics (up to a minute)...", true);
    cockpit.spawn(["/usr/local/sbin/aryaos-support-bundle"],
        { superuser: "require", err: "message" })
        .then(() => {
            btn.disabled = false;
            setStatus(el, "Bundle ready.", true);
            refreshSupportState();
        })
        .catch((ex) => {
            btn.disabled = false;
            setStatus(el, "Failed: " + (ex.message || ex), false);
        });
}

function downloadSupportBundle() {
    const el = $("support-status");
    if (!supportBundlePath) return;
    cockpit.file(supportBundlePath, { superuser: "require", binary: true, max_read_size: 256 * 1024 * 1024 })
        .read()
        .then((data) => {
            if (!data) throw new Error("bundle not found — generate it again");
            const blob = new Blob([data], { type: "application/gzip" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = supportBundlePath.split("/").pop();
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 30000);
        })
        .catch((ex) => setStatus(el, "Download failed: " + (ex.message || ex), false));
}

/* --- Node-RED admin password card --- */
function setNoderedPassword() {
    const el = $("nodered-status");
    const pass = $("nodered-pass").value;
    const pass2 = $("nodered-pass2").value;
    if (pass.length < 8)
        return setStatus(el, "Password must be at least 8 characters.", false);
    if (pass !== pass2)
        return setStatus(el, "Passwords do not match.", false);
    const btn = $("btn-nodered-pass");
    btn.disabled = true;
    cockpit.spawn(["/usr/local/sbin/aryaos-set-nodered-password"],
        { superuser: "require", err: "message" })
        .input(pass + "\n", false)
        .then(() => {
            btn.disabled = false;
            $("nodered-pass").value = "";
            $("nodered-pass2").value = "";
            setStatus(el, "Password updated; Node-RED restarted.", true);
        })
        .catch((ex) => {
            btn.disabled = false;
            setStatus(el, "Failed: " + (ex.message || ex), false);
        });
}

/* --- Tailscale VPN card --- */
const TAILSCALE = "/usr/bin/tailscale";
let tsLoginProc = null;

function tsButtons(state) {
    $("btn-ts-start").hidden = state !== "NoDaemon";
    $("btn-ts-connect").hidden = state === "NoDaemon" || tsLoginProc !== null;
    $("btn-ts-cancel").hidden = tsLoginProc === null;
    $("btn-ts-down").disabled = state !== "Running";
    $("btn-ts-logout").disabled = state !== "Running" && state !== "Stopped";
}

function refreshTailscale() {
    cockpit.spawn([TAILSCALE, "status", "--json"], { superuser: "try", err: "message" })
        .then((out) => {
            const st = JSON.parse(out);
            const state = st.BackendState || "Unknown";
            const ips = (st.TailscaleIPs || []).join(", ");
            const dns = st.Self && st.Self.DNSName ? st.Self.DNSName.replace(/\.$/, "") : "";
            let text;
            if (state === "Running")
                text = "Connected as " + (dns || "this node") + (ips ? " (" + ips + ")" : "");
            else if (state === "NeedsLogin")
                text = "Not logged in to a tailnet.";
            else if (state === "Stopped")
                text = "Logged in but disconnected.";
            else
                text = "Tailscale state: " + state;
            $("ts-state").textContent = text;
            $("btn-ts-connect").textContent =
                state === "Stopped" ? "Reconnect" : "Connect (get login link)";
            tsButtons(state);
        })
        .catch((ex) => {
            $("ts-state").textContent =
                "Tailscale daemon not running (" + ((ex.message || ex) + "").split("\n")[0] + ")";
            tsButtons("NoDaemon");
        });
}

function tsStartDaemon() {
    const el = $("ts-status");
    cockpit.spawn(["systemctl", "enable", "--now", "tailscaled"],
        { superuser: "require", err: "message" })
        .then(() => {
            setStatus(el, "Tailscale service started.", true);
            refreshTailscale();
        })
        .catch((ex) => setStatus(el, "Failed: " + (ex.message || ex), false));
}

function tsConnect() {
    if (tsLoginProc) return;
    const el = $("ts-status");
    const link = $("ts-login-link");
    link.textContent = "";
    const proc = cockpit.spawn([TAILSCALE, "up"], { superuser: "require", err: "out" });
    tsLoginProc = proc;
    tsButtons("NeedsLogin");
    setStatus(el, "Requesting login link...", true);
    let buf = "";
    let linkShown = false;
    proc.stream((data) => {
        buf += data;
        const m = buf.match(/https:\/\/login\.tailscale\.com\/\S+/);
        if (m && !linkShown) {
            linkShown = true;
            const a = document.createElement("a");
            a.href = m[0];
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            a.textContent = m[0];
            link.textContent = "Open on any signed-in device to authorize this node: ";
            link.appendChild(a);
            setStatus(el, "Waiting for authorization...", true);
        }
    });
    proc.then(() => {
        link.textContent = "";
        setStatus(el, "Connected to tailnet.", true);
    })
        .catch((ex) => {
            if (String(ex.problem || "") !== "cancelled")
                setStatus(el, "Login failed: " + (ex.message || ex), false);
        })
        .then(() => {
            tsLoginProc = null;
            refreshTailscale();
        });
}

function tsCancelLogin() {
    if (tsLoginProc) {
        tsLoginProc.close("cancelled");
        tsLoginProc = null;
        $("ts-login-link").textContent = "";
        setStatus($("ts-status"), "Login cancelled.", true);
        refreshTailscale();
    }
}

function tsDown() {
    const el = $("ts-status");
    cockpit.spawn([TAILSCALE, "down"], { superuser: "require", err: "message" })
        .then(() => {
            setStatus(el, "Disconnected from tailnet.", true);
            refreshTailscale();
        })
        .catch((ex) => setStatus(el, "Failed: " + (ex.message || ex), false));
}

function tsLogout() {
    const el = $("ts-status");
    if (!window.confirm("Log this node out of the tailnet? It will need a new login link to rejoin."))
        return;
    cockpit.spawn([TAILSCALE, "logout"], { superuser: "require", err: "message" })
        .then(() => {
            setStatus(el, "Logged out of tailnet.", true);
            refreshTailscale();
        })
        .catch((ex) => setStatus(el, "Failed: " + (ex.message || ex), false));
}

/* --- init --- */
configFile.watch((content) => {
    configText = content || "";
    renderForm(configText);
    refreshServices();
    showCurrentTls();
    refreshTakEnrollmentStatus();
    refreshNeighbors();
});
$("btn-save").addEventListener("click", () => saveConfig(true));
$("btn-save-only").addEventListener("click", () => saveConfig(false));
$("btn-tls-upload").addEventListener("click", installTls);
$("btn-dp-upload").addEventListener("click", importDataPackage);
$("btn-enrollment-import").addEventListener("click", importEnrollmentUrl);
$("btn-tak-refresh").addEventListener("click", refreshTakEnrollmentStatus);
$("btn-neighbors-refresh").addEventListener("click", refreshNeighbors);
$("btn-update-check").addEventListener("click", checkUpdates);
$("btn-update-apply").addEventListener("click", applyUpdates);
$("btn-support-generate").addEventListener("click", generateSupportBundle);
$("btn-support-download").addEventListener("click", downloadSupportBundle);
$("btn-nodered-pass").addEventListener("click", setNoderedPassword);
$("btn-radios-refresh").addEventListener("click", refreshRadios);
$("btn-ts-refresh").addEventListener("click", refreshTailscale);
$("btn-ts-start").addEventListener("click", tsStartDaemon);
$("btn-ts-connect").addEventListener("click", tsConnect);
$("btn-ts-cancel").addEventListener("click", tsCancelLogin);
$("btn-ts-down").addEventListener("click", tsDown);
$("btn-ts-logout").addEventListener("click", tsLogout);
refreshUpdateStatus();
refreshSupportState();
refreshRadios();
refreshTailscale();
setInterval(refreshNeighbors, 8000);
