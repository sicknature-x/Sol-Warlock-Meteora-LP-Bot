"use strict";
// One approved paper-only correction; state mutation is invoked/persisted by the bot only.
const u=require('./paper-usdc'),qp=require('./paper-quote-pnl');
const ID='pepetide-20261111-000504-onchain-fee-replay-v1';
async function applyPepetide(state,at=new Date().toISOString()){
 const book=state.books?.N5;if(!book)return null;
 const h=book.history?.find(r=>r.pool==='2uA94Y3X9dwDduojoj2NRcyZQaYtcoSsHZ4y1UX5P8Rs'&&r.closedAt==='2026-11-10T17:05:04.700Z'&&r.position==='68skbkr4y1iqkzAVHW3x7xPBdif6j24E2TV8W3F9ZxsR');
 if(!h||h.correction?.id===ID||state.accountingCorrections?.some(c=>c.id===ID))return null;
 if(h.correction)throw Error('Pepetide already has a different correction; review required');
 if(Math.abs(h.usdcOut-1115.6798034400297)>1e-8||Math.abs(h.usdcIn-1125.108334)>1e-8)throw Error('Historical Pepetide baseline changed; refusing correction');
 const original=JSON.parse(JSON.stringify(h));
 const p={...h,networkFeesSol:h.networkFeesSol-.000075,bins:{one:{x:h.x,y:h.y}}};
 const val=await u.exitQuote({pos:p,book:{virtual:{sol:h.reserveSol}},snap:{price:h.exitPrice,pxUsd:h.solUsd,estimatedTokenSwapFeeRate:h.baseFeePct/100},quote:async()=>({ok:false,error:'Approved historical on-chain fee replay; no execution quote recovered'})});
 const mark=h.y+(h.feeY||0)+(h.x+(h.feeX||0))*h.exitPrice;
 const display=qp.calculate({pos:p,valueQuote:mark,solUsd:h.solUsd,val});
 const delta=val.usdcOut-h.usdcOut;
 if(!(delta>14&&delta<14.2)||!Number.isFinite(book.virtual?.usdc)||!Number.isFinite(display.pnlQuote))throw Error('Historical reconciliation invariant failed');
 const swapCostUsd=(h.swapCostCarryUsd||0)+(h.openSwapCostUsd||0)+val.tokenSwapCostUsd+val.solSwapCostUsd;
 Object.assign(h,display,{usdcOut:val.usdcOut,legUsdcOut:val.usdcOut,pnlUsd:val.pnlUsd,pnlPct:val.pnlPct,netPnlUsd:val.pnlUsd,netPnlPct:val.pnlPct,netPnlSol:val.pnlUsd/h.solUsd,
  tokenSwapCostUsd:val.tokenSwapCostUsd,solSwapCostUsd:val.solSwapCostUsd,swapCostUsd,swapCostSol:swapCostUsd/h.solUsd,solPile:val.solPile,quoted:false,valuationBasis:val.valuationBasis,
  estimatesNote:'Corrected paper close from recorded holdings/entry and historical active-bin price, estimated SDK pool fee + 5bps native conversion. Not a recovered executable Jupiter quote. Original row preserved under correction.original.',corrected:true});
 book.virtual.usdc+=delta;
 const receipt={id:ID,at,pool:h.pool,closedAt:h.closedAt,cashDeltaUsdc:delta,oldUsdcOut:original.usdcOut,newUsdcOut:h.usdcOut,oldPnlUsd:original.pnlUsd,newPnlUsd:h.pnlUsd,oldPnlQuote:original.pnlQuote,newPnlQuote:h.pnlQuote,newPnlQuoteUsd:h.pnlQuoteUsd,method:'Approved recorded-price/holdings replay; SDK swap fee and native 5bps; original close reason retained'};
 h.correction={...receipt,original};state.accountingCorrections=[...(state.accountingCorrections||[]),receipt];
 return receipt;
}

