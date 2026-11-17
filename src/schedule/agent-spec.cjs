const DEFAULT_TOOLS = ['read', 'grep', 'find', 'ls', 'memory_search', 'memory_save', 'ops_report'];
function validateAgent(input) {
	const prompt = String(input.prompt ?? '').trim();
	if (!prompt || prompt.length > 20_000) throw new Error('Agent prompt must contain 1–20000 characters');
	const spec = { kind: 'agent', prompt, intervalMs: input.intervalMs ?? 3_600_000,
		timeoutMs: input.timeoutMs ?? 300_000, failureThreshold: input.failureThreshold ?? 3,
		maxTurns: input.maxTurns ?? 12, maxOutputChars: input.maxOutputChars ?? 32_000 };
	for (const [key, min, max] of [['intervalMs', 1000, 31_536_000_000], ['timeoutMs', 100, 3_600_000],
		['failureThreshold', 1, 100], ['maxTurns', 1, 100], ['maxOutputChars', 100, 100_000]]) {
		if (!Number.isSafeInteger(spec[key]) || spec[key] < min || spec[key] > max) throw new Error(`Invalid ${key}`);
	}
	const tools = input.tools ?? DEFAULT_TOOLS;
	if (!Array.isArray(tools) || tools.length > 50 || tools.some(name => typeof name !== 'string' || !/^[A-Za-z0-9_*-]+$/.test(name))) {
		throw new Error('Agent tools must be an array of tool names or patterns');
	}
	spec.tools = [...new Set([...tools, 'ops_report'])];
	return spec;
}
module.exports = { validateAgent, DEFAULT_TOOLS };
