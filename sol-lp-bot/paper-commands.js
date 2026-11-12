// Authenticated manual paper commands. Consumer is the ONLY paper-state writer.
'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const base=(dir)=>path.join(dir,'commands');
function pending(dir){const d=path.join(base(dir),'pending');return fs.existsSync(d)?fs.readdirSync(d).filter(n=>/^[a-zA-Z0-9_-]{8,80}\.json$/.test(n)).map(n=>JSON.parse(fs.readFileSync(path.join(d,n),'utf8'))).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)):[];}
function queue(dir,{type,pool,openedAt,requestId=crypto.randomUUID(),updatedBy,expectedPool,expectedOpenedAt,overrideFailedFilters=false,confirmedReasons=[]}){
 if(!['open','switch','close'].includes(type)||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pool)||!/^[a-zA-Z0-9_-]{8,80}$/.test(requestId))throw Error('Invalid paper command');
 if(type==='switch'&&(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(expectedPool)||!Number.isFinite(Date.parse(expectedOpenedAt))))throw Error('Current position identity required');
 if(!Array.isArray(confirmedReasons)||confirmedReasons.length>20||confirmedReasons.some(x=>typeof x!=='string'||x.length>300))throw Error('Invalid confirmed filters');
 if(type==='close'&&!Number.isFinite(Date.parse(openedAt)))throw Error('Position identity required');
 for(const status of ['pending','applied']){
  const f=path.join(base(dir),status,requestId+'.json');if(!fs.existsSync(f))continue;
  const old=JSON.parse(fs.readFileSync(f));if(old.type!==type||old.pool!==pool||old.updatedBy!==updatedBy||old.openedAt!==openedAt||old.expectedPool!==expectedPool||old.expectedOpenedAt!==expectedOpenedAt||!!old.overrideFailedFilters!==!!overrideFailedFilters||JSON.stringify(old.confirmedReasons||[])!==JSON.stringify(confirmedReasons))throw Error('Request ID conflict');
  return {ok:true,id:requestId,status:status==='pending'?'queued':'applied',duplicate:true};
 }
 if(pending(dir).length>=20)throw Error('Paper command queue full');
 const d=path.join(base(dir),'pending');fs.mkdirSync(d,{recursive:true,mode:0o700});
 const r={id:requestId,type,pool,openedAt,updatedBy,expectedPool,expectedOpenedAt,overrideFailedFilters:!!overrideFailedFilters,confirmedReasons,paper:true,createdAt:new Date().toISOString()},tmp=path.join(d,'.'+crypto.randomUUID()+'.tmp');
 fs.writeFileSync(tmp,JSON.stringify(r),{mode:0o600,flag:'wx'});try{fs.linkSync(tmp,path.join(d,requestId+'.json'));}finally{fs.unlinkSync(tmp);}
 return {ok:true,id:requestId,status:'queued',duplicate:false};
}
async function applyPending(state,dir,{execute,save,audit=()=>{},log=()=>{},afterCommit=async()=>{}}){
 if(!Array.isArray(state.paperCommands))state.paperCommands=[];
 let count=0;
 for(const r of pending(dir)){
  if(r.paper!==true||r.updatedBy!==Number(process.env.TELEGRAM_ALLOWED_ID||0)||!/^[a-zA-Z0-9_-]{8,80}$/.test(r.id))throw Error('Invalid queued paper command');
  const d=path.join(base(dir),'applied');fs.mkdirSync(d,{recursive:true,mode:0o700});
  if(state.paperCommands.some(x=>x.id===r.id)){fs.renameSync(path.join(base(dir),'pending',r.id+'.json'),path.join(d,r.id+'.json'));continue;}
  if(state.paperCommands.length>=10000)throw Error('Paper command ledger full');
  // Restore on error before commit, so a failed SDK/quote cannot overwrite an open position.
  const before=JSON.stringify(state);let result;
  try{result=await execute(r);if(!result||result.ok===false)throw Error(result?.error||'Paper action failed');}
  catch(e){for(const k of Object.keys(state))delete state[k];Object.assign(state,JSON.parse(before));result={ok:false,error:String(e.message).slice(0,200)};}
  const notice=result?._notify;if(result)delete result._notify;
  const receipt={...r,result,appliedAt:new Date().toISOString()};state.paperCommands.push(receipt);
  try{save(state);}catch(e){for(const k of Object.keys(state))delete state[k];Object.assign(state,JSON.parse(before));throw e;}
  audit(`uid=${r.updatedBy} action=paper-manual-${r.type} id=${r.id} pool=${r.pool} result=${JSON.stringify(result)}`);
  log(`manual ${r.type} ${r.pool}: ${result.ok?'berhasil':(r.type==='switch'?'gagal; perubahan virtual di-rollback: ':'')+result.error}`);
  fs.writeFileSync(path.join(base(dir),'pending',r.id+'.json'),JSON.stringify(receipt));
  fs.renameSync(path.join(base(dir),'pending',r.id+'.json'),path.join(d,r.id+'.json'));count++;
  try{await afterCommit(notice,receipt);}catch(e){log('manual notification failed after commit');}
 }
 return count;
}
function snapshot(dir){try{const s=JSON.parse(fs.readFileSync(path.join(dir,'state.json')));return {pending:pending(dir).length,last:(s.paperCommands||[]).slice(-3).map(x=>({id:x.id,type:x.type,result:x.result,appliedAt:x.appliedAt}))};}catch{return {pending:0,last:[]};}}
module.exports={queue,applyPending,snapshot};