// Second approved paper-only correction (Tuan, 11 Nov 2026): HOLD-SOL re-entry recalculated as if EMERGENCY_TP had been
// enabled (range 50% trigger armed at bin -463; TP +10% via on-chain fallback). Values are the exact bot.log monitor
// values at 2026-11-11 12:56:50 WIB (replay point). Original row preserved under correction.original.
const HOLD_ID='hold-sol-20261111-emergency-tp-recalc-v1';
const HOLD={pool:'C1Xwm4e8UEQRmhsmogn3HYoHLqJu7M7FVG7nrtPvqHVH',position:'GevspFr7GWNqDBQBgJRzvg7j4CKHLHP3r9v8EVx5tJUo',closedAt:'2026-11-11T07:40:32.274Z',
 oldUsdcOut:319.8589373256273,oldPnlUsd:-180.04106267437265,
 newClosedAt:'2026-11-11T05:56:50.000Z',newExitWib:'2026-11-11 12:56:50 WIB',pnlUsd:65.7311,pnlPct:13.1488,legExitUsdc:565.4311,
 pnlQuote:0.79354305,pnlQuoteUsd:66.086265,feesUsd:44.4902,activeBin:-450,reshapes:9};
function applyHold(state,at=new Date().toISOString()){
 const book=state.books?.N5;if(!book)return null;
 const h=book.history?.find(r=>r.pool===HOLD.pool&&r.position===HOLD.position&&r.closedAt===HOLD.closedAt);
 if(!h||h.correction?.id===HOLD_ID||state.accountingCorrections?.some(c=>c.id===HOLD_ID))return null;
 if(h.correction)throw Error('HOLD-SOL already has a different correction; review required');
 if(Math.abs(h.usdcOut-HOLD.oldUsdcOut)>1e-8||Math.abs(h.pnlUsd-HOLD.oldPnlUsd)>1e-8||!Number.isFinite(book.virtual?.usdc))throw Error('HOLD-SOL baseline changed; refusing correction');
 const original=JSON.parse(JSON.stringify(h)),delta=HOLD.pnlUsd-h.pnlUsd;
 if(!(delta>245&&delta<246.5))throw Error('HOLD-SOL reconciliation invariant failed');
 const solUsd=HOLD.pnlQuoteUsd/HOLD.pnlQuote,holdMin=Math.round((Date.parse(HOLD.newClosedAt)-Date.parse(h.openedAt))/60000);
 Object.assign(h,{closedAt:HOLD.newClosedAt,exitWib:HOLD.newExitWib,hold:`${Math.floor(holdMin/60)}h ${holdMin%60}m`,holdHours:+(holdMin/60).toFixed(2),
  exitPrice:h.entryPrice*Math.pow(1+h.binStep/1e4,HOLD.activeBin-h.entryActiveBin),lastActiveBin:HOLD.activeBin,reshapes:HOLD.reshapes,
  reason:'emergency_tp USDC +10% (on-chain fallback) (recalc)',usdcOut:h.usdcOut+delta,legUsdcOut:h.legUsdcOut+delta,
  pnlUsd:HOLD.pnlUsd,pnlPct:HOLD.pnlPct,pnlCapital:HOLD.pnlUsd,pnlCapitalPct:HOLD.pnlPct,netPnlUsd:HOLD.pnlUsd,netPnlPct:HOLD.pnlPct,netPnlSol:HOLD.pnlUsd/solUsd,
  pnlQuote:HOLD.pnlQuote,pnlQuoteUsd:HOLD.pnlQuoteUsd,pnlQuotePct:100*HOLD.pnlQuote/h.depositQuote,solUsd,displaySolUsd:solUsd,feesEarnedUsd:HOLD.feesUsd,
  quoted:false,valuationBasis:'on-chain mark minus estimated swap fees (bot.log monitor 12:56:50 WIB)',corrected:true,
  estimatesNote:'Recalculated paper close (approved): EMERGENCY_TP replay at bot.log monitor 12:56:50 WIB (pnlUsdc/exitUsdc/pnlQuote exact log values, 4-8 dp). Holdings x/y, IL, swap/gas cost fields are from the actual 14:40 close and not recomputed. Not an executed quote. Original row under correction.original.'});
 h.closeReasonText=require('./paper-history').closeReason(h);
 book.virtual.usdc+=delta;
 const receipt={id:HOLD_ID,at,pool:h.pool,closedAt:h.closedAt,originalClosedAt:HOLD.closedAt,cashDeltaUsdc:delta,oldUsdcOut:original.usdcOut,newUsdcOut:h.usdcOut,oldPnlUsd:original.pnlUsd,newPnlUsd:h.pnlUsd,oldPnlQuote:original.pnlQuote,newPnlQuote:h.pnlQuote,newPnlQuoteUsd:h.pnlQuoteUsd,method:'Approved EMERGENCY_TP recalculation (range 50% trigger, TP +10%, on-chain fallback) from bot.log monitor values at 12:56:50 WIB; close reason emergency_tp (recalc)'};
 h.correction={...receipt,original};state.accountingCorrections=[...(state.accountingCorrections||[]),receipt];
 return receipt;
}

