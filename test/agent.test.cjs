const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ops-agent-'));
process.env.PI_CODING_AGENT_DIR = path.join(dir, 'agent');
const store = require('../src/schedule/store.cjs');
const memory = require('../src/memory/store.cjs');
const { projectFor } = require('../src/shared/project.cjs');
const { validateAgent, DEFAULT_TOOLS } = require('../src/schedule/agent-spec.cjs');
const { runAgent } = require('../src/schedule/agent.cjs');
const { createEngine } = require('../src/schedule/engine.cjs');
const { command } = require('../src/schedule/commands.cjs');
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const projectRoot = path.join(dir, 'project'); fs.mkdirSync(projectRoot);
const project = projectFor(projectRoot);
const input = { kind: 'agent', project, name: 'audit', prompt: 'Inspect the current project', intervalMs: 300_000 };
const report = (outcome, status = 'success') => ({ status, outcome, summary: outcome });
function fixture(t) { const db = store.openSchedule(':memory:'); t.after(() => db.close()); return db; }

test('Agent tasks persist prompts and bounded execution settings', t => {
	const db = fixture(t); const task = store.addTask(db, input, 0);
	assert.equal(task.kind, 'agent'); assert.equal(task.prompt, input.prompt);
	assert.deepEqual(task.tools, DEFAULT_TOOLS); assert.equal(task.timeoutMs, 300_000);
	for (const bad of [{ prompt: '' }, { tools: ['bash;rm'] }, { maxTurns: 0 }, { timeoutMs: Infinity }]) {
		assert.throws(() => validateAgent({ ...input, ...bad }));
	}
	assert.deepEqual(validateAgent({ ...input, tools: ['read'] }).tools, ['read', 'ops_report']);
});

test('Agent outcomes, not completed executions, drive incident transitions', async t => {
	const db = fixture(t); const task = store.addTask(db, input, 0);
	let outcome = 'degraded';
	const engine = createEngine(db, { agent: async (_task, { runId, onProgress }) => {
		assert.ok(runId); onProgress({ sessionFile: '/test/session.jsonl' }); return report(outcome);
	} });
	for (let n = 0; n < 3; n++) await engine.run(task.id, true);
	assert.equal(store.notifications(db, project.id).length, 1);
	outcome = 'unknown'; await engine.run(task.id, true);
	assert.equal(store.notifications(db, project.id).length, 1);
	assert.ok(store.getTask(db, task.id).incident_id);
	outcome = 'healthy'; await engine.run(task.id, true);
	assert.deepEqual(store.notifications(db, project.id).map(note => note.kind), ['opened', 'recovered']);
	await engine.stop();
});

test('interrupted Agent tasks block automatic and manual replay until resumed', async t => {
	const db = fixture(t); const task = store.addTask(db, input, 0);
	const run = store.claim(db, task.id, 'old-owner', 1000, { manual: true });
	store.recordProgress(db, run, { sessionFile: '/saved/session.jsonl', sessionId: 'saved-id' });
	assert.equal(store.recover(db, 2000), 1);
	assert.equal(store.history(db, task.id)[0].result.sessionId, 'saved-id');
	assert.equal(store.getTask(db, task.id).blocked, true);
	store.setEnabled(db, task.id, false, 3000);
	assert.equal(store.getTask(db, task.id).blocked, true, 'pausing must not clear reconciliation');
	assert.equal(store.claim(db, task.id, 'new-owner', 900000), null);
	assert.throws(() => store.claim(db, task.id, 'new-owner', 900000, { manual: true }), /reconciliation/);
	store.setEnabled(db, task.id, true, 900000);
	assert.equal(store.getTask(db, task.id).blocked, false);
	const engine = createEngine(db, { agent: async () => report('unknown', 'timeout') });
	await engine.run(task.id, true);
	assert.equal(store.getTask(db, task.id).blocked, true);
	assert.equal(store.notifications(db, project.id).length, 0, 'execution failures are not service incidents');
	await engine.stop();
});

test('old scheduler databases migrate without losing HTTP tasks', () => {
	const { DatabaseSync } = require('node:sqlite');
	const file = path.join(dir, 'legacy.db'); const old = new DatabaseSync(file);
	old.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,cwd TEXT NOT NULL,name TEXT NOT NULL,spec TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,next_at INTEGER NOT NULL,failures INTEGER NOT NULL DEFAULT 0,incident_id TEXT,created_at INTEGER NOT NULL)');
	old.prepare('INSERT INTO tasks(id,project_id,cwd,name,spec,next_at,created_at) VALUES(?,?,?,?,?,?,?)')
		.run('old-http', project.id, projectRoot, 'http', JSON.stringify({ url: 'http://localhost', intervalMs: 1000, failureThreshold: 3 }), 1000, 0);
	old.close(); const db = store.openSchedule(file);
	try { assert.equal(store.getTask(db, 'old-http').kind, 'http'); assert.equal(store.getTask(db, 'old-http').blocked, false); }
	finally { db.close(); }
});

test('agent-add command preserves multiword prompts and current project', async () => {
	const task = JSON.parse(await command(['agent-add', 'audit', '3600', '检查部署', '并汇报结果'], projectRoot));
	assert.equal(task.kind, 'agent'); assert.equal(task.prompt, '检查部署 并汇报结果');
	assert.equal(task.project_id, project.id);
});

