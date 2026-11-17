const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");

// Isolate all state before the extension reads any path.
process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ops-ext-"));

const ROOT = path.join(__dirname, "..");
// Pi exports only an ESM entry point; anchor CJS dependency resolution at its
// real package directory so both symlinked and hoisted installations work.
const PI_ROOT = fs.realpathSync(path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent"));
const requireFromPi = createRequire(path.join(PI_ROOT, "package.json"));
const { createJiti } = requireFromPi("jiti");

/** Minimal stand-in for pi's ExtensionAPI, recording what the extension registers. */
function createMockPi() {
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	return {
		tools,
		commands,
		handlers,
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		registerTool(definition) {
			tools.set(definition.name, definition);
		},
		registerCommand(name, definition) {
			commands.set(name, definition);
		},
		registerShortcut() {},
		registerFlag() {},
		registerProvider() {},
		registerMessageRenderer() {},
		registerEntryRenderer() {},
		getCommands() {
			return [];
		},
		getActiveTools() {
			return [];
		},
		setActiveTools() {},
		events: { on: () => () => {}, emit: () => {} },
		sendMessage() {},
		sendUserMessage() {},
		appendEntry() {},
		setSessionName() {},
		getSessionName() {
			return undefined;
		},
	};
}

function createMockContext(cwd) {
	const notes = [];
	return {
		cwd,
		notes,
		ui: {
			notify: (message, level) => {
				assert.ok([undefined, "info", "warning", "error"].includes(level), `Unsupported notification level: ${level}`);
				notes.push(message);
			},
			setStatus() {},
			setWidget() {},
		},
	};
}

let factory;
let pi;
after(async () => {
	if (pi) await pi.handlers.get("session_shutdown")[0]({}, createMockContext("/tmp"));
	fs.rmSync(process.env.PI_CODING_AGENT_DIR, { recursive: true, force: true });
});

test("extension loads through jiti", async () => {
	const jiti = createJiti(__filename);
	const module = await jiti.import(path.join(ROOT, "index.ts"));
	factory = module.default ?? module;
	assert.equal(typeof factory, "function");
});

test("registers memory tools, scheduling tool and commands", () => {
	pi = createMockPi();
	factory(pi);
	assert.ok(pi.tools.has("memory_save"), [...pi.tools.keys()].join(","));
	assert.ok(pi.tools.has("memory_search"));
	assert.ok(pi.commands.has("memory"));
	assert.ok(pi.handlers.has("before_agent_start"));
	assert.ok(pi.handlers.has("session_start"));
});

test("saving a fact and asking about it injects the memory section", async () => {
	const ctx = createMockContext("/srv/apps/payments");
	const start = pi.handlers.get("session_start")[0];
	await start({ reason: "startup" }, ctx);

	const save = pi.tools.get("memory_save");
	const saved = await save.execute(
		"call-1",
		{ body: "nginx 502 是 upstream 超时导致，已把 proxy_read_timeout 调到 60s", tags: ["nginx"] },
		undefined,
		undefined,
		ctx,
	);
	assert.match(saved.content[0].text, /Saved to/);

	const event = {
		messageType: "user",
		prompt: "nginx 又 502 了，上次是怎么解决的",
		systemPromptOptions: { sections: {} },
	};
	await pi.handlers.get("before_agent_start")[0](event, ctx);

	const section = event.systemPromptOptions.sections["pi-ops-memory"];
	assert.ok(section, "expected a memory section to be injected");
	assert.match(section, /502/);
	assert.match(section, /trust the observation/);
});

test("a short or trivial prompt injects nothing", async () => {
	const ctx = createMockContext("/srv/apps/payments");
	const event = { messageType: "user", prompt: "好", systemPromptOptions: { sections: {} } };
	await pi.handlers.get("before_agent_start")[0](event, ctx);
	assert.equal(event.systemPromptOptions.sections["pi-ops-memory"], undefined);
});

test("custom-message runs are skipped", async () => {
	const ctx = createMockContext("/srv/apps/payments");
	const event = { messageType: "custom", message: {}, systemPromptOptions: { sections: {} } };
	await pi.handlers.get("before_agent_start")[0](event, ctx);
	assert.equal(event.systemPromptOptions.sections["pi-ops-memory"], undefined);
});

test("the search tool finds the saved fact", async () => {
	const search = pi.tools.get("memory_search");
	const result = await search.execute("call-2", { query: "502 超时" }, undefined, undefined, undefined);
	assert.match(result.content[0].text, /502/);
	assert.ok(result.details.count > 0);
});

test("the memory command reports totals", async () => {
	const ctx = createMockContext("/srv/apps/payments");
	const command = pi.commands.get("memory");
	await command.handler("", ctx);
	const report = ctx.notes.join("\n");
	assert.match(report, /Ops memory/);
	assert.match(report, /Index:/);
});

test("project scope follows the working directory", async () => {
	const globals = await (async () => {
		const ctx = createMockContext("/srv/apps/search");
		await pi.handlers.get("session_start")[0]({ reason: "new" }, ctx);
		const save = pi.tools.get("memory_save");
		await save.execute("call-3", { body: "搜索服务用 ES 7.17，索引每天凌晨重建", scope: "global" }, undefined, undefined, ctx);
		return true;
	})();
	assert.ok(globals);

	// A different project sees global facts but not project-scoped ones.
	const otherCtx = createMockContext("/srv/apps/billing");
	await pi.handlers.get("session_start")[0]({ reason: "new" }, otherCtx);
	const event = {
		messageType: "user",
		prompt: "搜索服务的索引什么时候重建",
		systemPromptOptions: { sections: {} },
	};
	await pi.handlers.get("before_agent_start")[0](event, otherCtx);
	assert.match(event.systemPromptOptions.sections["pi-ops-memory"] ?? "", /ES 7\.17/);
});

test("session shutdown closes cleanly", async () => {
	const handler = pi.handlers.get("session_shutdown")[0];
	await handler({ reason: "quit" }, createMockContext("/srv/apps/payments"));
});

test("a reused prompt section is cleared when the next prompt is trivial", async () => {
	const event = { messageType: "user", prompt: "好", systemPromptOptions: { sections: { "pi-ops-memory": "stale", other: "keep" } } };
	await pi.handlers.get("before_agent_start")[0](event, createMockContext("/srv/apps/payments"));
	assert.deepEqual(event.systemPromptOptions.sections, { other: "keep" });
});

test("new sessions pick up manual edits with an already-open index", async () => {
	const ctx = createMockContext("/srv/apps/payments");
	const start = pi.handlers.get("session_start")[0];
	await start({}, ctx);
	const file = path.join(process.env.PI_CODING_AGENT_DIR, "pi-ops", "memory", "global.md");
	fs.appendFileSync(file, "\n- [2026-11-17] manualeditmarker host uses port 8443\n");
	await start({}, ctx);
	const result = await pi.tools.get("memory_search").execute("manual", { query: "manualeditmarker" });
	assert.match(result.content[0].text, /port 8443/);
});

test("forget reports missing ids and search exposes an actionable id", async () => {
	const ctx = createMockContext("/srv/apps/payments");
	await pi.commands.get("memory").handler("forget missing-id", ctx);
	assert.match(ctx.notes.pop(), /No memory entry/);
	const result = await pi.tools.get("memory_search").execute("id", { query: "manualeditmarker" });
	const id = result.content[0].text.match(/\[([a-f0-9]{16})\]/)?.[1];
	assert.ok(id);
	await pi.commands.get("memory").handler(`forget ${id}`, ctx);
	assert.match(ctx.notes.pop(), /Forgot/);
	const after = await pi.tools.get("memory_search").execute("deleted", { query: "manualeditmarker" });
	assert.equal(after.details.count, 0);
});

test('ops command is registered and validates input without starting a daemon', async () => {
	assert.ok(pi.commands.has('ops'));
	const ctx = createMockContext('/srv/apps/payments');
	await pi.commands.get('ops').handler('help', ctx);
	assert.match(ctx.notes.pop(), /ops add/);
	await pi.commands.get('ops').handler('add invalid file:///etc/passwd', ctx);
	assert.match(ctx.notes.pop(), /HTTP checks require/);
});

test('legacy memories require explicit import and project events are recalled', async () => {
	const store = require('../src/memory/store.cjs');
	const { projectFor } = require('../src/shared/project.cjs');
	const ctx = createMockContext('/srv/apps/legacy-payments');
	const project = projectFor(ctx.cwd);
	store.appendFact({ scope: project.legacyScope, body: 'legacyimportmarker nginx upstream timeout' });
	await pi.handlers.get('session_start')[0]({}, ctx);
	let found = await pi.tools.get('memory_search').execute('before-import', { query: 'legacyimportmarker' });
	assert.equal(found.details.count, 0);
	await pi.commands.get('memory').handler('import-legacy', ctx);
	assert.match(ctx.notes.pop(), /Imported 1 facts/);
	found = await pi.tools.get('memory_search').execute('after-import', { query: 'legacyimportmarker' });
	assert.equal(found.details.count, 1);
	assert.equal(store.readScope(project.legacyScope).length, 1);
	await pi.tools.get('memory_save').execute('event-save', { body: 'eventassociationmarker service recovered', scope: 'event' }, undefined, undefined, ctx);
	found = await pi.tools.get('memory_search').execute('event-search', { query: 'eventassociationmarker' });
	assert.equal(found.details.count, 1);
});

test('Pi Agent can schedule a prompt through ops_schedule and see startup status', async () => {
	const runtime = require('../src/schedule/runtime.cjs');
	const scheduler = require('../src/schedule/store.cjs');
	const original = runtime.launchDaemon;
	const ctx = createMockContext('/srv/apps/scheduled-agent');
	let launches = 0;
	try {
		runtime.launchDaemon = async () => { launches++; return { service: 'pi-ops' }; };
		const tool = pi.tools.get('ops_schedule'); assert.ok(tool);
		const result = await tool.execute('schedule-call', { name: 'audit', prompt: '检查项目部署状态', everySeconds: 3600 }, undefined, undefined, ctx);
		assert.equal(result.details.schedulerStarted, true); assert.equal(launches, 1);
		const db = scheduler.openSchedule();
		try {
			const task = scheduler.getTask(db, result.details.taskId);
			assert.equal(task.kind, 'agent'); assert.equal(task.prompt, '检查项目部署状态');
			assert.equal(task.intervalMs, 3600000); assert.equal(task.tools,undefined);assert.equal(task.maxTurns,undefined);
		} finally { db.close(); }
		runtime.launchDaemon = async () => { throw new Error('occupied port'); };
		const saved = await tool.execute('schedule-start-failure', { name: 'audit-2', prompt: '检查部署', everySeconds: 3600 }, undefined, undefined, ctx);
		assert.equal(saved.details.schedulerStarted, false);
		assert.match(saved.content[0].text, /Saved Pi Agent task.*occupied port/);
	} finally { runtime.launchDaemon = original; }
});
