const fs=require('node:fs');const path=require('node:path');const {spawn}=require('node:child_process');
const {allowedCwd}=require('./remote.cjs');
function planClone(text,settings){
 const match=String(text).match(/^\/clone(?:@\w+)?\s+(\S+)(?:\s+([A-Za-z0-9][A-Za-z0-9._-]{0,79}))?\s*$/i);if(!match)throw new Error('Usage: /clone <https-repository-url> [folder-name]');
 const url=new URL(match[1]);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!url.hostname||url.port)throw new Error('Clone requires a public HTTPS URL without credentials, query or custom port');
 const root=allowedCwd('',settings),name=match[2]||path.basename(url.pathname).replace(/\.git$/,'');
 if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name)||name==='.'||name==='..')throw new Error('Invalid repository folder name');
 const destination=path.join(root,name);if(fs.existsSync(destination))throw new Error('Clone destination already exists');
 return {url:url.href,destination,root};
}
async function cloneRepository(plan,{signal,spawnImpl=spawn,timeoutMs=120000,killGraceMs=1000}={}){
 if(signal?.aborted)throw new Error('Clone cancelled before startup');
 fs.mkdirSync(plan.destination,{mode:0o700});
 return new Promise((resolve,reject)=>{
  const env={...process.env,GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'};
  for(const key of Object.keys(env))if(/^GIT_(CONFIG|SSH|ASKPASS)/.test(key)&&!['GIT_CONFIG_NOSYSTEM','GIT_CONFIG_GLOBAL'].includes(key))delete env[key];
  const child=spawnImpl('git',['-c','core.hooksPath=/dev/null','-c','credential.helper=','-c','protocol.allow=never','-c','protocol.https.allow=always','-c','http.followRedirects=false','-c','filter.lfs.required=false','clone','--depth','1','--',plan.url,plan.destination],{cwd:plan.root,env,stdio:['ignore','ignore','pipe'],detached:process.platform!=='win32'});
  let detail='',failure,killTimer,reason;
  const kill=kind=>{try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,kind);else child.kill(kind);}catch(error){if(error.code!=='ESRCH')failure=error;}};
  const terminate=why=>{if(reason)return;reason=why;kill('SIGTERM');killTimer=setTimeout(()=>kill('SIGKILL'),killGraceMs);};
  const abort=()=>terminate('cancelled');
  const timer=setTimeout(()=>terminate('timed out'),timeoutMs);
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  child.stderr.on('data',chunk=>{detail=(detail+chunk.toString()).slice(-2000);});
  child.once('error',error=>{failure=error;});
  child.once('exit',()=>child.stderr.destroy?.());
  child.once('close',code=>{
   clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);
   if(reason||failure||code!==0)reject(new Error(`Clone ${reason||'failed'} (${code}); partial directory retained. ${failure?.message||detail}`));
   else resolve(plan.destination);
  });
 });
}
module.exports={planClone,cloneRepository};
