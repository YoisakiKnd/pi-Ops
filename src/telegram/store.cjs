// Tables share schedule.db so one leader owns both scheduling and TG delivery.
function initialize(db) {
	db.exec(`CREATE TABLE IF NOT EXISTS tg_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
	CREATE TABLE IF NOT EXISTS tg_sessions(id TEXT PRIMARY KEY,cwd TEXT NOT NULL,name TEXT NOT NULL,
	 session_file TEXT,project_id TEXT,topic_id INTEGER UNIQUE,topic_state TEXT NOT NULL DEFAULT 'new');
	CREATE TABLE IF NOT EXISTS tg_inbox(update_id INTEGER PRIMARY KEY,session_id TEXT NOT NULL,
	 text TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',created_at INTEGER NOT NULL);
	CREATE TABLE IF NOT EXISTS tg_outbox(key TEXT PRIMARY KEY,session_id TEXT NOT NULL,text TEXT NOT NULL,
	 status TEXT NOT NULL DEFAULT 'pending',message_id INTEGER,error TEXT,next_at INTEGER NOT NULL DEFAULT 0);
	INSERT OR IGNORE INTO tg_meta VALUES('offset','0');`);
	atomic(db, () => {
		for (const [table, column, definition] of [
			['tg_sessions', 'last_prompt', 'TEXT'], ['tg_outbox', 'kind', "TEXT NOT NULL DEFAULT 'text'"], ['tg_outbox', 'payload', 'TEXT'],
		]) if (!db.prepare(`PRAGMA table_info(${table})`).all().some(item => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
		db.exec(`CREATE TABLE IF NOT EXISTS tg_cards(session_id TEXT PRIMARY KEY,token TEXT UNIQUE NOT NULL,message_id INTEGER,
		 status TEXT NOT NULL DEFAULT 'new',phase TEXT NOT NULL DEFAULT 'Ready',detail TEXT NOT NULL DEFAULT '',dirty INTEGER NOT NULL DEFAULT 1,
		 pinned INTEGER NOT NULL DEFAULT 0,error TEXT,next_at INTEGER NOT NULL DEFAULT 0);
		 CREATE TABLE IF NOT EXISTS tg_actions(update_id INTEGER PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',error TEXT,result TEXT);
		 CREATE TABLE IF NOT EXISTS tg_remote(session_id TEXT PRIMARY KEY,update_id INTEGER UNIQUE NOT NULL);`);
		if (!db.prepare('PRAGMA table_info(tg_remote)').all().some(item => item.name === 'started')) db.exec('ALTER TABLE tg_remote ADD COLUMN started INTEGER NOT NULL DEFAULT 0');
	});
	require('./questions.cjs').initialize(db);
}
function atomic(db, fn) {
	db.exec('BEGIN IMMEDIATE');
	try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
}
function register(db, session) {
	if (!session || typeof session.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(session.id) ||
		typeof session.cwd !== 'string' || !session.cwd || typeof session.projectId !== 'string' ||
		(session.sessionFile != null && typeof session.sessionFile !== 'string')) throw new Error('Invalid session registration');
	db.prepare(`INSERT INTO tg_sessions(id,cwd,name,session_file,project_id) VALUES(?,?,?,?,?)
	 ON CONFLICT(id) DO UPDATE SET cwd=excluded.cwd,name=excluded.name,session_file=excluded.session_file,project_id=excluded.project_id`)
		.run(session.id, session.cwd, String(session.name || session.id).slice(0, 100), session.sessionFile || null, session.projectId);
	return getSession(db, session.id);
}
function getSession(db, id) { return db.prepare('SELECT * FROM tg_sessions WHERE id=?').get(id); }
function enqueue(db, key, id, text) {
	if (!getSession(db, id)) throw new Error('Unknown session');
	if (typeof text !== 'string' || text.length > 100000) throw new Error('Invalid outgoing text');
	const chunks = []; let chunk = '';
	for (const char of text) {
		if (chunk.length + char.length > 3500) { chunks.push(chunk); chunk = ''; }
		chunk += char;
	}
	chunks.push(chunk);
	for (const [index, part] of chunks.entries()) {
		db.prepare('INSERT OR IGNORE INTO tg_outbox(key,session_id,text) VALUES(?,?,?)').run(`${key}:${index}`, id, part);
	}
}
function ingest(db, update, settings) {
	return atomic(db, () => {
		const offset = Number(db.prepare("SELECT value FROM tg_meta WHERE key='offset'").get().value);
		if (!Number.isSafeInteger(update.update_id) || update.update_id < offset) return false;
		const message = update.message;
		if (update.callback_query?.from?.id === settings.allowedUserId && !update.callback_query.from.is_bot && update.callback_query.message?.chat?.id === settings.chatId) {
			db.prepare("INSERT OR IGNORE INTO tg_actions(update_id,kind,payload) VALUES(?,'callback',?)").run(update.update_id, JSON.stringify(update.callback_query));
		}
		if (message?.chat?.id === settings.chatId && message?.from?.id === settings.allowedUserId && !message.from.is_bot) {
			const session = db.prepare('SELECT id FROM tg_sessions WHERE topic_id=?').get(message.message_thread_id ?? -1);
			if (session && (message.document || message.photo?.length)) {
				db.prepare("INSERT OR IGNORE INTO tg_actions(update_id,kind,payload) VALUES(?,'attachment',?)").run(update.update_id, JSON.stringify({ sessionId: session.id, ...message }));
			} else if (!session && typeof message.text === 'string' && message.text.length <= 20000 && /^\/(new|clone|sessions|status|help)(?:@\w+)?(?:\s|$)/i.test(message.text)) {
				db.prepare("INSERT OR IGNORE INTO tg_actions(update_id,kind,payload) VALUES(?,'remote',?)").run(update.update_id, JSON.stringify(message));
			} else if (session && typeof message.text === 'string' && message.text.length <= 20000) db.prepare('INSERT OR IGNORE INTO tg_inbox(update_id,session_id,text,created_at) VALUES(?,?,?,?)')
				.run(update.update_id, session.id, message.text, Date.now());
		}
		db.prepare("UPDATE tg_meta SET value=? WHERE key='offset'").run(String(update.update_id + 1));
		return true;
	});
}
function recover(db) {
	db.exec("UPDATE tg_questions SET status='uncertain',error='Broker stopped during question send' WHERE status='sending'");
	db.exec("UPDATE tg_inbox SET status='uncertain' WHERE status='waking'; UPDATE tg_outbox SET status='uncertain',error='Broker stopped during send; inspect Telegram before retrying' WHERE status='sending'; UPDATE tg_sessions SET topic_state='uncertain' WHERE topic_state='creating';");
	db.exec("UPDATE tg_cards SET status='uncertain' WHERE status='sending'; UPDATE tg_actions SET status='uncertain',error='Broker stopped during action' WHERE status='processing';");
}
function notice(db, key, text, threadId = null) {
	db.prepare("INSERT OR IGNORE INTO tg_outbox(key,session_id,text,kind,payload) VALUES(?,'',?,'notice',?)").run(key, String(text).slice(0,3500), JSON.stringify({ threadId }));
}
function enqueueFile(db, key, id, filePath, caption = '') {
	const session = getSession(db, id); if (!session) throw new Error('Unknown session');
	const file = require('./files.cjs').fileInside(session.cwd, filePath);
	if (require('node:fs').statSync(file).size > require('./files.cjs').MAX_UPLOAD) throw new Error('File upload exceeds 50 MiB');
	if (typeof caption !== 'string' || caption.length > 1024) throw new Error('Caption must not exceed 1024 characters');
	db.prepare("INSERT OR IGNORE INTO tg_outbox(key,session_id,text,kind,payload) VALUES(?,?,'','file',?)").run(key, id, JSON.stringify({ file, caption }));
}
module.exports = { initialize, atomic, register, getSession, enqueue, enqueueFile, notice, ingest, recover };
