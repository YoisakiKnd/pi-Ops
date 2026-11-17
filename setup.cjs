#!/usr/bin/env node
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const readline = require('node:readline/promises');
const { createApi } = require('./src/telegram/api.cjs');
const { TOKEN_PATH } = require('./src/telegram/settings.cjs');
const { OPS_DIR } = require('./src/shared/paths.cjs');
const { readConfig, writeConfig } = require('./src/shared/config.cjs');

function bindingFrom(update, code) {
	const message = update.message;
	return message?.chat?.type === 'private' && message.from?.id === message.chat.id && !message.from.is_bot &&
		message.text?.trim() === `/start ${code}` ? { chatId: message.chat.id, allowedUserId: message.from.id } : null;
}
function hiddenToken() {
	const input = process.stdin, output = process.stdout;
	if (!input.isTTY) throw new Error('Use an interactive terminal, or set PI_OPS_TELEGRAM_BOT_TOKEN temporarily');
	output.write('Bot token (hidden): ');
	return new Promise((resolve, reject) => {
		let text = ''; const wasRaw = input.isRaw;
		const done = (error) => { input.off('data', data); input.setRawMode(Boolean(wasRaw)); input.pause(); output.write('\n'); error ? reject(error) : resolve(text); };
		const data = chunk => { for (const character of String(chunk)) {
			if (character === '\r' || character === '\n') return done();
			if (character === '\u0003') return done(new Error('Setup cancelled'));
			if (character === '\u007f' || character === '\b') text = text.slice(0, -1); else text += character;
		} };
		input.setEncoding('utf8'); input.setRawMode(true); input.resume(); input.on('data', data);
	});
}
async function isListening(port) {
	return new Promise(resolve => {
		const socket = net.createConnection({ host: '127.0.0.1', port });
		const finish = result => { socket.destroy(); resolve(result); };
		socket.setTimeout(500, () => finish(false)); socket.once('error', () => finish(false)); socket.once('connect', () => finish(true));
	});
}
async function setup() {
	const config = readConfig();
	if (await isListening(config.port)) throw new Error('Stop all Pi Ops brokers first: /ops stop');
	const token = String(process.env.PI_OPS_TELEGRAM_BOT_TOKEN || await hiddenToken()).trim();
	if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('Invalid bot token');
	const api = createApi({ apiBaseUrl: config.telegram.apiBaseUrl.replace(/\/$/, ''), token });
	const bot = await api('getMe', {});
	const code = randomBytes(12).toString('hex');
	process.stdout.write(`In your PRIVATE chat with @${bot.username}, send:\n/start ${code}\nEnable Threaded Mode in BotFather first. Waiting up to three minutes…\n`);
	let offset = 0, binding;
	const deadline = Date.now() + 180000;
	while (!binding && Date.now() < deadline) {
		for (const update of await api('getUpdates', { offset, timeout: 20, allowed_updates: ['message'] })) {
			offset = Math.max(offset, update.update_id + 1); binding ||= bindingFrom(update, code);
		}
	}
	if (!binding) throw new Error('Binding timed out; nothing was saved');
	const identityDb = require('./src/schedule/store.cjs').openSchedule();
	try {
		require('./src/telegram/store.cjs').initialize(identityDb);
		const previous = identityDb.prepare("SELECT value FROM tg_meta WHERE key='binding'").get()?.value;
		if (previous && previous !== `${bot.id}:${binding.chatId}`) throw new Error('This state directory is bound to another bot/chat. Use a separate PI_CODING_AGENT_DIR to preserve existing topics and queues.');
	} finally { identityDb.close(); }
	const topic = await api('createForumTopic', { chat_id: binding.chatId, name: 'Pi Ops setup verification' });
	await api('deleteForumTopic', { chat_id: binding.chatId, message_thread_id: topic.message_thread_id });
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	let wakeRoot = '';
	try { wakeRoot = (await rl.question('Allow offline session wake inside this directory (empty = disabled): ')).trim(); }
	finally { rl.close(); }
	if (wakeRoot) { wakeRoot = fs.realpathSync(path.resolve(wakeRoot)); if (!fs.statSync(wakeRoot).isDirectory()) throw new Error('Wake root must be a directory'); }
	fs.mkdirSync(OPS_DIR, { recursive: true, mode: 0o700 });
	const temporary = `${TOKEN_PATH}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, `${token}\n`, { mode: 0o600 }); fs.renameSync(temporary, TOKEN_PATH);
	config.telegram = { ...config.telegram, enabled: true, ...binding, wakeMode: Boolean(wakeRoot), wakeDefaultCwd: wakeRoot, wakeAllowedRoots: wakeRoot ? [wakeRoot] : [] };
	writeConfig(config);
	const db = require('./src/schedule/store.cjs').openSchedule();
	try {
		require('./src/telegram/store.cjs').initialize(db);
		db.prepare("UPDATE tg_meta SET value=? WHERE key='offset'").run(String(offset));
		db.prepare("INSERT INTO tg_meta VALUES('binding',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`${bot.id}:${binding.chatId}`);
		db.prepare("INSERT INTO meta VALUES('broker_desired','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
	} finally { db.close(); }
	process.stdout.write('Telegram connected. Load/reload Pi Ops in Pi; each session gets its own topic when it sends output.\n');
}
if (require.main === module) setup().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { bindingFrom, setup };