// A real child process tests the IPC lifecycle without credentials or a model call.
const worker = path.join(dir, 'worker.cjs');
fs.writeFileSync(worker, `let ignoreCancel = false; process.on('message', msg => {
 if (msg.type === 'cancel') { if (ignoreCancel) return; process.send({type:'result',result:{status:'unknown',outcome:'unknown',summary:'cancelled'}},()=>process.exit(0)); return; }
 if (msg.type !== 'run') return;
 process.send({type:'progress',progress:{sessionFile:'/test/transcript.jsonl',sessionId:'session-id'}});
 if (msg.task.prompt === 'ignorecancel') { ignoreCancel = true; return; }
 if (msg.task.prompt === 'hang') return;
 if (msg.task.prompt === 'crash') { process.exit(7); return; }
 process.send({type:'result',result:{status:'success',outcome:'healthy',summary:'checked',output:'done'}},()=>process.exit(0));
});`);

test('worker records session metadata and separates clean exit from interruption', async () => {
	const task = { ...validateAgent(input), cwd: projectRoot };
	const progress = [];
	const ok = await runAgent(task, { workerPath: worker, runId: 'run', onProgress: value => progress.push(value) });
	assert.equal(ok.status, 'success'); assert.equal(ok.sessionId, 'session-id'); assert.equal(progress.length, 1);
	const crash = await runAgent({ ...task, prompt: 'crash' }, { workerPath: worker, runId: 'run' });
	assert.equal(crash.status, 'unknown');
	const timeout = await runAgent({ ...task, prompt: 'hang', timeoutMs: 100 }, { workerPath: worker, runId: 'run' });
	assert.equal(timeout.status, 'timeout'); assert.equal(timeout.outcome, 'unknown');
});

test('worker cancellation waits for child termination and preserves uncertainty', async () => {
	const controller = new AbortController();
	const result = await runAgent({ ...validateAgent({ ...input, prompt: 'hang' }), cwd: projectRoot }, {
		workerPath: worker, signal: controller.signal, runId: 'run', onProgress: () => controller.abort(),
	});
	assert.equal(result.status, 'unknown'); assert.equal(result.outcome, 'unknown');
});

test('a worker that ignores cancellation is forcibly terminated within its deadline', async () => {
	const result = await runAgent({ ...validateAgent({ ...input, prompt: 'ignorecancel', timeoutMs: 150 }), cwd: projectRoot }, {
		workerPath: worker, runId: 'forced-stop', killGraceMs: 30,
	});
	assert.equal(result.status, 'timeout');
	assert.ok(result.durationMs < 2000);
});

test('real Pi SDK executes tools, loads project context and injects operational memory offline', async () => {
	const sdk = await import('@earendil-works/pi-coding-agent');
	const ai = await import('@earendil-works/pi-ai/compat');
	const { executeSession } = await import('../src/schedule/agent-session.mjs');
	fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), 'Project context: sdkprojectmarker.');
	memory.appendFact({ scope: project.scope, body: 'sdkmemorymarker deployment uses port 8443' });
	const contexts = [];
	let session;
	let step = 0;
	const facade = { ...sdk, createAgentSession: async options => {
		const runtime = await sdk.ModelRuntime.create({ refreshOnCreate: false, authPath: path.join(dir, 'offline-auth.json'), modelsPath: null });
		const model = runtime.getModels('openai')[0]; assert.ok(model);
		await runtime.setRuntimeApiKey(model.provider, 'offline-test-key');
		runtime.streamSimple = (selected, context) => {
			contexts.push(context);
			const content = step++ === 0 ? [
				{ type: 'toolCall', id: 'read', name: 'read', arguments: { path: 'AGENTS.md' } },
				{ type: 'toolCall', id: 'search', name: 'memory_search', arguments: { query: 'sdkmemorymarker' } },
			] : step === 2 ? [{ type: 'toolCall', id: 'report', name: 'ops_report', arguments: { outcome: 'healthy', summary: 'Verified project and memory' } }]
				: [{ type: 'text', text: 'Audit complete.' }];
			const stopReason = step <= 2 ? 'toolUse' : 'stop';
			const message = { role: 'assistant', content, api: selected.api, provider: selected.provider, model: selected.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, timestamp: Date.now() };
			const stream = ai.createAssistantMessageEventStream();
			stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: stopReason, message });
			return stream;
		};
		const created = await sdk.createAgentSession({ ...options, modelRuntime: runtime, model });
		session = created.session; return created;
	} };
	const progress = [];
	const task = { ...validateAgent({ ...input, prompt: 'Inspect sdkmemorymarker deployment and project context' }),
		id: 'sdk-task', name: 'SDK audit', cwd: projectRoot, project_id: project.id, newSessionId:'17d4ad96-5914-48c4-87ed-d495d540a8a3' };
	const result = await executeSession(task, { sdk: facade, runId: 'sdk-run', onProgress: value => progress.push(value) });
	assert.equal(result.status, 'success'); assert.equal(result.outcome, 'healthy'); assert.equal(result.output, 'Audit complete.');
	assert.equal(result.sessionId,task.newSessionId);
	assert.equal(progress.length, 1); assert.ok(fs.existsSync(result.sessionFile));
	assert.match(JSON.stringify(contexts[0]), /sdkprojectmarker/);
	assert.match(JSON.stringify(contexts[0]), /sdkmemorymarker deployment uses port 8443/);
	const results = session.messages.filter(message => message.role === 'toolResult');
	assert.equal(results.length, 3); assert.ok(results.every(message => !message.isError));
	step = 0;
	const resumed = await executeSession({ ...task, wake: true, resumeSessionFile: result.sessionFile }, { sdk: facade, runId: 'telegram-resume' });
	assert.equal(resumed.sessionId, result.sessionId);
	assert.equal(resumed.status, 'success');
	assert.ok(session.messages.filter(message => message.role === 'user').length >= 2);
	step = 0;
	const limited = await executeSession({ ...task, maxTurns: 1 }, { sdk: facade, runId: 'turn-limited' });
	assert.equal(limited.status, 'unknown');
	assert.match(limited.summary, /turn limit/);
});
