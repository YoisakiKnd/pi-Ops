const fs = require("node:fs");
const { CONFIG_PATH, DEFAULT_PORT, OPS_DIR } = require("./paths.cjs");

const DEFAULTS = Object.freeze({
	port: DEFAULT_PORT,
	bridgeSecret: "",
	memory: {
		enabled: true,
		// How many entries a single recall may inject.
		recallLimit: 6,
		// Hard cap on injected characters, so a noisy index cannot eat the context.
		recallCharBudget: 1400,
		// Entries below this bm25-derived relevance are dropped.
		minScore: 0.2,
	},
	schedule: {
		enabled: true,
		// A run missed by less than this is still executed; older ones are skipped
		// and recorded, so a leader handover never floods the chat with backlog.
		misfireGraceMs: 10 * 60 * 1000,
		// Never run two instances of the same task at once.
		maxConcurrentPerTask: 1,
	},
	telegram: {
		notifications: "silent",
		enabled: false,
		chatId: "",
		allowedUserId: "",
		apiBaseUrl: "https://api.telegram.org",
		wakeMode: false,
		wakeDefaultCwd: "",
		wakeAllowedRoots: [],
	},
});

function deepMerge(base, override) {
	const out = Object.fromEntries(Object.entries(base).map(([key, value]) => [
		key, value && typeof value === "object" && !Array.isArray(value) ? deepMerge(value, {}) : value,
	]));
	if (!override || typeof override !== "object" || Array.isArray(override)) return out;
	for (const [key, value] of Object.entries(override)) {
		if (["__proto__", "constructor", "prototype"].includes(key)) continue;
		if (value && typeof value === "object" && !Array.isArray(value)) {
			out[key] = deepMerge(base[key] && typeof base[key] === "object" ? base[key] : {}, value);
		} else if (value !== undefined) {
			out[key] = value;
		}
	}
	return out;
}

function readConfig() {
	let stored = {};
	try {
		stored = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
	} catch (error) {
		if (error.code !== "ENOENT") {
			process.stderr.write(`[pi-ops] Cannot read ${CONFIG_PATH}: ${error.message}\n`);
		}
	}
	const config = deepMerge(DEFAULTS, stored);
	const memory = config.memory;
	if (!memory || typeof memory !== "object" || Array.isArray(memory)) {
		config.memory = deepMerge(DEFAULTS.memory, {});
	} else {
		const valid = {
			enabled: (value) => typeof value === "boolean",
			recallLimit: (value) => Number.isInteger(value) && value >= 1 && value <= 20,
			recallCharBudget: (value) => Number.isInteger(value) && value >= 0 && value <= 100_000,
			minScore: (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1,
		};
		for (const [key, check] of Object.entries(valid)) {
			if (!check(memory[key])) memory[key] = DEFAULTS.memory[key];
		}
	}
	return config;
}

function writeConfig(config) {
	fs.mkdirSync(OPS_DIR, { recursive: true });
	fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

module.exports = Object.freeze({ CONFIG_PATH, DEFAULTS, deepMerge, readConfig, writeConfig });