// v2 (Tuan, 11 Nov 2026 ~15:35 WIB): full-history recalc under SL -20% net / EMERGENCY_TP +10% (armed at 50% of open lower
// range) / TP +20%, first event wins. HOLD-SOL: min -19.7609% (12:28:24 WIB) never reached SL -20%; armed 11:29:17 (bin -463);
// first poll >= +10% at 12:52:08 WIB (+10.0905%). Recorded at exactly +10% of TP basis initialUsdcIn 499.9 = +49.99 USDC.
const HOLD_ID_V2='hold-sol-20261111-emergency-tp-recalc-v2';
const V2={closedAt:'2026-11-11T05:52:08.000Z',exitWib:'2026-11-11 12:52:08 WIB',activeBin:-454,pollPnl:50.4425,pollPq:0.61234397,pollPqu:50.977635,feesUsd:41.9004,reshapes:9};
function applyHoldV2(state,at=new Date().toISOString()){
 const book=state.books?.N5;if(!book)return null;
 if(state.accountingCorrections?.some(c=>c.id===HOLD_ID_V2))return null;
 const h=book.history?.find(r=>r.pool===HOLD.pool&&r.position===HOLD.position&&r.correction?.id===HOLD_ID);
 if(!h)return null;
 const basis=Number(h.initialUsdcIn);
 if(Math.abs(basis-499.9)>1e-9||Math.abs(h.pnlUsd-HOLD.pnlUsd)>1e-9||!Number.isFinite(book.virtual?.usdc))throw Error('HOLD-SOL v1 baseline changed; refusing v2');
 const newPnl=+(basis*0.10).toFixed(6),d2=newPnl-h.pnlUsd,k=newPnl/V2.pollPnl,orig=h.correction.original;
 const v1={pnlUsd:h.pnlUsd,pnlPct:h.pnlPct,usdcOut:h.usdcOut,closedAt:h.closedAt,reason:h.reason,pnlQuote:h.pnlQuote,pnlQuoteUsd:h.pnlQuoteUsd};
 const solUsd=V2.pollPqu/V2.pollPq,holdMin=Math.round((Date.parse(V2.closedAt)-Date.parse(h.openedAt))/60000);
 Object.assign(h,{closedAt:V2.closedAt,exitWib:V2.exitWib,hold:`${Math.floor(holdMin/60)}h ${holdMin%60}m`,holdHours:+(holdMin/60).toFixed(2),
  exitPrice:h.entryPrice*Math.pow(1+h.binStep/1e4,V2.activeBin-h.entryActiveBin),lastActiveBin:V2.activeBin,reshapes:V2.reshapes,feesEarnedUsd:V2.feesUsd,
  usdcOut:h.usdcOut+d2,legUsdcOut:h.legUsdcOut+d2,pnlUsd:newPnl,pnlPct:10,pnlCapital:newPnl,pnlCapitalPct:10,netPnlUsd:newPnl,netPnlPct:10,netPnlSol:newPnl/solUsd,solUsd,displaySolUsd:solUsd,
  pnlQuote:V2.pollPq*k,pnlQuoteUsd:V2.pollPqu*k,pnlQuotePct:100*V2.pollPq*k/h.depositQuote,reason:'emergency_tp USDC +10% (recalc)',
  estimatesNote:'Recalculated paper close (approved v2, full-history recalc SL -20%/EMERGENCY_TP +10%/TP +20%): exactly +10% of TP basis initialUsdcIn 499.9 USDC = +49.99 USDC at first poll >= +10% (bot.log 12:52:08 WIB, +10.0905%); SL -20% never reached (min -19.7609% at 12:28:24). pnlQuote scaled from that poll. Holdings x/y, IL, swap/gas fields from the actual 14:40 close, not recomputed. Not an executed quote. Original row under correction.original; v1 under correction.v1.'});
 h.closeReasonText=require('./paper-history').closeReason(h);
 book.virtual.usdc+=d2;
 const receipt={id:HOLD_ID_V2,supersedes:HOLD_ID,at,pool:h.pool,closedAt:h.closedAt,originalClosedAt:HOLD.closedAt,basisUsdc:basis,cashDeltaUsdc:newPnl-orig.pnlUsd,cashDeltaVsV1Usdc:d2,
  oldUsdcOut:orig.usdcOut,newUsdcOut:h.usdcOut,oldPnlUsd:orig.pnlUsd,v1PnlUsd:v1.pnlUsd,newPnlUsd:newPnl,oldPnlQuote:orig.pnlQuote,newPnlQuote:h.pnlQuote,newPnlQuoteUsd:h.pnlQuoteUsd,
  method:'Approved full-history recalc v2 (SL -20% net, EMERGENCY_TP +10% armed at 50% of open lower range, TP +20%; first event wins). HOLD-SOL: EMERGENCY_TP first at 12:52:08 WIB; exactly +10% of initialUsdcIn 499.9.'};
 h.correction={...receipt,original:orig,v1};state.accountingCorrections=[...(state.accountingCorrections||[]),receipt];
 return receipt;
}

