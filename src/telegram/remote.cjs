const fs = require('node:fs');
const path = require('node:path');
const { isPathInside } = require('../shared/paths.cjs');
function parseNew(text) {
	const match = String(text).match(/^\/new(?:@\w+)?(?:\s+([\s\S]*))?$/i); if (!match) return null;
	const argument = (match[1] || '').trim(), separator = argument.indexOf('|');
	return separator < 0 ? { folder: argument, prompt: '' } : { folder: argument.slice(0, separator).trim(), prompt: argument.slice(separator + 1).trim() };
}
function allowedCwd(folder, settings) {
	if (!settings.wakeMode) throw new Error('Remote sessions require wakeMode');
	const requested = folder || settings.wakeDefaultCwd;
	if (!requested) throw new Error('Specify a project directory: /new <folder> | <prompt>');
	if (!path.isAbsolute(requested) && !settings.wakeDefaultCwd) throw new Error('Relative project paths require wakeDefaultCwd');
	const cwd = fs.realpathSync(path.resolve(settings.wakeDefaultCwd || process.cwd(), requested));
	if (!fs.statSync(cwd).isDirectory() || !settings.wakeAllowedRoots.some(root => isPathInside(fs.realpathSync(root), cwd))) throw new Error('Project is outside wakeAllowedRoots');
	return cwd;
}
module.exports = { parseNew, allowedCwd };
