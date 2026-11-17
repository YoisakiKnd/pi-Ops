const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ops-schedule-'));
process.env.PI_CODING_AGENT_DIR = dir;
const store = require('../src/schedule/store.cjs');
const { createEngine } = require('../src/schedule/engine.cjs');
const { checkHttp, validateHttp } = require('../src/schedule/probe.cjs');
const { startDaemon } = require('../src/schedule/runtime.cjs');
const { projectFor } = require('../src/shared/project.cjs');
const { command } = require('../src/schedule/commands.cjs');
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const project = { id: 'payments', root: '/srv/payments' };
const input = { project, name: 'gateway', url: 'http://127.0.0.1/health', intervalMs: 1000 };
const result = status => ({ status, summary: status, durationMs: 1, statusCode: status === 'success' ? 200 : 503 });

function fixture(t) {
	const db = store.openSchedule(':memory:');
	t.after(() => db.close());
	return db;
}
function complete(db, task, status, time, owner = 'test') {
	const run = store.claim(db, task.id, owner, time, { manual: true });
	assert.ok(run);
	assert.equal(store.finish(db, run, result(status), time + 1), true);
	return run;
}

test('project identity separates equal basenames and resolves symlinks', () => {
	const a = path.join(dir, 'a', 'app');
	const b = path.join(dir, 'b', 'app');
	fs.mkdirSync(a, { recursive: true }); fs.mkdirSync(b, { recursive: true });
	assert.notEqual(projectFor(a).id, projectFor(b).id);
	fs.symlinkSync(a, path.join(dir, 'linked'));
	assert.equal(projectFor(a).id, projectFor(path.join(dir, 'linked')).id);
	fs.writeFileSync(path.join(a, '.pi-ops.json'), '{"projectId":"shared-project"}');
	fs.writeFileSync(path.join(b, '.pi-ops.json'), '{"projectId":"shared-project"}');
	assert.equal(projectFor(a).id, projectFor(b).id);
	fs.writeFileSync(path.join(b, '.pi-ops.json'), '{"projectId":"../escape"}');
	assert.throws(() => projectFor(b), /projectId/);
});

test('task inputs reject unsupported URLs and invalid limits', () => {
	for (const bad of [{ url: 'file:///etc/passwd' }, { url: 'https://user:pass@host' },
		{ intervalMs: 0 }, { timeoutMs: Infinity }, { failureThreshold: 0 }, { expectedStatus: 999 }]) {
		assert.throws(() => validateHttp({ ...input, ...bad }));
	}
});

test('due claims are exclusive and missed intervals collapse to one run', t => {
	const db = fixture(t);
	const task = store.addTask(db, input, 0);
	assert.equal(store.claim(db, task.id, 'a', 999), null);
	const run = store.claim(db, task.id, 'a', 3500);
	assert.equal(run.scheduled_at, 1000);
	assert.equal(store.getTask(db, task.id).next_at, 4000);
	assert.equal(store.claim(db, task.id, 'b', 3500, { manual: true }), null);
	assert.equal(store.finish(db, { ...run, owner: 'wrong' }, result('success'), 3501), false);
	assert.equal(store.finish(db, run, result('success'), 3501), true);
	assert.equal(store.finish(db, run, result('failure'), 3502), false);
	assert.equal(store.getTask(db, task.id).failures, 0);
});

test('old misfires are recorded once and pause/resume does not replay backlog', t => {
	const db = fixture(t);
	const task = store.addTask(db, input, 0);
	const run = store.claim(db, task.id, 'test', 10000, { graceMs: 100 });
	assert.equal(run.status, 'skipped');
	assert.equal(store.getTask(db, task.id).next_at, 11000);
	store.setEnabled(db, task.id, false, 10000);
	assert.equal(store.claim(db, task.id, 'test', 20000), null);
	store.setEnabled(db, task.id, true, 20000);
	assert.equal(store.getTask(db, task.id).next_at, 21000);
	assert.equal(store.history(db, task.id).length, 1);
});

test('three consecutive failures open one incident; recovery closes it once', t => {
	const db = fixture(t);
	const task = store.addTask(db, input, 0);
	complete(db, task, 'failure', 1000);
	complete(db, task, 'success', 2000);
	for (let n = 3; n <= 4; n++) complete(db, task, 'failure', n * 1000);
	assert.equal(store.notifications(db, project.id).length, 0);
	complete(db, task, 'timeout', 5000);
	const first = store.notifications(db, project.id);
	assert.equal(first.length, 1); assert.equal(first[0].kind, 'opened');
	complete(db, task, 'failure', 6000);
	assert.equal(store.notifications(db, project.id).length, 1);
	complete(db, task, 'success', 7000);
	complete(db, task, 'success', 8000);
	const notes = store.notifications(db, project.id);
	assert.deepEqual(notes.map(n => n.kind), ['opened', 'recovered']);
	assert.equal(notes[0].incident_id, notes[1].incident_id);
	assert.ok(db.prepare('SELECT closed_at FROM incidents').get().closed_at);
	assert.equal(store.getTask(db, task.id).incident_id, null);
});