// Third approved paper-only correction (Tuan t210, 11 Nov 2026): X-SOL closed by paper manual close at 15:45:05 WIB after open
// positions' SL was synced to -20%. Recorded as stop loss at the first bot.log monitor poll <= -20% (15:24:15 WIB, -22.4970%,
// -112.4623 USDC); value recorded at exactly -20% of TP/SL basis usdcIn 499.9 = -99.98 USDC. Original row preserved.
const XSOL_ID='xsol-20261111-sl20-recalc-v1';
const XSOL={pool:'38hkfLZhhtjhn9t49LhCkconQ297ad5fnoZ3Mj7w5wEk',position:'Cvzk4MH5wnRMRwbSXiJZXVMdKyC1n1WRDuMSivyNNvAo',openedAt:'2026-11-11T05:17:47.337Z',closedAt:'2026-11-11T08:45:05.470Z',
 oldPnlUsd:-66.63835315984875,newClosedAt:'2026-11-11T08:24:15.000Z',newExitWib:'2026-11-11 15:24:15 WIB',activeBin:-710,pollPnl:-112.4623,pollPq:-1.38808280,pollPqu:-115.544012,feesUsd:18.4370};
function applyXsol(state,at=new Date().toISOString()){
 const book=state.books?.N5;if(!book)return null;
 if(state.accountingCorrections?.some(c=>c.id===XSOL_ID))return null;
 const h=book.history?.find(r=>r.pool===XSOL.pool&&r.position===XSOL.position&&r.openedAt===XSOL.openedAt&&r.closedAt===XSOL.closedAt);
 if(!h)return null;
 if(h.correction)throw Error('X-SOL already has a different correction; review required');
 const basis=Number(h.initialUsdcIn||h.usdcIn);
 if(Math.abs(basis-499.9)>1e-9||Math.abs(h.pnlUsd-XSOL.oldPnlUsd)>1e-8||!Number.isFinite(book.virtual?.usdc))throw Error('X-SOL baseline changed; refusing correction');
 const original=JSON.parse(JSON.stringify(h)),newPnl=+(-basis*0.20).toFixed(6),delta=newPnl-h.pnlUsd,k=newPnl/XSOL.pollPnl;
 if(!(delta<-33&&delta>-34))throw Error('X-SOL reconciliation invariant failed');
 const solUsd=XSOL.pollPqu/XSOL.pollPq,holdMin=Math.round((Date.parse(XSOL.newClosedAt)-Date.parse(h.openedAt))/60000);
 Object.assign(h,{closedAt:XSOL.newClosedAt,exitWib:XSOL.newExitWib,hold:`${Math.floor(holdMin/60)}h ${holdMin%60}m`,holdHours:+(holdMin/60).toFixed(2),
  exitPrice:h.entryPrice*Math.pow(1+h.binStep/1e4,XSOL.activeBin-h.entryActiveBin),lastActiveBin:XSOL.activeBin,feesEarnedUsd:XSOL.feesUsd,
  usdcOut:h.usdcOut+delta,legUsdcOut:(h.legUsdcOut??h.usdcOut)+delta,pnlUsd:newPnl,pnlPct:-20,pnlCapital:newPnl,pnlCapitalPct:-20,netPnlUsd:newPnl,netPnlPct:-20,netPnlSol:newPnl/solUsd,solUsd,displaySolUsd:solUsd,
  pnlQuote:XSOL.pollPq*k,pnlQuoteUsd:XSOL.pollPqu*k,pnlQuotePct:100*XSOL.pollPq*k/h.depositQuote,reason:'emergency_stop SL -20% (recalc)',quoted:false,corrected:true,
  valuationBasis:'exactly -20% of basis usdcIn 499.9 (SL recalc)',
  estimatesNote:'Recalculated paper close (approved t210): stop loss -20% at first bot.log monitor poll <= -20% (15:24:15 WIB, -22.4970% / -112.4623 USDC); recorded exactly -20% of basis usdcIn 499.9 = -99.98 USDC. Actual paper close was manual_close 15:45:05 WIB at -66.64 USDC (correction.original). Holdings/swap/gas fields from actual close, not recomputed. Not an executed quote.'});
 h.closeReasonText=require('./paper-history').closeReason(h);
 book.virtual.usdc+=delta;
 const receipt={id:XSOL_ID,at,pool:h.pool,closedAt:h.closedAt,originalClosedAt:XSOL.closedAt,basisUsdc:basis,cashDeltaUsdc:delta,oldUsdcOut:original.usdcOut,newUsdcOut:h.usdcOut,oldPnlUsd:original.pnlUsd,newPnlUsd:newPnl,oldPnlQuote:original.pnlQuote,newPnlQuote:h.pnlQuote,newPnlQuoteUsd:h.pnlQuoteUsd,
  method:'Approved SL -20% recalc (t210): first monitor poll <= -20% at 15:24:15 WIB; recorded exactly -20% of usdcIn 499.9; actual close manual_close 15:45:05 WIB'};
 h.correction={...receipt,original};state.accountingCorrections=[...(state.accountingCorrections||[]),receipt];
 return receipt;
}

