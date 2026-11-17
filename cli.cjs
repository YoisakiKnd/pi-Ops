#!/usr/bin/env node
const { command } = require('./src/schedule/commands.cjs');
command(process.argv.slice(2)).then(output => process.stdout.write(`${output}\n`))
	.catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