test('restart preserves incidents and history, uncertain runs are never counted as failures', () => {
	const file = path.join(dir, 'restart.db');
	let db = store.openSchedule(file);
	const task = store.addTask(db, input, 0);
	for (let n = 1; n <= 3; n++) complete(db, task, 'failure', n * 1000);
	store.claim(db, task.id, 'old-owner', 4000, { manual: true });
	db.close(); db = store.openSchedule(file);
	try {
		assert.equal(store.recover(db, 5000), 1);
		assert.equal(store.recover(db, 5001), 0);
		assert.equal(store.history(db, task.id)[0].status, 'unknown');
		assert.equal(store.getTask(db, task.id).failures, 0);
		assert.equal(store.notifications(db, project.id).length, 1);
		complete(db, task, 'success', 6000);
		assert.equal(store.notifications(db, project.id).length, 2);
		assert.equal(store.history(db, task.id).length, 5);
	} finally { db.close(); }
});

test('independent database connections cannot overlap a task', () => {
	const file = path.join(dir, 'claim.db');
	const a = store.openSchedule(file); const b = store.openSchedule(file);
	try {
		const task = store.addTask(a, input, 0);
		const first = store.claim(a, task.id, 'a', 1000);
		assert.ok(first);
		assert.equal(store.claim(b, task.id, 'b', 1000, { manual: true }), null);
		assert.equal(store.history(b, task.id)[0].id, first.id);
	} finally { a.close(); b.close(); }
});

test('engine ticks do not overlap and shutdown cancels in-flight checks', async t => {
	const db = fixture(t);
	const task = store.addTask(db, input, 0);
	let calls = 0;
	const engine = createEngine(db, { now: () => 1000, probe: (_task, { signal }) => new Promise(resolve => {
		calls++;
		signal.addEventListener('abort', () => resolve(result('unknown')), { once: true });
	}) });
	const tick = engine.tick();
	await engine.tick();
	assert.equal(calls, 1);
	assert.equal(await engine.run(task.id, true), null);
	await engine.stop(); await tick;
	assert.equal(store.history(db, task.id)[0].status, 'unknown');
	assert.equal(engine.activeCount, 0);
});

test('HTTP checks distinguish status mismatch, timeouts and network failures', async t => {
	const server = http.createServer((req, res) => {
		if (req.url === '/hang') return;
		res.writeHead(req.url === '/bad' ? 503 : req.url === '/redirect' ? 302 : 200, { location: '/ok' });
		res.end('ok');
	});
	server.listen(0, '127.0.0.1'); await once(server, 'listening');
	t.after(() => { server.closeAllConnections(); server.close(); });
	const base = `http://127.0.0.1:${server.address().port}`;
	const task = { timeoutMs: 1000, expectedStatus: 200 };
	assert.equal((await checkHttp({ ...task, url: base })).status, 'success');
	assert.equal((await checkHttp({ ...task, url: `${base}/bad` })).status, 'failure');
	assert.equal((await checkHttp({ ...task, url: `${base}/redirect` })).statusCode, 302);
	assert.equal((await checkHttp({ ...task, url: `${base}/hang`, timeoutMs: 20 })).status, 'timeout');
	const network = await checkHttp(task, { fetchImpl: async () => { throw new Error('DNS failed'); } });
	assert.equal(network.status, 'failure');
	assert.equal(network.statusCode, null);
});

test('daemon authenticates control requests and excludes a second leader before recovery', async t => {
	const db = fixture(t);
	const task = store.addTask(db, input, Date.now());
	const daemon = await startDaemon({ db, port: 0, pollMs: 60_000, probe: async () => result('success') });
	t.after(() => daemon.close());
	const base = `http://127.0.0.1:${daemon.port}`;
	const headers = { authorization: `Bearer ${db.prepare("SELECT value FROM meta WHERE key='token'").get().value}` };
	assert.equal((await fetch(`${base}/status`)).status, 401);
	assert.equal((await (await fetch(`${base}/status`, { headers })).json()).service, 'pi-ops');
	const held = store.claim(db, task.id, 'held', Date.now(), { manual: true });
	await assert.rejects(startDaemon({ db, port: daemon.port }), /EADDRINUSE/);
	assert.equal(store.history(db, task.id)[0].status, 'running');
	store.finish(db, held, result('success'));
	const response = await fetch(`${base}/run?id=${task.id}`, { method: 'POST', headers });
	assert.equal(response.status, 200);
	assert.equal((await response.json()).status, 'success');
});

test('commands scope task access to the project and expose run history', async () => {
	const cwd = path.join(dir, 'cli-project'); fs.mkdirSync(cwd);
	const added = JSON.parse(await command(['add', 'gateway', input.url, '300'], cwd));
	assert.equal(added.intervalMs, 300_000);
	assert.equal(JSON.parse(await command(['list'], cwd)).length, 1);
	assert.equal(JSON.parse(await command(['pause', added.id], cwd)).enabled, false);
	assert.equal(JSON.parse(await command(['resume', added.id], cwd)).enabled, true);
	assert.deepEqual(JSON.parse(await command(['history', added.id], cwd)), []);
	await assert.rejects(command(['history', added.id], path.join(dir, 'different-project')), /current project/);
	await assert.rejects(command(['add', 'bad', input.url, 'nonsense'], cwd), /intervalMs/);
});

