class TelegramError extends Error {
	constructor(message, code, retryAfter) { super(message); this.code = code; this.retryAfter = retryAfter; }
}
function createApi(settings, fetchImpl = fetch) {
	const api = async (method, params, signal, upload) => {
		let response;
		let body = JSON.stringify(params);
		if (upload) {
			body = new FormData();
			for (const [key, value] of Object.entries(params)) body.append(key, String(value));
			body.append(upload.field || 'document', new Blob([upload.bytes]), upload.name);
		}
		try {
			response = await fetchImpl(`${settings.apiBaseUrl}/bot${settings.token}/${method}`, {
				method: 'POST', headers: upload ? undefined : { 'content-type': 'application/json' }, body,
				signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35000)]) : AbortSignal.timeout(35000),
			});
		} catch { throw new TelegramError(`Telegram ${method} transport failed`, 'uncertain'); }
		let result;
		try { result = await response.json(); } catch { throw new TelegramError(`Telegram ${method} returned an unreadable response`, 'uncertain'); }
		if (!result.ok) throw new TelegramError(`Telegram ${method}: ${String(result.description || 'request failed').replaceAll(settings.token, '[redacted]').slice(0, 500)}`, result.error_code || response.status, result.parameters?.retry_after);
		return result.result;
	};
	api.download = async (filePath, signal) => {
		if (typeof filePath !== 'string' || !filePath || filePath.split('/').some(part => !part || part === '.' || part === '..') || /[\\%?#:]/.test(filePath)) throw new Error('Invalid Telegram file path');
		const { MAX_DOWNLOAD } = require('./files.cjs');
		let response;
		try { response = await fetchImpl(`${settings.apiBaseUrl}/file/bot${settings.token}/${filePath.split('/').map(encodeURIComponent).join('/')}`, {
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35000)]) : AbortSignal.timeout(35000), redirect: 'error',
		}); } catch { throw new TelegramError('Telegram file download failed', 'download'); }
		if (!response.ok || Number(response.headers.get('content-length')) > MAX_DOWNLOAD || !response.body) {
			await response.body?.cancel(); throw new Error('Telegram attachment is unavailable or exceeds 20 MiB');
		}
		const parts = []; let size = 0;
		try {
			for await (const chunk of response.body) { size += chunk.length; if (size > MAX_DOWNLOAD) throw new Error('Telegram attachment exceeds 20 MiB'); parts.push(Buffer.from(chunk)); }
		} catch { throw new Error('Telegram file download failed or exceeded 20 MiB'); }
		return Buffer.concat(parts);
	};
	return api;
}
module.exports = { createApi, TelegramError };
