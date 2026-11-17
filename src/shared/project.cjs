const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { slug } = require('../memory/store.cjs');

// An explicit ID follows a project across machines and moves. Without one,
// canonical paths isolate unrelated checkouts with the same directory name.
function projectFor(cwd) {
	let root = path.resolve(cwd || '.');
	try { root = fs.realpathSync(root); } catch (error) {
		if (error.code !== 'ENOENT') throw error;
	}
	let config = {};
	try { config = JSON.parse(fs.readFileSync(path.join(root, '.pi-ops.json'), 'utf8')); }
	catch (error) { if (error.code !== 'ENOENT') throw error; }
	if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid .pi-ops.json');
	const explicit = config.projectId;
	if (explicit !== undefined && (typeof explicit !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(explicit))) {
		throw new Error('projectId must be 1–48 letters, digits, underscores or hyphens');
	}
	const name = path.basename(root) || 'default';
	const id = explicit || `${slug(name).slice(0, 36)}-${createHash('sha256').update(root).digest('hex').slice(0, 12)}`;
	return { id, name, root, scope: `project:${id}`, legacyScope: `project:${slug(name)}` };
}

module.exports = { projectFor };
