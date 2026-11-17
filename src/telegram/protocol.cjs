const MAX_LINE_BYTES = 512 * 1024;
function send(socket, value) {
	if (!socket || socket.destroyed) throw new Error('Pi Ops bridge is disconnected');
	const line = JSON.stringify(value) + '\n';
	if (Buffer.byteLength(line) > MAX_LINE_BYTES || socket.writableLength > MAX_LINE_BYTES * 2) throw new Error('Pi Ops bridge message limit exceeded');
	socket.write(line);
}
function readLines(socket, onMessage) {
	let buffer = Buffer.alloc(0);
	socket.on('data', chunk => {
		buffer = Buffer.concat([buffer, chunk]);
		for (;;) {
			const newline = buffer.indexOf(10);
			if (newline < 0) break;
			if (newline > MAX_LINE_BYTES) { socket.destroy(); return; }
			const line = buffer.subarray(0, newline).toString('utf8'); buffer = buffer.subarray(newline + 1);
			try { onMessage(JSON.parse(line)); } catch { socket.destroy(); return; }
		}
		if (buffer.length > MAX_LINE_BYTES) socket.destroy();
	});
}
module.exports = { send, readLines };
