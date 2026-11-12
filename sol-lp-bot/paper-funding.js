// Virtual PAPER deposits only. No wallet, key, RPC, transaction, or live controls.
'use strict';
const multi=require('./paper-multi');
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const wib=(d=new Date())=>new Date(d).toLocaleString('sv-SE',{timeZone:'Asia/Jakarta'})+' WIB';
function dirs(paperDir){const root=path.join(paperDir,'capital');return {pending:path.join(root,'pending'),applied:path.join(root,'applied')};}
function initialize(state,initial=0){
 let changed=false;
 for(const b of Object.values(state.books||{})){
  if(!b.virtual)continue;
  if(!Number.isFinite(b.virtual.totalDepositedUsdc)){
   b.virtual.totalDepositedUsdc=Number.isFinite(b.virtual.usdcStart)?b.virtual.usdcStart:initial;changed=true;
  }
 }
 if(!Array.isArray(state.capitalDeposits)){state.capitalDeposits=[];changed=true;}
 return changed;
}
function amountValue(value){
 if(!['string','number'].includes(typeof value)||String(value).trim()==='')throw Error('Jumlah harus 1–10000 USDC');
 const n=Number(value);
 if(!Number.isFinite(n)||n<1||n>10000||Math.abs(n*1e6-Math.round(n*1e6))>.00001)throw Error('Jumlah harus 1–10000 USDC, maksimum 6 desimal');
 return Math.round(n*1e6)/1e6;
}
function entryCash(cash,budget,buffer=.1){return budget>0?Math.min(cash,budget+buffer):cash;}
function pendingFiles(paperDir){const p=dirs(paperDir).pending;return fs.existsSync(p)?fs.readdirSync(p).filter(x=>/^[a-zA-Z0-9_-]{8,80}\.json$/.test(x)).sort():[];}
function queueDeposit(paperDir,amount,{updatedBy,requestId=crypto.randomUUID()}={}){
 amount=amountValue(amount);
 if(!/^[a-zA-Z0-9_-]{8,80}$/.test(requestId))throw Error('Invalid request ID');
 const d=dirs(paperDir);fs.mkdirSync(d.pending,{recursive:true,mode:0o700});fs.mkdirSync(d.applied,{recursive:true,mode:0o700});
 for(const dir of [d.pending,d.applied]){
  const f=path.join(dir,requestId+'.json');if(!fs.existsSync(f))continue;
  const old=JSON.parse(fs.readFileSync(f,'utf8'));
  if(old.amount!==amount||old.updatedBy!==updatedBy)throw Error('Request ID sudah dipakai untuk jumlah lain');
  return {ok:true,id:requestId,amount,status:dir===d.applied?'applied':'queued',duplicate:true};
 }
 if(pendingFiles(paperDir).length>=100)throw Error('Antrean penuh; tunggu bot memproses');
 const request={id:requestId,amount,updatedBy,createdAt:new Date().toISOString(),createdWib:wib(),paper:true};
 // A dot-prefixed temp is never consumed. Hard-link publishes atomically without overwriting an ID.
 const tmp=path.join(d.pending,'.'+requestId+'.'+crypto.randomUUID()+'.tmp'),dest=path.join(d.pending,requestId+'.json');
 fs.writeFileSync(tmp,JSON.stringify(request),{flag:'wx',mode:0o600});
 try{fs.linkSync(tmp,dest);}finally{fs.unlinkSync(tmp);}
 return {ok:true,id:requestId,amount,status:'queued',duplicate:false};
}
function applyPending(state,paperDir,{save,audit=()=>{},log=()=>{}}){
 initialize(state);const d=dirs(paperDir);let count=0;
 for(const name of pendingFiles(paperDir)){
  const file=path.join(d.pending,name),r=JSON.parse(fs.readFileSync(file,'utf8'));
  if(r.id+'.json'!==name||r.paper!==true||r.updatedBy!==Number(process.env.TELEGRAM_ALLOWED_ID||0))throw Error('Invalid paper capital request');
  const amount=amountValue(r.amount),old=state.capitalDeposits.find(x=>x.id===r.id);
  fs.mkdirSync(d.applied,{recursive:true,mode:0o700});
  if(old){fs.renameSync(file,path.join(d.applied,name));continue;} // crash after commit: no double-credit
  if(state.capitalDeposits.length>=10000)throw Error('Paper capital ledger limit reached');
  const books=Object.values(state.books||{});if(!books.length||books.some(b=>!b.virtual))throw Error('Paper books unavailable');
  const before=books.map(b=>({usdc:b.virtual.usdc,total:b.virtual.totalDepositedUsdc}));
  if(before.some(b=>!Number.isFinite(b.usdc)||b.usdc<0||b.usdc+amount>1e9||b.total+amount>1e9))throw Error('Paper capital balance safety limit');
  const event={...r,type:'deposit',appliedAt:new Date().toISOString(),appliedWib:wib()};
  for(const b of books){b.virtual.usdc=Math.round((b.virtual.usdc+amount)*1e6)/1e6;b.virtual.totalDepositedUsdc=Math.round((b.virtual.totalDepositedUsdc+amount)*1e6)/1e6;}
  state.capitalDeposits.push(event);
  try{save(state);}catch(e){books.forEach((b,i)=>{b.virtual.usdc=before[i].usdc;b.virtual.totalDepositedUsdc=before[i].total;});state.capitalDeposits.pop();throw e;}
  // Persist balance + id atomically before moving request. Retried requests can never add twice.
  audit(`uid=${r.updatedBy} action=paper-capital-deposit-applied id=${r.id} amount=${amount} USDC (virtual only)`);
  log(`capital deposit applied: +${amount.toFixed(6)} USDC virtual, id=${r.id}; total deposits=${books[0].virtual.totalDepositedUsdc.toFixed(6)}`);
  fs.renameSync(file,path.join(d.applied,name));count++;
 }
 return count;
}
function snapshot(paperDir){
 let s;try{s=JSON.parse(fs.readFileSync(path.join(paperDir,'state.json'),'utf8'));}catch{return {available:false,pending:0};}
 const b=s.books?.N5||Object.values(s.books||{})[0];if(!b?.virtual)return {available:false,pending:0};
 const total=b.virtual.totalDepositedUsdc??b.virtual.usdcStart??0;
 return {available:true,capitalAsset:b.virtual.capitalAsset||'USDC',freeCapitalSol:b.virtual.capitalSol||0,totalDepositedSol:b.virtual.totalDepositedSol,virtualUsdc:b.virtual.usdc,totalDepositedUsdc:total,pending:pendingFiles(paperDir).length,
  lastDeposits:(s.capitalDeposits||[]).slice(-5).map(r=>({id:r.id,amount:r.amount,appliedWib:r.appliedWib})),positions:multi.positions(b).map(p=>({pool:p.pool,mintX:p.mintX,openedAt:p.openedAt,name:p.name})),openCount:multi.positions(b).length,lockedUsdc:multi.positions(b).reduce((n,p)=>n+(p.usdcIn||0),0)};
}
module.exports={initialize,amountValue,entryCash,queueDeposit,applyPending,snapshot};
