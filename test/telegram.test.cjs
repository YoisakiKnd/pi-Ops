const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ops-tg-'));
process.env.PI_CODING_AGENT_DIR = dir;
const schedule = require('../src/schedule/store.cjs');
const state = require('../src/telegram/store.cjs');
const { createBroker } = require('../src/telegram/broker.cjs');
const { createClient } = require('../src/telegram/client.cjs');
const { createApi, TelegramError } = require('../src/telegram/api.cjs');
const { startDaemon } = require('../src/schedule/runtime.cjs');
const { readLines, send } = require('../src/telegram/protocol.cjs');
const { bindingFrom } = require('../setup.cjs');
const { projectFor } = require('../src/shared/project.cjs');
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const settings = { chatId: 123, allowedUserId: 123, wakeMode: false, wakeAllowedRoots: [] };
const session = { id: 'session-a', cwd: dir, name: 'Project A', projectId: projectFor(dir).id };
const update = (id, thread = 100, text = 'hello', user = 123) => ({ update_id: id, message: { chat: { id: 123 }, from: { id: user }, message_thread_id: thread, text } });
async function until(check, label = 'condition') {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
	throw new Error(`Timed out: ${label}`);
}
function fixture(t) { const db = schedule.openSchedule(':memory:'); state.initialize(db); t.after(() => db.close()); return db; }
let topicBase = 99;
function mockApi() {
	const calls = []; let topicId = topicBase, messageId = 1000;
	topicBase += 1000;
	return { calls, async call(method, params, signal) {
		calls.push({ method, params });
		if (method === 'getUpdates') return new Promise(resolve => signal.addEventListener('abort', () => resolve([]), { once: true }));
		if (method === 'createForumTopic') return { message_thread_id: ++topicId };
		return { message_id: ++messageId };
	} };
}

test('setup binds only a private owner sending the one-time code', () => {
	const good = { message: { chat: { id: 123, type: 'private' }, from: { id: 123 }, text: '/start challenge' } };
	assert.deepEqual(bindingFrom(good, 'challenge'), { chatId: 123, allowedUserId: 123 });
	assert.equal(bindingFrom(good, 'different'), null);
	assert.equal(bindingFrom({ message: { ...good.message, from: { id: 456 } } }, 'challenge'), null);
	assert.equal(bindingFrom({ message: { ...good.message, chat: { id: 123, type: 'group' } } }, 'challenge'), null);
});

test('offset and authorized inbound delivery persist together without duplicates', t => {
	const db = fixture(t); state.register(db, session);
	db.prepare("UPDATE tg_sessions SET topic_id=100,topic_state='ready'").run();
	state.ingest(db, update(1), settings); state.ingest(db, update(1), settings);
	state.ingest(db, update(2, 100, 'unauthorized', 999), settings);
	state.ingest(db, update(3, 999), settings);
	assert.equal(db.prepare('SELECT count(*) AS n FROM tg_inbox').get().n, 1);
	assert.equal(db.prepare("SELECT value FROM tg_meta WHERE key='offset'").get().value, '4');
	assert.equal(db.prepare('SELECT status FROM tg_inbox').get().status, 'queued');
});

test('outbox chunks Unicode text and deduplicates retries', t => {
	const db = fixture(t); state.register(db, session);
	const text = '🚀'.repeat(8000);
	state.enqueue(db, 'answer', session.id, text); state.enqueue(db, 'answer', session.id, text);
	const rows = db.prepare('SELECT * FROM tg_outbox ORDER BY rowid').all();
	assert.equal(rows.length, 5); assert.equal(rows.map(row => row.text).join(''), text);
	assert.ok(rows.every(row => row.text.length <= 3500));
});

test('broker restart marks ambiguous sends and wakes uncertain without automatic replay', t => {
	const db = fixture(t); state.register(db, session); state.enqueue(db, 'send', session.id, 'answer');
	db.exec("UPDATE tg_outbox SET status='sending'; UPDATE tg_sessions SET topic_state='creating'; INSERT INTO tg_inbox VALUES(1,'session-a','partial action','waking',0)");
	state.recover(db);
	assert.equal(db.prepare('SELECT status FROM tg_outbox').get().status, 'uncertain');
	assert.equal(db.prepare('SELECT status FROM tg_inbox').get().status, 'uncertain');
	assert.equal(state.getSession(db, session.id).topic_state, 'uncertain');
});

