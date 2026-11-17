const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const {
	MEMORY_DIR,
	MEMORY_EVENTS_DIR,
	MEMORY_GLOBAL_PATH,
	MEMORY_PROJECTS_DIR,
} = require("../shared/paths.cjs");
const { info, warn } = require("../shared/log.cjs");

/**
 * Memory is plain Markdown: one bullet per fact, date first, optional #tags.
 *
 *   - [2026-11-17] nginx 403 comes from SELinux context #nginx #selinux
 *
 * Nothing is stored in a proprietary format, so the files stay diffable, reviewable
 * and editable by hand. The index is derived and can always be rebuilt.
 */

const LINE_RE = /^\s*[-*]\s+\[(\d{4}-\d{2}-\d{2})\]\s*(.+?)\s*$/;
const TAG_RE = /\s+#([\p{L}\p{N}_-]+)/gu;

const HEADERS = {
	global: "# Global memory\n\nLong-lived facts that apply to every project.\n",
	project: (name) => `# Project memory: ${name}\n\nFacts scoped to this project.\n`,
	event: (month) => `# Events ${month}\n\nAppend-only operational log.\n`,
};

function today() {
	return new Date().toISOString().slice(0, 10);
}

function slug(value) {
	return String(value)
		.trim()
		.replace(/[^\p{L}\p{N}._-]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64) || "default";
}

function parseScope(scope) {
	if (scope === "global") return { kind: "global", name: "global" };
	if (scope.startsWith("project:")) return { kind: "project", name: scope.slice("project:".length) };
	if (scope.startsWith("event:")) return { kind: "event", name: scope.slice("event:".length) };
	throw new Error(`Unknown memory scope: ${scope}`);
}

function scopePath(scope, date = today()) {
	const { kind, name } = parseScope(scope);
	if (kind === "global") return MEMORY_GLOBAL_PATH;
	if (kind === "project") return path.join(MEMORY_PROJECTS_DIR, `${slug(name)}.md`);
	return path.join(MEMORY_EVENTS_DIR, `${slug(name || date.slice(0, 7))}.md`);
}

function headerFor(scope, date) {
	const { kind, name } = parseScope(scope);
	if (kind === "global") return HEADERS.global;
	if (kind === "project") return HEADERS.project(name);
	return HEADERS.event(date.slice(0, 7));
}

function ensureTree() {
	for (const dir of [MEMORY_DIR, MEMORY_PROJECTS_DIR, MEMORY_EVENTS_DIR]) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

function factId(scope, date, body) {
	return createHash("sha1").update(`${scope}\u0000${date}\u0000${body}`).digest("hex").slice(0, 16);
}

/** Parse one Markdown line into a fact, or null when it is prose. */
function parseLine(line, scope) {
	const match = LINE_RE.exec(line);
	if (!match) return null;
	let body = match[2];
	const tags = [];
	TAG_RE.lastIndex = 0;
	for (let found = TAG_RE.exec(body); found; found = TAG_RE.exec(body)) tags.push(found[1]);
	body = body.replace(TAG_RE, "").trim();
	if (!body) return null;
	return {
		id: factId(scope, match[1], body),
		scope,
		date: match[1],
		body,
		tags,
	};
}

function parseFile(scope, text) {
	const facts = [];
	for (const line of String(text ?? "").split(/\r?\n/)) {
		const fact = parseLine(line, scope);
		if (fact) facts.push(fact);
	}
	return facts;
}

function readScope(scope, date) {
	const file = scopePath(scope, date);
	try {
		return parseFile(scope, fs.readFileSync(file, "utf8"));
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
}

/** Walk every memory file and return all facts with their source path. */
function readAll() {
	ensureTree();
	const out = [];
	const push = (scope, file) => {
		let text;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch {
			return;
		}
		for (const fact of parseFile(scope, text)) out.push({ ...fact, file });
	};

	push("global", MEMORY_GLOBAL_PATH);
	for (const file of listMarkdown(MEMORY_PROJECTS_DIR)) {
		push(`project:${path.basename(file, ".md")}`, file);
	}
	for (const file of listMarkdown(MEMORY_EVENTS_DIR)) {
		push(`event:${path.basename(file, ".md")}`, file);
	}
	return out;
}

function listMarkdown(dir) {
	try {
		return fs
			.readdirSync(dir)
			.filter((name) => name.endsWith(".md"))
			.map((name) => path.join(dir, name));
	} catch {
		return [];
	}
}

/**
 * Append a fact. Returns `{ fact, created }`; duplicates are detected by id so a
 * retried write never doubles a line.
 */
function appendFact({ scope = "global", body, tags = [], date = today() }) {
	const text = String(body ?? "").replace(/[\r\n]+/g, " ").trim();
	if (!text) throw new Error("Memory fact body is empty");
	const { kind, name } = parseScope(scope);
	if (kind !== "global") scope = `${kind}:${slug(name || date.slice(0, 7))}`;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
		!Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
		throw new Error("Memory fact date must be a valid YYYY-MM-DD date");
	}
	if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string" || !/^[\p{L}\p{N}_-]+$/u.test(tag))) {
		throw new Error("Memory tags must contain only letters, numbers, underscores or hyphens");
	}
	const suffix = tags.length ? ` ${tags.map((tag) => `#${tag}`).join(" ")}` : "";
	const line = `- [${date}] ${text}${suffix}\n`;
	// Derive identity from the persisted representation, including inline #tags.
	const fact = parseLine(line.trimEnd(), scope);
	if (!fact) throw new Error("Memory fact body is empty after extracting tags");
	ensureTree();

	const file = scopePath(scope, date);
	let existing = "";
	try {
		existing = fs.readFileSync(file, "utf8");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		existing = headerFor(scope, date);
		fs.writeFileSync(file, existing.endsWith("\n") ? existing : `${existing}\n`);
	}

	const previous = parseFile(scope, existing).find((entry) => entry.id === fact.id);
	if (previous) {
		return { created: false, fact: { ...previous, file } };
	}

	fs.appendFileSync(file, `${existing.endsWith("\n") || !existing ? "" : "\n"}${line}`);
	return { created: true, fact: { ...fact, file } };
}

