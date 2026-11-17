const http = require('node:http');
const net = require('node:net');
const { readTelegram } = require('../telegram/settings.cjs');
const { createBroker } = require('../telegram/broker.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { timingSafeEqual } = require('node:crypto');
const store = require('./store.cjs');
const { createEngine } = require('./engine.cjs');
const { readConfig } = require('../shared/config.cjs');
const { OPS_DIR } = require('../shared/paths.cjs');

function settings() {
	const config = readConfig();
	if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('Invalid scheduler port');
	const schedule = config.schedule;
	if (!schedule || typeof schedule.enabled !== 'boolean' || !Number.isSafeInteger(schedule.misfireGraceMs) || schedule.misfireGraceMs < 0) {
		throw new Error('Invalid schedule configuration');
	}
	return { port: config.port, enabled: schedule.enabled, graceMs: schedule.misfireGraceMs };
}
function getToken(db) { return db.prepare("SELECT value FROM meta WHERE key='token'").get().value; }
function sameToken(a, b) {
	const left = Buffer.from(a || '');
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}
async function startDaemon({ port, db, enabled = true, graceMs = 600_000, pollMs = 1000, probe, telegramOptions } = {}) {
	const telegramSettings = telegramOptions?.settings ?? readTelegram();
	if (!enabled && !telegramSettings) throw new Error('Scheduling is disabled in config.json');
	const owned = !db;
	db ||= store.openSchedule();
	const token = getToken(db);
	const engine = createEngine(db, { graceMs, probe,
		onNotification: note => process.stdout.write(`${JSON.stringify(note)}\n`),
	});
	let timer;
	let closing;
	let ready = false;
	let broker;
	const connections = new Set();
	const control = http.createServer(async (req, res) => {
		const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
		if (!sameToken(req.headers.authorization, `Bearer ${token}`)) { reply(401, { error: 'Unauthorized' }); return; }
		if (!ready) { reply(503, { error: 'Scheduler is starting' }); return; }
		try {
			const url = new URL(req.url, 'http://localhost');
			if (req.method === 'GET' && url.pathname === '/status') {
				reply(200, { service: 'pi-ops', pid: process.pid, active: engine.activeCount, taskKinds: ['http', 'agent'], telegram: Boolean(broker), bridgeVersion: 1 });
			} else if (req.method === 'POST' && url.pathname === '/stop') {
				db.prepare("INSERT INTO meta VALUES('broker_desired','0') ON CONFLICT(key) DO UPDATE SET value='0'").run();
				reply(200, { stopping: true });
				void close();
			} else if (req.method === 'POST' && url.pathname === '/run') {
				if (!enabled) throw new Error('Scheduling is disabled');
				const result = await engine.run(url.searchParams.get('id'), true);
				reply(result ? 200 : 409, result || { error: 'Task already running' });
			} else reply(404, { error: 'Unknown endpoint' });
		} catch (error) { reply(400, { error: error.message }); }
	});
	// One TCP listener arbitrates leadership for both JSON bridge and HTTP control.
	const server = net.createServer({ pauseOnConnect: true }, socket => {
		connections.add(socket); socket.on('close', () => connections.delete(socket)); socket.on('error', () => {});
		socket.setTimeout(5000, () => socket.destroy());
		socket.once('data', chunk => {
			socket.pause(); socket.setTimeout(0); socket.unshift(chunk);
			if (chunk[0] === 123 && broker) broker.attach(socket);
			else if (chunk[0] !== 123) control.emit('connection', socket);
			else socket.destroy();
			socket.resume();
		});
		socket.resume();
	});
	control.requestTimeout = 5000;
	control.headersTimeout = 5000;
	control.maxHeadersCount = 20;
	async function close() {
		if (closing) return closing;
		ready = false;
		clearInterval(timer);
		closing = (async () => {
			// Keep ownership until every probe has stopped and its result is committed.
			await engine.stop();
			await broker?.close();
			const closed = new Promise(resolve => server.close(resolve));
			control.closeAllConnections();
			for (const socket of connections) socket.destroy();
			await closed;
			if (owned) db.close();
		})();
		return closing;
	}
	try {
		await new Promise((resolve, reject) => {
			server.once('error', reject);
			server.listen(port ?? settings().port, '127.0.0.1', resolve);
		});
		if (telegramSettings) { broker = createBroker(db, telegramSettings, telegramOptions); broker.start(); }
		// Binding happens before recovery: a second daemon cannot invalidate active runs.
		store.recover(db);
		ready = true;
		const tick = () => (enabled ? engine.tick() : Promise.resolve()).catch(error => process.stderr.write(`[pi-ops] Scheduler tick failed: ${error.message}\n`));
		timer = setInterval(tick, pollMs);
		void tick();
		return { server, engine, broker, close, port: server.address().port };
	} catch (error) {
		if (server.listening) await close();
		else if (owned) db.close();
		throw error;
	}
}
async function requestDaemon(endpoint = '/status', { method = 'GET', timeoutMs = 2000, port } = {}) {
	const db = store.openSchedule();
	let token;
	try { token = getToken(db); } finally { db.close(); }
	const response = await fetch(`http://127.0.0.1:${port ?? settings().port}${endpoint}`, {
		method, headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs),
	});
	const body = await response.json();
	if (!response.ok) throw new Error(body.error || `Scheduler returned ${response.status}`);
	if (endpoint === '/status' && body.service !== 'pi-ops') throw new Error('Port is occupied by another service');
	return body;
}
async function launchDaemon() {
	const config = settings();
	if (!config.enabled && !readTelegram()) throw new Error('Scheduling is disabled in config.json');
	const state = store.openSchedule();
	try { state.prepare("INSERT INTO meta VALUES('broker_desired','1') ON CONFLICT(key) DO UPDATE SET value='1'").run(); } finally { state.close(); }
	let running;
	try { running = await requestDaemon(); } catch { /* Start and verify; bind protects ownership. */ }
	if (running) {
		if (!running.taskKinds?.includes('agent') || (readTelegram() && !running.bridgeVersion)) throw new Error('Running scheduler predates Agent tasks; use /ops stop, then /ops start');
		return running;
	}
	fs.mkdirSync(OPS_DIR, { recursive: true });
	const fd = fs.openSync(path.join(OPS_DIR, 'scheduler.log'), 'a', 0o600);
	let child;
	try {
		child = spawn(process.execPath, [path.join(__dirname, '../../daemon.cjs')], {
			detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, PI_OPS_DAEMON: '1' },
		});
	} finally { fs.closeSync(fd); }
	let spawnError;
	child.on('error', error => { spawnError = error; });
	child.unref();
	for (let attempt = 0; attempt < 40; attempt++) {
		await new Promise(resolve => setTimeout(resolve, 100));
		if (spawnError) throw spawnError;
		try { return await requestDaemon(); } catch { /* Wait for startup. */ }
		if (child.exitCode !== null) break;
	}
	throw new Error('Scheduler did not start; inspect scheduler.log (the configured port may be occupied)');
}
function brokerDesired() {
	const db = store.openSchedule();
	try { return db.prepare("SELECT value FROM meta WHERE key='broker_desired'").get()?.value !== '0'; }
	finally { db.close(); }
}
async function runWakeDaemon({service=false}={}) {
	let stopping = false, leader;
	const stop = () => { stopping = true; if (leader) void leader.close(); };
	process.on('SIGTERM', stop); process.on('SIGINT', stop);
	try {
		while (!stopping) {
			if(!brokerDesired()){if(!service)break;await new Promise(resolve=>setTimeout(resolve,1000));continue;}
			try {
				leader = await startDaemon(settings());
				await new Promise(resolve => leader.server.once('close', resolve));
				leader = undefined;
			} catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
			if (!stopping && brokerDesired()) await new Promise(resolve => setTimeout(resolve, 1000));
		}
	} finally { process.off('SIGTERM', stop); process.off('SIGINT', stop); }
}
module.exports = { settings, startDaemon, requestDaemon, launchDaemon, brokerDesired, runWakeDaemon };
