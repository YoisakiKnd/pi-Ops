const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ops-config-"));
process.env.PI_CODING_AGENT_DIR = dir;
const { CONFIG_PATH, DEFAULTS, deepMerge, readConfig, writeConfig } = require("../src/shared/config.cjs");
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("returned configuration does not mutate defaults", () => {
	const first = readConfig();
	first.memory.recallLimit = 20;
	assert.equal(readConfig().memory.recallLimit, 6);
	assert.equal(DEFAULTS.memory.recallLimit, 6);
});

test("invalid memory config falls back to usable defaults", () => {
	for (const memory of [null, false, [], "invalid"]) {
		writeConfig({ memory });
		assert.deepEqual(readConfig().memory, DEFAULTS.memory);
	}
	writeConfig({ memory: { enabled: "false", recallLimit: -1, recallCharBudget: "1400", minScore: 2 } });
	assert.deepEqual(readConfig().memory, DEFAULTS.memory);
});

test("valid overrides preserve the rest of the defaults", () => {
	writeConfig({ memory: { enabled: false, recallLimit: 12, recallCharBudget: 0, minScore: 0 } });
	assert.deepEqual(readConfig().memory, { enabled: false, recallLimit: 12, recallCharBudget: 0, minScore: 0 });
	assert.equal(readConfig().port, DEFAULTS.port);
	fs.writeFileSync(CONFIG_PATH, "null");
	assert.deepEqual(readConfig(), DEFAULTS);
});

test("config merge ignores prototype keys", () => {
	const merged = deepMerge(DEFAULTS, JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}'));
	assert.equal(merged.polluted, undefined);
	assert.equal(Object.getPrototypeOf(merged), Object.prototype);
	assert.equal(Object.hasOwn(merged, "constructor"), false);
});
