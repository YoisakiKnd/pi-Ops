const net = require('node:net');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { send, readLines } = require('./protocol.cjs');
const { readTelegram } = require('./settings.cjs');
const { projectFor } = require('../shared/project.cjs');
const schedule = require('../schedule/store.cjs');
const sessions = new Map();

function createClient(pi, ctx, { connect = net.createConnection, recover = ensureLeader } = {}) {
	const db = schedule.openSchedule(); let auth;
	try { auth = db.prepare("SELECT value FROM meta WHERE key='token'").get().value; } finally { db.close(); }
	const id = ctx.sessionManager.getSessionId();
	const session = { id, cwd: ctx.cwd, name: pi.getSessionName?.() || path.basename(ctx.cwd),
		sessionFile: ctx.sessionManager.getSessionFile?.(), projectId: projectFor(ctx.cwd).id };
	const seen = new Set(); const outgoing = new Map();
	const requests = new Map();
	const questionRequests=new Map();
	const questionCancellations=new Set();
	let lastPrompt;
	let latestStatus = { phase: ctx.isIdle?.() === false ? 'Working' : 'Ready', detail: '' };
	for (const entry of ctx.sessionManager.getEntries?.() || []) {
		if (entry.type !== 'custom') continue;
		if (entry.customType === 'pi_ops_tg_delivery') seen.add(entry.data?.updateId);
		if (entry.customType === 'pi_ops_tg_outgoing') outgoing.set(entry.data.key, entry.data.text);
		if (entry.customType === 'pi_ops_tg_accepted') outgoing.delete(entry.data.key);
		if(entry.customType==='pi_ops_tg_question_cancel')questionCancellations.add(entry.data.requestId);
		if(entry.customType==='pi_ops_tg_question_cancel_ack')questionCancellations.delete(entry.data.requestId);
	}
	let socket, ready = false, closed = false, superseded = false, connecting, reconnectTimer;
	let streamKey = randomUUID(), latestText = '', lastDraft = 0;
	function write(message) { send(socket, { ...message, auth, sessionId: id }); }
	function retry() {
		if (closed || superseded || reconnectTimer) return;
		reconnectTimer = setTimeout(() => { reconnectTimer = null; void open().catch(retry); }, 1000);
		reconnectTimer.unref();
	}
	async function attempt() {
		return new Promise((resolve, reject) => {
			const current = connect({ host: '127.0.0.1', port: require('../schedule/runtime.cjs').settings().port });
			socket = current; ready = false;
			const timer = setTimeout(() => { current.destroy(); reject(new Error('Telegram bridge handshake timed out')); }, 3000);
			current.setNoDelay(true); current.unref?.();
			current.once('connect', () => send(current, { type: 'register', version: 1, auth, session }));
			current.on('error', reject);
			current.on('close', () => {
				clearTimeout(timer);
				if (socket === current) { ready = false; for (const pending of requests.values()) pending.reject(new Error('File request disconnected; inspect /ops tg status before retrying')); requests.clear(); retry(); }
				reject(new Error('Telegram bridge disconnected'));
			});
			readLines(current, message => {
				if (message.type === 'superseded') { superseded = true; current.destroy(); return; }
				if (message.type === 'registered') {
					if (message.version !== 1 || message.sessionId !== id) { current.destroy(); return; }
					clearTimeout(timer); ready = true;
					write({ type: 'status', ...latestStatus });
					for(const requestId of questionCancellations)write({type:'questionCancel',requestId});
					for(const pending of questionRequests.values())write(pending.payload);
					for (const [key, text] of outgoing) write({ type: 'final', key, text });
					resolve(); return;
				}
				if (message.type === 'accepted' && outgoing.has(message.key)) {
					outgoing.delete(message.key); pi.appendEntry?.('pi_ops_tg_accepted', { key: message.key }); return;
				}
				if(message.type==='questionCancelAck'){questionCancellations.delete(message.requestId);pi.appendEntry?.('pi_ops_tg_question_cancel_ack',{requestId:message.requestId});return;}
				if(message.type==='questionResult'){
					const pending=questionRequests.get(message.requestId);if(!pending){write({type:'questionAck',requestId:message.requestId});return;}
					questionRequests.delete(message.requestId);pending.cleanup();
					message.status==='answered'?pending.resolve(message.answer):pending.reject(new Error(message.error||`Question ${message.status}`));
					write({type:'questionAck',requestId:message.requestId});return;
				}
				if (message.type === 'fileResult') {
					const pending = requests.get(message.requestId); if (!pending) return;
					requests.delete(message.requestId); message.ok ? pending.resolve() : pending.reject(new Error(message.error)); return;
				}
				if (!['reply', 'stop'].includes(message.type) || message.sessionId !== id || ctx.sessionManager.getSessionId() !== id || !Number.isSafeInteger(message.updateId)) return;
				if (!seen.has(message.updateId)) {
					if (message.type === 'stop') ctx.abort?.();
					else pi.sendUserMessage(message.text, ctx.isIdle() ? { expandPromptTemplates: true } : { deliverAs: 'steer', expandPromptTemplates: true });
					seen.add(message.updateId); pi.appendEntry?.('pi_ops_tg_delivery', { updateId: message.updateId });
				}
				write({ type: 'ack', updateId: message.updateId });
			});
		});
	}
	async function open() {
		if (closed || superseded || ready) return;
		if (connecting) return connecting;
		connecting = (async () => {
			try { await attempt(); return; } catch { if (closed) return; }
			await recover();
			if (!closed) await attempt();
		})().finally(() => { connecting = null; });
		return connecting;
	}
	function draft(text) {
		latestText = text;
		if (!ready || Date.now() - lastDraft < 1200) return;
		lastDraft = Date.now(); write({ type: 'draft', key: `${id}:${streamKey}`, text: latestText.slice(-100000) });
	}
	function final(text) {
		if (!text.trim()) return;
		if (text.length > 100000) text = text.slice(0, 99900) + '\n[Long response truncated; see the Pi transcript.]';
		const key = `${id}:${streamKey}`; streamKey = randomUUID(); latestText = '';
		pi.appendEntry?.('pi_ops_tg_outgoing', { key, text }); outgoing.set(key, text);
		if (ready) write({ type: 'final', key, text }); else void open().catch(retry);
	}
	function status(phase, detail = '', prompt) {
		if (prompt !== undefined) lastPrompt = prompt;
		latestStatus = { phase, detail, ...(lastPrompt === undefined ? {} : { prompt: lastPrompt }) };
		if (ready) {
			try { write({ type:'status', ...latestStatus }); }
			catch { ready=false; socket?.destroy(); retry(); }
		}
	}
	async function sendFile(filePath, caption, requestId) {
		await open(); if (!ready) throw new Error('Telegram session is not connected');
		if (requests.size >= 20) throw new Error('Too many pending file requests');
		const key = `${id}:file:${requestId || randomUUID()}`;
		return new Promise((resolve,reject) => {
			const timer = setTimeout(() => { requests.delete(key); reject(new Error('File enqueue acknowledgement timed out; inspect /ops tg status')); },10000);
			requests.set(key,{ resolve:()=>{clearTimeout(timer);resolve();}, reject:error=>{clearTimeout(timer);reject(error);} });
			try { write({type:'file',key,path:filePath,caption}); } catch(error) { requests.delete(key);clearTimeout(timer);reject(error); }
		});
	}
	async function askQuestion(input,signal){
		await open();if(!ready)throw new Error('Telegram is disconnected');if(signal?.aborted)throw new Error('Question cancelled');
		return new Promise((resolve,reject)=>{
			const payload={type:'question',...input};
			const cancel=()=>{questionRequests.delete(input.requestId);cleanup();questionCancellations.add(input.requestId);pi.appendEntry?.('pi_ops_tg_question_cancel',{requestId:input.requestId});try{write({type:'questionCancel',requestId:input.requestId});}catch{}reject(new Error('Question cancelled or timed out'));};
			const timer=setTimeout(cancel,(input.timeoutSeconds??300)*1000+2000);
			const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);};
			questionRequests.set(input.requestId,{payload,resolve,reject,cleanup,cancel});signal?.addEventListener('abort',cancel,{once:true});
			try{write(payload);}catch(error){questionRequests.delete(input.requestId);cleanup();reject(error);}
		});
	}
	const client = { open, draft, final, status, sendFile, askQuestion, get sessionId() { return id; }, async flush(timeoutMs = 5000) {
		const deadline = Date.now() + timeoutMs;
		while ((outgoing.size || questionCancellations.size) && Date.now() < deadline && !closed) await new Promise(resolve => setTimeout(resolve, 20));
	}, async close() {
		for(const pending of [...questionRequests.values()])pending.cancel();
		if(ready&&questionCancellations.size)await client.flush(500);
		closed = true; clearTimeout(reconnectTimer); socket?.destroy();
		for (const pending of requests.values()) pending.reject(new Error('Telegram session closed')); requests.clear();
		if (sessions.get(id) === client) sessions.delete(id);
	} };
	sessions.set(id, client);
	return client;
}
let inlineLeader;
async function ensureLeader() {
	const runtime = require('../schedule/runtime.cjs');
	if (!runtime.brokerDesired()) throw new Error('Pi Ops broker was stopped; use /ops start');
	try { await runtime.launchDaemon(); return; } catch { /* Third stage: this Pi process can lead. */ }
	try { inlineLeader = await runtime.startDaemon(runtime.settings()); inlineLeader.server.unref(); }
	catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
}
function assistantText(message) {
	return message?.role === 'assistant' && Array.isArray(message.content)
		? message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') : '';
}
function attachTelegram(pi, { readSettings = readTelegram, makeClient = createClient } = {}) {
	let client, pendingText = '';
	const report = error => process.stderr.write(`[pi-ops] Telegram bridge: ${error.message}\n`);
	pi.on('session_start', async (_event, ctx) => {
		await client?.close(); client = undefined; pendingText = '';
		try {
			if (!readSettings() || !ctx.sessionManager?.getSessionId) return;
			client = makeClient(pi, ctx); await client.open();
		} catch (error) { report(error); }
	});
	pi.on('message_update', event => {
		if (client) { try { client.draft(assistantText(event.message)); } catch (error) { report(error); } }
	});
	pi.on('message_end', event => {
		if (client && event.message?.role === 'assistant') {
			// Tool-use commentary stays ephemeral; only the final assistant answer
			// from this task is persisted when Pi reports agent_settled.
			pendingText = assistantText(event.message);
			try { client.draft(pendingText); } catch (error) { report(error); }
		}
	});
	pi.on('before_agent_start', event => { if (client && event.messageType === 'user') { pendingText = ''; client.status('Working','Preparing task',String(event.prompt).slice(0,20000)); } });
	pi.on('agent_start', () => client?.status('Working','Running'));
	pi.on('tool_execution_start', event => client?.status('Working',`Tool: ${String(event.toolName).slice(0,100)}`));
	pi.on('agent_settled', event => {
		if (!client) return;
		try {
			if (pendingText.trim()) client.final(event.aborted ? `${pendingText}\n\n[Task stopped; partial response.]` : pendingText);
		} catch (error) { report(error); }
		finally { pendingText = ''; }
		client.status(event.aborted ? 'Stopped' : 'Ready','');
	});
	pi.on('session_shutdown', async () => {
		await client?.close(); client = undefined;
		if (inlineLeader) { const leader = inlineLeader; inlineLeader = undefined; await leader.close(); }
	});
}
async function finishSession(id, timeoutMs) {
	const client = sessions.get(id); if (!client) return;
	await client.flush(timeoutMs); await client.close();
}
async function sendFile(id,filePath,caption,requestId) {
	const client = sessions.get(id); if (!client) throw new Error('Telegram is not configured or this Pi session is not connected');
	return client.sendFile(filePath,caption,requestId);
}
async function askQuestion(id,input,signal){const client=sessions.get(id);if(!client)throw new Error('Telegram session is not connected');return client.askQuestion(input,signal);}
module.exports = { createClient, attachTelegram, ensureLeader, finishSession, sendFile, askQuestion };
