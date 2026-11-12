"use strict";
const fs=require('fs'),path=require('path');
function readArchivePolicy(dir){try{return JSON.parse(fs.readFileSync(path.join(dir,'history-archive-policy.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function archived(h,p){if(!p||!(Number(h.usdcIn)>500))return false;const t=Date.parse(h.openedAt);if(!Number.isFinite(t)||t<Date.parse(p.from)||t>=Date.parse(p.cutoff))return false;const ct=Date.parse(h.closedAt);if(Number.isFinite(ct)&&ct>=Date.parse(p.cutoff))return false; /* only rows already closed at policy time are archived; later closes always stay in history */const c=h.openContext||{},manual=['open','switch'].includes(c.sourceCode)||String(c.source||h.openSource||'').startsWith('Manual');return manual||(p.repeatPools||[]).includes(h.pool);}
function visible(history,p){return (history||[]).filter(h=>!archived(h,p));}
function cooldownReason(history,pool,minutes,now=Date.now()){if(!(minutes>0))return null;const times=(history||[]).filter(h=>h.pool===pool&&h.reason!=='oor_right_reposition_leg').map(h=>Date.parse(h.closedAt)).filter(Number.isFinite);if(!times.length)return null;const remain=Math.max(...times)+minutes*60000-now;return remain>0?`Cooldown pool: tunggu ${Math.ceil(remain/60000)} menit (batas ${minutes} menit sejak close)`:null;}
module.exports={readArchivePolicy,archived,visible,cooldownReason};
