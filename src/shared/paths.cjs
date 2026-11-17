const os = require("node:os");
const path = require("node:path");

/**
 * All pi-ops state lives under the agent dir, next to pi's own files.
 * Memory is a plain directory tree so it can be versioned, copied between
 * machines and read by hand; only the search index is a binary artefact.
 */
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const OPS_DIR = path.join(AGENT_DIR, "pi-ops");

const CONFIG_PATH = path.join(OPS_DIR, "config.json");
const STATE_PATH = path.join(OPS_DIR, "state.json");
const LOG_PATH = path.join(OPS_DIR, "pi-ops.log");

const MEMORY_DIR = path.join(OPS_DIR, "memory");
const MEMORY_GLOBAL_PATH = path.join(MEMORY_DIR, "global.md");
const MEMORY_PROJECTS_DIR = path.join(MEMORY_DIR, "projects");
const MEMORY_EVENTS_DIR = path.join(MEMORY_DIR, "events");

const INDEX_PATH = path.join(OPS_DIR, "index.db");

const TASKS_DIR = path.join(OPS_DIR, "tasks");
const TASKS_FILE = path.join(TASKS_DIR, "tasks.json");
const RUNS_DIR = path.join(TASKS_DIR, "runs");

// Deliberately different from pi-telegram-operator's 43871 so both can run.
const DEFAULT_PORT = 43917;

function isPathInside(root, candidate) {
	const relative = path.relative(root, candidate);
	return (
		relative === "" ||
		(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
	);
}

module.exports = Object.freeze({
	AGENT_DIR,
	CONFIG_PATH,
	DEFAULT_PORT,
	INDEX_PATH,
	LOG_PATH,
	MEMORY_DIR,
	MEMORY_EVENTS_DIR,
	MEMORY_GLOBAL_PATH,
	MEMORY_PROJECTS_DIR,
	OPS_DIR,
	RUNS_DIR,
	STATE_PATH,
	TASKS_DIR,
	TASKS_FILE,
	isPathInside,
});
