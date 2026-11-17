const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatMarkdown, silent } = require('../src/telegram/format.cjs');

test('Markdown renders headings, nested emphasis, lists, quotes, links and fenced code', () => {
	const source = '## 巡检结果\n\n**结论**：`df -h`\n\n```sh\necho "<>&"\n```\n\n[链接](https://example.com/?a=1&b=2)\n\n- 正常\n- ~~失败~~\n\n> *备注*';
	const [part] = formatMarkdown(source);
	assert.equal(part.text, '巡检结果\n\n结论：df -h\n\necho "<>&"\n\n链接\n\n• 正常\n• 失败\n\n备注');
	const spans = part.entities.map(entity => ({ ...entity, value: part.text.slice(entity.offset, entity.offset + entity.length) }));
	for (const [type, value] of [['bold','巡检结果'], ['bold','结论'], ['code','df -h'], ['pre','echo "<>&"\n'], ['text_link','链接'], ['strikethrough','失败'], ['italic','备注'], ['blockquote','备注']]) {
		assert.ok(spans.some(span => span.type === type && span.value === value), `${type}: ${value}`);
	}
	assert.equal(spans.find(span => span.type === 'pre').language, 'sh');
	assert.equal(spans.find(span => span.type === 'text_link').url, 'https://example.com/?a=1&b=2');
});

test('long code and links retain formatting and UTF-16 offsets across chunks', () => {
	const code = '🚀中<>&'.repeat(1500);
	const parts = formatMarkdown(`😀 **开头**\n\n\`\`\`js\n${code}\n\`\`\`\n\n[${'链接'.repeat(2500)}](https://example.com)`);
	assert.ok(parts.length > 3);
	const codeParts = [];
	for (const part of parts) {
		assert.ok(part.text.length <= 3500);
		assert.ok(!/[\uD800-\uDBFF]$/.test(part.text));
		assert.ok(!/^[\uDC00-\uDFFF]/.test(part.text));
		for (const entity of part.entities) {
			assert.ok(entity.length > 0 && entity.offset >= 0 && entity.offset + entity.length <= part.text.length);
			if (entity.type === 'pre') { assert.equal(entity.language, 'js'); codeParts.push(part.text.slice(entity.offset, entity.offset + entity.length)); }
		}
	}
	assert.equal(codeParts.join(''), code + '\n');
	assert.deepEqual(parts[0].entities.find(entity => entity.type === 'bold'), { type:'bold', offset:3, length:2 });
	assert.ok(parts.at(-1).entities.some(entity => entity.type === 'text_link' && entity.url === 'https://example.com'));
});

test('untrusted markup remains text; tables and ordered lists remain readable', () => {
	const [literal] = formatMarkdown('<b>literal</b> & [unsafe](javascript:alert(1))\n\n```\n**literal**\n```');
	assert.ok(literal.text.includes('<b>literal</b> & [unsafe](javascript:alert(1))'));
	assert.ok(!literal.entities.some(entity => entity.type === 'text_link' || entity.type === 'bold'));
	assert.equal(formatMarkdown('| 项目 | 状态 |\n| --- | --- |\n| disk | **ok** |')[0].text, '项目 | 状态\ndisk | ok');
	assert.equal(formatMarkdown('3. three\n4. four')[0].text, '3. three\n4. four');
	const [nested] = formatMarkdown('**bold `code` bold**');
	assert.deepEqual(nested.entities.map(entity => [entity.type,nested.text.slice(entity.offset,entity.offset+entity.length)]), [['bold','bold '],['code','code'],['bold',' bold']]);
});

test('dense formatting stays within the Telegram entity limit without losing content', () => {
	const parts = formatMarkdown('**x** '.repeat(500));
	assert.equal(parts.map(part => part.text).join(''), 'x '.repeat(500).trimEnd());
	assert.ok(parts.every(part => part.entities.length <= 100 && part.text.length <= 3500));
});

test('notifications default to silent and continuation chunks never alert', () => {
	assert.equal(silent({}), true);
	assert.equal(silent({notifications:'silent'}, true), true);
	assert.equal(silent({notifications:'important'}), true);
	assert.equal(silent({notifications:'important'}, true), false);
	assert.equal(silent({notifications:'all'}), false);
	assert.equal(silent({notifications:'all'}, true, true), true);
});
