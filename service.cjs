#!/usr/bin/env node
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {execFileSync}=require('node:child_process');
const {AGENT_DIR,OPS_DIR}=require('./src/shared/paths.cjs');
const LABEL='dev.pi-ops.agent';const UNIT='pi-ops.service';
const xml=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));
const quote=value=>'"'+String(value).replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/%/g,'%%').replace(/\n/g,'\\n')+'"';
function plan({platform=process.platform,home=os.homedir(),node=process.execPath,agentDir=AGENT_DIR,environment=process.env,uid=process.getuid?.()}={}){
 const daemon=path.join(__dirname,'daemon.cjs'),env={PI_CODING_AGENT_DIR:agentDir,PATH:environment.PATH||'/usr/bin:/bin'};
 for(const key of ['HTTP_PROXY','HTTPS_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy','NODE_USE_ENV_PROXY'])if(environment[key])env[key]=environment[key];
 if(platform==='darwin')return {file:path.join(home,'Library/LaunchAgents',`${LABEL}.plist`),target:`gui/${uid}/${LABEL}`,content:`<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array>${[node,daemon,'--service'].map(value=>`<string>${xml(value)}</string>`).join('')}</array><key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key,value])=>`<key>${xml(key)}</key><string>${xml(value)}</string>`).join('')}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer><key>StandardOutPath</key><string>${xml(path.join(agentDir,'pi-ops/service.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(agentDir,'pi-ops/service.log'))}</string></dict></plist>\n`};
 if(platform==='linux')return {file:path.join(home,'.config/systemd/user',UNIT),target:UNIT,content:`[Unit]\nDescription=Pi Ops broker and scheduler\nAfter=network-online.target\n[Service]\nType=simple\nExecStart=${quote(node)} ${quote(daemon)} --service\n${Object.entries(env).map(([key,value])=>`Environment=${quote(`${key}=${value}`)}`).join('\n')}\nRestart=always\nRestartSec=5\nKillMode=control-group\n[Install]\nWantedBy=default.target\n`};
 throw new Error('Service installation supports macOS launchd and Linux systemd user services; run node daemon.cjs on other platforms');
}
function writePrivate(file,content){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;try{fs.writeFileSync(tmp,content,{mode:0o600,flag:'wx'});fs.renameSync(tmp,file);}finally{fs.rmSync(tmp,{force:true});}}
async function manage(action,{dryRun=false,run=(command,args)=>execFileSync(command,args,{stdio:'inherit'}),...options}={}){
 const spec=plan(options),platform=options.platform||process.platform,domain=spec.target.split('/').slice(0,2).join('/');
 if(dryRun)return spec;
 if(!['install','start','stop','restart','uninstall','status'].includes(action))throw new Error('Usage: node service.cjs install|start|stop|restart|uninstall|status [--dry-run]');
 const runtime=require('./src/schedule/runtime.cjs');

 if(action==='status'){run(platform==='darwin'?'launchctl':'systemctl',platform==='darwin'?['print',spec.target]:['--user','status',UNIT]);return spec;}
 if(['stop','restart','uninstall'].includes(action)){
  const db=require('./src/schedule/store.cjs').openSchedule();try{db.prepare("INSERT INTO meta VALUES('broker_desired','0') ON CONFLICT(key) DO UPDATE SET value='0'").run();}finally{db.close();}
  try{await runtime.requestDaemon('/stop',{method:'POST'});}catch{/* No active broker. */}
  if(platform==='darwin'){try{run('launchctl',['bootout',spec.target]);}catch{/* Not loaded. */}}else run('systemctl',['--user','stop',UNIT]);
 } if(['install','start','restart'].includes(action)){const db=require('./src/schedule/store.cjs').openSchedule();try{db.prepare("INSERT INTO meta VALUES('broker_desired','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();}finally{db.close();}}
 if(action==='uninstall'){if(platform==='linux')run('systemctl',['--user','disable',UNIT]);fs.rmSync(spec.file,{force:true});if(platform==='linux')run('systemctl',['--user','daemon-reload']);return spec;}
 if(action==='stop')return spec;
 if(action==='install'){fs.mkdirSync(OPS_DIR,{recursive:true,mode:0o700});writePrivate(spec.file,spec.content);}
 if(platform==='darwin'){
  if(action==='install'){try{run('launchctl',['bootout',spec.target]);}catch{}}
  try{run('launchctl',['bootstrap',domain,spec.file]);}catch(error){if(action!=='start')throw error;try{run('launchctl',['print',spec.target]);}catch{throw error;}}
  run('launchctl',['kickstart',spec.target]);
 }else{run('systemctl',['--user','daemon-reload']);run('systemctl',['--user',action==='install'?'enable':'start',...(action==='install'?['--now']:[]),UNIT]);}
 return spec;
}
if(require.main===module)manage(process.argv[2],{dryRun:process.argv.includes('--dry-run')}).then(result=>{if(process.argv.includes('--dry-run'))process.stdout.write(JSON.stringify(result,null,2)+'\n');}).catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
module.exports={plan,manage,writePrivate};
