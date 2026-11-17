/**
 * CJK-aware tokenizer for the memory index.
 *
 * SQLite's unicode61 tokenizer treats a run of Han characters as ONE token, so
 * "服务器故障" is a single term and searching "服务器" misses it. FTS5's trigram
 * tokenizer fixes that but needs at least three characters, which kills the most
 * common ops words: 重启 / 超时 / 磁盘 / 内存.
 *
 * So we tokenize ourselves: Han runs become overlapping bigrams (single chars stay
 * whole), Latin/digit runs stay whole and lowercased. Indexing and querying use the
 * same function, so a two-character Chinese query always finds its document.
 */

const CJK = "\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff";
const CJK_RE = new RegExp(`[${CJK}]`);
const SEGMENT_RE = new RegExp(`[A-Za-z0-9_]+|[${CJK}]+`, "g");

/** Split text into raw segments: Han runs and Latin/digit runs. */
function segment(text) {
	return String(text ?? "").match(SEGMENT_RE) || [];
}

/** Expand text into index terms. */
function tokenize(text) {
	const out = [];
	for (const part of segment(text)) {
		if (CJK_RE.test(part)) {
			const chars = [...part];
			if (chars.length === 1) {
				out.push(chars[0]);
				continue;
			}
			for (let index = 0; index < chars.length - 1; index += 1) {
				out.push(chars[index] + chars[index + 1]);
			}
		} else {
			out.push(part.toLowerCase());
		}
	}
	return out;
}

/** Stable, deduplicated token list, used for the indexed column. */
function tokenList(text) {
	return [...new Set(tokenize(text))];
}

/**
 * Build an FTS5 MATCH expression. Terms are quoted so words such as "or" or
 * "and" are read as literals, then OR-ed: recall matters more than precision
 * here because bm25 does the ranking.
 */
function buildMatch(text) {
	const terms = tokenList(text)
		.filter((term) => term.length > 0)
		.map((term) => `"${term.replaceAll('"', '""')}"`);
	return terms.join(" OR ");
}

module.exports = Object.freeze({ buildMatch, segment, tokenList, tokenize });
