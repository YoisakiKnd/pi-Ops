const fs = require('node:fs');
const path = require('node:path');
const { OPS_DIR } = require('../shared/paths.cjs');
const { readConfig } = require('../shared/config.cjs');
const TOKEN_PATH = path.join(OPS_DIR, 'telegram.secret');
function readTelegram() {
	const config = readConfig();
	const raw = config.telegram;
	if (!raw?.enabled) return null;
	if (raw.enabled !== true || typeof raw.wakeMode !== 'boolean') throw new Error('Telegram enabled/wakeMode must be booleans');
	if (!['silent', 'important', 'all'].includes(raw.notifications)) throw new Error('Telegram notifications must be silent, important or all');
	const token = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
	if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('Invalid Telegram token; run node setup.cjs');
	const chatId = Number(raw.chatId), allowedUserId = Number(raw.allowedUserId);
	if (!Number.isSafeInteger(chatId) || !chatId || !Number.isSafeInteger(allowedUserId) || allowedUserId <= 0) throw new Error('Telegram chatId/allowedUserId must be configured');
	const url = new URL(raw.apiBaseUrl);
	if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid Telegram API base URL');
	if (!Array.isArray(raw.wakeAllowedRoots) || raw.wakeAllowedRoots.some(root => typeof root !== 'string')) throw new Error('Invalid wakeAllowedRoots');
	return { ...raw, token, chatId, allowedUserId, apiBaseUrl: url.href.replace(/\/$/, '') };
}
module.exports = { readTelegram, TOKEN_PATH };
