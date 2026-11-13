"use strict";
// Realized PnL per UTC day (daily reset 00:00 UTC = 07:00 WIB) from the same visible history (same archive/hide policy) the bot uses for History + totals.
const fs=require('fs'),path=require('path'),entryPolicy=require('./paper-entry-policy');
const pnlUsdOf=h=>h.pnlUsd!=null?+h.pnlUsd:(+h.netPnlUsd||0);
// SOL view: the trade's own SOL result (netPnlSol), else USD / the SOL price at close; 0 when neither exists.
const pnlSolOf=h=>{const n=Number(h&&h.netPnlSol);if(Number.isFinite(n))return n;const px=Number(h&&(h.solUsd??h.displaySolUsd));return px>0?pnlUsdOf(h)/px:0;};
function dayKey(iso){const t=Date.parse(iso);return Number.isFinite(t)?new Date(t).toISOString().slice(0,10):null;}
function capitalOf(h){const v=Number(h&&(h.initialUsdcIn??h.usdcIn));return Number.isFinite(v)&&v>0?v:null;}
function nameOf(h){const n=String((h&&(h.name||h.pair))||'').trim();return n||'Pool';}
function groupTokens(rows){
  const map=new Map();
  for(const r of rows){
    const g=map.get(r.name)||{name:r.name,trades:0,pnl:0,pnlSol:0};
    g.trades++;g.pnl+=r.pnlUsd;g.pnlSol+=r.pnlSol||0;map.set(r.name,g);
  }
  return [...map.values()]
    .map(g=>({name:g.name,trades:g.trades,pnl:+g.pnl.toFixed(4),pnlSol:+g.pnlSol.toFixed(6)}))
    .sort((a,b)=>b.pnl-a.pnl||a.name.localeCompare(b.name));
}
function fromHistory(history,policy){
  const days={};let total=0,totalSol=0,trades=0;
  for(const h of entryPolicy.visible(history||[],policy)){const k=dayKey(h.closedAt);if(!k)continue;const v=pnlUsdOf(h),vs=pnlSolOf(h);
    const d=days[k]||(days[k]={pnl:0,trades:0,wins:0,losses:0,profit:0,minus:0,pnlSol:0,profitSol:0,minusSol:0,rows:[]});
    d.pnl+=v;d.pnlSol+=vs;d.trades++;if(v>0){d.wins++;d.profit+=v;}else if(v<0){d.losses++;d.minus+=v;}
    if(vs>0)d.profitSol+=vs;else if(vs<0)d.minusSol+=vs;
    total+=v;totalSol+=vs;trades++;
    d.rows.push({name:nameOf(h),closedAt:h.closedAt,pnlUsd:v,pnlSol:+vs.toFixed(6),capital:capitalOf(h)});
  }
  for(const d of Object.values(days)){
    d.rows.sort((a,b)=>String(a.closedAt||'').localeCompare(String(b.closedAt||'')));
    d.tokens=groupTokens(d.rows);
    d.profit=+d.profit.toFixed(4);
    d.minus=+d.minus.toFixed(4);
    d.pnl=+d.pnl.toFixed(4);
    d.pnlSol=+d.pnlSol.toFixed(6);d.profitSol=+d.profitSol.toFixed(6);d.minusSol=+d.minusSol.toFixed(6);
  }
  return {days,total:+total.toFixed(4),totalSol:+totalSol.toFixed(6),trades};
}
function build(paperDir){
  let st={};try{st=JSON.parse(fs.readFileSync(path.join(paperDir,'state.json'),'utf8'));}catch{}
  const all=[];for(const b of Object.values(st.books||{}))all.push(...(b.history||[]));
  // All history incl. archived rows, so calendar total = Total PnL = equity - modal - open PnL.
  return {...fromHistory(all,null),archivedIncluded:true,tz:'UTC (reset 00:00 UTC = 07:00 WIB)'};
}
// LIVE only when the bot config explicitly says live AND the STOP lock is gone; anything else is DRY RUN.
function mode(env={},stopPresent=true){
  const paper=String(env.PAPER??'1')!=='0',dry=String(env.DRY_RUN??'1')!=='0',confirmed=String(env.LIVE_CONFIRMED??'0')==='1';
  const live=!paper&&!dry&&confirmed&&!stopPresent;
  return {label:live?'LIVE':'DRY RUN',live,paper,dryRun:dry,liveConfirmed:confirmed,stopPresent:!!stopPresent};
}
module.exports={build,fromHistory,mode,dayKey,pnlUsdOf,pnlSolOf};
