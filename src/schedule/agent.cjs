const { fork } = require('node:child_process');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

function runAgent(task, { signal, runId, onProgress = () => {}, workerPath = path.join(__dirname, 'agent-worker.cjs'), forkImpl = fork, killGraceMs = 4000 } = {}) {
	return new Promise(resolve => {
		if (signal?.aborted) { resolve({ status: 'unknown', outcome: 'unknown', summary: 'Agent run cancelled before startup' }); return; }
		const start = performance.now();
		let child;
		try { child = forkImpl(workerPath, [], { cwd: task.cwd, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: process.env }); }
		catch (error) { resolve({ status: 'failure', outcome: 'unknown', summary: error.message }); return; }
		let result;
		let reason;
		let killTimer;
		let bytes = 0;
		let diagnostics = '';
		let progress = {};
		const cancel = why => {
			if (reason) return;
			reason = why;
			if (child.connected) child.send({ type: 'cancel' }, () => {});
			killTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
		};
		const abort = () => cancel('cancelled');
		signal?.addEventListener('abort', abort, { once: true });
		const timer = setTimeout(() => cancel('timeout'), task.timeoutMs);
		for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
			bytes += chunk.length;
			diagnostics = (diagnostics + chunk.toString()).slice(-2000);
			if (bytes > task.maxOutputChars * 4) cancel('output limit');
		});
		child.on('message', message => {
			if (message?.type === 'progress') {
				try { progress = message.progress; onProgress(progress); }
				catch { cancel('progress persistence failed'); }
			}
			if (message?.type === 'result') result = message.result;
		});
		child.once('error', error => { result = { status: 'failure', outcome: 'unknown', summary: error.message }; });
		// An unrelated tool descendant may have inherited these pipes. Its handles
		// must not keep a terminated worker's run open indefinitely.
		child.once('exit', () => { child.stdout.destroy(); child.stderr.destroy(); });
		child.once('close', (code, exitSignal) => {
			clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
			if (reason) result = { status: reason === 'timeout' ? 'timeout' : 'unknown', outcome: 'unknown', summary: `Pi Agent interrupted: ${reason}` };
			if (!result || (code !== 0 && !reason)) result = { status: 'unknown', outcome: 'unknown', summary: `Pi Agent worker exited before completion (${exitSignal || code})`, diagnostics };
			resolve({ ...progress, ...result, executionMode: 'pi-sdk', durationMs: Math.round(performance.now() - start) });
		});
		child.send({ type: 'run', task, runId }, error => { if (error) cancel('IPC failure'); });
		if (signal?.aborted) abort();
	});
}
module.exports = { runAgent };