test('rate limits retry, but uncertain send responses remain visible for reconciliation', async t => {
	const db = fixture(t); state.register(db, session);
	const mock = mockApi(); let fail = 429;
	const broker = createBroker(db, settings, { api: async (method, params, signal) => {
		if (method === 'sendMessage' && fail) throw new TelegramError('injected', fail, 1);
		return mock.call(method, params, signal);
	} });
	t.after(() => broker.close());
	state.enqueue(db, 'rate-limited', session.id, 'answer'); await broker.flush();
	assert.equal(db.prepare('SELECT status FROM tg_outbox').get().status, 'pending');
	fail = 'uncertain'; db.exec('UPDATE tg_outbox SET next_at=0'); await broker.flush();
	assert.equal(db.prepare('SELECT status FROM tg_outbox').get().status, 'uncertain');
	fail = null; await broker.flush();
	assert.equal(db.prepare('SELECT status FROM tg_outbox').get().status, 'uncertain');
});

test('API errors redact credentials and honor retry-after', async () => {
	const token = '123:very-secret-token';
	const api = createApi({ token, apiBaseUrl: 'https://example.invalid' }, async () => { throw new Error(token); });
	await assert.rejects(api('sendMessage', {}), error => !error.message.includes(token) && error.code === 'uncertain');
	const limited = createApi({ token, apiBaseUrl: 'https://example.invalid' }, async () => ({ json: async () => ({ ok: false, error_code: 429, description: token, parameters: { retry_after: 5 } }) }));
	await assert.rejects(limited('sendMessage', {}), error => error.retryAfter === 5 && !error.message.includes(token));
});

