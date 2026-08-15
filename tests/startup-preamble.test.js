const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("startup preamble can move the services card", () => {
    const sourcePath = process.env.ARYAOS_JS || path.join(__dirname, "..", "aryaos.js");
    const source = fs.readFileSync(sourcePath, "utf8");
    const preambleEnd = source.indexOf("function setStatus");
    assert.notEqual(preambleEnd, -1, "startup preamble boundary is present");

    const elements = new Map();
    const element = (id) => {
        if (!elements.has(id)) elements.set(id, { id });
        return elements.get(id);
    };
    const moves = [];
    const context = {
        cockpit: {
            file() {
                return {};
            },
        },
        document: {
            getElementById: element,
            querySelector(selector) {
                assert.equal(selector, ".aos-main");
                return {
                    insertBefore(node, reference) {
                        moves.push([node, reference]);
                    },
                };
            },
        },
    };

    vm.runInNewContext(source.slice(0, preambleEnd), context, {
        filename: sourcePath,
    });

    assert.deepEqual(moves, [[element("card-services"), element("card-location")]]);
});

test("location snapshot uses the bounded fast GPS report count", () => {
    const sourcePath = process.env.ARYAOS_JS || path.join(__dirname, "..", "aryaos.js");
    const source = fs.readFileSync(sourcePath, "utf8");

    assert.match(
        source,
        /cockpit\.spawn\(\["gpspipe", "--json", "-n", "8"\]/,
        "location refresh should not wait for unnecessary gpsd report cycles"
    );
});

test("TAK enrollment sends one-time credentials over stdin", () => {
    const sourcePath = process.env.ARYAOS_JS || path.join(__dirname, "..", "aryaos.js");
    const source = fs.readFileSync(sourcePath, "utf8");

    assert.match(
        source,
        /runTakImport\(\["--enroll-stdin"\], enrollmentUrl, "require"\)/,
        "enrollment URLs must not be exposed in the cockpit helper argv"
    );
    assert.doesNotMatch(
        source,
        /runTakImport\(\["--enroll", enrollmentUrl\]/,
        "the legacy argv enrollment path must not be used by the UI"
    );
});
