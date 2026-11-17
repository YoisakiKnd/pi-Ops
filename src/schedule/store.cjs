const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { OPS_DIR } = require('../shared/paths.cjs');
const { validateHttp } = require('./probe.cjs');
const { validateAgent } = require('./agent-spec.cjs');

function openSchedule(file = path.join(OPS_DIR, 'schedule.db')) {
	const { DatabaseSync } = require('node:sqlite');
	fs.mkdirSync(path.dirname(file), { recursive: true });
	if (file !== ':memory:') {
		try { fs.closeSync(fs.openSync(file, 'wx', 0o600)); }
		catch (error) { if (error.code !== 'EEXIST') throw error; }
		fs.chmodSync(file, 0o600);
	}
	const db = new DatabaseSync(file);
	try {
		db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
		CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS tasks(
		 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, cwd TEXT NOT NULL, name TEXT NOT NULL,
		 spec TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, blocked INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL,
		 failures INTEGER NOT NULL DEFAULT 0, incident_id TEXT, created_at INTEGER NOT NULL);
		CREATE TABLE IF NOT EXISTS runs(
		 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), scheduled_at INTEGER NOT NULL,
		 started_at INTEGER, finished_at INTEGER, status TEXT NOT NULL, result TEXT, owner TEXT);
		CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id, scheduled_at DESC);
		CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs(task_id) WHERE status='running';
		CREATE TABLE IF NOT EXISTS incidents(
		 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), opened_at INTEGER NOT NULL,
		 closed_at INTEGER, opening_run TEXT NOT NULL, closing_run TEXT);
		CREATE TABLE IF NOT EXISTS notifications(
		 id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id TEXT NOT NULL REFERENCES incidents(id),
		 project_id TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL, message TEXT NOT NULL,
		 UNIQUE(incident_id, kind));`);
		if (file !== ':memory:') fs.chmodSync(file, 0o600);
		atomic(db, () => {
			if (!db.prepare('PRAGMA table_info(tasks)').all().some(column => column.name === 'blocked')) {
				db.exec('ALTER TABLE tasks ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0');
			}
		});
		db.prepare('INSERT OR IGNORE INTO meta VALUES (?, ?)').run('token', randomBytes(32).toString('hex'));
		return db;
	} catch (error) { db.close(); throw error; }
}
function atomic(db, fn) {
	db.exec('BEGIN IMMEDIATE');
	try { const result = fn(); db.exec('COMMIT'); return result; }
	catch (error) { db.exec('ROLLBACK'); throw error; }
}
function taskFrom(row) {
	return row && { kind: 'http', ...row, ...JSON.parse(row.spec), enabled: Boolean(row.enabled), blocked: Boolean(row.blocked) };
}
function getTask(db, id) { return taskFrom(db.prepare('SELECT * FROM tasks WHERE id=?').get(id)); }
function listTasks(db, projectId) {
	return (projectId ? db.prepare('SELECT * FROM tasks WHERE project_id=? ORDER BY created_at, id').all(projectId)
		: db.prepare('SELECT * FROM tasks ORDER BY created_at, id').all()).map(taskFrom);
}
function addTask(db, input, now = Date.now()) {
	if (input.kind && !['http', 'agent'].includes(input.kind)) throw new Error('Unknown task kind');
	const spec = input.kind === 'agent' ? validateAgent(input) : { kind: 'http', ...validateHttp(input) };
	if (!input.project?.id || !input.project?.root) throw new Error('Task requires a project');
	const name = String(input.name || (spec.kind === 'agent' ? 'Pi Agent task' : 'HTTP check')).trim();
	if (!name || name.length > 200) throw new Error('Task name must be 1–200 characters');
	const id = randomUUID();
	db.prepare('INSERT INTO tasks(id,project_id,cwd,name,spec,next_at,created_at) VALUES(?,?,?,?,?,?,?)')
		.run(id, input.project.id, input.project.root, name, JSON.stringify(spec), now + spec.intervalMs, now);
	return getTask(db, id);
}
function setEnabled(db, id, enabled, now = Date.now()) {
	return atomic(db, () => {
		const task = getTask(db, id);
		if (!task) throw new Error(`Unknown task: ${id}`);
		db.prepare('UPDATE tasks SET enabled=?,next_at=?,failures=0,blocked=CASE WHEN ?=1 THEN 0 ELSE blocked END WHERE id=?')
			.run(enabled ? 1 : 0, now + task.intervalMs, enabled ? 1 : 0, id);
		return getTask(db, id);
	});
}
function claim(db, id, owner, now = Date.now(), { manual = false, graceMs = 600_000 } = {}) {
	return atomic(db, () => {
		const task = getTask(db, id);
		if (!task) throw new Error(`Unknown task: ${id}`);
		if (task.blocked) {
			if (manual) throw new Error('Agent task needs reconciliation after an interrupted run; inspect history, then resume it');
			return null;
		}
		if ((!manual && (!task.enabled || task.next_at > now)) || db.prepare("SELECT 1 FROM runs WHERE task_id=? AND status='running'").get(id)) return null;
		const skipped = !manual && now - task.next_at > graceMs;
		const run = { id: randomUUID(), task_id: id, scheduled_at: manual ? now : task.next_at,
			started_at: skipped ? null : now, status: skipped ? 'skipped' : 'running', owner };
		db.prepare('INSERT INTO runs(id,task_id,scheduled_at,started_at,finished_at,status,result,owner) VALUES(?,?,?,?,?,?,?,?)')
			.run(run.id, id, run.scheduled_at, run.started_at, skipped ? now : null, run.status,
				skipped ? JSON.stringify({ summary: 'Missed run exceeded grace period' }) : null, owner);
		// Keep the interval anchored to its previous due time. Collapse backlog to one run.
		if (!manual) db.prepare('UPDATE tasks SET next_at=? WHERE id=?').run(task.next_at + (Math.floor((now - task.next_at) / task.intervalMs) + 1) * task.intervalMs, id);
		if (skipped) db.prepare('UPDATE tasks SET failures=0 WHERE id=?').run(id);
		return { ...run, task };
	});
}
function finish(db, run, result, now = Date.now()) {
	if (!['success', 'failure', 'timeout', 'unknown'].includes(result.status)) throw new Error('Invalid run result');
	return atomic(db, () => {
		const updated = db.prepare("UPDATE runs SET status=?,finished_at=?,result=? WHERE id=? AND owner=? AND status='running'")
			.run(result.status, now, JSON.stringify(result), run.id, run.owner);
		if (!updated.changes) return false;
		const task = getTask(db, run.task_id);
		// Agent execution success is separate from the observed environment outcome.
		const observed = task.kind === 'agent'
			? result.status === 'success' ? ({ healthy: 'success', degraded: 'failure' }[result.outcome] || 'unknown') : 'unknown'
			: result.status;
		const failures = ['failure', 'timeout'].includes(observed) ? task.failures + 1 : 0;
		if (task.kind === 'agent' && result.status !== 'success') db.prepare('UPDATE tasks SET enabled=0,blocked=1 WHERE id=?').run(task.id);
		let incidentId = task.incident_id;
		if (failures >= task.failureThreshold && !incidentId) {
			incidentId = randomUUID();
			db.prepare('INSERT INTO incidents(id,task_id,opened_at,opening_run) VALUES(?,?,?,?)').run(incidentId, task.id, now, run.id);
			notify('opened', `ALERT ${task.name}: ${failures} consecutive failures. ${result.summary}`);
		} else if (observed === 'success' && incidentId) {
			db.prepare('UPDATE incidents SET closed_at=?,closing_run=? WHERE id=?').run(now, run.id, incidentId);
			notify('recovered', `RECOVERED ${task.name}: ${result.summary}`);
			incidentId = null;
		}
		function notify(kind, message) {
			db.prepare('INSERT OR IGNORE INTO notifications(incident_id,project_id,kind,created_at,message) VALUES(?,?,?,?,?)')
				.run(incidentId, task.project_id, kind, now, message);
		}
		db.prepare('UPDATE tasks SET failures=?,incident_id=? WHERE id=?').run(failures, incidentId, task.id);
		return true;
	});
}
function recordProgress(db, run, progress) {
	db.prepare("UPDATE runs SET result=? WHERE id=? AND owner=? AND status='running'")
		.run(JSON.stringify(progress), run.id, run.owner);
}
// Called only after acquiring the singleton socket. Interrupted Agent tasks remain
// blocked until the user reconciles their effects and explicitly resumes them.
function recover(db, now = Date.now()) {
	return atomic(db, () => {
		const unfinished = db.prepare("SELECT r.*, t.spec FROM runs r JOIN tasks t ON r.task_id=t.id WHERE r.status='running'").all();
		db.prepare("UPDATE tasks SET failures=0 WHERE id IN (SELECT task_id FROM runs WHERE status='running')").run();
		for (const run of unfinished) {
			if (JSON.parse(run.spec).kind === 'agent') db.prepare('UPDATE tasks SET enabled=0,blocked=1 WHERE id=?').run(run.task_id);
			db.prepare("UPDATE runs SET status='unknown',finished_at=?,result=? WHERE id=?")
				.run(now, JSON.stringify({ ...JSON.parse(run.result || '{}'), summary: 'Scheduler stopped before recording a result' }), run.id);
		}
		return unfinished.length;
	});
}
function history(db, id, limit = 20) {
	return db.prepare('SELECT * FROM runs WHERE task_id=? ORDER BY scheduled_at DESC,rowid DESC LIMIT ?').all(id, limit)
		.map(row => ({ ...row, result: row.result ? JSON.parse(row.result) : null }));
}
function notifications(db, projectId, after = 0) {
	return db.prepare('SELECT * FROM notifications WHERE project_id=? AND id>? ORDER BY id LIMIT 100').all(projectId, after);
}
module.exports = { openSchedule, getTask, listTasks, addTask, setEnabled, claim, finish, recover, recordProgress, history, notifications };