test('one listener supports HTTP control, two isolated Pi sessions, reconnect and persisted topics', async t => {
	const db = schedule.openSchedule();
	const mock = mockApi();
	let daemon = await startDaemon({ db, port: 0, telegramOptions: { settings, api: mock.call.bind(mock) } });
	const clients = [];
	t.after(async () => { for (const client of clients) await client.close(); await daemon.close(); db.close(); });
	const make = (id, entries = [], busy = false) => {
		const received = [], appended = entries;
		const pi = { getSessionName: () => id, appendEntry: (customType, data) => appended.push({ type: 'custom', customType, data }),
			sendUserMessage: (text, options) => received.push({ text, options }) };
		const ctx = { cwd: dir, isIdle: () => !busy, abort: () => received.push({ stop: true }),
			sessionManager: { getSessionId: () => id, getSessionFile: () => null, getEntries: () => appended } };
		const client = createClient(pi, ctx, { connect: options => net.createConnection({ ...options, port: daemon.port }), recover: async () => {} });
		clients.push(client); return { client, received, entries: appended };
	};
	const a = make('session-a'), b = make('session-b', [], true);
	await a.client.open(); await b.client.open();
	assert.equal(daemon.broker.clients.size, 2);
	const token = db.prepare("SELECT value FROM meta WHERE key='token'").get().value;
	const status = await (await fetch(`http://127.0.0.1:${daemon.port}/status`, { headers: { authorization: `Bearer ${token}` } })).json();
	assert.equal(status.telegram, true);
	a.client.draft('Streaming A'); a.client.final('Answer A'); b.client.final('Answer B');
	await until(() => db.prepare("SELECT count(*) AS n FROM tg_outbox WHERE status='sent'").get().n === 2, 'two final answers');
	const topicA = state.getSession(db, 'session-a').topic_id, topicB = state.getSession(db, 'session-b').topic_id;
	assert.notEqual(topicA, topicB);
	await daemon.broker.step([update(10, topicA, 'for A'), update(11, topicB, 'for B')]);
	await until(() => a.received.length === 1 && b.received.length === 1, 'inbound replies');
	assert.equal(a.received[0].text, 'for A'); assert.equal(b.received[0].text, 'for B');
	assert.equal(b.received[0].options.deliverAs, 'steer');
	await daemon.broker.step([update(10, topicA, 'duplicate')]);
	assert.equal(a.received.length, 1);
	await b.client.close(); await until(() => !daemon.broker.clients.has('session-b'));
	await daemon.broker.step([update(12, topicB, 'offline B')]);
	assert.equal(db.prepare('SELECT status FROM tg_inbox WHERE update_id=12').get().status, 'queued');
	await a.client.close(); await daemon.close();
	daemon = await startDaemon({ db, port: 0, telegramOptions: { settings, api: mock.call.bind(mock) } });
	const resumed = make('session-b', b.entries); await resumed.client.open();
	await until(() => resumed.received.length === 1);
	assert.equal(resumed.received[0].text, 'offline B');
	assert.equal(state.getSession(db, 'session-b').topic_id, topicB);
	assert.equal(mock.calls.filter(call => call.method === 'createForumTopic').length, 2);
	await daemon.broker.step([update(13, topicB, '/stop')]);
	await until(() => resumed.received.some(item => item.stop));
	const report = path.join(dir,'outbound-report.txt');fs.writeFileSync(report,'test report');
	await resumed.client.sendFile(report,'Report','upload-test');
	await until(()=>db.prepare("SELECT status FROM tg_outbox WHERE kind='file'").get()?.status==='sent','outbound file upload');
	assert.ok(mock.calls.some(call=>call.method==='sendDocument' && call.params.caption==='Report'));
	await assert.rejects(resumed.client.sendFile(path.join(dir,'..','outside-project.txt'),'','invalid-file'));
	const answer=resumed.client.askQuestion({requestId:'tcp-question',question:'Proceed?',options:['Yes','No'],timeoutSeconds:10});
	await until(()=>db.prepare("SELECT status FROM tg_questions WHERE request_id='tcp-question'").get()?.status==='open','question delivered over TCP');
	const question=db.prepare("SELECT * FROM tg_questions WHERE request_id='tcp-question'").get();
	await daemon.broker.step([{update_id:14,callback_query:{id:'tcp-answer',from:{id:123},message:{chat:{id:123},message_id:question.message_id,message_thread_id:topicB},data:`q:${question.id}:0`}}]);
	assert.deepEqual(await answer,['Yes']);
});

test('registration authentication rejects invalid clients before routing messages', async t => {
	const db = fixture(t); const mock = mockApi();
	const broker = createBroker(db, settings, { api: mock.call.bind(mock) });
	const server = net.createServer(socket => broker.attach(socket));
	server.listen(0, '127.0.0.1'); await once(server, 'listening');
	t.after(async () => { await broker.close(); await new Promise(resolve => server.close(resolve)); });
	const socket = net.createConnection({ host: '127.0.0.1', port: server.address().port });
	await once(socket, 'connect');
	send(socket, { type: 'register', version: 1, auth: 'wrong', session });
	await once(socket, 'close');
	assert.equal(db.prepare('SELECT count(*) AS n FROM tg_sessions').get().n, 0);
});

test('offline wake resumes only a registered session inside explicitly allowed roots', async t => {
	const db = fixture(t), mock = mockApi();
	const transcript = path.join(dir, 'session.jsonl'); fs.writeFileSync(transcript, 'test');
	state.register(db, { ...session, sessionFile: transcript });
	db.prepare("UPDATE tg_sessions SET topic_id=100,topic_state='ready'").run();
	const calls = [];
	const broker = createBroker(db, { ...settings, wakeMode: true, wakeAllowedRoots: [dir] }, {
		api: mock.call.bind(mock), wake: async task => { calls.push(task); return { status: 'success' }; },
	});
	t.after(() => broker.close());
	await broker.step([update(100)]);
	await until(() => db.prepare('SELECT status FROM tg_inbox').get().status === 'delivered');
	assert.equal(calls.length, 1); assert.equal(calls[0].resumeSessionFile, transcript); assert.equal(calls[0].wake, true);
	assert.equal(calls[0].prompt, 'hello');
});

