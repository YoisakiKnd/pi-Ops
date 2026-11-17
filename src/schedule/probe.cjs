const { performance } = require('node:perf_hooks');

function validateHttp(input) {
	const url = new URL(input.url);
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
		throw new Error('HTTP checks require an http(s) URL without embedded credentials');
	}
	const intervalMs = input.intervalMs ?? 300_000;
	const timeoutMs = input.timeoutMs ?? 10_000;
	const failureThreshold = input.failureThreshold ?? 3;
	for (const [key, value, min, max] of [
		['intervalMs', intervalMs, 1000, 31_536_000_000],
		['timeoutMs', timeoutMs, 1, 300_000],
		['failureThreshold', failureThreshold, 1, 100],
	]) {
		if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
	}
	const expectedStatus = input.expectedStatus ?? 200;
	if (!Number.isInteger(expectedStatus) || expectedStatus < 100 || expectedStatus > 599) throw new Error('Invalid expectedStatus');
	return { url: url.href, intervalMs, timeoutMs, failureThreshold, expectedStatus };
}

async function checkHttp(task, { fetchImpl = fetch, signal } = {}) {
	const start = performance.now();
	const timeout = AbortSignal.timeout(task.timeoutMs);
	try {
		const response = await fetchImpl(task.url, {
			method: 'GET', redirect: 'manual',
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		// Only headers are needed. Never accumulate an unbounded response body.
		await response.body?.cancel();
		return { status: response.status === task.expectedStatus ? 'success' : 'failure',
			statusCode: response.status, durationMs: Math.round(performance.now() - start),
			summary: `HTTP ${response.status}; expected ${task.expectedStatus}` };
	} catch (error) {
		return { status: signal?.aborted ? 'unknown' : timeout.aborted ? 'timeout' : 'failure',
			statusCode: null, durationMs: Math.round(performance.now() - start),
			summary: String(error.message || error).slice(0, 1000) };
	}
}
module.exports = { validateHttp, checkHttp };
