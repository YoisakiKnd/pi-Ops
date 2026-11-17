const { randomBytes } = require('node:crypto');
function initialize(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS tg_questions(id TEXT PRIMARY KEY,request_id TEXT UNIQUE NOT NULL,session_id TEXT NOT NULL,
 text TEXT NOT NULL,options TEXT NOT NULL,multiple INTEGER NOT NULL,selected TEXT NOT NULL DEFAULT '[]',answer TEXT,
 status TEXT NOT NULL DEFAULT 'pending',message_id INTEGER,expires_at INTEGER NOT NULL,dirty INTEGER NOT NULL DEFAULT 1,delivered INTEGER NOT NULL DEFAULT 0,error TEXT);`);
 if(!db.prepare('PRAGMA table_info(tg_questions)').all().some(row=>row.name==='next_at'))db.exec('ALTER TABLE tg_questions ADD COLUMN next_at INTEGER NOT NULL DEFAULT 0');
}
function ask(db,sessionId,input) {
 if(typeof input.requestId!=='string'||input.requestId.length>200||!input.requestId||typeof input.question!=='string'||!input.question.trim()||input.question.length>2000||
 !Array.isArray(input.options)||input.options.length<1||input.options.length>12||input.options.some(value=>typeof value!=='string'||!value.trim()||value.length>80)) throw new Error('Invalid Telegram question');
 const seconds=input.timeoutSeconds??300;if(!Number.isInteger(seconds)||seconds<1||seconds>3600)throw new Error('Invalid question timeout');
 const existing=db.prepare('SELECT * FROM tg_questions WHERE request_id=?').get(input.requestId);
 if(existing&&existing.session_id!==sessionId)throw new Error('Question belongs to another session');
 db.prepare('INSERT OR IGNORE INTO tg_questions(id,request_id,session_id,text,options,multiple,expires_at) VALUES(?,?,?,?,?,?,?)')
 .run(randomBytes(10).toString('hex'),input.requestId,sessionId,input.question,JSON.stringify(input.options),input.multiple===true?1:0,Date.now()+seconds*1000);
 return db.prepare('SELECT * FROM tg_questions WHERE request_id=?').get(input.requestId);
}
function keyboard(row) {
 if(row.status!=='open')return {inline_keyboard:[]};
 const selected=new Set(JSON.parse(row.selected));
 const rows=JSON.parse(row.options).map((text,index)=>[{text:`${selected.has(index)?'✓ ':''}${text}`,callback_data:`q:${row.id}:${index}`}]);
 if(row.multiple)rows.push([{text:'Done',callback_data:`q:${row.id}:done`}]);
 rows.push([{text:'Cancel',callback_data:`q:${row.id}:cancel`}]);return {inline_keyboard:rows};
}
function answer(db,query,settings) {
 if(query.from?.id!==settings.allowedUserId||query.from.is_bot||query.message?.chat?.id!==settings.chatId)throw new Error('Unauthorized question response');
 const match=String(query.data).match(/^q:([a-f0-9]{20}):(\d+|done|cancel)$/);if(!match)throw new Error('Invalid question response');
 const row=db.prepare('SELECT q.*,s.topic_id FROM tg_questions q JOIN tg_sessions s ON q.session_id=s.id WHERE q.id=?').get(match[1]);
 if(!row||row.message_id!==query.message.message_id||row.topic_id!==query.message.message_thread_id||row.status!=='open'||row.expires_at<=Date.now())throw new Error('Question expired or already answered');
 const options=JSON.parse(row.options);let selected=JSON.parse(row.selected),status='open';
 if(match[2]==='cancel')status='cancelled';
 else if(match[2]==='done'){if(!row.multiple||!selected.length)throw new Error('Select at least one option');status='answered';}
 else {const index=Number(match[2]);if(!Number.isInteger(index)||index<0||index>=options.length)throw new Error('Invalid option');
 if(row.multiple)selected=selected.includes(index)?selected.filter(value=>value!==index):[...selected,index].sort((a,b)=>a-b);
 else {selected=[index];status='answered';}}
 db.prepare('UPDATE tg_questions SET status=?,selected=?,answer=?,dirty=1 WHERE id=?').run(status,JSON.stringify(selected),status==='answered'?JSON.stringify(selected.map(index=>options[index])):null,row.id);
}
async function flush(db,settings,api,topic,signal) {
 db.prepare("UPDATE tg_questions SET status='expired',dirty=1 WHERE status IN ('pending','open') AND expires_at<=?").run(Date.now());
 for(const row of db.prepare("SELECT * FROM tg_questions WHERE dirty=1 AND status NOT IN ('uncertain','failed') AND next_at<=? LIMIT 30").all(Date.now())){
  try{
   if(!row.message_id&&row.status==='pending'){
    const thread=await topic(row.session_id);
    if(!db.prepare("UPDATE tg_questions SET status='sending' WHERE id=? AND status='pending' AND expires_at>?").run(row.id,Date.now()).changes)continue;
    const message=await api('sendMessage',{chat_id:settings.chatId,message_thread_id:thread,text:row.text,reply_markup:keyboard({...row,status:'open'})},signal);
    db.prepare("UPDATE tg_questions SET message_id=?,dirty=CASE WHEN status='sending' THEN 0 ELSE 1 END,status=CASE WHEN status='sending' THEN 'open' ELSE status END WHERE id=?").run(message.message_id,row.id);
   }else if(row.message_id){await api('editMessageReplyMarkup',{chat_id:settings.chatId,message_id:row.message_id,reply_markup:keyboard(row)},signal);db.prepare('UPDATE tg_questions SET dirty=0 WHERE id=? AND selected=? AND status=?').run(row.id,row.selected,row.status);}
   else db.prepare('UPDATE tg_questions SET dirty=0 WHERE id=?').run(row.id);
  }catch(error){
   if(row.message_id&&/message is not modified/i.test(error.message)){db.prepare('UPDATE tg_questions SET dirty=0 WHERE id=? AND selected=? AND status=?').run(row.id,row.selected,row.status);continue;}
   const retry=error.code===429;const seconds=Number(error.retryAfter);const delay=Number.isFinite(seconds)?Math.max(1,Math.min(3600,seconds)):5;
   const status=retry?(row.message_id?row.status:'pending'):error.code==='uncertain'&&!row.message_id?'uncertain':row.message_id?row.status:'failed';
   db.prepare("UPDATE tg_questions SET status=CASE WHEN status IN ('answered','cancelled','expired') THEN status ELSE ? END,error=?,next_at=? WHERE id=?").run(status,error.message,Date.now()+delay*1000,row.id);
  }
 }
}
module.exports={initialize,ask,keyboard,answer,flush};