test('a connected Pi client reconnects after leader replacement without recreating its topic', async t => {
	const db = schedule.openSchedule(); const mock = mockApi();
	let daemon = await startDaemon({ db, port: 0, telegramOptions: { settings, api: mock.call.bind(mock) } });
	const port = daemon.port;
	let recoveries = 0;
	const entries = [];
	const client = createClient({ getSessionName: () => 'reconnect', appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }), sendUserMessage() {} }, {
		cwd: dir, isIdle: () => true, sessionManager: { getSessionId: () => 'reconnect', getEntries: () => entries },
	}, { connect: options => net.createConnection({ ...options, port }), recover: async () => {
		recoveries++;
		daemon = await startDaemon({ db, port, telegramOptions: { settings, api: mock.call.bind(mock) } });
	} });
	t.after(async () => { await client.close(); await daemon.close(); db.close(); });
	await client.open(); client.final('before takeover'); await client.flush();
	await until(() => db.prepare("SELECT count(*) AS n FROM tg_outbox WHERE session_id='reconnect' AND status='sent'").get().n === 1);
	const topic = state.getSession(db, 'reconnect').topic_id;
	const questionAbort=new AbortController();
	const waiting=client.askQuestion({requestId:'cancel-across-reconnect',question:'Proceed after reconnect?',options:['yes'],timeoutSeconds:10},questionAbort.signal);
	const rejected=assert.rejects(waiting,/cancelled/);
	await until(()=>db.prepare("SELECT status FROM tg_questions WHERE request_id='cancel-across-reconnect'").get()?.status==='open');
	await daemon.close();
	questionAbort.abort();await rejected;
	await until(() => recoveries === 1 && daemon.broker.clients.has('reconnect'), 'automatic client reconnect');
	await until(()=>db.prepare("SELECT status FROM tg_questions WHERE request_id='cancel-across-reconnect'").get()?.status==='cancelled','cancel replayed to new broker');
	client.final('after takeover'); await client.flush();
	await until(() => db.prepare("SELECT count(*) AS n FROM tg_outbox WHERE session_id='reconnect' AND status='sent'").get().n === 2);
	assert.equal(state.getSession(db, 'reconnect').topic_id, topic);
});

test('an intentional stop prevents a reconnect from silently restarting the broker', async () => {
	const db = schedule.openSchedule();
	db.prepare("INSERT INTO meta VALUES('broker_desired','0') ON CONFLICT(key) DO UPDATE SET value='0'").run(); db.close();
	await assert.rejects(require('../src/telegram/client.cjs').ensureLeader(), /was stopped/);
});

test('offline wake cannot escape its configured roots', async t => {
	const db = fixture(t); const mock = mockApi();
	const transcript = path.join(dir, 'outside-session.jsonl'); fs.writeFileSync(transcript, 'test');
	const allowed = path.join(dir, 'allowed-root'); fs.mkdirSync(allowed);
	state.register(db, { ...session, sessionFile: transcript }); db.prepare("UPDATE tg_sessions SET topic_id=100,topic_state='ready'").run();
	let calls = 0;
	const broker = createBroker(db, { ...settings, wakeMode: true, wakeAllowedRoots: [allowed] }, {
		api: mock.call.bind(mock), wake: async () => { calls++; return { status: 'success' }; },
	});
	t.after(() => broker.close()); await broker.step([update(200)]);
	assert.equal(calls, 0); assert.equal(db.prepare('SELECT status FROM tg_inbox').get().status, 'queued');
});

