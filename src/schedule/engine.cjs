const { randomUUID } = require('node:crypto');
const store = require('./store.cjs');
const { checkHttp } = require('./probe.cjs');
const { runAgent } = require('./agent.cjs');

function createEngine(db, { probe = checkHttp, agent = runAgent, now = Date.now, graceMs = 600_000, maxConcurrent = 4, onNotification = () => {} } = {}) {
	const owner = randomUUID();
	const active = new Map();
	const controller = new AbortController();
	let stopped = false;
	let ticking = false;
	async function run(id, manual = false) {
		if (stopped) throw new Error('Scheduler is stopping');
		if (active.size >= maxConcurrent) throw new Error('Scheduler concurrency limit reached');
		const claimed = store.claim(db, id, owner, now(), { manual, graceMs });
		if (!claimed) return null;
		if (claimed.status === 'skipped') return claimed;
		const work = (async () => {
			let result;
			try {
				const execute = claimed.task.kind === 'agent' ? agent : probe;
				result = await execute(claimed.task, { signal: controller.signal, runId: claimed.id,
					onProgress: progress => store.recordProgress(db, claimed, progress),
				});
			}
			catch (error) { result = { status: 'unknown', summary: String(error.message || error).slice(0, 1000) }; }
			if (store.finish(db, claimed, result, now())) {
				const notes = db.prepare(`SELECT n.* FROM notifications n JOIN incidents i ON n.incident_id=i.id
				 WHERE (n.kind='opened' AND i.opening_run=?) OR (n.kind='recovered' AND i.closing_run=?)`).all(claimed.id, claimed.id);
				for (const note of notes) onNotification(note);
			}
			return { ...claimed, status: result.status, result };
		})();
		active.set(id, work);
		try { return await work; } finally { active.delete(id); }
	}
	async function tick() {
		if (stopped || ticking) return;
		ticking = true;
		try {
			const due = store.listTasks(db).filter(task => task.enabled && !task.blocked && task.next_at <= now() && !active.has(task.id));
			const selected = due.slice(0, Math.max(0, maxConcurrent - active.size));
			await Promise.all(selected.map(task => run(task.id)));
		} finally { ticking = false; }
	}
	async function stop() {
		stopped = true;
		controller.abort();
		await Promise.allSettled([...active.values()]);
	}
	return { run, tick, stop, owner, get activeCount() { return active.size; } };
}
module.exports = { createEngine };
