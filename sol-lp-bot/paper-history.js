"use strict";
// Provenance only: never changes settings, inventory or exit decisions.
const fs=require('fs'),path=require('path');
const SOURCES={auto:'Auto (bot)',open:'Manual (tombol Open sekarang)',switch:'Manual (Ganti pool)',reposition:'Reposition',unknown:'tidak diketahui'};
const wb=t=>new Date(t).toLocaleString('sv-SE',{timeZone:'Asia/Jakarta'})+' WIB';
const num=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(+v)?+v:null;
function capture(pool,{source='auto',requestId=null,updatedBy=null,strategy='N5',capitalAsset='USDC',capitalInSol=null,settings={},at=new Date().toISOString()}={}){
 const t=num(pool.created_at),secs=t===null?null:t>1e12?t/1000:t;
 const failed=Array.isArray(pool.manualWarnings)?[...pool.manualWarnings]:[];
 const screened=source!=='reposition'&&source!=='unknown';
 return {version:1,source:SOURCES[source]||SOURCES.unknown,sourceCode:source,requestId,updatedBy,at,
  reason:source==='auto'?'Lolos screening bot':source==='reposition'?'OOR kanan: reposisi setelah konfirmasi; profit net USDC di bawah ambang':source==='unknown'?'Bukti sumber buka tidak tersedia':failed.length?'Dibuka manual dengan peringatan filter':'Dibuka manual; lolos screening',
  snapshot:{capitalAsset,capitalInSol,entryCostEstimate:pool.entryCostEstimate||null,ft30mPct:num(pool.fee_tvl_ratio?.['30m']),tvlUsd:num(pool.tvl),ageH:secs===null?null:Math.max(0,(Date.parse(at)/1000-secs)/3600),binStep:num(pool.pool_config?.bin_step),marketCapUsd:num(pool.token_x?.market_cap),insiderPct:num(pool.entryInsiderPct),vol1hUsd:num(pool.volume?.['1h']),vol24hUsd:num(pool.volume?.['24h']),pump1hPct:num(pool.pump1h)===null?null:pool.pump1h*100,pump24hPct:num(pool.pump24h)===null?null:pool.pump24h*100,quote:pool.token_y?.symbol||(pool.token_y?.address==='So11111111111111111111111111111111111111112'?'SOL':pool.token_y?.address==='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'?'USDC':null),strategy,
   passedAllFilters:screened?!failed.length:null,failedFilters:screened?failed:null,screenedAt:at,
   policy:screened?Object.fromEntries(['MAX_LIQ_USD','MAX_NONREFUND_SOL','MIN_FT','MIN_LIQ_USD','MIN_AGE_H','MIN_BIN_STEP','MAX_BIN_STEP','MAX_PUMP1H','MAX_PUMP_24H','VOL_SPIKE_1H_OF_24H','RUGCHECK','MAX_TOP10_HOLD','MAX_DEV_HOLD'].filter(k=>settings[k]!==undefined).map(k=>[k,settings[k]])):null,
   evidence:source==='reposition'?'Fresh pool metrics; reposition sanity check only, not a complete entry screening':'Fresh screening accepted for this entry',precision:'full'}};
}
function closeReason(h){
 const r=typeof h==='string'?h:h.reason||'',asset=typeof h==='object'?(h.capitalAsset||'USDC'):'USDC',net=typeof h==='object'&&/^net-(?:usdc|sol)-/.test(h.riskPolicyVersion||'');
 if(r.startsWith('emergency_stop SL '))return 'Stop Loss '+r.slice(15).replace(/^SL /,'')+' net '+asset;
 if(r==='emergency_stop')return net?'Emergency: kerugian net '+asset+' mencapai batas':'Emergency: harga token turun (aturan lama)';
 if(r.startsWith('TP USDC')||r.startsWith('TP SOL'))return 'Take profit '+r.replace(/^TP /,'');
 if(r==='oor_right_take_profit')return net?'OOR kanan: profit net '+asset+' memenuhi ambang':'OOR kanan: take profit (aturan lama)';
 if(r==='oor_right_take_profit_fallback')return 'OOR kanan: profit net '+asset+' (estimasi on-chain setelah 10 poll gagal)';
 if(r==='oor_right_reposition_limit')return 'OOR kanan: batas reposition tercapai';
 if(r==='oor_right_reposition_leg')return 'Reposition kanan (lanjut posisi, bukan penutupan final)';
 if(r==='oor_right_quote_unavailable')return 'OOR kanan: quote tidak tersedia (aturan lama)';
 if(r.startsWith('oor_right_reposition_failed'))return 'Reposition kanan gagal (aturan lama)';
 if(r==='manual_close')return 'Ditutup manual';
 if(r.startsWith('manual_switch_to_'))return 'Manual: ganti pool';
 if(r.startsWith('max age ')){const m=r.match(/^max age ([\d.]+)h(?: \(stale (\w+) ([^)]+)\))?/);return 'Stale close: umur ≥ '+(m?m[1]:r.slice(8))+' jam'+(m&&m[2]?' · syarat '+m[2]+' '+m[3]:' · tutup langsung (berapa pun PnL)');}
 if(r==='trailing_tp_usdc')return 'Trailing profit net '+asset;
 if(r.startsWith('emergency_slplus '))return 'TP Emergency SL+ (kunci profit setelah TP emergency aktif) '+r.slice(17).replace(/ \(recalc\)$/,'');
 if(r.startsWith('emergency_tp '))return 'TP emergency (harga sempat turun dalam dari entry) '+r.slice(13);
 if(r==='oor_left_timeout')return 'OOR kiri melewati batas waktu';
 if(r==='paper STOP')return 'Paper dihentikan (STOP)';
 if(r==='paper 7d window ended')return 'Periode paper berakhir';
 return 'tidak diketahui';
}
function readEvidence(dir){
 const text=fs.existsSync(path.join(dir,'bot.log'))?fs.readFileSync(path.join(dir,'bot.log'),'utf8'):'';
 const events=[];
 for(const [i,line] of text.split('\n').entries()){
  const tm=line.match(/^\[(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) WIB\]/);if(!tm)continue;
  const at=new Date(`${tm[1]}T${tm[2]}+07:00`).toISOString(),time=Date.parse(at);
  const open=line.match(/PAPER OPEN \[([^\]]+)\] (.+?): spent /);
  if(open)events.push({type:'open',at,time,name:open[2],strategy:open[1],manual:line.includes('(manual committed)'),line:i+1,text:line});
  const pass=line.match(/PASS (\S+) (\S+) ft30m=([\d.]+)% tvl=\$([\d.]+) age=([\d.]+)h bs=(\d+)/);
  if(pass)events.push({type:'pass',at,time,name:pass[1],prefix:pass[2],ft:+pass[3],tvl:+pass[4],age:+pass[5],bs:+pass[6],line:i+1});
 }
 const cmds=[];const folder=path.join(dir,'commands','applied');
 if(fs.existsSync(folder))for(const f of fs.readdirSync(folder)){if(!f.endsWith('.json'))continue;try{cmds.push(JSON.parse(fs.readFileSync(path.join(folder,f),'utf8')));}catch{}}
 return {events,cmds};
}
function backfill(state,evidence){
 let n=0;
 for(const book of Object.values(state.books||{}))for(const h of [...(book.history||[]),...(book.positions||[])]){
  if(!h.openContext){
   const time=Date.parse(h.openedAt);
   const matching=evidence.events.filter(e=>e.type==='open'&&e.name===h.name&&e.time>=time-1000&&e.time-time<=30000);
   const e=matching.length===1?matching[0]:null;
   let source='unknown',request=null;
   if(e&&!e.manual)source='auto';
   if(e?.manual){const matches=evidence.cmds.filter(c=>c.result?.ok===true&&c.pool===h.pool&&['open','switch'].includes(c.type)&&+c.updatedBy===Number(process.env.TELEGRAM_ALLOWED_ID||0)&&Date.parse(c.createdAt)<=e.time+1000&&Date.parse(c.appliedAt)>=time-1000&&Math.abs(Date.parse(c.appliedAt)-e.time)<=30000);if(matches.length===1){request=matches[0];source=request.type;}}
   const passes=evidence.events.filter(p=>p.type==='pass'&&p.name===h.name&&h.pool?.startsWith(p.prefix)&&p.time<=time+1000&&time-p.time<300000);
   const pass=passes.at(-1),fullEntry=!h.legOpenedAt;
   const context={version:1,source:SOURCES[source],sourceCode:source,at:h.openedAt,requestId:request?.id||null,updatedBy:request?.updatedBy||null,
    reason:source==='auto'?'Buka otomatis, dibuktikan log PAPER OPEN non-manual':source==='unknown'?'Sumber tidak dapat dipastikan dari log/command':'Buka manual, dibuktikan command berhasil + log commit',
    snapshot:{entryCostEstimate:null,ft30mPct:pass?.ft??null,tvlUsd:fullEntry?num(h.tvlUsd)??pass?.tvl??null:pass?.tvl??null,ageH:pass?.age??null,binStep:num(h.binStep)??pass?.bs??null,marketCapUsd:null,quote:h.quoteSymbol||null,strategy:e?.strategy||null,
     passedAllFilters:source==='auto'&&pass?true:request?!(request.confirmedReasons||[]).length:null,failedFilters:source==='auto'&&pass?[]:request?.confirmedReasons||null,screenedAt:pass?.at||null,policy:null,
     evidence:[e?`bot.log:${e.line} @ ${wb(e.at)}`:'log open tidak ditemukan/tidak unik',pass?`PASS bot.log:${pass.line} @ ${wb(pass.at)}`:'snapshot screening tidak tersedia',request?`commands/applied/${request.id}.json`:'', 'MC dan nilai policy saat entry tidak tersimpan: tidak diketahui'].filter(Boolean).join('; '),precision:'historical log: fee/TVL 2 decimals; age 0.1h; TVL exact entry state unless repositioned'}};
   h.openContext=context;h.openSource=context.source;h.openReason=context.reason;n++;
   if(h.legOpenedAt){h.currentLegOpenContext={version:1,source:SOURCES.reposition,sourceCode:'reposition',at:h.legOpenedAt,reason:'Reposition kanan tercatat di state',snapshot:{strategy:context.snapshot.strategy,quote:context.snapshot.quote,passedAllFilters:null,failedFilters:null,evidence:'state.legOpenedAt/rightRepositions; snapshot leg tidak tersimpan'}};}
  }
  // Reconstruct display-only quote PnL from recorded historical holdings/costs (no ledger change).
  if(h.closedAt&&h.pnlQuote==null&&['x','y','exitPrice','solUsd','solUsdEntry','depositQuote','networkFeesSol','rentNonRefundableSol','openSwapCostUsd','tokenSwapCostUsd','solSwapCostUsd'].every(k=>num(h[k])!==null)){
   const qp=require('./paper-quote-pnl'),copy={...h};const display=qp.calculate({pos:copy,valueQuote:h.y+(h.feeY||0)+(h.x+(h.feeX||0))*h.exitPrice,solUsd:h.solUsd,val:{tokenSwapCostUsd:h.tokenSwapCostUsd,solSwapCostUsd:h.solSwapCostUsd},closed:true});
   if(display){Object.assign(h,display);h.quoteDisplayReconstructed='Recorded entry/close holdings, price, gas and swap costs; no new execution quote, USD ledger unchanged';}
  }
  if(h.closedAt&&!h.closeReasonText)h.closeReasonText=closeReason(h);
 }
 return n;
}
function csv(h){const c=h.openContext||{},s=c.snapshot||{},x=h.correction;return {capital_asset:h.capitalAsset||s.capitalAsset||'USDC',capital_in_sol:h.initialCapitalInSol??h.capitalInSol??s.capitalInSol??null,pnl_capital:h.pnlCapital??h.pnlUsd,pnl_capital_pct:h.pnlCapitalPct??h.pnlPct,entry_nonref_sol:s.entryCostEstimate?.nonrefTotalSol??null,entry_nonref_rent_sol:s.entryCostEstimate?.nonrefRentSol??h.rentNonRefundableSol??null,entry_new_bin_arrays:s.entryCostEstimate?.newBinArrays??null,open_source:c.source||SOURCES.unknown,open_reason:c.reason||SOURCES.unknown,entry_strategy:s.strategy,entry_ft_30m_pct:s.ft30mPct,entry_tvl_usd:s.tvlUsd,entry_age_h:s.ageH,entry_bin_step:s.binStep,entry_mc_usd:s.marketCapUsd,entry_quote:s.quote,entry_passed_all_filters:s.passedAllFilters,entry_failed_filters:s.failedFilters==null?'tidak diketahui':JSON.stringify(s.failedFilters),entry_evidence:s.evidence,entry_screened_wib:s.screenedAt?wb(s.screenedAt):null,close_reason_id:h.closeReasonText||closeReason(h),pnl_quote:h.pnlQuote,pnl_quote_usd:h.pnlQuoteUsd,current_leg_open_source:h.currentLegOpenContext?.source,corrected:!!x,correction_id:x?.id,original_pnl_usdc:x?.original?.pnlUsd,original_pnl_quote:x?.original?.pnlQuote,original_usdc_out:x?.original?.usdcOut,correction_delta_usdc:x?.cashDeltaUsdc,entry_insider_pct:s.insiderPct??null,entry_vol_1h_usd:s.vol1hUsd??null,entry_vol_24h_usd:s.vol24hUsd??null,entry_pump_1h_pct:s.pump1hPct??null,entry_pump_24h_pct:s.pump24hPct??null};}
module.exports={SOURCES,capture,closeReason,readEvidence,backfill,csv};
