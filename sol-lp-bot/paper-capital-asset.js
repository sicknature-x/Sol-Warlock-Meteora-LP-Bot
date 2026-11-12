"use strict";
// PAPER ONLY. Free SOL lives in capitalSol, never in per-position gas virtual.sol.
const SOL='So11111111111111111111111111111111111111112',USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
async function exchange(amount,from,to,px,quote,txFee=.000025){
 if(!(amount>=0)||!(px>0))throw Error('Capital conversion price/amount unavailable');
 if(from===to||!amount)return {out:amount,costUsd:0,quoted:true,basis:'no conversion'};
 const inSol=from==='SOL',raw=BigInt(Math.floor(amount*10**(inSol?9:6)));
 let q;try{q=await quote(inSol?SOL:USDC,inSol?USDC:SOL,raw,inSol?9:6,inSol?6:9);}catch(e){q={ok:false,error:String(e.message)};}
 const mark=inSol?amount*px:amount/px,known=q.ok&&Number.isFinite(q.outUi)&&q.outUi>0;
 const gross=known?q.outUi:mark*(1-.0005),out=Math.max(0,gross-txFee*(inSol?px:1));
 if(!(out>0))throw Error('Capital conversion too small after paper swap/network cost');
 return {out,costUsd:Math.max(0,(inSol?amount*px:amount)-(inSol?out:out*px)),quoted:known,basis:known?'Jupiter paper quote + network fee':'on-chain SOL/USD estimate minus 5bps + network fee'};
}
async function sync(book,requested,px,{quote,txFee=.000025,log=()=>{},audit=()=>{},now=()=>new Date().toISOString()}={}){
 if(!['USDC','SOL'].includes(requested))throw Error('Invalid capital asset');if(!(px>0))throw Error('SOL/USD required for capital accounting');
 const v=book.virtual;let changed=false;if(v.lastCapitalSolUsd!==px){v.lastCapitalSolUsd=px;changed=true;}
 if(v.capitalAsset==null){v.capitalAsset='USDC';v.capitalSol=0;changed=true;}
 const deposits=v.totalDepositedUsdc??v.usdcStart??0;
 if(!Number.isFinite(v.totalDepositedSol)){v.totalDepositedSol=deposits/px;v.depositsUsdAccounted=deposits;v.solDepositBasisAt=now();v.solDepositBasisPrice=px;v.solDepositBasisNote='USD deposits rebased to SOL at feature activation; historical deposit SOL prices were not recorded';changed=true;}
 const delta=deposits-v.depositsUsdAccounted;if(delta!==0){v.totalDepositedSol+=delta/px;v.depositsUsdAccounted=deposits;changed=true;}
 const from=requested==='SOL'?'USDC':'SOL',amount=from==='USDC'?(v.usdc||0):(v.capitalSol||0);
 if(amount>1e-10){const q=await exchange(amount,from,requested,px,quote,txFee);if(from==='USDC'){v.usdc=0;v.capitalSol=(v.capitalSol||0)+q.out;}else{v.capitalSol=0;v.usdc=(v.usdc||0)+q.out;}
 const event={at:now(),from,to:requested,input:amount,output:q.out,costUsd:q.costUsd,solUsd:px,basis:q.basis};book.capitalConversions=[...(book.capitalConversions||[]),event].slice(-1000);
 const line=`capital conversion PAPER ${from}->${requested} ${amount.toFixed(8)} -> ${q.out.toFixed(8)}; costUSD=${q.costUsd.toFixed(6)}; ${q.basis}; existing positions keep entry basis`;log(line);audit('uid='+process.env.TELEGRAM_ALLOWED_ID+' action='+line);changed=true;}
 if(v.capitalAsset!==requested){v.capitalAsset=requested;changed=true;}
 return changed;
}
module.exports={exchange,sync};
