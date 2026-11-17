const stringWidth = require('string-width').default;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// Compatibility rendering for Bot API servers/clients without rich tables.
// Bound cell widths and wrap by grapheme, preserving CJK and emoji sequences.
function renderTable(tokens) {
	const rows = [], alignments = [];
	let row, cell = '', column = 0, inCell = false;
	function inline(children) {
		let value = ''; const links = [];
		for (const child of children || []) {
			if (['text', 'code_inline', 'image'].includes(child.type)) value += child.content;
			if (['softbreak', 'hardbreak'].includes(child.type)) value += '\n';
			if (child.type === 'link_open') links.push(child.attrGet('href'));
			if (child.type === 'link_close') {
				const url = links.pop(); if (url) value += ` (${url})`;
			}
		}
		return value;
	}
	for (const token of tokens) {
		if (token.type === 'tr_open') { row = []; column = 0; }
		if (['th_open', 'td_open'].includes(token.type)) {
			inCell = true; cell = '';
			alignments[column] ||= token.attrGet('style')?.match(/text-align:\s*(left|right|center)/)?.[1] || 'left';
		}
		if (token.type === 'inline' && inCell) cell += inline(token.children);
		if (['th_close', 'td_close'].includes(token.type)) { row.push(cell); column++; inCell = false; }
		if (token.type === 'tr_close') rows.push(row);
	}
	if (!rows.length) return '';
	const count = Math.max(...rows.map(values => values.length));
	const widths = Array.from({ length: count }, (_, index) => Math.min(24,
		rows.reduce((widest, values) => (values[index] || '').split('\n')
			.reduce((max, line) => Math.max(max, stringWidth(line)), widest), 4)));
	while (widths.reduce((sum, width) => sum + width + 3, 1) > 76 && Math.max(...widths) > 4) {
		const widest = widths.indexOf(Math.max(...widths)); widths[widest]--;
	}
	function wrap(value, width) {
		const lines = [];
		for (const line of value.split('\n')) {
			let current = '', columns = 0;
			for (const { segment } of segmenter.segment(line)) {
				const size = stringWidth(segment);
				if (columns + size > width && current) { lines.push(current); current = ''; columns = 0; }
				current += segment; columns += size;
			}
			lines.push(current);
		}
		return lines;
	}
	const border = (left, middle, right, stroke = '─') => left + widths.map(width => stroke.repeat(width + 2)).join(middle) + right;
	const lines = [border('┌', '┬', '┐')];
	for (const [index, values] of rows.entries()) {
		const cells = widths.map((width, column) => wrap(values[column] || '', width));
		for (let line = 0; line < Math.max(...cells.map(cell => cell.length)); line++) {
			lines.push('│' + widths.map((width, column) => {
				const value = cells[column][line] || '', padding = width - stringWidth(value);
				const left = alignments[column] === 'right' ? padding : alignments[column] === 'center' ? Math.floor(padding / 2) : 0;
				return ` ${' '.repeat(left)}${value}${' '.repeat(padding - left)} `;
			}).join('│') + '│');
		}
		lines.push(index === rows.length - 1 ? border('└', '┴', '┘') : index === 0 ? border('╞', '╪', '╡', '═') : border('├', '┼', '┤'));
	}
	return lines.join('\n');
}
module.exports = { renderTable };
