const markdown = require('markdown-it')({ html: false, linkify: false });

// Parse before splitting. Telegram entity offsets and lengths use UTF-16 units,
// so even a code block spanning several messages retains valid formatting.
function formatMarkdown(source, limit = 3500) {
	let text = '';
	const entities = [], active = [], lists = [], previousByFormat = new Map();
	function append(value, extra = []) {
		if (!value) return;
		let formats = [...active, ...extra];
		const code = formats.find(item => item.type === 'code' || item.type === 'pre');
		if (code) formats = [code]; // Telegram forbids nesting other entities in code.
		const unique = new Map(formats.map(format => [format.type, format]));
		for (const format of unique.values()) {
			const previous = previousByFormat.get(format);
			if (previous && previous.offset + previous.length === text.length) previous.length += value.length;
			else {
				const entity = { ...format, offset: text.length, length: value.length };
				entities.push(entity); previousByFormat.set(format, entity);
			}
		}
		text += value;
	}
	function newline(count = 1) {
		const existing = text.match(/\n*$/)[0].length;
		if (text && existing < count) append('\n'.repeat(count - existing));
	}
	function walk(tokens) {
		for (const [index, token] of tokens.entries()) {
			switch (token.type) {
				case 'inline': walk(token.children || []); break;
				case 'text': append(token.content); break;
				case 'softbreak': case 'hardbreak': append('\n'); break;
				case 'strong_open': case 'heading_open': active.push({ type: 'bold' }); break;
				case 'em_open': active.push({ type: 'italic' }); break;
				case 's_open': active.push({ type: 'strikethrough' }); break;
				case 'blockquote_open': newline(); active.push({ type: 'blockquote' }); break;
				case 'link_open': active.push({ type: 'text_link', url: token.attrGet('href') }); break;
				case 'strong_close': case 'em_close': case 's_close': case 'link_close': active.pop(); break;
				case 'heading_close': case 'blockquote_close': active.pop(); newline(2); break;
				case 'code_inline': append(token.content, [{ type: 'code' }]); break;
				case 'fence': case 'code_block': {
					newline();
					const language = token.info.trim().split(/\s/)[0];
					append(token.content, [{ type: 'pre', ...(language ? { language } : {}) }]);
					newline(2); break;
				}
				case 'paragraph_close': newline(lists.length ? 1 : 2); break;
				case 'bullet_list_open': lists.push({ ordered: false }); break;
				case 'ordered_list_open': lists.push({ ordered: true, next: Number(token.attrGet('start') || 1) }); break;
				case 'bullet_list_close': case 'ordered_list_close': lists.pop(); newline(lists.length ? 1 : 2); break;
				case 'list_item_open': {
					newline(); const list = lists.at(-1);
					append('  '.repeat(Math.max(0, lists.length - 1)) + (list?.ordered ? `${list.next++}. ` : '• ')); break;
				}
				case 'list_item_close': newline(); break;
				case 'hr': newline(); append('────────'); newline(2); break;
				case 'table_open': newline(); break;
				case 'th_open': active.push({ type: 'bold' }); break;
				case 'th_close': active.pop(); break;
				case 'td_open': case 'tr_open': break;
				case 'td_close': break;
				case 'tr_close': newline(); break;
				case 'table_close': newline(2); break;
				case 'image': append(token.content); break;
			}
			// Tables have no native Telegram equivalent; keep cells readable.
			if (['td_close', 'th_close'].includes(token.type)) {
				const next = tokens[index + 1];
				if (next && ['td_open', 'th_open'].includes(next.type)) append(' | ');
			}
		}
	}
	walk(markdown.parse(String(source), {}));
	text = text.replace(/\n+$/, '');
	const ranges = entities.filter(entity => entity.offset < text.length);
	const chunks = [];
	for (let start = 0; start < text.length;) {
		let end = Math.min(text.length, start + limit);
		if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end--;
		const overlapping = ranges.filter(entity => entity.offset < end && entity.offset + entity.length > start)
			.sort((a, b) => a.offset - b.offset || b.length - a.length);
		if (overlapping.length > 100) end = overlapping[100].offset;
		chunks.push({ text: text.slice(start, end), entities: overlapping.filter(entity => entity.offset < end).map(entity => ({
			...entity, offset: Math.max(start, entity.offset) - start,
			length: Math.min(end, entity.offset + entity.length) - Math.max(start, entity.offset),
		})) });
		start = end;
	}
	return chunks.length ? chunks : [{ text: '', entities: [] }];
}

function silent(settings, important = false, continuation = false) {
	return continuation || !(settings.notifications === 'all' || (settings.notifications === 'important' && important));
}
module.exports = { formatMarkdown, silent };
