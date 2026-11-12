// Lightweight read-only screen refresh requests; never touches trading state.
'use strict';const fs=require('fs'),path=require('path'),crypto=require('crypto');
const defaults=require('./paper-settings').DEFAULTS;
const KEYS=[...require('./paper-strategy').KEYS,'MAX_POSITIONS','CAPITAL_ASSET','REOPEN_COOLDOWN_MIN','MAX_PUMP24H_PCT','POSITION_USDC','MIN_FT','MIN_LIQ_USD','MAX_LIQ_USD','MAX_NONREFUND_SOL','MIN_AGE_H','MIN_BIN_STEP','MAX_BIN_STEP','MAX_PUMP1H','MAX_PUMP_24H','VOL_SPIKE_1H_OF_24H','FILTERS_ENABLED','PUMP1H_FILTER_ENABLED','PUMP24H_FILTER_ENABLED','RUGCHECK_ENABLED','TOP_HOLDERS_ENABLED','CHECK_INSIDERS','MAX_INSIDER_PCT','ANTI_PVP_MODE','ANTI_PVP_MIN_LIQ_USD','OLD_DUMP_FILTER_ENABLED','OLD_TOKEN_MODE','OLD_DUMP_MIN_AGE_H','OLD_DUMP_MAX_PUMP24H','TVL_DROP_FILTER_ENABLED','TVL_DROP_MAX_PCT'];
const policy=v=>Object.fromEntries(KEYS.map(k=>[k,v[k]??defaults[k]]));
const signature=v=>JSON.stringify(policy(v));
function read(dir){try{return JSON.parse(fs.readFileSync(path.join(dir,'scan-request.json')));}catch{return null;}}
function request(dir,{manual=false,userId,reason='settings changed',now=Date.now()}={}){
 const old=read(dir);if(manual&&now-(old?.lastManualAt||0)<30000)return {ok:false,retryAfterSec:Math.ceil((30000-now+old.lastManualAt)/1000)};
 const r={id:crypto.randomUUID(),requestedAt:new Date(now).toISOString(),reason,userId,lastManualAt:manual?now:old?.lastManualAt||0};
 fs.mkdirSync(dir,{recursive:true});const f=path.join(dir,'scan-request.json'),tmp=f+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(r));fs.renameSync(tmp,f);return {ok:true,...r};
}
function status(dir,values,scan){const r=read(dir),policyChanged=scan?.policyKey!==signature(values),pending=!!r&&scan?.requestId!==r.id;
 return {stale:policyChanged||pending,policyChanged,pending,requestedAt:r?.requestedAt,reason:r?.reason,scanAt:scan?.at,usedPolicy:scan?.policy||scan?.filters||null,currentPolicy:policy(values)};}
function category(s){s=String(s);if(s.startsWith('fee/tvl'))return 'fee/tvl';if(s.startsWith('age<'))return 'age';if(s.startsWith('bin_step'))return 'bin_step';if(s.startsWith('pump1h'))return 'pump1h';if(s.startsWith('pump24'))return 'pump24h';if(s.startsWith('vol spike'))return 'vol spike';if(s.startsWith('vol1h low'))return 'vol1h';return s;}
module.exports={KEYS,policy,signature,read,request,status,category};
