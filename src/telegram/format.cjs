const markdown = require('markdown-it')({ html: false, linkify: false });
const { renderTable } = require('./table.cjs');

// Render only parser-generated HTML. Raw HTML and automatic media uploads are
// excluded; supported rich table attributes are explicit rather than CSS.
markdown.renderer.rules.table_open = () => '<table bordered striped compact>\n';
for (const type of ['thead_open', 'thead_close', 'tbody_open', 'tbody_close']) markdown.renderer.rules[type] = () => '';
for (const tag of ['th', 'td']) markdown.renderer.rules[`${tag}_open`] = (tokens, index) => {
	const align = tokens[index].attrGet('style')?.match(/text-align:\s*(left|right|center)/)?.[1];
	return `<${tag}${align ? ` align="${align}"` : ''}>`;
};
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content);

function richTableMessage(source) {
	// Larger/overly complex documents use the bounded entity renderer below.
	if (source.length > 20000) return null;
	const tokens = markdown.parse(source, {});
	if (!tokens.some(token => token.type === 'table_open')) return null;
	if (tokens.filter(token => token.nesting === 1 || token.type === 'fence').length > 400 || tokens.some(token => token.level > 12)) return null;
	let columns = 0;
	for (const token of tokens) {
		if (token.type === 'tr_open') columns = 0;
		if (['th_open', 'td_open'].includes(token.type) && ++columns > 20) return null;
	}
	return { html: markdown.renderer.render(tokens, markdown.options, {}) };
}

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
		for (let index = 0; index < tokens.length; index++) {
			const token = tokens[index];
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
				case 'table_open': {
					const end = tokens.findIndex((item, position) => position > index && item.type === 'table_close');
					newline(2); append(renderTable(tokens.slice(index, end + 1)), [{ type: 'pre' }]); newline(2);
					index = end; break;
				}
				case 'image': append(token.content); break;
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
		if (end < text.length) {
			const lineEnd = text.lastIndexOf('\n', end - 1) + 1;
			if (lineEnd > start + limit / 2) end = lineEnd;
		}
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
module.exports = { formatMarkdown, richTableMessage, silent };
