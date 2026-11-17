const { randomBytes } = require('node:crypto');
function ensureCard(db, id) {
	db.prepare('INSERT OR IGNORE INTO tg_cards(session_id,token) VALUES(?,?)').run(id, randomBytes(10).toString('hex'));
	return db.prepare('SELECT * FROM tg_cards WHERE session_id=?').get(id);
}
function setStatus(db, id, phase, detail = '') {
	if (!['Ready', 'Working', 'Stopped', 'Disconnected', 'Error'].includes(phase)) throw new Error('Invalid session phase');
	ensureCard(db, id);
	db.prepare('UPDATE tg_cards SET phase=?,detail=?,dirty=1 WHERE session_id=? AND (phase!=? OR detail!=?)')
		.run(phase, String(detail).slice(0, 300), id, phase, String(detail).slice(0, 300));
}
function keyboard(card) {
	return { inline_keyboard: [[
		{ text: 'Continue', callback_data: `${card.token}:continue` }, { text: 'Stop', callback_data: `${card.token}:stop` },
	], [{ text: 'Retry', callback_data: `${card.token}:retry` }, { text: 'Refresh', callback_data: `${card.token}:refresh` }]] };
}
function callbackSession(db, query, settings) {
	if (query?.from?.id !== settings.allowedUserId || query.from.is_bot || query.message?.chat?.id !== settings.chatId) return null;
	const match = String(query.data || '').match(/^([a-f0-9]{20}):(continue|stop|retry|refresh)$/);
	if (!match) return null;
	const card = db.prepare('SELECT c.*,s.topic_id FROM tg_cards c JOIN tg_sessions s ON c.session_id=s.id WHERE c.token=? AND c.message_id=?')
		.get(match[1], query.message.message_id);
	if (!card || card.topic_id !== query.message.message_thread_id) return null;
	return { sessionId: card.session_id, action: match[2] };
}
async function flushCards(db, settings, api, signal) {
	for (const card of db.prepare(`SELECT c.*,s.name,s.topic_id FROM tg_cards c JOIN tg_sessions s ON c.session_id=s.id
	 WHERE c.dirty=1 AND c.status NOT IN ('uncertain','failed') AND s.topic_id IS NOT NULL AND c.next_at<=? LIMIT 20`).all(Date.now())) {
		const params = { chat_id: settings.chatId, text: `Pi · ${card.name}\n${card.phase}${card.detail ? `\n${card.detail}` : ''}`, reply_markup: keyboard(card) };
		try {
			if (!card.message_id) {
				db.prepare("UPDATE tg_cards SET status='sending' WHERE session_id=?").run(card.session_id);
				const message = await api('sendMessage', { ...params, message_thread_id: card.topic_id, disable_notification: true }, signal);
				db.prepare("UPDATE tg_cards SET message_id=?,status='ready' WHERE session_id=?").run(message.message_id, card.session_id);
				card.message_id = message.message_id;
			} else await api('editMessageText', { ...params, message_id: card.message_id }, signal);
			if (!card.pinned) {
				await api('pinChatMessage', { chat_id: settings.chatId, message_id: card.message_id, disable_notification: true }, signal);
				db.prepare('UPDATE tg_cards SET pinned=1 WHERE session_id=?').run(card.session_id);
			}
			// Do not clear a status change that arrived while the API request was in flight.
			db.prepare('UPDATE tg_cards SET dirty=0,status=\'ready\',error=NULL WHERE session_id=? AND phase=? AND detail=?').run(card.session_id, card.phase, card.detail);
		} catch (error) {
			const unchanged = /message is not modified/i.test(error.message);
			if (unchanged) {
				try {
					if (!card.pinned) { await api('pinChatMessage',{chat_id:settings.chatId,message_id:card.message_id,disable_notification:true},signal); db.prepare('UPDATE tg_cards SET pinned=1 WHERE session_id=?').run(card.session_id); }
					db.prepare('UPDATE tg_cards SET dirty=0 WHERE session_id=? AND phase=? AND detail=?').run(card.session_id, card.phase, card.detail);
				} catch { db.prepare('UPDATE tg_cards SET next_at=? WHERE session_id=?').run(Date.now()+5000,card.session_id); }
			}
			else db.prepare('UPDATE tg_cards SET status=?,error=?,next_at=? WHERE session_id=?')
				.run(error.code === 429 ? 'ready' : error.code === 'uncertain' && !card.message_id ? 'uncertain' : card.message_id ? 'ready' : 'failed', error.message,
					Date.now() + Math.max(5, Number(error.retryAfter) || 5) * 1000, card.session_id);
		}
	}
}
module.exports = { ensureCard, setStatus, keyboard, callbackSession, flushCards };