// Fourth approved paper-only correction (Tuan, 12 Nov 2026): HUNG-SOL (entry 09:02 WIB) recalculated under TP Emergency SL+
// (TP emergency v1 armed 09:45:13; PnL first >= +5% at 10:05:23; third consecutive poll <= +0.1% at 10:29:08 WIB -> close).
// Values are the exact bot.log monitor values of that poll (10:29:08 WIB, quoted=false, 3 reshapes done). The row had been closed by
// emergency_stop SL at 11:36:17 WIB (-108.83 USDC). Holdings x/y, IL and swap/gas fields are from the actual close and not recomputed.
const HUNG_ID='hung-sol-20261112-emergency-slplus-recalc-v1';
const HUNG={pool:'cyif7J8nYYYRDuc2ocyagB6s7Wygaho8RNB22E6QyiA',position:'4Qiya7unmJwZHBu3Paw6yuVZbMgUmAt5BydPpTGVEhYD',openedAt:'2026-11-12T02:02:15.704Z',closedAt:'2026-11-12T04:36:17.354Z',
 oldPnlUsd:-108.83076245209736,oldUsdcOut:391.0692375479026,newClosedAt:'2026-11-12T03:29:08.000Z',newExitWib:'2026-11-12 10:29:08 WIB',activeBin:-265,reshapes:3,
 pnlUsd:-0.2239,exitUsdc:499.6761,pnlQuote:-0.00604677,pnlQuoteUsd:-0.502003,feesUsd:29.9060,peakPct:8.7};
