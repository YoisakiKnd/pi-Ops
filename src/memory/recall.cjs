const { tokenList } = require("../shared/cjk.cjs");
const { searchDocs } = require("./indexer.cjs");
const { readAll } = require("./store.cjs");

/**
 * Retrieval and prompt injection.
 *
 * Two goals shape this module: never inject more than a small, bounded block, and
 * never present memory as authority. Facts go stale — a server gets rebuilt, a
 * workaround stops being needed — so the injected block always tells the model to
 * trust present observations over remembered ones.
 */

function normalise(hit) {
	return {
		id: hit.id,
		body: hit.body,
		date: hit.title ?? hit.date ?? "",
		score: hit.score ?? 0,
		scope: hit.scope,
		tags: String(hit.tags ?? "")
			.split(/\s+/)
			.filter(Boolean),
	};
}

/** Linear scan used when SQLite is unavailable. Slower, but never wrong. */
function scanFallback(query, scope) {
	const wanted = new Set(tokenList(query));
	if (!wanted.size) return [];
	const scored = [];
	for (const fact of readAll()) {
		const eventPrefix = scope?.startsWith("project:") ? `event:${scope.slice(8)}--` : null;
		if (scope && fact.scope !== scope && fact.scope !== "global" && !(eventPrefix && fact.scope.startsWith(eventPrefix))) continue;
		const have = new Set(tokenList(`${fact.body} ${fact.tags.join(" ")}`));
		let hits = 0;
		for (const term of wanted) if (have.has(term)) hits += 1;
		if (hits === 0) continue;
		scored.push({
			...fact,
			title: fact.date,
			tags: fact.tags.join(" "),
			score: hits / wanted.size,
		});
	}
	scored.sort((a, b) => b.score - a.score);
	const best = scored[0]?.score;
	for (const hit of scored) hit.score /= best;
	return scored;
}

/**
 * Find facts relevant to `query`. Returns at most `limit` entries, each scored
 * 0..1 relative to the best hit, and deduplicated by body.
 */
function recall(db, query, { scope, limit = 6, minScore = 0.2 } = {}) {
	const text = String(query ?? "").trim();
	if (!text) return [];

	const raw = db ? searchDocs(db, text, { limit: limit * 4, scope }) : scanFallback(text, scope);
	const seen = new Set();
	const hits = [];
	for (const hit of raw) {
		const fact = normalise(hit);
		if (!fact.body || seen.has(fact.body)) continue;
		if (fact.score < minScore) continue;
		seen.add(fact.body);
		hits.push(fact);
		if (hits.length >= limit) break;
	}
	return hits;
}

/**
 * Render hits as the body of a prompt section. pi wraps sections in a tag named
 * after their key, so no XML is added here. Returns "" when there is nothing worth
 * injecting, letting the caller leave the section out entirely.
 */
function buildInjectionBody(hits, { charBudget = 1_400 } = {}) {
	if (!hits.length) return "";
	const preface = "Related notes from earlier sessions. They may be out of date; when they conflict with what you observe now, trust the observation.";
	const lines = [];
	let used = preface.length;
	for (const hit of hits) {
		const tags = hit.tags.length ? ` ${hit.tags.map((tag) => `#${tag}`).join(" ")}` : "";
		const scope = hit.scope && hit.scope !== "global" ? ` (${hit.scope})` : "";
		const line = `- [${hit.date}] ${hit.body}${tags}${scope}`;
		if (used + line.length + 1 > charBudget) continue;
		lines.push(line);
		used += line.length + 1;
	}
	if (!lines.length) return "";
	return [
		preface,
		...lines,
	].join("\n");
}

module.exports = Object.freeze({
	buildInjectionBody,
	normalise,
	recall,
	scanFallback,
});
