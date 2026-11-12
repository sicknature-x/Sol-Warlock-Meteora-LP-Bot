'use strict';
// DISPLAY ONLY. Never supplies a value to TP/OOR/emergency decisions or the cash ledger.
const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const symbol=p=>p.quoteSymbol==='USDC'||p.quoteMint===USDC?'USDC':'SOL';
const finite=n=>Number.isFinite(+n)&&n!=null;
function ensureEntry(pos){
 if(!finite(pos.entryQuoteAmount)){
  const amount=pos.depositQuote??pos.depositSol;
  if(!finite(amount)||amount<=0)return false;
  pos.entryQuoteAmount=+amount;pos.entryQuoteSource=pos.depositQuote!=null?'state.depositQuote':'state.depositSol';
 }
 if(!finite(pos.initialEntryQuoteAmount))pos.initialEntryQuoteAmount=pos.entryQuoteAmount;
 if(!finite(pos.displaySolUsdEntry)&&finite(pos.solUsdEntry))pos.displaySolUsdEntry=+pos.solUsdEntry;
 if(!finite(pos.embeddedEntrySwapQuote)){
  // Entry X purchase shortfall is ALREADY reflected in the inventory mark vs deposit;
  // remove it from the explicit swap-cost line so it cannot be charged twice.
  pos.embeddedEntrySwapQuote=finite(pos.entryTokenX)&&finite(pos.entryQuoteY)?Math.max(0,pos.entryQuoteAmount-pos.entryQuoteY-pos.entryTokenX*pos.entryPrice):0;
 }
 return true;
}
function calculate({pos,valueQuote,solUsd,val={},closed=false}){
 if(!ensureEntry(pos)||!finite(valueQuote)||!(solUsd>0))return null;
 const quoteSymbol=symbol(pos),unit=quoteSymbol==='USDC'?1:solUsd;
 const entryUnit=quoteSymbol==='USDC'?1:(pos.solUsdEntry||solUsd);
 const fundingSwapQuote=Math.max(0,(pos.openSwapCostUsd||0)/entryUnit-(pos.embeddedEntrySwapQuote||0));
 const closeFees=closed?0:(val.closeFees??.000075);
 const networkAndRentQuote=((pos.networkFeesSol||0)+(pos.rentNonRefundableSol||0)+closeFees)*solUsd/unit;
 const exitSwapQuote=((val.tokenSwapCostUsd||0)+(val.solSwapCostUsd||0))/unit;
 const displayCostsQuote=fundingSwapQuote+networkAndRentQuote+exitSwapQuote;
 const pnlQuote=(pos.pnlQuoteCarry||0)+valueQuote-pos.entryQuoteAmount-displayCostsQuote;
 const solEntry=pos.displaySolUsdEntry||pos.solUsdEntry;
 return {entryQuoteAmount:pos.entryQuoteAmount,initialEntryQuoteAmount:pos.initialEntryQuoteAmount,
  quoteSymbol,pnlQuote,pnlQuoteUsd:pnlQuote*unit,pnlQuotePct:100*pnlQuote/pos.initialEntryQuoteAmount,
  displayValueQuote:valueQuote,displayCostsQuote,embeddedEntrySwapQuote:pos.embeddedEntrySwapQuote,
  displaySolUsdEntry:solEntry,displaySolUsd:solUsd,solPriceChangePct:solEntry>0?100*(solUsd/solEntry-1):null,
  displayBasis:'LP inventory + unclaimed fees; compounded fees already in inventory; net gas/nonrefundable rent + swaps, no double charge for entry token swap. USD is quote PnL converted at current price; NOT USDC exit PnL.'};
}
function fromPosition(pos,val={}){
 let x=0,y=0;for(const b of Object.values(pos.bins||{})){x+=b.x||0;y+=b.y||0;}
 return calculate({pos,valueQuote:y+(pos.feeY||0)+(x+(pos.feeX||0))*(pos.lastPrice||pos.entryPrice),solUsd:pos.lastSolUsd||pos.solUsdEntry,val});
}
function totals(rows){
 const quotes={};let usd=0,count=0;
 for(const d of rows){if(!d||!finite(d.pnlQuote)||!finite(d.pnlQuoteUsd))continue;quotes[d.quoteSymbol]=(quotes[d.quoteSymbol]||0)+d.pnlQuote;usd+=d.pnlQuoteUsd;count++;}
 return {quotes,usd,count};
}
function format(d){
 if(!d||!finite(d.pnlQuote)||!finite(d.pnlQuoteUsd))return 'PnL quote belum tersedia';
 const n=(v,digits)=>(v>=0?'+':'−')+Math.abs(v).toFixed(digits);
 return `${n(d.pnlQuote,d.quoteSymbol==='USDC'?2:4)} ${d.quoteSymbol} (${d.pnlQuoteUsd<0?'−':''}$${Math.abs(d.pnlQuoteUsd).toFixed(2)})`;
}
function solChange(d){return finite(d?.solPriceChangePct)?`SOL sejak entry: $${(+d.displaySolUsdEntry).toFixed(2)} → $${(+d.displaySolUsd).toFixed(2)} (${d.solPriceChangePct>=0?'+':''}${d.solPriceChangePct.toFixed(2)}%)`:'';}
function logFields(d){return d?`pnlQuote=${d.pnlQuote.toFixed(8)} quoteSymbol=${d.quoteSymbol} pnlQuoteUsd=${d.pnlQuoteUsd.toFixed(6)} solChangePct=${d.solPriceChangePct?.toFixed(4)??'n/a'}`:'';}
module.exports={symbol,ensureEntry,calculate,fromPosition,totals,format,solChange,logFields};
