#!/usr/bin/env node

/**
 * Syntax gate for the CommonJS core. The TypeScript entry point is checked by
 * `tsc --noEmit` and, at runtime, by pi's own jiti loader.
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SKIP = new Set(["node_modules", ".git", ".workbuddy"]);

function walk(dir, out = []) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (SKIP.has(entry.name)) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else if (/\.(cjs|mjs)$/.test(entry.name)) out.push(full);
	}
	return out;
}

const files = walk(ROOT);
let failed = 0;
for (const file of files) {
	try {
		execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
	} catch (error) {
		failed += 1;
		process.stderr.write(`syntax error in ${path.relative(ROOT, file)}\n`);
		process.stderr.write(`${error.stderr ?? error.message}\n`);
	}
}

if (failed > 0) {
	process.stderr.write(`${failed} file(s) failed the syntax check\n`);
	process.exit(1);
}
process.stdout.write(`syntax ok: ${files.length} JavaScript files\n`);
