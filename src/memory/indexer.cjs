const fs = require("node:fs");
const path = require("node:path");
const { buildMatch, tokenList } = require("../shared/cjk.cjs");

/**
 * Search index over the Markdown memory files.
 *
 * SQLite is the only dependency and it ships with Node, but `node:sqlite` is still
 * flagged experimental, so it is loaded lazily and every caller degrades to a
 * linear scan when it is unavailable (older Node, exotic builds).
 */

let DatabaseSync;
let loadAttempted = false;

function loadSqlite() {
	if (loadAttempted) return DatabaseSync;
	loadAttempted = true;

	// The experimental warning fires once per process and would paint over the TUI.
	const originalEmit = process.emitWarning;
	process.emitWarning = function patched(warning, ...rest) {
		const text = typeof warning === "string" ? warning : warning?.message;
		if (String(text ?? "").includes("SQLite")) return;
		return originalEmit.call(process, warning, ...rest);
	};
	try {
		({ DatabaseSync } = require("node:sqlite"));
	} catch {
		DatabaseSync = null;
	} finally {
		process.emitWarning = originalEmit;
	}
	return DatabaseSync;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS docs (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	scope TEXT NOT NULL,
	title TEXT,
	body TEXT NOT NULL,
	tags TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS docs_scope ON docs(scope, kind);
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
	id UNINDEXED,
	tokens,
	tokenize = 'unicode61'
);
`;

/** Open (and create if needed) the index. Returns null when SQLite is unavailable. */
function openIndex(dbPath) {
	const Ctor = loadSqlite();
	if (!Ctor) return null;
	let db;
	try {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		db = new Ctor(dbPath);
		db.exec(SCHEMA);
		return db;
	} catch {
		try { db?.close(); } catch { /* Best-effort cleanup. */ }
		return null;
	}
}

let savepointId = 0;
// Savepoints also work inside the transaction used by a full rebuild.
function transaction(db, write) {
	const name = `ops_write_${savepointId++}`;
	db.exec(`SAVEPOINT ${name}`);
	try {
		const result = write();
		db.exec(`RELEASE ${name}`);
		return result;
	} catch (error) {
		db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
		throw error;
	}
}

function indexedText(doc) {
	return [doc.title ?? "", doc.body, doc.tags ?? ""].join("\n");
}

function upsertDoc(db, doc) {
	if (!db) return;
	return transaction(db, () => {
		const now = Date.now();
		db.prepare(
			`INSERT INTO docs (id, kind, scope, title, body, tags, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   kind = excluded.kind,
			   scope = excluded.scope,
			   title = excluded.title,
			   body = excluded.body,
			   tags = excluded.tags,
			   updated_at = excluded.updated_at`,
		).run(
			doc.id,
			doc.kind,
			doc.scope,
			doc.title ?? null,
			doc.body,
			doc.tags ?? "",
			doc.createdAt ?? now,
			now,
		);
		db.prepare("DELETE FROM docs_fts WHERE id = ?").run(doc.id);
		db.prepare("INSERT INTO docs_fts (id, tokens) VALUES (?, ?)").run(
			doc.id,
			tokenList(indexedText(doc)).join(" "),
		);
	});
}

function removeDoc(db, id) {
	if (!db) return;
	return transaction(db, () => {
		db.prepare("DELETE FROM docs WHERE id = ?").run(id);
		db.prepare("DELETE FROM docs_fts WHERE id = ?").run(id);
	});
}

/**
 * Rank documents for a query. `score` is normalised to the best hit (=1) so
 * callers can apply a relative relevance floor without knowing bm25's scale.
 */
function searchDocs(db, query, { limit = 24, scope } = {}) {
	if (!db) return [];
	const match = buildMatch(query);
	if (!match) return [];
	const eventPrefix = scope?.startsWith("project:") ? `event:${scope.slice(8)}--` : null;
	const rows = scope
		? db
				.prepare(
					`SELECT d.id, d.kind, d.scope, d.title, d.body, d.tags, d.updated_at,
					        -bm25(docs_fts) AS rank
					 FROM docs_fts JOIN docs d ON d.id = docs_fts.id
					 WHERE docs_fts MATCH ? AND (d.scope = ? OR d.scope = 'global'
					   OR substr(d.scope, 1, ?) = ?)
					 ORDER BY rank DESC LIMIT ?`,
				)
				.all(match, scope, eventPrefix?.length ?? 0, eventPrefix, limit)
		: db
				.prepare(
					`SELECT d.id, d.kind, d.scope, d.title, d.body, d.tags, d.updated_at,
					        -bm25(docs_fts) AS rank
					 FROM docs_fts JOIN docs d ON d.id = docs_fts.id
					 WHERE docs_fts MATCH ?
					 ORDER BY rank DESC LIMIT ?`,
				)
				.all(match, limit);
	if (!rows.length) return [];
	const best = Math.max(...rows.map((row) => row.rank), 0);
	return rows.map((row) => ({
		...row,
		score: best > 0 ? row.rank / best : 0,
	}));
}

function countDocs(db) {
	if (!db) return 0;
	return db.prepare("SELECT count(*) AS n FROM docs").get().n;
}

module.exports = Object.freeze({
	countDocs,
	indexedText,
	openIndex,
	removeDoc,
	searchDocs,
	upsertDoc,
	transaction,
	isAvailable: () => loadSqlite() !== null,
});
