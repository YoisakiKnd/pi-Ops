// Isolated SDK host. The IPC channel is also a parent-liveness signal.
const controller = new AbortController();
let started = false;
let exitTimer;
function cancel() {
	controller.abort();
	// Handles a stuck extension/provider; the task is blocked for reconciliation.
	exitTimer ||= setTimeout(() => process.exit(2), 3000);
}
process.on('disconnect', cancel);
process.on('SIGTERM', cancel);
process.on('message', async message => {
	if (message?.type === 'cancel') { cancel(); return; }
	if (message?.type !== 'run' || started) return;
	started = true;
	let result;
	try {
		const { executeSession } = await import('./agent-session.mjs');
		result = await executeSession(message.task, { runId: message.runId, signal: controller.signal,
			onProgress: progress => { if (process.connected) process.send({ type: 'progress', progress }); },
		});
	} catch (error) { result = { status: 'failure', outcome: 'unknown', summary: String(error.message || error).slice(0, 2000) }; }
	clearTimeout(exitTimer);
	if (process.connected) process.send({ type: 'result', result }, () => process.exit(0));
	else process.exit(2);
});
