const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Isolate state before anything reads paths.cjs.
process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ops-test-"));

const store = require("../src/memory/store.cjs");
const indexer = require("../src/memory/indexer.cjs");
const recall = require("../src/memory/recall.cjs");
const { INDEX_PATH } = require("../src/shared/paths.cjs");

const db = indexer.openIndex(INDEX_PATH);
after(() => {
	db?.close();
	fs.rmSync(process.env.PI_CODING_AGENT_DIR, { recursive: true, force: true });
});

test("sqlite index is available", () => {
	assert.ok(db, "expected node:sqlite to be loadable");
});

test("facts dedupe by content", () => {
	const first = store.appendFact({ scope: "global", body: "server-01 runs nginx", tags: ["topology"] });
	const again = store.appendFact({ scope: "global", body: "server-01 runs nginx", tags: ["topology"] });
	assert.equal(first.created, true);
	assert.equal(again.created, false);
	assert.equal(again.fact.id, first.fact.id);
});

test("project scope writes to its own file", () => {
	const { fact } = store.appendFact({
		scope: "project:server-01",
		body: "nginx 返回 403 是因为 SELinux 上下文不对，修复用 restorecon",
		tags: ["nginx", "selinux"],
	});
	assert.ok(fs.existsSync(fact.file));
	assert.match(fact.file, /projects\/server-01\.md$/);
});

test("index rebuild picks up every markdown fact", () => {
	store.appendFact({ scope: "global", body: "PostgreSQL 主库在 10.0.0.12，从库 10.0.0.13", tags: ["pg"] });
	store.appendFact({ scope: "event:2026-11", body: "凌晨磁盘写满导致日志采集中断，清理后恢复", tags: ["disk"] });
	const result = store.rebuildIndex(db);
	assert.equal(result.skipped, false);
	assert.ok(result.indexed >= 4, `expected at least 4 facts, got ${result.indexed}`);
});

test("two-character Chinese query recalls the fact", () => {
	// The whole point of the bigram index: 重启 is shorter than a trigram.
	store.appendFact({ scope: "global", body: "网关进程内存泄漏，已重启并加上 systemd 重启策略", tags: ["gateway"] });
	store.rebuildIndex(db);
	const hits = recall.recall(db, "重启", { limit: 5 });
	assert.ok(hits.length > 0, "expected a hit for 重启");
	assert.ok(hits.some((hit) => hit.body.includes("重启")), JSON.stringify(hits));
});

test("Chinese substring of a longer run still matches", () => {
	const hits = recall.recall(db, "磁盘", { limit: 5 });
	assert.ok(hits.some((hit) => hit.body.includes("磁盘")), JSON.stringify(hits));
});

test("latin and numeric terms match", () => {
	const nginxHits = recall.recall(db, "nginx", { limit: 5 });
	assert.ok(nginxHits.some((hit) => hit.body.includes("nginx")), JSON.stringify(nginxHits));

	const pgHits = recall.recall(db, "PostgreSQL", { limit: 5 });
	assert.ok(pgHits.some((hit) => hit.body.includes("PostgreSQL")), JSON.stringify(pgHits));
});

test("mixed query works", () => {
	const hits = recall.recall(db, "SELinux 403", { limit: 5 });
	assert.ok(hits.length > 0, "expected a hit for SELinux 403");
	assert.ok(hits[0].body.includes("SELinux"), JSON.stringify(hits[0]));
});

test("scope filter keeps global facts visible", () => {
	const hits = recall.recall(db, "nginx", { limit: 8, scope: "project:server-01" });
	assert.ok(hits.length > 0);
	assert.ok(hits.every((hit) => hit.scope === "project:server-01" || hit.scope === "global"));
});

test("injection body carries a staleness warning and obeys budget", () => {
	const hits = recall.recall(db, "nginx", { limit: 5 });
	const body = recall.buildInjectionBody(hits, { charBudget: 400 });
	assert.match(body, /trust the observation/);
	assert.doesNotMatch(body, /<pi-ops-memory>/);
	assert.ok(body.length < 400, `body too large: ${body.length}`);
});

test("empty query produces no block", () => {
	assert.equal(recall.buildInjectionBody(recall.recall(db, "")), "");
	assert.equal(recall.buildInjectionBody([]), "");
});

test("fallback scan works without sqlite", () => {
	const hits = recall.scanFallback("nginx", undefined);
	assert.ok(hits.length > 0);
	assert.ok(hits[0].body.includes("nginx"));
});

