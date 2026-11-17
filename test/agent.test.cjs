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
const { validateAgent } = require('../src/schedule/agent-spec.cjs');
const { runAgent } = require('../src/schedule/agent.cjs');
const { createEngine } = require('../src/schedule/engine.cjs');
const { command } = require('../src/schedule/commands.cjs');
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const projectRoot = path.join(dir, 'project'); fs.mkdirSync(projectRoot);
const project = projectFor(projectRoot);
const input = { kind: 'agent', project, name: 'audit', prompt: 'Inspect the current project', intervalMs: 300_000 };
const report = (outcome, status = 'success') => ({ status, outcome, summary: outcome });
function fixture(t) { const db = store.openSchedule(':memory:'); t.after(() => db.close()); return db; }

test('Agent tasks inherit Pi defaults unless execution settings are explicit', t => {
	const db = fixture(t); const task = store.addTask(db, input, 0);
	assert.equal(task.kind, 'agent'); assert.equal(task.prompt, input.prompt);
	assert.equal(task.tools,undefined);assert.equal(task.timeoutMs,undefined);assert.equal(task.maxTurns,undefined);assert.equal(task.maxOutputChars,undefined);
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
	const telegramFinals = [], telegramDrafts = [];
	const { attachTelegram } = require('../src/telegram/client.cjs');
	let session;
	let step = 0;
	let longRun=false;
	const facade = { ...sdk, DefaultResourceLoader: class extends sdk.DefaultResourceLoader {
		constructor(options) {
			super({...options, extensionFactories:[...options.extensionFactories, pi => attachTelegram(pi, {
				readSettings:()=>true, makeClient:()=>({open:async()=>{},close:async()=>{},status:()=>{},
					draft:text=>telegramDrafts.push(text),final:text=>telegramFinals.push(text)}),
			})]});
		}
	}, createAgentSession: async options => {
		assert.equal(Object.hasOwn(options,'tools'),false,'SDK must inherit Pi tool settings');
		const runtime = await sdk.ModelRuntime.create({ refreshOnCreate: false, authPath: path.join(dir, 'offline-auth.json'), modelsPath: null });
		const model = runtime.getModels('openai')[0]; assert.ok(model);
		await runtime.setRuntimeApiKey(model.provider, 'offline-test-key');
		runtime.streamSimple = (selected, context) => {
			contexts.push(context);
			const content = longRun ? (++step<=14 ? [{type:'toolCall',id:`report-${step}`,name:'ops_report',arguments:{outcome:'healthy',summary:'progress'}}] : [{type:'text',text:'Audit complete.'}]) : step++ === 0 ? [
				{ type: 'toolCall', id: 'read', name: 'read', arguments: { path: 'AGENTS.md' } },
				{ type:'toolCall',id:'bash',name:'bash',arguments:{command:'printf pi-ops-shell-ok'} },
				{ type: 'toolCall', id: 'search', name: 'memory_search', arguments: { query: 'sdkmemorymarker' } },
			] : step === 2 ? [{ type: 'toolCall', id: 'report', name: 'ops_report', arguments: { outcome: 'healthy', summary: 'Verified project and memory' } }]
				: [{ type: 'text', text: 'Audit complete.' }];
			const stopReason = content.some(block=>block.type==='toolCall')?'toolUse':'stop';
			if (stopReason === 'toolUse') content.unshift({type:'text',text:'Checking the next item…'});
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
	assert.deepEqual(telegramFinals, ['Audit complete.']);
	assert.ok(telegramDrafts.includes('Checking the next item…'));
	assert.equal(result.sessionId,task.newSessionId);
	assert.equal(progress.length, 1); assert.ok(fs.existsSync(result.sessionFile));
	assert.match(JSON.stringify(contexts[0]), /sdkprojectmarker/);
	assert.match(JSON.stringify(contexts[0]), /sdkmemorymarker deployment uses port 8443/);
	const results = session.messages.filter(message => message.role === 'toolResult');
	assert.equal(results.length, 4);
	assert.ok(session.getActiveToolNames().includes('bash'));assert.ok(session.getActiveToolNames().includes('edit'));assert.ok(session.getActiveToolNames().includes('write'));
	assert.match(JSON.stringify(results.find(message=>message.toolCallId==='bash')),/pi-ops-shell-ok/); assert.ok(results.every(message => !message.isError));
	step = 0;
	const resumed = await executeSession({ ...task, wake: true, resumeSessionFile: result.sessionFile }, { sdk: facade, runId: 'telegram-resume' });
	assert.equal(resumed.sessionId, result.sessionId);
	assert.equal(resumed.status, 'success');
	assert.ok(session.messages.filter(message => message.role === 'user').length >= 2);
	step = 0;
	const limited = await executeSession({ ...task, maxTurns: 1 }, { sdk: facade, runId: 'turn-limited' });
	assert.equal(limited.status, 'unknown');
	assert.match(limited.summary, /turn limit/);
	step=0;longRun=true;
	const sentBeforeLongRun=telegramFinals.length;
	const unrestricted=await executeSession(task,{sdk:facade,runId:'beyond-old-cap'});
	assert.equal(unrestricted.status,'success');assert.ok(unrestricted.turns>12);
	assert.deepEqual(telegramFinals.slice(sentBeforeLongRun), ['Audit complete.'], '15 provider turns produce one final Telegram answer');
});


test('upgrading legacy Agent tasks removes injected defaults and preserves custom settings',()=>{
 const file=path.join(dir,'legacy-policy.db');let db=store.openSchedule(file);
 const task=store.addTask(db,input,0);
 const legacy={kind:'agent',prompt:input.prompt,intervalMs:300000,failureThreshold:3,tools:['read','grep','find','ls','memory_search','memory_save','ops_report'],timeoutMs:300000,maxTurns:12,maxOutputChars:32000};
 db.prepare('UPDATE tasks SET spec=? WHERE id=?').run(JSON.stringify(legacy),task.id);
 const custom=store.addTask(db,{...input,tools:['bash'],maxTurns:99,timeoutMs:900000},0);
 const customSpec={...custom};delete customSpec.policyVersion;delete customSpec.spec;
 db.prepare('UPDATE tasks SET spec=? WHERE id=?').run(JSON.stringify(customSpec),custom.id);
 db.close();db=store.openSchedule(file);
 try{const upgraded=store.getTask(db,task.id);assert.equal(upgraded.tools,undefined);assert.equal(upgraded.maxTurns,undefined);assert.equal(upgraded.timeoutMs,undefined);assert.equal(upgraded.maxOutputChars,undefined);
 const retained=store.getTask(db,custom.id);assert.deepEqual(retained.tools,['bash','ops_report']);assert.equal(retained.maxTurns,99);assert.equal(retained.timeoutMs,900000);
 }finally{db.close();}
});
