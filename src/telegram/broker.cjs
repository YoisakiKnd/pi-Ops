const { timingSafeEqual, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isPathInside } = require('../shared/paths.cjs');
const { projectFor } = require('../shared/project.cjs');
const { runAgent } = require('../schedule/agent.cjs');
const { validateAgent } = require('../schedule/agent-spec.cjs');
const state = require('./store.cjs');
const { createApi } = require('./api.cjs');
const { formatMarkdown, silent } = require('./format.cjs');
const { send, readLines } = require('./protocol.cjs');
const controls = require('./controls.cjs');
const { receiveFile, uploadFile } = require('./files.cjs');
const questions = require('./questions.cjs');
const {planClone,cloneRepository}=require('./clone.cjs');
const { parseNew, allowedCwd } = require('./remote.cjs');

function createBroker(db, settings, { api = createApi(settings), wake = runAgent, pollTimeout = 25 } = {}) {
	state.initialize(db); state.recover(db);
	db.exec("UPDATE tg_cards SET phase='Disconnected',dirty=1 WHERE phase!='Disconnected'");
	const auth = db.prepare("SELECT value FROM meta WHERE key='token'").get().value;
	const controller = new AbortController();
	const wakeControllers = new Map();
	let processingActions = false;
	const clients = new Map(), sockets = new Set(), streams = new Map(), active = new Set(), wakeIds = new Set();
	let stopping = false, pollTask, flushing = false;
	function track(promise) { active.add(promise); promise.finally(() => active.delete(promise)).catch(() => {}); return promise; }
	function error(error) { if (!stopping) process.stderr.write(`[pi-ops] ${String(error.message || error)}\n`); }
	function authenticate(value) {
		const left = Buffer.from(String(value || '')), right = Buffer.from(auth);
		return left.length === right.length && timingSafeEqual(left, right);
	}
	function attach(socket) {
		sockets.add(socket); let sessionId;
		const timer = setTimeout(() => socket.destroy(), 5000);
		socket.on('close', () => { clearTimeout(timer); sockets.delete(socket); if (clients.get(sessionId) === socket) { clients.delete(sessionId); if (!stopping) controls.setStatus(db, sessionId, 'Disconnected'); } });
		socket.on('error', () => {});
		readLines(socket, message => {
			if (!authenticate(message.auth) || stopping) { socket.destroy(); return; }
			if (message.type === 'register') {
				if (message.version !== 1) throw new Error('Bridge version mismatch');
				const session = state.register(db, message.session);
				if (sessionId && clients.get(sessionId) === socket) clients.delete(sessionId);
				sessionId = session.id; controls.setStatus(db, sessionId, 'Ready');
				const previous = clients.get(sessionId);
				clients.set(sessionId, socket);
				if (previous && previous !== socket) { send(previous, { type: 'superseded' }); previous.end(); }
				clearTimeout(timer); send(socket, { type: 'registered', version: 1, sessionId });
				deliver(sessionId); return;
			}
			if (!sessionId || clients.get(sessionId) !== socket || message.sessionId !== sessionId) throw new Error('Session registration required');
			if (message.type === 'question') {
				try { const row=questions.ask(db,sessionId,message); if(['answered','cancelled','expired','uncertain','failed'].includes(row.status))send(socket,{type:'questionResult',requestId:row.request_id,status:row.status,answer:row.answer?JSON.parse(row.answer):[]}); track(flush()).catch(error); }
				catch(failure){send(socket,{type:'questionResult',requestId:message.requestId,status:'failed',error:failure.message});} return;
			}
			if(message.type==='questionCancel'){db.prepare("UPDATE tg_questions SET status='cancelled',dirty=1 WHERE request_id=? AND session_id=? AND status IN ('pending','open','sending')").run(message.requestId,sessionId);send(socket,{type:'questionCancelAck',requestId:message.requestId});return;}
			if(message.type==='questionAck'){db.prepare('UPDATE tg_questions SET delivered=1 WHERE request_id=? AND session_id=?').run(message.requestId,sessionId);return;}
			if (message.type === 'status') {
				controls.setStatus(db, sessionId, message.phase, message.detail || '');
				if (['Ready', 'Stopped', 'Error'].includes(message.phase)) {
					for (const [key, draft] of streams) if (draft.sessionId === sessionId) streams.delete(key);
				}
				if (typeof message.prompt === 'string') db.prepare('UPDATE tg_sessions SET last_prompt=? WHERE id=?').run(message.prompt.slice(0,20000), sessionId);
				return;
			}
			if (message.type === 'file') {
				if (typeof message.key !== 'string' || message.key.length > 200) throw new Error('Invalid file key');
				try { state.enqueueFile(db, message.key, sessionId, message.path, message.caption); send(socket, { type:'fileResult', requestId:message.key, ok:true }); track(flush()).catch(error); }
				catch (failure) { send(socket, { type:'fileResult', requestId:message.key, ok:false, error:failure.message }); }
				return;
			}
			if (message.type === 'ack') {
				if (Number.isSafeInteger(message.updateId)) db.prepare("UPDATE tg_inbox SET status='delivered' WHERE update_id=? AND session_id=? AND status='queued'").run(message.updateId, sessionId);
				return;
			}
			if (message.type === 'final') {
				if (typeof message.key !== 'string' || message.key.length > 200) throw new Error('Invalid delivery key');
				state.enqueue(db, message.key, sessionId, message.text);
				streams.delete(`${sessionId}:${message.key}`);
				send(socket, { type: 'accepted', key: message.key });
				track(flush()).catch(error); return;
			}
			if (message.type === 'draft') {
				if (typeof message.key !== 'string' || typeof message.text !== 'string' || message.text.length > 100000) throw new Error('Invalid draft');
				if (streams.size < 256 || streams.has(`${sessionId}:${message.key}`)) streams.set(`${sessionId}:${message.key}`, { sessionId, key: message.key, text: message.text, dirty: true });
			}
		});
	}
	function deliver(id) {
		const socket = clients.get(id); if (!socket || socket.destroyed) return;
		for (const message of db.prepare("SELECT * FROM tg_inbox WHERE session_id=? AND status='queued' ORDER BY update_id LIMIT 100").all(id)) {
			send(socket, { type: message.text.trim() === '/stop' ? 'stop' : 'reply', sessionId: id, updateId: message.update_id, text: message.text });
		}
	}
	async function topic(id) {
		const session = state.getSession(db, id); if (!session) throw new Error('Unknown session');
		controls.ensureCard(db, id);
		if (session.topic_id) return session.topic_id;
		if (session.topic_state !== 'new') throw new Error(`Topic for ${id} needs reconciliation; use /ops tg bind`);
		db.prepare("UPDATE tg_sessions SET topic_state='creating' WHERE id=?").run(id);
		try {
			const result = await api('createForumTopic', { chat_id: settings.chatId, name: `${session.name} · ${id.slice(0, 8)}`.slice(0, 128) }, controller.signal);
			db.prepare("UPDATE tg_sessions SET topic_id=?,topic_state='ready' WHERE id=?").run(result.message_thread_id, id);
			return result.message_thread_id;
		} catch (failure) {
			db.prepare('UPDATE tg_sessions SET topic_state=? WHERE id=?').run(failure.code === 'uncertain' ? 'uncertain' : 'new', id);
			throw failure;
		}
	}
	async function flush() {
		if (flushing || stopping) return;
		flushing = true;
		try {
			for (const item of db.prepare("SELECT * FROM tg_outbox WHERE status='pending' AND next_at<=? ORDER BY rowid LIMIT 20").all(Date.now())) {
				try {
					const payload = item.payload ? JSON.parse(item.payload) : {};
					const threadId = item.kind === 'notice' ? payload.threadId : await topic(item.session_id);
					const upload = item.kind === 'file' ? uploadFile(state.getSession(db,item.session_id).cwd,payload.file) : null;
					db.prepare("UPDATE tg_outbox SET status='sending' WHERE key=?").run(item.key);
					// Each queued row is already one bounded Telegram chunk.
					const disable_notification = silent(settings, /^(incident:|wake-result:|action-error:)/.test(item.key), payload.continuation);
					const sent = upload
						? await api('sendDocument', { chat_id:settings.chatId, message_thread_id:threadId, caption:payload.caption, disable_notification }, controller.signal, upload)
						: await api('sendMessage', { chat_id:settings.chatId, ...(threadId ? {message_thread_id:threadId} : {}), text:item.text || '(empty response)', entities:payload.entities || [], disable_notification, link_preview_options:{is_disabled:true} }, controller.signal);
					db.prepare("UPDATE tg_outbox SET status='sent',message_id=?,error=NULL WHERE key=?").run(sent.message_id, item.key);
				} catch (failure) {
					const retry = failure.code === 429;
					db.prepare('UPDATE tg_outbox SET status=?,error=?,next_at=? WHERE key=?').run(retry ? 'pending' : failure.code === 'uncertain' ? 'uncertain' : 'failed', failure.message,
						Date.now() + Math.max(1, Number(failure.retryAfter) || 5) * 1000, item.key);
				}
			}
			for (const [key, draft] of streams) {
				if (!draft.dirty) continue;
				draft.dirty = false;
				try {
					const threadId = await topic(draft.sessionId);
					// Telegram draft IDs are stable positive integers for this stream.
					const { createHash } = require('node:crypto');
					const draftId = createHash('sha256').update(key).digest().readUInt32BE(0) || 1;
					const formatted = formatMarkdown(draft.text, 1700).at(-1);
					await api('sendMessageDraft', { chat_id: settings.chatId, message_thread_id: threadId, draft_id: draftId, ...formatted, text:formatted.text || 'Working…' }, controller.signal);
				} catch { /* Drafts are best effort; the final answer is durable. */ }
			}
			await controls.flushCards(db, settings, api, controller.signal);
			await questions.flush(db,settings,api,topic,controller.signal);
		} finally { flushing = false; }
	}
	async function wakePending() {
		if (!settings.wakeMode || stopping) return;
		for (const item of db.prepare("SELECT * FROM tg_inbox WHERE status='queued' ORDER BY update_id LIMIT 100").all()) {
			if (wakeIds.size >= 2) break;
			if (clients.has(item.session_id) || wakeIds.has(item.session_id)) continue;
			const session = state.getSession(db, item.session_id);
			try {
				const remote = db.prepare('SELECT started FROM tg_remote WHERE session_id=?').get(session.id);
				const fresh = remote && !remote.started && (!session.session_file || !fs.existsSync(session.session_file));
				if (!fresh && (!session.session_file || !fs.existsSync(session.session_file) || !fs.statSync(session.session_file).isFile())) continue;
				const cwd = fs.realpathSync(session.cwd);
				if (!settings.wakeAllowedRoots.some(root => isPathInside(fs.realpathSync(root), cwd))) continue;
				if (item.text.trim() === '/stop') { db.prepare("UPDATE tg_inbox SET status='delivered' WHERE update_id=?").run(item.update_id); continue; }
				db.prepare("UPDATE tg_inbox SET status='waking' WHERE update_id=?").run(item.update_id);
				wakeIds.add(session.id);
				const wakeController = new AbortController(); wakeControllers.set(session.id, wakeController);
				const spec = validateAgent({ prompt: item.text, timeoutMs: settings.wakeTimeoutMs });
				track(wake({ ...spec, id: session.id, name: session.name, cwd, project_id: projectFor(cwd).id, resumeSessionFile: fresh ? undefined : session.session_file, newSessionId: fresh ? session.id : undefined, wake: true }, {
					runId: `telegram-${item.update_id}`, signal: AbortSignal.any([controller.signal,wakeController.signal]),
					onProgress: progress => { if(progress.sessionId === session.id && progress.sessionFile) db.prepare('UPDATE tg_sessions SET session_file=? WHERE id=?').run(progress.sessionFile,session.id); },
				}).then(result => {
					if (result.status !== 'success') state.enqueue(db,`wake-result:${item.update_id}`,session.id,`Background Pi did not complete (${result.status}). ${String(result.summary || 'Inspect the saved session before retrying.').slice(0,1500)}`);
					const saved = state.getSession(db,session.id).session_file;
					if (saved && fs.existsSync(saved)) db.prepare('UPDATE tg_remote SET started=1 WHERE session_id=?').run(session.id);
					db.prepare('UPDATE tg_inbox SET status=? WHERE update_id=?').run(result.status === 'success' ? 'delivered' : 'uncertain', item.update_id);
				}).catch(failure => {
					db.prepare("UPDATE tg_inbox SET status='uncertain' WHERE update_id=?").run(item.update_id); error(failure);
				}).finally(() => { wakeIds.delete(session.id); wakeControllers.delete(session.id); }));
			} catch (failure) { error(failure); }
		}
	}
	async function processActions() {
		if (processingActions || stopping) return;
		processingActions = true;
		try {
			for (const action of db.prepare("SELECT * FROM tg_actions WHERE status='pending' ORDER BY update_id LIMIT 20").all()) {
				db.prepare("UPDATE tg_actions SET status='processing' WHERE update_id=?").run(action.update_id);
				const payload = JSON.parse(action.payload);
				try {
					if (action.kind === 'callback') {
						if(String(payload.data).startsWith('q:')) { questions.answer(db,payload,settings); try{await api('answerCallbackQuery',{callback_query_id:payload.id,text:'Recorded'},controller.signal);}catch{} } else {
						const target = controls.callbackSession(db,payload,settings);
						if (!target) throw new Error('Expired or invalid session control');
						if (target.action === 'refresh') db.prepare('UPDATE tg_cards SET dirty=1 WHERE session_id=?').run(target.sessionId);
						else {
							const session = state.getSession(db,target.sessionId);
							const text = target.action === 'stop' ? '/stop' : target.action === 'continue' ? 'Continue the previous task and report progress.' : session.last_prompt;
							if (!text) throw new Error('No previous prompt is available to retry');
							if (target.action === 'stop') wakeControllers.get(target.sessionId)?.abort();
							db.prepare("INSERT OR IGNORE INTO tg_inbox(update_id,session_id,text,created_at) VALUES(?,?,?,?)").run(action.update_id,target.sessionId,text,Date.now());
						}
						try { await api('answerCallbackQuery',{callback_query_id:payload.id,text:'Accepted'},controller.signal); } catch { /* ephemeral acknowledgement */ }
					}
					} else if (action.kind === 'attachment') {
						const session = state.getSession(db,payload.sessionId);
						const text = await receiveFile(api,session,action.update_id,payload,controller.signal);
						db.prepare("INSERT OR IGNORE INTO tg_inbox(update_id,session_id,text,created_at) VALUES(?,?,?,?)").run(action.update_id,session.id,text,Date.now());
					} else if (action.kind === 'remote') {
						let request = parseNew(payload.text);
						if(/^\/clone(?:@\w+)?(?:\s|$)/i.test(payload.text)){
							const plan=planClone(payload.text,settings); await cloneRepository(plan,{signal:controller.signal}); request={folder:plan.destination,prompt:''};
						}
						if (request) {
							const cwd = allowedCwd(request.folder,settings), project = projectFor(cwd);
							const id = action.result || randomUUID();
							db.prepare('UPDATE tg_actions SET result=? WHERE update_id=?').run(id,action.update_id);
							state.register(db,{id,cwd,name:path.basename(cwd),projectId:project.id});
							db.prepare('INSERT OR IGNORE INTO tg_remote(session_id,update_id) VALUES(?,?)').run(id,action.update_id);
							await topic(id);
							if (!request.prompt) state.enqueue(db,`new:${action.update_id}`,id,'Remote Pi session ready. Reply in this topic to start working.');
							if (request.prompt) db.prepare("INSERT OR IGNORE INTO tg_inbox(update_id,session_id,text,created_at) VALUES(?,?,?,?)").run(action.update_id,id,request.prompt,Date.now());
							state.notice(db,`command:${action.update_id}`,`Created Pi session ${id} for ${cwd}. Open its topic to continue.`);
						} else if (/^\/sessions(?:@\w+)?(?:\s|$)/i.test(payload.text)) {
							const list = db.prepare('SELECT id,name,topic_id FROM tg_sessions ORDER BY rowid DESC LIMIT 30').all();
							state.notice(db,`command:${action.update_id}`,list.map(row=>`${row.name} · ${row.id} · topic ${row.topic_id || 'pending'}`).join('\n') || 'No sessions yet.');
						} else state.notice(db,`command:${action.update_id}`,`Pi Ops: ${clients.size} connected sessions, ${wakeIds.size} wake workers.\n/new <folder> | <prompt>\n/sessions\n/status\n/help`);
					}
					db.prepare("UPDATE tg_actions SET status='done' WHERE update_id=?").run(action.update_id);
				} catch (failure) {
					db.prepare('UPDATE tg_actions SET status=?,error=? WHERE update_id=?').run(failure.code === 'uncertain' ? 'uncertain':'failed',failure.message,action.update_id);
					if (action.kind === 'callback') { try { await api('answerCallbackQuery',{callback_query_id:payload.id,text:String(failure.message).slice(0,180),show_alert:true},controller.signal); } catch {} }
					else state.notice(db,`action-error:${action.update_id}`,failure.message,payload.message_thread_id);
				}
			}
		} finally { processingActions = false; }
	}
	async function step(updates) {
		for (const update of updates) state.ingest(db, update, settings);
		await processActions();
		for (const id of clients.keys()) deliver(id);
		for (const note of db.prepare(`SELECT n.*, (SELECT id FROM tg_sessions WHERE project_id=n.project_id ORDER BY rowid DESC LIMIT 1) AS target
		 FROM notifications n WHERE EXISTS(SELECT 1 FROM tg_sessions WHERE project_id=n.project_id)
		 AND NOT EXISTS(SELECT 1 FROM tg_outbox WHERE key='incident:' || n.id || ':0') ORDER BY n.id LIMIT 100`).all()) {
			state.enqueue(db, `incident:${note.id}`, note.target, note.message);
		}
		for(const row of db.prepare("SELECT * FROM tg_questions WHERE delivered=0 AND status IN ('answered','cancelled','expired','uncertain','failed') LIMIT 100").all()){
			const socket=clients.get(row.session_id);if(socket&&!socket.destroyed)send(socket,{type:'questionResult',requestId:row.request_id,status:row.status,answer:row.answer?JSON.parse(row.answer):[]});
		}
		await wakePending(); await flush();
	}
	async function poll() {
		while (!stopping) {
			try {
				const offset = Number(db.prepare("SELECT value FROM tg_meta WHERE key='offset'").get().value);
				const updates = await api('getUpdates', { offset, timeout: pollTimeout, allowed_updates: ['message','callback_query'] }, controller.signal);
				await step(updates);
			} catch (failure) {
				error(failure);
				if (!stopping) await new Promise(resolve => {
					const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
					const retryMs = Number(failure.retryAfter);
					const delay = Number.isFinite(retryMs) ? Math.min(60000, Math.max(1000, retryMs * 1000)) : 1000;
					const timer = setTimeout(done, delay); controller.signal.addEventListener('abort', done, { once: true });
				});
			}
		}
	}
	const timer = setInterval(() => { if (!stopping) track(step([])).catch(error); }, 1500);
	timer.unref();
	return { attach, step, topic, flush, clients, start() { pollTask ||= poll(); }, async close() {
		stopping = true; clearInterval(timer); controller.abort();
		for (const socket of sockets) socket.destroy();
		await pollTask; await Promise.allSettled([...active]);
	} };
}
module.exports = { createBroker };