test('session cards are pinned once, edited in place and validate callback ownership', async t => {
	const controls = require('../src/telegram/controls.cjs');
	const db = fixture(t), mock = mockApi(); state.register(db,session);
	db.prepare("UPDATE tg_sessions SET topic_id=100,topic_state='ready',last_prompt='Inspect deployment'").run();
	const broker = createBroker(db,settings,{api:mock.call.bind(mock)}); t.after(()=>broker.close());
	controls.setStatus(db,session.id,'Working','read'); await broker.flush();
	const card = db.prepare('SELECT * FROM tg_cards').get();
	assert.ok(card.message_id); assert.equal(card.pinned,1);
	assert.ok(controls.keyboard(card).inline_keyboard.flat().every(button=>Buffer.byteLength(button.callback_data)<=64));
	controls.setStatus(db,session.id,'Ready'); await broker.flush();
	assert.equal(mock.calls.filter(call=>call.method==='pinChatMessage').length,1);
	assert.ok(mock.calls.some(call=>call.method==='editMessageText'));
	const query = action => ({ id:`query-${action}`,from:{id:123},message:{chat:{id:123},message_id:card.message_id,message_thread_id:100},data:`${card.token}:${action}` });
	await broker.step([{update_id:300,callback_query:query('retry')}]);
	assert.equal(db.prepare('SELECT text FROM tg_inbox WHERE update_id=300').get().text,'Inspect deployment');
	await broker.step([{update_id:300,callback_query:query('retry')}]);
	assert.equal(db.prepare('SELECT count(*) AS n FROM tg_inbox').get().n,1);
	await broker.step([{update_id:301,callback_query:{...query('stop'),from:{id:999}}}]);
	assert.equal(db.prepare('SELECT count(*) AS n FROM tg_inbox').get().n,1);
	await broker.step([{update_id:302,callback_query:{...query('stop'),message:{...query('stop').message,message_thread_id:999}}}]);
	assert.equal(db.prepare('SELECT status FROM tg_actions WHERE update_id=302').get().status,'failed');
	await broker.step([{update_id:303,callback_query:query('stop')}]);
	assert.equal(db.prepare('SELECT text FROM tg_inbox WHERE update_id=303').get().text,'/stop');
});

test('photo/document downloads stay in the intended project and are delivered once', async t => {
	const db=fixture(t),mock=mockApi();state.register(db,session);db.prepare("UPDATE tg_sessions SET topic_id=100,topic_state='ready'").run();
	let downloads=0;
	const api=async(method,params,signal)=>method==='getFile'?{file_path:'documents/report.txt',file_size:5}:mock.call(method,params,signal);
	api.download=async()=>{downloads++;return Buffer.from('hello');};
	const broker=createBroker(db,settings,{api});t.after(()=>broker.close());
	const attachment={update_id:400,message:{chat:{id:123},from:{id:123},message_thread_id:100,caption:'Please read',document:{file_id:'file-1',file_name:'../../report.txt',file_size:5}}};
	await broker.step([attachment]);await broker.step([attachment]);
	assert.equal(downloads,1);
	const file=path.join(dir,'.pi-ops/inbox/400/report.txt');assert.equal(fs.readFileSync(file,'utf8'),'hello');
	assert.match(db.prepare('SELECT text FROM tg_inbox WHERE update_id=400').get().text,/Please read/);
	assert.equal(db.prepare('SELECT status FROM tg_actions WHERE update_id=400').get().status,'done');
});

test('attachment guards reject traversal, symlink escape, directories and oversized files', () => {
	const files=require('../src/telegram/files.cjs');
	const root=path.join(dir,'files-root'),outside=path.join(dir,'outside');fs.mkdirSync(root);fs.mkdirSync(outside);
	fs.writeFileSync(path.join(outside,'secret'),'secret');fs.symlinkSync(outside,path.join(root,'link'));
	assert.throws(()=>files.uploadFile(root,'link/secret'),/inside/);
	assert.throws(()=>files.uploadFile(root,'../outside/secret'),/inside/);
	assert.throws(()=>files.uploadFile(root,'.'),/regular/);
	fs.symlinkSync(outside,path.join(root,'.pi-ops'));
	assert.throws(()=>files.saveDownload(root,1,'test',Buffer.from('test')),/symlink/);
	const huge=path.join(root,'huge');const fd=fs.openSync(huge,'w');fs.ftruncateSync(fd,files.MAX_UPLOAD+1);fs.closeSync(fd);
	assert.throws(()=>files.uploadFile(root,'huge'),/50 MiB/);
});

