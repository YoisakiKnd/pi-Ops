const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isPathInside } = require('../shared/paths.cjs');
const MAX_DOWNLOAD = 20 * 1024 * 1024;
const MAX_UPLOAD = 50 * 1024 * 1024;
function safeName(value) {
	const name = path.basename(String(value || 'attachment').replaceAll('\\', '/')).replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 100);
	return !name || name === '.' || name === '..' ? 'attachment' : name;
}
function fileInside(cwd, requested) {
	const root = fs.realpathSync(cwd), file = fs.realpathSync(path.resolve(root, requested));
	if (!isPathInside(root, file) || !fs.statSync(file).isFile()) throw new Error('File must be a regular file inside the session project');
	return file;
}
function uploadFile(cwd, requested) {
	const file = fileInside(cwd, requested);
	const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
	try {
		const info = fs.fstatSync(fd);
		if (!info.isFile() || info.size > MAX_UPLOAD) throw new Error('File upload exceeds 50 MiB or is not a regular file');
		const parts = []; let total = 0;
		for (;;) {
			const chunk = Buffer.allocUnsafe(Math.min(65536, MAX_UPLOAD - total + 1));
			const count = fs.readSync(fd, chunk, 0, chunk.length, null); if (!count) break;
			total += count; if (total > MAX_UPLOAD) throw new Error('File upload exceeds 50 MiB');
			parts.push(chunk.subarray(0, count));
		}
		return { name: safeName(file), bytes: Buffer.concat(parts), field: 'document' };
	} finally { fs.closeSync(fd); }
}
function saveDownload(cwd, updateId, name, bytes) {
	if (!Number.isSafeInteger(updateId) || updateId < 0 || bytes.length > MAX_DOWNLOAD) throw new Error('Invalid or oversized attachment');
	const root = fs.realpathSync(cwd); let target = root;
	for (const segment of ['.pi-ops', 'inbox', String(updateId)]) {
		target = path.join(target, segment);
		try { fs.mkdirSync(target, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
		const info = fs.lstatSync(target);
		if (!info.isDirectory() || info.isSymbolicLink() || !isPathInside(root, fs.realpathSync(target))) throw new Error('Attachment inbox must not contain symlinks');
	}
	const file = path.join(target, safeName(name)), temporary = path.join(target, `.partial-${randomUUID()}`);
	try { fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); }
	finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
	return file;
}
async function receiveFile(api, session, updateId, payload, signal) {
	const attachment = payload.document || payload.photo?.at(-1);
	if (!attachment?.file_id || attachment.file_size > MAX_DOWNLOAD) throw new Error('Incoming attachment exceeds 20 MiB or has no file ID');
	const info = await api('getFile', { file_id: attachment.file_id }, signal);
	if (info.file_size > MAX_DOWNLOAD) throw new Error('Incoming attachment exceeds 20 MiB');
	const bytes = await api.download(info.file_path, signal);
	const file = saveDownload(session.cwd, updateId, attachment.file_name || (payload.photo ? 'photo.jpg' : path.basename(info.file_path)), bytes);
	return `${payload.caption || 'Please inspect the attached file.'}\n\nTelegram attachment saved inside this project: ${file}\nRead this file to inspect its contents.`;
}
module.exports = { MAX_DOWNLOAD, MAX_UPLOAD, safeName, fileInside, uploadFile, saveDownload, receiveFile };