function applyHungSlPlus(state,at=new Date().toISOString()){
 const book=state.books?.N5;if(!book)return null;
 if(state.accountingCorrections?.some(c=>c.id===HUNG_ID))return null;
 const h=book.history?.find(r=>r.pool===HUNG.pool&&r.position===HUNG.position&&r.openedAt===HUNG.openedAt&&r.closedAt===HUNG.closedAt);
 if(!h)return null;
 if(h.correction)throw Error('HUNG-SOL already has a different correction; review required');
 const basis=Number(h.initialUsdcIn||h.usdcIn);
 if(Math.abs(basis-499.9)>1e-9||Math.abs(h.pnlUsd-HUNG.oldPnlUsd)>1e-8||Math.abs(h.usdcOut-HUNG.oldUsdcOut)>1e-8||!Number.isFinite(book.virtual?.usdc))throw Error('HUNG-SOL baseline changed; refusing correction');
 const original=JSON.parse(JSON.stringify(h)),newPnl=HUNG.pnlUsd,delta=newPnl-h.pnlUsd,pct=100*newPnl/basis;
 if(!(delta>108.6&&delta<108.62))throw Error('HUNG-SOL reconciliation invariant failed');
 const solUsd=HUNG.pnlQuoteUsd/HUNG.pnlQuote,holdMin=Math.round((Date.parse(HUNG.newClosedAt)-Date.parse(h.openedAt))/60000);
 Object.assign(h,{closedAt:HUNG.newClosedAt,exitWib:HUNG.newExitWib,hold:`${Math.floor(holdMin/60)}h ${holdMin%60}m`,holdHours:+(holdMin/60).toFixed(2),
  exitPrice:h.entryPrice*Math.pow(1+h.binStep/1e4,HUNG.activeBin-h.entryActiveBin),lastActiveBin:HUNG.activeBin,reshapes:HUNG.reshapes,feesEarnedUsd:HUNG.feesUsd,
  reason:'emergency_slplus USDC +0.1% (peak +'+HUNG.peakPct+'%) (recalc)',usdcOut:h.usdcOut+delta,legUsdcOut:(h.legUsdcOut??h.usdcOut)+delta,
  pnlUsd:newPnl,pnlPct:pct,pnlCapital:newPnl,pnlCapitalPct:pct,netPnlUsd:newPnl,netPnlPct:pct,netPnlSol:newPnl/solUsd,solUsd,displaySolUsd:solUsd,
  pnlQuote:HUNG.pnlQuote,pnlQuoteUsd:HUNG.pnlQuoteUsd,pnlQuotePct:100*HUNG.pnlQuote/h.depositQuote,quoted:false,corrected:true,
  valuationBasis:'bot.log monitor 10:29:08 WIB (on-chain mark minus estimated swap fees, quoted=false) under TP Emergency SL+',
  estimatesNote:'Recalculated paper close (approved, Tuan 12 Nov 2026): TP Emergency SL+ at the third consecutive poll <= +0.1% (bot.log 10:29:08 WIB, pnlUsdc -0.2239 / exitUsdc 499.6761, exact log values). TP emergency v1 armed 09:45:13; PnL first >= +5% at 10:05:23; peak +8.7%. Actual paper close was emergency_stop SL -20% at 11:36:17 WIB at -108.83 USDC (correction.original). Holdings x/y, IL, swap/gas cost fields are from the actual close and not recomputed. Not an executed quote.'});
 h.closeReasonText=require('./paper-history').closeReason(h);
 book.virtual.usdc+=delta;
 const receipt={id:HUNG_ID,at,pool:h.pool,closedAt:h.closedAt,originalClosedAt:HUNG.closedAt,basisUsdc:basis,cashDeltaUsdc:delta,oldUsdcOut:original.usdcOut,newUsdcOut:h.usdcOut,oldPnlUsd:original.pnlUsd,newPnlUsd:newPnl,oldPnlQuote:original.pnlQuote,newPnlQuote:h.pnlQuote,newPnlQuoteUsd:h.pnlQuoteUsd,
  method:'Approved TP Emergency SL+ recalc (Tuan 12 Nov 2026): arm +5% after TP emergency v1, close at <= +0.1% for 3 consecutive polls; replay poll 10:29:08 WIB; actual close emergency_stop 11:36:17 WIB'};
 h.correction={...receipt,original};state.accountingCorrections=[...(state.accountingCorrections||[]),receipt];
 return receipt;
}
async function apply(state,at=new Date().toISOString()){const a=await applyPepetide(state,at),b=applyHold(state,at),c=applyHoldV2(state,at),d=applyXsol(state,at),e=applyHungSlPlus(state,at);return e||d||c||b||a;}
module.exports={ID,HOLD_ID,HOLD_ID_V2,XSOL_ID,HUNG_ID,HUNG,applyHungSlPlus,apply,applyPepetide,applyHold,applyHoldV2,applyXsol};