test('multipart upload and streamed downloads enforce byte limits without exposing tokens', async () => {
	const calls=[]; const api=createApi({apiBaseUrl:'https://example.invalid',token:'123:secret'},async(url,options)=>{
		calls.push({url,options});
		if(url.includes('/file/'))return new Response(Buffer.from('download'));
		return {json:async()=>({ok:true,result:{message_id:1}})};
	});
	await api('sendDocument',{chat_id:123},undefined,{name:'report.txt',bytes:Buffer.from('report'),field:'document'});
	assert.ok(calls[0].options.body instanceof FormData);assert.equal(calls[0].options.body.get('document').name,'report.txt');
	assert.equal((await api.download('documents/test.txt')).toString(),'download');
	await assert.rejects(api.download('../secret'),/Invalid/);
	await assert.rejects(api.download('https://evil.invalid'),/Invalid/);
	const limited=createApi({apiBaseUrl:'https://example.invalid',token:'123:secret'},async()=>new Response('large',{headers:{'content-length':String(21*1024*1024)}}));
	await assert.rejects(limited.download('file/test'),/20 MiB/);
});

test('remote /new creates one fixed session ID and starts only within allowed roots', async t => {
	const db=fixture(t),mock=mockApi(),tasks=[];
	const broker=createBroker(db,{...settings,wakeMode:true,wakeAllowedRoots:[dir],wakeDefaultCwd:dir},{api:mock.call.bind(mock),wake:async task=>{tasks.push(task);return {status:'success'};}});
	t.after(()=>broker.close());
	const request={update_id:500,message:{chat:{id:123},from:{id:123},text:'/new | Inspect the project'}};
	await broker.step([request]);await until(()=>tasks.length===1);await broker.step([request]);
	assert.equal(db.prepare('SELECT count(*) AS n FROM tg_remote').get().n,1);
	const created=db.prepare('SELECT * FROM tg_sessions').get();
	assert.equal(tasks[0].newSessionId,created.id);assert.equal(tasks[0].prompt,'Inspect the project');assert.equal(tasks[0].resumeSessionFile,undefined);
	await broker.step([{update_id:501,message:{chat:{id:123},from:{id:123},text:'/new /private/tmp | do work'}}]);
	assert.equal(db.prepare('SELECT status FROM tg_actions WHERE update_id=501').get().status,'failed');
	assert.equal(tasks.length,1);
	await broker.step([{update_id:502,message:{chat:{id:123},from:{id:123},text:'/new'}}]);
	assert.equal(db.prepare('SELECT count(*) AS n FROM tg_remote').get().n,2);assert.equal(tasks.length,1,'empty new session does not invoke a model');
	await broker.step([{update_id:503,message:{chat:{id:123},from:{id:123},text:'/sessions'}}]);
	assert.equal(db.prepare('SELECT status FROM tg_actions WHERE update_id=503').get().status,'done');
});

test('processing remote actions and status-card sends are uncertain after broker loss', t=>{
	const db=fixture(t);state.register(db,session);
	require('../src/telegram/controls.cjs').ensureCard(db,session.id);
	db.prepare("INSERT INTO tg_actions(update_id,kind,payload,status) VALUES(600,'remote','{}','processing')").run();
	db.exec("UPDATE tg_cards SET status='sending'");state.recover(db);
	assert.equal(db.prepare('SELECT status FROM tg_cards').get().status,'uncertain');
	assert.equal(db.prepare('SELECT status FROM tg_actions').get().status,'uncertain');
});

