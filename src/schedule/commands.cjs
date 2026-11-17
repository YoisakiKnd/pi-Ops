const store = require('./store.cjs');
const { projectFor } = require('../shared/project.cjs');
const runtime = require('./runtime.cjs');

const HELP = [
	'ops start | stop | status',
	'ops agent-add <name> <interval-seconds> <prompt...>',
	'ops tg [status|bind <session-id> <topic-id>|retry <outbox-key>]',
	'ops add <name> <http(s)://url> [interval-seconds=300] [timeout-seconds=10] [expected-status=200]',
	'ops list | pause <id> | resume <id> | run <id> | history <id> | events',
	'Tasks and events are scoped to the current project. Foreground daemon: node daemon.cjs',
].join('\n');
async function command(args, cwd = process.cwd()) {
	const [action, ...rest] = args;
	if (!action || action === 'help') return HELP;
	if (action === 'start') return JSON.stringify(await runtime.launchDaemon(), null, 2);
	if (action === 'stop') return JSON.stringify(await runtime.requestDaemon('/stop', { method: 'POST' }));
	if (action === 'status') return JSON.stringify(await runtime.requestDaemon(), null, 2);
	const project = projectFor(cwd);
	const db = store.openSchedule();
	try {
		if (action === 'tg') {
			require('../telegram/store.cjs').initialize(db);
			if (!rest[0] || rest[0] === 'status') return JSON.stringify({
				sessions: db.prepare('SELECT * FROM tg_sessions WHERE project_id=?').all(project.id),
				pending: db.prepare("SELECT i.* FROM tg_inbox i JOIN tg_sessions s ON i.session_id=s.id WHERE s.project_id=? AND i.status!='delivered'").all(project.id),
				outbox: db.prepare("SELECT o.* FROM tg_outbox o JOIN tg_sessions s ON o.session_id=s.id WHERE s.project_id=? AND o.status!='sent'").all(project.id),
				cards: db.prepare('SELECT c.* FROM tg_cards c JOIN tg_sessions s ON c.session_id=s.id WHERE s.project_id=?').all(project.id),
				questions: db.prepare('SELECT q.* FROM tg_questions q JOIN tg_sessions s ON q.session_id=s.id WHERE s.project_id=? ORDER BY q.rowid DESC LIMIT 50').all(project.id),
				actions: db.prepare("SELECT update_id,kind,status,error,result FROM tg_actions WHERE status!='done' ORDER BY update_id DESC LIMIT 50").all(),
			}, null, 2);
			const session = db.prepare('SELECT * FROM tg_sessions WHERE id=? AND project_id=?').get(rest[1], project.id);
			if (rest[0] === 'card-bind' && session && Number.isSafeInteger(Number(rest[2])) && Number(rest[2]) > 0) {
				require('../telegram/controls.cjs').ensureCard(db,session.id);
				db.prepare("UPDATE tg_cards SET message_id=?,status='ready',dirty=1,pinned=0,next_at=0 WHERE session_id=?").run(Number(rest[2]),session.id);
				return 'Status card mapping updated';
			}
			if (rest[0] === 'bind' && session && Number.isSafeInteger(Number(rest[2])) && Number(rest[2]) > 0) {
				db.prepare("UPDATE tg_sessions SET topic_id=?,topic_state='ready' WHERE id=?").run(Number(rest[2]), session.id);
				db.prepare("UPDATE tg_outbox SET status='pending',next_at=0 WHERE session_id=? AND status='failed'").run(session.id);
				return 'Topic mapping updated';
			}
			if (rest[0] === 'retry') {
				const item = db.prepare('SELECT o.key FROM tg_outbox o JOIN tg_sessions s ON o.session_id=s.id WHERE o.key=? AND s.project_id=?').get(rest[1], project.id);
				if (item) { db.prepare("UPDATE tg_outbox SET status='pending',next_at=0 WHERE key=? AND status IN ('uncertain','failed')").run(item.key); return 'Explicit retry queued; inspect Telegram for duplicates'; }
			}
			throw new Error('Usage: /ops tg [status|bind <session-id> <topic-id>|retry <outbox-key>]');
		}
		const requireTask = () => {
			const task = store.getTask(db, rest[0]);
			if (!task || task.project_id !== project.id) throw new Error('Task not found in the current project');
			return task;
		};
		if (action === 'add') {
			if (!rest[0] || !rest[1] || rest.length > 5) throw new Error(HELP);
			return JSON.stringify(store.addTask(db, { project, name: rest[0], url: rest[1],
				intervalMs: Number(rest[2] ?? 300) * 1000, timeoutMs: Number(rest[3] ?? 10) * 1000,
				expectedStatus: Number(rest[4] ?? 200) }), null, 2);
		}
		if (action === 'agent-add') {
			if (rest.length < 3) throw new Error(HELP);
			return JSON.stringify(store.addTask(db, { kind: 'agent', project, name: rest[0],
				intervalMs: Number(rest[1]) * 1000, prompt: rest.slice(2).join(' '),
			}), null, 2);
		}
		if (action === 'list') return JSON.stringify(store.listTasks(db, project.id), null, 2);
		if (action === 'events') return JSON.stringify(db.prepare('SELECT n.*,i.opened_at,i.closed_at FROM notifications n JOIN incidents i ON i.id=n.incident_id WHERE n.project_id=? ORDER BY n.id DESC LIMIT 100').all(project.id), null, 2);
		if (['pause', 'resume'].includes(action)) {
			const task = requireTask();
			return JSON.stringify(store.setEnabled(db, task.id, action === 'resume'), null, 2);
		}
		if (action === 'history') return JSON.stringify(store.history(db, requireTask().id), null, 2);
		if (action === 'run') {
			const task = requireTask();
			return JSON.stringify(await runtime.requestDaemon(`/run?id=${encodeURIComponent(task.id)}`, {
				method: 'POST', timeoutMs: task.timeoutMs + 5000,
			}), null, 2);
		}
		throw new Error(HELP);
	} finally { db.close(); }
}
module.exports = { command, HELP };
