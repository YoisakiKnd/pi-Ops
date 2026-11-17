const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatMarkdown, richTableMessage, silent } = require('../src/telegram/format.cjs');
const stringWidth = require('string-width').default;

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
	const [table] = formatMarkdown('| 项目 | 状态 |\n| --- | --- |\n| disk | **ok** |');
	assert.match(table.text, /^┌.*┐\n│ 项目 │ 状态 │/);
	assert.match(table.text, /│ disk │ ok   │/);
	assert.deepEqual(table.entities, [{type:'pre',offset:0,length:table.text.length}]);
	assert.equal(formatMarkdown('3. three\n4. four')[0].text, '3. three\n4. four');
	const [nested] = formatMarkdown('**bold `code` bold**');
	assert.deepEqual(nested.entities.map(entity => [entity.type,nested.text.slice(entity.offset,entity.offset+entity.length)]), [['bold','bold '],['code','code'],['bold',' bold']]);
});

test('rich tables use supported HTML, retain inline formatting and escape raw markup', () => {
	const source = '## 对比\n\n| 指标 | 数值 |\n| :--- | ---: |\n| 内存 | **9.7Gi** |\n| link | [详情](https://example.com/?a=1&b=2) |\n\n<b>literal</b>\n\n![alt](https://example.com/private.png)';
	const {html} = richTableMessage(source);
	assert.match(html, /<h2>对比<\/h2>/);
	assert.match(html, /<table bordered striped compact>/);
	assert.match(html, /<td align="right"><strong>9.7Gi<\/strong><\/td>/);
	assert.match(html, /href="https:\/\/example.com\/\?a=1&amp;b=2"/);
	assert.match(html, /&lt;b&gt;literal&lt;\/b&gt;/);
	assert.ok(!/<img|<thead|<tbody|style=/.test(html));
	assert.equal(richTableMessage('plain **text**'), null);
	assert.equal(richTableMessage('x'.repeat(20001) + '\n\n' + source), null);
});

test('compatibility tables align CJK, emoji and combining marks and wrap long cells without loss', () => {
	const source = '| 指标 | 当前值 | 16 分钟前 |\n| --- | ---: | :---: |\n| 内存 | 15Gi 总，5.9Gi 用，9.7Gi 可用，swap 0B | 持平 |\n| 👨‍👩‍👧‍👦 | e\u0301 | 🟢 |';
	const [part] = formatMarkdown(source);
	const lines = part.text.split('\n');
	assert.ok(lines.every(line => stringWidth(line) === stringWidth(lines[0])));
	assert.ok(stringWidth(lines[0]) <= 76);
	assert.ok(part.text.includes('👨‍👩‍👧‍👦') && part.text.includes('e\u0301'));
	assert.match(part.text, /当前值/);
	assert.match(formatMarkdown('| 项目 | 详情 |\n| --- | --- |\n| disk | [详情](https://x.co) |')[0].text, /https:\/\/x.co/);
	const rows = Array.from({length:180}, (_,index)=>`| id${String(index).padStart(4,'0')} | 中文🚀 |`).join('\n');
	const chunks = formatMarkdown('| 项目 | 状态 |\n| --- | --- |\n' + rows);
	assert.ok(chunks.length > 1);
	const complete = chunks.map(chunk => chunk.text).join('');
	for (let index=0;index<180;index++) assert.ok(complete.includes(`id${String(index).padStart(4,'0')}`));
	assert.ok(chunks.every(chunk => chunk.text.length<=3500 && chunk.entities.some(entity=>entity.type==='pre')));
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
