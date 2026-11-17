const fs = require("node:fs");
const { LOG_PATH, OPS_DIR } = require("./paths.cjs");

const MAX_BYTES = 2 * 1024 * 1024;

function rotateIfNeeded() {
	try {
		const { size } = fs.statSync(LOG_PATH);
		if (size < MAX_BYTES) return;
		fs.renameSync(LOG_PATH, `${LOG_PATH}.1`);
	} catch {
		// No log yet, or the rename raced another process; either way, append.
	}
}

function write(level, message) {
	const line = `${new Date().toISOString()} [${level}] ${message}\n`;
	try {
		fs.mkdirSync(OPS_DIR, { recursive: true });
		rotateIfNeeded();
		fs.appendFileSync(LOG_PATH, line);
	} catch {
		// Logging must never take the agent down.
	}
	if (level === "error" || level === "warn") process.stderr.write(`[pi-ops] ${message}\n`);
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

module.exports = Object.freeze({
	debug: (message) => write("debug", message),
	error: (message) => write("error", message),
	errorMessage,
	info: (message) => write("info", message),
	warn: (message) => write("warn", message),
});
