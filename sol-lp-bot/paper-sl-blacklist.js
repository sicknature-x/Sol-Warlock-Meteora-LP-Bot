'use strict';
// Persistent SL blacklist (token mints that closed by stop loss). Paper only. File: <paperDir>/sl-blacklist.json
const fs=require('fs'),path=require('path');
const file=dir=>path.join(dir,'sl-blacklist.json');
function read(dir){try{const j=JSON.parse(fs.readFileSync(file(dir),'utf8'));return j&&typeof j.mints==='object'?j:{mints:{}};}catch{return {mints:{}};}}
function write(dir,j){const f=file(dir),tmp=f+'.tmp';fs.writeFileSync(tmp,JSON.stringify(j,null,2)+'\n');fs.renameSync(tmp,f);}
function has(dir,mint){return !!(mint&&read(dir).mints[mint]);}
function isStopLoss(reason){const r=String(reason||'');return r==='emergency_stop'||r.startsWith('emergency_stop')||/^stop_loss/i.test(r);}
function add(dir,{mint,symbol,pool,reason,closedAt,source}){if(!mint)return false;const j=read(dir);if(j.mints[mint])return false;j.mints[mint]={symbol:symbol||null,pool:pool||null,reason:reason||null,closedAt:closedAt||null,source:source||'auto',addedAt:new Date().toISOString()};write(dir,j);return true;}
function remove(dir,mint){const j=read(dir);if(!j.mints[mint])return false;delete j.mints[mint];write(dir,j);return true;}
function list(dir){return Object.entries(read(dir).mints).map(([mint,v])=>({mint,...v}));}
module.exports={read,has,add,remove,list,isStopLoss,file};
