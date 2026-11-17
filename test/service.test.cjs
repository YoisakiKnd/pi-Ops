const {test,after}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {EventEmitter}=require('node:events');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-ops-service-'));process.env.PI_CODING_AGENT_DIR=path.join(dir,'state');after(()=>fs.rmSync(dir,{recursive:true,force:true}));
const service=require('../service.cjs');const {planClone,cloneRepository}=require('../src/telegram/clone.cjs');
test('service definitions escape paths and preserve only operational environment',()=>{
 const mac=service.plan({platform:'darwin',home:dir,node:'/a&b/node',agentDir:'/state<test>',uid:501,environment:{PATH:'/bin',HTTPS_PROXY:'http://proxy',SECRET_KEY:'private'}});
 assert.match(mac.content,/a&amp;b/);assert.match(mac.content,/state&lt;test&gt;/);assert.doesNotMatch(mac.content,/SECRET_KEY|private/);assert.match(mac.content,/--service/);
 const linux=service.plan({platform:'linux',home:dir,node:'/path 100%/node',environment:{PATH:'/bin'}});assert.match(linux.content,/100%%/);assert.match(linux.content,/KillMode=control-group/);
 assert.throws(()=>service.plan({platform:'win32'}),/supports macOS/);
});
test('dry-run never writes a service file or invokes a manager',async()=>{
 const spec=await service.manage('install',{dryRun:true,home:dir,platform:'darwin',uid:501,run:()=>assert.fail('manager invoked')});assert.equal(fs.existsSync(spec.file),false);
});
test('service installation can be reviewed with an isolated manager and private file',async()=>{
 const calls=[];const spec=await service.manage('install',{home:dir,platform:'darwin',uid:501,run:(command,args)=>calls.push({command,args})});
 assert.equal(fs.statSync(spec.file).mode&0o777,0o600);assert.ok(calls.some(call=>call.args[0]==='bootstrap'));assert.ok(calls.some(call=>call.args[0]==='kickstart'));
});
test('clone plans reject credentials, option injection, custom protocols and traversal',()=>{
 const settings={wakeMode:true,wakeAllowedRoots:[dir],wakeDefaultCwd:dir};
 const plan=planClone('/clone https://example.com/team/repo.git local-repo',settings);assert.equal(plan.destination,path.join(fs.realpathSync(dir),'local-repo'));
 for(const text of ['/clone --upload-pack=evil','/clone file:///tmp/repo','/clone https://user:pass@example.com/repo','/clone https://example.com/repo ../escape'])assert.throws(()=>planClone(text,settings));
});
test('clone uses argument arrays, disables credential prompts and preserves failures',async()=>{
 const settings={wakeMode:true,wakeAllowedRoots:[dir],wakeDefaultCwd:dir},plan=planClone('/clone https://example.com/team/repo.git cloned',settings);let captured;
 await cloneRepository(plan,{spawnImpl:(command,args,options)=>{captured={command,args,options};const child=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};setTimeout(()=>child.emit('close',0),1);return child;}});
 assert.equal(captured.command,'git');assert.equal(captured.options.env.GIT_TERMINAL_PROMPT,'0');assert.equal(captured.args.at(-2),plan.url);assert.equal(captured.args.at(-3),'--');assert.ok(fs.existsSync(plan.destination));
 assert.throws(()=>planClone('/clone https://example.com/repo.git cloned',settings),/already exists/);
});

test('clone cancellation waits for a resistant process to actually exit',async()=>{
 const {spawn}=require('node:child_process');const controller=new AbortController();let exited=false;
 const plan=planClone('/clone https://example.com/repo.git cancel-clone',{wakeMode:true,wakeAllowedRoots:[dir],wakeDefaultCwd:dir});
 await assert.rejects(cloneRepository(plan,{signal:controller.signal,killGraceMs:30,spawnImpl:(_command,_args,options)=>{
  const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.stderr.write('ready');setInterval(()=>{},1000)"],options);
  child.stderr.once('data',()=>controller.abort());child.once('close',()=>{exited=true;});return child;
 }}),/cancelled/);
 assert.equal(exited,true);assert.ok(fs.existsSync(plan.destination));
});
test('an already cancelled clone neither starts a process nor reserves a directory',async()=>{
 const controller=new AbortController();controller.abort();
 const plan=planClone('/clone https://example.com/repo.git no-clone',{wakeMode:true,wakeAllowedRoots:[dir],wakeDefaultCwd:dir});
 await assert.rejects(cloneRepository(plan,{signal:controller.signal,spawnImpl:()=>assert.fail('spawned')}),/before startup/);
 assert.equal(fs.existsSync(plan.destination),false);
});
test('service stop preserves intent even if no broker can be contacted',async()=>{
 const runtime=require('../src/schedule/runtime.cjs');const original=runtime.requestDaemon;
 try{runtime.requestDaemon=async()=>{throw new Error('offline');};
 await service.manage('stop',{home:dir,platform:'darwin',uid:501,run:()=>{}});
 assert.equal(runtime.brokerDesired(),false);
 await service.manage('restart',{home:dir,platform:'darwin',uid:501,run:()=>{}});
 assert.equal(runtime.brokerDesired(),true);
 }finally{runtime.requestDaemon=original;}
});