test('questions persist selections, reject foreign callbacks and finish only on Done',async t=>{
 const q=require('../src/telegram/questions.cjs'),db=fixture(t),mock=mockApi();state.register(db,session);db.prepare("UPDATE tg_sessions SET topic_id=100,topic_state='ready'").run();
 const broker=createBroker(db,settings,{api:mock.call.bind(mock)});t.after(()=>broker.close());
 const row=q.ask(db,session.id,{requestId:'question-1',question:'Choose services',options:['nginx','postgres'],multiple:true});
 await broker.flush();let saved=db.prepare('SELECT * FROM tg_questions').get();assert.equal(saved.status,'open');
 const query=choice=>({id:`q-${choice}`,from:{id:123},message:{chat:{id:123},message_id:saved.message_id,message_thread_id:100},data:`q:${row.id}:${choice}`});
 await broker.step([{update_id:700,callback_query:query(0)}]);saved=db.prepare('SELECT * FROM tg_questions').get();assert.equal(saved.status,'open');assert.equal(saved.selected,'[0]');
 await broker.step([{update_id:700,callback_query:query(0)}]);assert.equal(db.prepare('SELECT selected FROM tg_questions').get().selected,'[0]');
 assert.throws(()=>q.answer(db,{...query(1),from:{id:999}},settings),/Unauthorized/);
 await broker.step([{update_id:701,callback_query:query(1)},{update_id:702,callback_query:query('done')}]);
 saved=db.prepare('SELECT * FROM tg_questions').get();assert.equal(saved.status,'answered');assert.deepEqual(JSON.parse(saved.answer),['nginx','postgres']);
 assert.equal(q.ask(db,session.id,{requestId:'question-1',question:'Choose services',options:['nginx','postgres'],multiple:true}).id,row.id);
 assert.ok(q.keyboard({...saved,status:'open'}).inline_keyboard.flat().every(button=>Buffer.byteLength(button.callback_data)<=64));
});

test('question expiry and cancelled answers never reopen after an edit failure',async t=>{
 const q=require('../src/telegram/questions.cjs'),db=fixture(t);state.register(db,session);
 q.ask(db,session.id,{requestId:'expired',question:'Continue?',options:['yes']});db.exec("UPDATE tg_questions SET expires_at=0");
 await q.flush(db,settings,async()=>{},async()=>100);assert.equal(db.prepare('SELECT status FROM tg_questions').get().status,'expired');
 db.exec("UPDATE tg_questions SET status='cancelled',message_id=1,dirty=1");
 await q.flush(db,settings,async()=>{throw new Error('edit failed');},async()=>100);assert.equal(db.prepare('SELECT status FROM tg_questions').get().status,'cancelled');
 db.exec("UPDATE tg_questions SET status='open',dirty=1,expires_at=9999999999999,next_at=0");
 await q.flush(db,settings,async()=>{db.exec("UPDATE tg_questions SET status='answered',answer='[\"yes\"]'");throw new Error('late edit failure');},async()=>100);
 assert.equal(db.prepare('SELECT status FROM tg_questions').get().status,'answered');
});

test('question sends honor retry-after and permanent errors fail promptly',async t=>{
 const q=require('../src/telegram/questions.cjs'),db=fixture(t);state.register(db,session);
 q.ask(db,session.id,{requestId:'limited',question:'Ready?',options:['yes']});let calls=0;
 const api=async()=>{calls++;throw new TelegramError('rate limited',429,30);};
 await q.flush(db,settings,api,async()=>100);await q.flush(db,settings,api,async()=>100);
 assert.equal(calls,1);assert.ok(db.prepare('SELECT next_at FROM tg_questions').get().next_at>Date.now()+20000);
 db.exec('UPDATE tg_questions SET next_at=0');
 await q.flush(db,settings,async()=>{throw new TelegramError('forbidden',403);},async()=>100);
 assert.equal(db.prepare('SELECT status FROM tg_questions').get().status,'failed');
});
test('cancellation while resolving a topic cannot reopen and send a question',async t=>{
 const q=require('../src/telegram/questions.cjs'),db=fixture(t);state.register(db,session);
 q.ask(db,session.id,{requestId:'cancel-topic',question:'Ready?',options:['yes']});let sends=0;
 await q.flush(db,settings,async()=>{sends++;return {message_id:1};},async()=>{db.exec("UPDATE tg_questions SET status='cancelled'");return 100;});
 assert.equal(sends,0);assert.equal(db.prepare('SELECT status FROM tg_questions').get().status,'cancelled');
});