function removeFact(scope, id) {
	const file = scopePath(scope);
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
	let removed = false;
	const kept = text.split(/\r?\n/).filter((line) => {
		const fact = parseLine(line, scope);
		if (fact && fact.id === id) {
			removed = true;
			return false;
		}
		return true;
	});
	if (!removed) return false;
	fs.writeFileSync(file, kept.join("\n"));
	return true;
}

function listScopes() {
	ensureTree();
	const scopes = ["global"];
	for (const file of listMarkdown(MEMORY_PROJECTS_DIR)) scopes.push(`project:${path.basename(file, ".md")}`);
	for (const file of listMarkdown(MEMORY_EVENTS_DIR)) scopes.push(`event:${path.basename(file, ".md")}`);
	return scopes;
}

/**
 * Rebuild the whole search index from the Markdown files. Called on startup and
 * after manual edits, since a hand-edited file cannot notify us.
 */
function rebuildIndex(db) {
	if (!db) return { indexed: 0, skipped: true };
	const facts = readAll();
	const { upsertDoc, transaction } = require("./indexer.cjs");
	transaction(db, () => {
		db.exec("DELETE FROM docs; DELETE FROM docs_fts;");
		for (const fact of facts) {
			upsertDoc(db, {
				id: fact.id,
				kind: "fact",
				scope: fact.scope,
				title: fact.date,
				body: fact.body,
				tags: fact.tags.join(" "),
				createdAt: Date.parse(`${fact.date}T00:00:00Z`) || Date.now(),
			});
		}
	});
	info(`Memory index rebuilt: ${facts.length} facts`);
	return { indexed: facts.length, skipped: false };
}

function indexFact(db, fact) {
	if (!db) return;
	const { upsertDoc } = require("./indexer.cjs");
	try {
		upsertDoc(db, {
			id: fact.id,
			kind: "fact",
			scope: fact.scope,
			title: fact.date,
			body: fact.body,
			tags: fact.tags.join(" "),
			createdAt: Date.parse(`${fact.date}T00:00:00Z`) || Date.now(),
		});
	} catch (error) {
		warn(`Cannot index memory fact ${fact.id}: ${error.message}`);
	}
}

/**
 * Fingerprint of every memory file (path + mtime + size). Comparing it across
 * starts tells us whether a hand edit invalidated the index — files cannot
 * notify us, so polling the filesystem is the only reliable signal.
 */
function memorySignature() {
	const parts = [];
	const add = (file) => {
		try {
			const stat = fs.statSync(file);
			parts.push(`${file}:${stat.mtimeMs}:${stat.size}`);
		} catch {
			// Missing file is part of the state; it simply does not contribute.
		}
	};
	add(MEMORY_GLOBAL_PATH);
	for (const file of listMarkdown(MEMORY_PROJECTS_DIR)) add(file);
	for (const file of listMarkdown(MEMORY_EVENTS_DIR)) add(file);
	return createHash("md5").update(parts.sort().join("|")).digest("hex");
}

module.exports = Object.freeze({
	appendFact,
	ensureTree,
	factId,
	indexFact,
	listScopes,
	memorySignature,
	parseFile,
	parseLine,
	readAll,
	readScope,
	rebuildIndex,
	removeFact,
	scopePath,
	slug,
	today,
});
