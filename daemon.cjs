#!/usr/bin/env node
process.env.PI_OPS_DAEMON = '1';
require('./src/schedule/runtime.cjs').runWakeDaemon({service:process.argv.includes('--service')}).catch(error => {
 process.stderr.write(`${error.message}\n`); process.exitCode = 1;
});
