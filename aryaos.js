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

// TAK data-package / enrollment import runs through the authenticated Cockpit
// superuser backend /usr/local/sbin/aryaos-tak-dp-import — NOT the old
// unauthenticated /cgi-bin/aryaos-tak-dp-upload endpoint (which was reachable
// pre-auth from the LAN and the onboarding hotspot = TAK/CoT takeover).
function runTakImport(args, inputBytes, superuser) {
    const proc = cockpit.spawn(["aryaos-tak-dp-import"].concat(args), {
        superuser: superuser,
        binary: true,
        err: "message",
    });
    const done = (inputBytes !== null && inputBytes !== undefined) ? proc.input(inputBytes) : proc;
    return done.then((out) => {
        const text = typeof out === "string" ? out : new TextDecoder().decode(out);
        const payload = JSON.parse(text || "{}");
        if (!payload.ok) throw new Error(payload.error || "Operation failed");
        return payload;
    });
}

function refreshTakEnrollmentStatus() {
    return runTakImport(["--status"], null, "try")
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
    el.textContent = "Importing package...";
    el.className = "aos-status";
    file.arrayBuffer()
        .then((buf) => runTakImport(["--package"], new Uint8Array(buf), "require"))
        .then((payload) => {
            const target = payload.cot_url || "TAK Server";
            setStatus(el, "Imported " + target + "; Charontak forwarding updated.", true);
            fileInput.value = "";
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
    el.textContent = "Enrolling...";
    el.className = "aos-status";
    runTakImport(["--enroll", enrollmentUrl], null, "require")
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

/* --- Device role card --- */
let roleData = null;

function renderRoleUnits() {
    const el = $("role-units");
    const role = $("role-select").value;
    if (!roleData || !roleData.roles || !roleData.roles[role]) {
        el.textContent = "";
        return;
    }
    const units = roleData.roles[role].units;
    el.textContent = units.length
        ? "Sensor services for this role: " + units.join(", ")
        : "No sensor services — CoT routing core only.";
}

function refreshRole() {
    cockpit.spawn(["/usr/local/sbin/aryaos-role", "list"], { superuser: "try", err: "message" })
        .then((out) => {
            roleData = JSON.parse(out);
            if (roleData.current && $("role-select").querySelector('[value="' + roleData.current + '"]'))
                $("role-select").value = roleData.current;
            renderRoleUnits();
        })
        .catch(() => {
            roleData = null;
            $("role-units").textContent = "Role helper unavailable (needs aryaos-overlay >= 2.2).";
        });
}

function applyRole() {
    const el = $("role-status");
    const role = $("role-select").value;
    if (!window.confirm("Apply role '" + role + "'? Sensor services outside this role stop and are disabled at boot."))
        return;
    const btn = $("btn-role-apply");
    btn.disabled = true;
    cockpit.spawn(["/usr/local/sbin/aryaos-role", "set", role],
        { superuser: "require", err: "message" })
        .then(() => {
            btn.disabled = false;
            setStatus(el, "Role applied: " + role + ".", true);
            refreshRole();
            refreshServices();
        })
        .catch((ex) => {
            btn.disabled = false;
            setStatus(el, "Failed: " + (ex.message || ex), false);
        });
}

/* --- Onboarding hotspot (comitup) password card --- */
const COMITUP_CONF = "/etc/comitup.conf";

function setHotspotPassword(password) {
    const el = $("hotspot-status");
    if (password && (password.length < 8 || password.length > 63))
        return setStatus(el, "Password must be 8-63 characters (WPA2).", false);
    const file = cockpit.file(COMITUP_CONF, { superuser: "require" });
    file.read()
        .then((content) => {
            let text = content || "";
            const line = "ap_password: " + password;
            const re = /^#?\s*ap_password:.*$/m;
            if (password) {
                if (re.test(text)) text = text.replace(re, line);
                else text = text.replace(/\n*$/, "\n") + line + "\n";
            } else {
                // Comment the setting out to return to an open AP.
                text = text.replace(re, "# ap_password:");
            }
            return file.replace(text);
        })
        .then(() => cockpit.spawn(["systemctl", "try-restart", "comitup"],
            { superuser: "require", err: "message" }).catch(() => undefined))
        .then(() => {
            $("hotspot-pass").value = "";
            setStatus(el, password
                ? "Hotspot password set. Applies to the next hotspot (reboot to force)."
                : "Hotspot password removed — onboarding AP is open.", true);
        })
        .catch((ex) => setStatus(el, "Failed: " + (ex.message || ex), false));
}

/* --- Radio control & EMCON card (backed by /usr/local/sbin/aryaos-radio) --- */
function refreshRadioControl() {
    cockpit.spawn(["aryaos-radio", "ap", "status"], { superuser: "try", err: "message" })
        .then((out) => {
            const on = /\bactive\b/.test(out) && /\benabled\b/.test(out);
            const btn = $("btn-ap-toggle");
            btn.dataset.on = on ? "1" : "0";
            btn.textContent = on ? "Disable Wi-Fi hotspot" : "Enable Wi-Fi hotspot";
        }).catch(() => undefined);
    cockpit.spawn(["aryaos-radio", "silence", "status"], { superuser: "try", err: "message" })
        .then((out) => {
            const on = /emcon:\s*ON/i.test(out);
            const btn = $("btn-emcon-toggle");
            btn.dataset.on = on ? "1" : "0";
            btn.textContent = on ? "Disable EMCON (restore radios)" : "Enable EMCON (radio silence)";
        }).catch(() => undefined);
}

function toggleAP() {
    const el = $("ap-control-status");
    const on = $("btn-ap-toggle").dataset.on === "1";
    const action = on ? "off" : "on";
    setStatus(el, on ? "Disabling hotspot…" : "Enabling hotspot…", true);
    cockpit.spawn(["aryaos-radio", "ap", action], { superuser: "require", err: "message" })
        .then((out) => { setStatus(el, out.trim() || "Done.", true); refreshRadioControl(); })
        .catch((ex) => setStatus(el, "Failed: " + (ex.message || ex), false));
}

function toggleEMCON() {
    const el = $("emcon-status");
    const on = $("btn-emcon-toggle").dataset.on === "1";
    const action = on ? "off" : "on";
    if (!on && !window.confirm(
        "Enable EMCON? This rfkill-blocks Wi-Fi and Bluetooth (the box goes radio-silent). " +
        "Ethernet stays up. It persists across reboot until you disable it."))
        return;
    setStatus(el, on ? "Restoring radios…" : "Blocking radios…", true);
    cockpit.spawn(["aryaos-radio", "silence", action], { superuser: "require", err: "message" })
        .then((out) => { setStatus(el, out.split("\n")[0].trim() || "Done.", true); refreshRadioControl(); })
        .catch((ex) => setStatus(el, "Failed: " + (ex.message || ex), false));
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

/* --- Backup & restore card --- */
const BACKUP_STATE = "/var/lib/aryaos/config-backup.json";
let backupPath = null;

function renderBackupState(state) {
    if (!state || !state.path) {
        backupPath = null;
        $("btn-backup-download").hidden = true;
        $("backup-last").textContent = "";
        return;
    }
    backupPath = state.path;
    $("btn-backup-download").hidden = false;
    $("backup-last").textContent =
        "Last backup: " + state.path.split("/").pop() +
        " (" + fmtSize(state.size) + (state.include_secrets ? ", with secrets" : ", no secrets") + ")";
}

function refreshBackupState() {
    cockpit.file(BACKUP_STATE, { superuser: "try", syntax: JSON }).read()
        .then(renderBackupState)
        .catch(() => renderBackupState(null));
}

function createBackup() {
    const el = $("backup-status");
    const btn = $("btn-backup-create");
    const args = ["/usr/local/sbin/aryaos-config-backup", "backup"];
    if (!$("backup-secrets").checked) args.push("--no-secrets");
    btn.disabled = true;
    setStatus(el, "Creating backup...", true);
    cockpit.spawn(args, { superuser: "require", err: "message" })
        .then(() => {
            btn.disabled = false;
            setStatus(el, "Backup created.", true);
            refreshBackupState();
        })
        .catch((ex) => {
            btn.disabled = false;
            setStatus(el, "Failed: " + (ex.message || ex), false);
        });
}

function downloadBackup() {
    const el = $("backup-status");
    if (!backupPath) return;
    cockpit.file(backupPath, { superuser: "require", binary: true, max_read_size: 256 * 1024 * 1024 })
        .read()
        .then((data) => {
            if (!data) throw new Error("backup not found — create it again");
            const blob = new Blob([data], { type: "application/gzip" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = backupPath.split("/").pop();
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 30000);
        })
        .catch((ex) => setStatus(el, "Download failed: " + (ex.message || ex), false));
}

function restoreBackup() {
    const el = $("backup-status");
    const input = $("restore-file");
    const file = input.files && input.files[0];
    if (!file) return setStatus(el, "Choose a backup archive to restore.", false);
    if (!window.confirm("Restore configuration from " + file.name +
        "? This overwrites the current configuration and reboots is recommended."))
        return;
    const dest = "/var/lib/aryaos/backups/" + file.name.replace(/[^A-Za-z0-9._-]/g, "_");
    const btn = $("btn-restore");
    btn.disabled = true;
    setStatus(el, "Uploading and restoring...", true);
    const reader = new FileReader();
    reader.onerror = () => { btn.disabled = false; setStatus(el, "Could not read the file.", false); };
    reader.onload = () => {
        const bytes = new Uint8Array(reader.result);
        cockpit.spawn(["mkdir", "-p", "/var/lib/aryaos/backups"], { superuser: "require", err: "message" })
            .then(() => cockpit.file(dest, { superuser: "require", binary: true }).replace(bytes))
            .then(() => cockpit.spawn(["/usr/local/sbin/aryaos-config-backup", "restore", dest, "--service"],
                { superuser: "require", err: "message" }))
            .then(() => {
                btn.disabled = false;
                setStatus(el, "Restore complete. Reboot to fully apply.", true);
            })
            .catch((ex) => {
                btn.disabled = false;
                setStatus(el, "Restore failed: " + (ex.message || ex), false);
            });
    };
    reader.readAsArrayBuffer(file);
}

/* --- Reset & decommission card --- */
function hostnameThen(cb) {
    cockpit.file("/etc/hostname").read()
        .then((h) => cb((h || "").trim()))
        .catch(() => cb(""));
}

function wireFactoryReset(hostname) {
    const input = $("reset-confirm");
    const btn = $("btn-factory-reset");
    input.addEventListener("input", () => { btn.disabled = input.value.trim() !== hostname; });
    btn.addEventListener("click", () => {
        if (input.value.trim() !== hostname) return;
        if (!window.confirm("Factory reset " + hostname + " and reboot now? The device will disconnect."))
            return;
        const el = $("reset-status");
        btn.disabled = true;
        // The wipe-network option is passed to the static service via a /run flag file.
        const pre = $("reset-wipe-network").checked
            ? cockpit.spawn(["touch", "/run/aryaos-factory-reset.wipe-network"], { superuser: "require", err: "message" })
            : Promise.resolve();
        pre.then(() => cockpit.spawn(["systemctl", "start", "--no-block", "aryaos-factory-reset.service"],
            { superuser: "require", err: "message" }))
            .then(() => setStatus(el, "Factory reset started — the device is rebooting.", true))
            .catch((ex) => { btn.disabled = false; setStatus(el, "Failed: " + (ex.message || ex), false); });
    });
}

function wireZeroize(hostname) {
    const input = $("zeroize-confirm");
    const btn = $("btn-zeroize");
    const phrase = "ERASE " + hostname;
    input.addEventListener("input", () => { btn.disabled = input.value !== phrase; });
    btn.addEventListener("click", () => {
        if (input.value !== phrase) return;
        if (!window.confirm("ZEROIZE " + hostname + "? This destroys all keys, credentials, and data, then reboots."))
            return;
        const el = $("zeroize-status");
        btn.disabled = true;
        const pre = $("zeroize-keep-network").checked
            ? cockpit.spawn(["touch", "/run/aryaos-zeroize.keep-network"], { superuser: "require", err: "message" })
            : Promise.resolve();
        pre.then(() => cockpit.spawn(["systemctl", "start", "--no-block", "aryaos-zeroize.service"],
            { superuser: "require", err: "message" }))
            .then(() => setStatus(el, "Zeroize started — the device is sanitizing and will reboot.", true))
            .catch((ex) => { btn.disabled = false; setStatus(el, "Failed: " + (ex.message || ex), false); });
    });
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
$("role-select").addEventListener("change", renderRoleUnits);
$("btn-role-apply").addEventListener("click", applyRole);
$("btn-hotspot-save").addEventListener("click", () => setHotspotPassword($("hotspot-pass").value));
$("btn-hotspot-clear").addEventListener("click", () => {
    if (window.confirm("Remove the hotspot password? The onboarding AP will be open."))
        setHotspotPassword("");
});
$("btn-ap-toggle").addEventListener("click", toggleAP);
$("btn-emcon-toggle").addEventListener("click", toggleEMCON);
refreshRadioControl();
$("btn-ts-refresh").addEventListener("click", refreshTailscale);
$("btn-ts-start").addEventListener("click", tsStartDaemon);
$("btn-ts-connect").addEventListener("click", tsConnect);
$("btn-ts-cancel").addEventListener("click", tsCancelLogin);
$("btn-ts-down").addEventListener("click", tsDown);
$("btn-ts-logout").addEventListener("click", tsLogout);
$("btn-backup-create").addEventListener("click", createBackup);
$("btn-backup-download").addEventListener("click", downloadBackup);
$("btn-restore").addEventListener("click", restoreBackup);
$("backup-secrets").addEventListener("change", () => {
    $("backup-secrets-warn").hidden = !$("backup-secrets").checked;
});

/* --- OS image backup: pull down this box's own .img.xz --- */
function fmtGB(bytes) {
    return (Number(bytes || 0) / 1073741824).toFixed(2) + " GB";
}
function checkImage() {
    const el = $("image-status");
    setStatus(el, "Looking up this unit's image…", true);
    cockpit.spawn(["aryaos-image-download", "--status"], { superuser: "try", err: "message" })
        .then((out) => {
            const d = JSON.parse(out || "{}");
            if (!d.ok) throw new Error(d.error || "lookup failed");
            const warn = d.fallback ? " (⚠ no build stamp — showing the newest release)" : "";
            $("image-info").textContent =
                `Image: ${d.tag} — ${d.asset} (${fmtGB(d.size)})${warn}` +
                (d.already_downloaded ? " — already downloaded on this box." : "");
            setStatus(el, "Ready to download.", true);
        })
        .catch((ex) => setStatus(el, "Lookup failed: " + (ex.message || ex), false));
}
function downloadImage() {
    const el = $("image-status");
    setStatus(el, "Downloading ~1.5 GB to the box — this takes a few minutes…", true);
    $("btn-image-download").disabled = true;
    cockpit.spawn(["aryaos-image-download"], { superuser: "require", err: "message" })
        .then((out) => {
            const d = JSON.parse((out || "{}").trim().split("\n").pop());
            if (!d.ok) throw new Error(d.error || "download failed");
            setStatus(el, `Saved ${d.path} (${fmtGB(d.size)})${d.cached ? " — already present" : ""}. ` +
                "Copy it off the box, then re-flash from it.", true);
        })
        .catch((ex) => setStatus(el, "Download failed: " + (ex.message || ex), false))
        .finally(() => { $("btn-image-download").disabled = false; });
}
$("btn-image-check").addEventListener("click", checkImage);
$("btn-image-download").addEventListener("click", downloadImage);
hostnameThen((h) => { wireFactoryReset(h); wireZeroize(h); });
refreshUpdateStatus();
refreshSupportState();
refreshRadios();
refreshRole();
refreshTailscale();
refreshBackupState();
setInterval(refreshNeighbors, 8000);