test('transition delivery emits only new incident changes', async t => {
	const db = fixture(t);
	const task = store.addTask(db, input, 0);
	const emitted = [];
	let status = 'failure';
	const engine = createEngine(db, { now: () => 1000, probe: async () => result(status), onNotification: note => emitted.push(note) });
	for (let n = 0; n < 5; n++) await engine.run(task.id, true);
	assert.deepEqual(emitted.map(note => note.kind), ['opened']);
	status = 'success';
	await engine.run(task.id, true); await engine.run(task.id, true);
	assert.deepEqual(emitted.map(note => note.kind), ['opened', 'recovered']);
	await engine.stop();
});

test('detached CLI daemon survives commands and retains incidents across restarts', async t => {
	const { execFile } = require('node:child_process');
	const { promisify } = require('node:util');
	const runFile = promisify(execFile);
	const root = path.join(dir, 'detached'); fs.mkdirSync(root);
	const state = path.join(root, 'state'); fs.mkdirSync(path.join(state, 'pi-ops'), { recursive: true });
	const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
	const port = reservation.address().port;
	await new Promise(resolve => reservation.close(resolve));
	fs.writeFileSync(path.join(state, 'pi-ops', 'config.json'), JSON.stringify({ port }));
	const env = { ...process.env, PI_CODING_AGENT_DIR: state };
	const cli = (...args) => runFile(process.execPath, [path.join(__dirname, '../cli.cjs'), ...args], { cwd: root, env, timeout: 15000 });
	let status = 503;
	const target = http.createServer((_req, res) => { res.writeHead(status); res.end(); });
	target.listen(0, '127.0.0.1'); await once(target, 'listening');
	t.after(async () => {
		try { await cli('stop'); } catch { /* Already stopped. */ }
		for (let n = 0; n < 50; n++) {
			try { await cli('status'); } catch { break; }
			await new Promise(resolve => setTimeout(resolve, 20));
		}
		target.closeAllConnections(); await new Promise(resolve => target.close(resolve));
	});
	const task = JSON.parse((await cli('add', 'service', `http://127.0.0.1:${target.address().port}`, '300')).stdout);
	const first = JSON.parse((await cli('start')).stdout);
	assert.equal(first.service, 'pi-ops');
	assert.equal(JSON.parse((await cli('start')).stdout).pid, first.pid);
	for (let n = 0; n < 4; n++) await cli('run', task.id);
	const opened = JSON.parse((await cli('events')).stdout);
	assert.equal(opened.length, 1);
	await cli('stop');
	for (let n = 0; n < 50; n++) {
		try { await cli('status'); } catch { break; }
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	await cli('start');
	status = 200;
	await cli('run', task.id);
	const notes = JSON.parse((await cli('events')).stdout);
	assert.deepEqual(notes.map(note => note.kind), ['recovered', 'opened']);
	assert.equal(notes[0].incident_id, notes[1].incident_id);
	assert.equal(JSON.parse((await cli('history', task.id)).stdout).length, 5);
});

test('shutdown retains socket ownership until the last probe has finished', async t => {
	const db = fixture(t);
	const task = store.addTask(db, input, Date.now());
	let release;
	const daemon = await startDaemon({ db, port: 0, pollMs: 60_000,
		probe: () => new Promise(resolve => { release = () => resolve(result('unknown')); }) });
	const running = daemon.engine.run(task.id, true);
	const stopping = daemon.close();
	try {
		await assert.rejects(startDaemon({ db, port: daemon.port }), /EADDRINUSE/);
		assert.equal(store.history(db, task.id)[0].status, 'running');
	} finally { release(); await running; await stopping; }
	assert.equal(store.history(db, task.id)[0].status, 'unknown');
});

test('five-minute scheduled acceptance: three failures, restart, then one recovery', async t => {
	const db = fixture(t);
	const intervalMs = 300_000;
	const task = store.addTask(db, { ...input, intervalMs }, 0);
	let now = 0;
	const observed = [];
	const engine = createEngine(db, { now: () => now, probe: async () => result('failure'), onNotification: note => observed.push(note) });
	await engine.tick();
	assert.equal(store.history(db, task.id).length, 0);
	for (let n = 1; n <= 3; n++) { now = n * intervalMs; await engine.tick(); await engine.tick(); }
	assert.equal(store.history(db, task.id).length, 3);
	assert.deepEqual(observed.map(note => note.kind), ['opened']);
	await engine.stop();
	assert.equal(store.recover(db, now + 1), 0);
	const restarted = createEngine(db, { now: () => now, probe: async () => result('success'), onNotification: note => observed.push(note) });
	now += intervalMs;
	await restarted.tick(); await restarted.tick();
	await restarted.stop();
	assert.deepEqual(observed.map(note => note.kind), ['opened', 'recovered']);
	assert.equal(store.history(db, task.id).length, 4);
	assert.equal(store.getTask(db, task.id).next_at, 5 * intervalMs);
});