test("saving multiline facts and inline tags preserves their identity on disk", () => {
	const input = { scope: "project:round trip", body: "restart\r\nthe worker #ops", tags: ["worker"], date: "2026-11-17" };
	const saved = store.appendFact(input);
	const disk = store.readScope(saved.fact.scope).find((fact) => fact.id === saved.fact.id);
	const { file, ...fact } = saved.fact;
	assert.deepEqual(disk, fact);
	assert.equal(store.appendFact(input).created, false);
	assert.equal(store.appendFact({ ...input, tags: ["different"] }).fact.tags.join(" "), "ops worker");
	assert.equal(store.removeFact(fact.scope, fact.id), true);
	assert.equal(store.readScope(fact.scope).length, 0);
});

test("invalid tags and dates cannot corrupt markdown", () => {
	assert.throws(() => store.appendFact({ body: "valid", tags: ["bad\n- [2026-11-17] injected"] }), /tags/);
	assert.throws(() => store.appendFact({ body: "valid", date: "2026-02-30" }), /date/);
});

test("removing a missing id leaves every file untouched", () => {
	const file = store.scopePath("global");
	const before = fs.readFileSync(file, "utf8");
	const signature = store.memorySignature();
	assert.equal(store.removeFact("global", "missing-id"), false);
	assert.equal(fs.readFileSync(file, "utf8"), before);
	assert.equal(store.memorySignature(), signature);
	assert.match(before, /^# Global memory/);
});

test("the complete injection obeys its budget and skips oversized entries", () => {
	const hit = { body: "short fact", date: "2026-11-17", tags: [], scope: "global" };
	const hits = [{ ...hit, body: "x".repeat(500) }, hit];
	for (const charBudget of [0, 50, 140, 180, 300, 600]) {
		const body = recall.buildInjectionBody(hits, { charBudget });
		assert.ok(body.length <= charBudget, `${body.length} exceeds ${charBudget}`);
	}
	assert.match(recall.buildInjectionBody(hits, { charBudget: 180 }), /short fact/);
});

test("fallback scores are relative to the best match", () => {
	const hits = recall.recall(null, "nginx nonexistentkeyword anotherunknown", { minScore: 0.9 });
	assert.ok(hits.length > 0);
	assert.equal(hits[0].score, 1);
});

test("an FTS write failure rolls back the document update", () => {
	const isolated = indexer.openIndex(":memory:");
	try {
		indexer.upsertDoc(isolated, { id: "atomic", kind: "fact", scope: "global", body: "original" });
		// Substitute a constrained table to fail after the docs row is updated.
		isolated.exec("DROP TABLE docs_fts; CREATE TABLE docs_fts (id TEXT, tokens TEXT CHECK(tokens = 'original')); INSERT INTO docs_fts VALUES ('atomic', 'original');");
		assert.throws(() => indexer.upsertDoc(isolated, { id: "atomic", kind: "fact", scope: "global", body: "changed" }), /CHECK constraint/);
		assert.equal(isolated.prepare("SELECT body FROM docs WHERE id = 'atomic'").get().body, "original");
		assert.equal(isolated.prepare("SELECT tokens FROM docs_fts WHERE id = 'atomic'").get().tokens, "original");
	} finally { isolated.close(); }
});

test("failed rebuild preserves the previous searchable index", () => {
	const isolated = indexer.openIndex(":memory:");
	try {
		indexer.upsertDoc(isolated, { id: "survivor", kind: "fact", scope: "global", body: "survivor" });
		isolated.exec("CREATE TRIGGER fail_docs BEFORE INSERT ON docs BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
		assert.throws(() => store.rebuildIndex(isolated), /injected failure/);
		assert.equal(indexer.countDocs(isolated), 1);
		assert.equal(indexer.searchDocs(isolated, "survivor")[0].id, "survivor");
	} finally { isolated.close(); }
});

test('project events participate in indexed and fallback recall without leaking to other projects', () => {
	store.appendFact({ scope: 'event:project-a--2026-11', body: 'eventisolationmarker upstream timeout' });
	store.appendFact({ scope: 'event:project-b--2026-11', body: 'eventisolationmarker database timeout' });
	store.rebuildIndex(db);
	for (const index of [db, null]) {
		const hits = recall.recall(index, 'eventisolationmarker', { scope: 'project:project-a' });
		assert.equal(hits.length, 1);
		assert.equal(hits[0].scope, 'event:project-a--2026-11');
	}
});
