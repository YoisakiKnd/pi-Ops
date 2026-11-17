// Omitted execution settings belong to Pi, not to the transport plugin.
const LEGACY_TOOLS = ['read', 'grep', 'find', 'ls', 'memory_search', 'memory_save', 'ops_report'];
function validateAgent(input) {
 const prompt=String(input.prompt??'').trim();
 if(!prompt||prompt.length>20000)throw new Error('Agent prompt must contain 1–20000 characters');
 const spec={kind:'agent',policyVersion:2,prompt,intervalMs:input.intervalMs??3600000,failureThreshold:input.failureThreshold??3};
 for(const [key,min,max] of [['intervalMs',1000,31536000000],['failureThreshold',1,100],['timeoutMs',100,3600000],['maxTurns',1,100000],['maxOutputChars',100,100000]]){
  const value=key in spec?spec[key]:input[key];
  if(value===undefined)continue;
  if(!Number.isSafeInteger(value)||value<min||value>max)throw new Error(`Invalid ${key}`);
  spec[key]=value;
 }
 if(input.tools!==undefined){
  if(!Array.isArray(input.tools)||input.tools.length>50||input.tools.some(name=>typeof name!=='string'||!/^[-+A-Za-z0-9_*]+$/.test(name)))throw new Error('Agent tools must be an array of tool names or patterns');
  const selection=[...new Set(input.tools)];
  // Keep +/- Pi default-tool modifiers intact. An explicit allowlist gets the report tool.
  spec.tools=selection.length&&selection.every(name=>/^[+-]/.test(name))?selection:[...new Set([...selection,'ops_report'])];
 }
 return spec;
}
function upgradeLegacySpec(spec){
 if(spec.kind!=='agent'||spec.policyVersion)return null;
 const next={...spec,policyVersion:2};
 if(JSON.stringify(next.tools)===JSON.stringify(LEGACY_TOOLS))delete next.tools;
 if(next.maxTurns===12)delete next.maxTurns;
 if(next.maxOutputChars===32000)delete next.maxOutputChars;
 if(next.timeoutMs===300000)delete next.timeoutMs;
 return next;
}
module.exports={validateAgent,upgradeLegacySpec};
