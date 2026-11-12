'use strict';
// Paper-only entry cost estimation. No funds or credentials.
// No signing, state writes, network construction, or credential handling.
const BIN_ARRAY_FEE_SOL=.07143744;
function amount(x,name){const n=Number(x);if(x==null||!Number.isFinite(n)||n<0)throw Error('Invalid SDK '+name);return n;}
async function estimate(dlmm,strategy,{txFeeSol=.000025,openTransactions=3,tokenAccountFeeSol=0,bitmapExists,now=()=>new Date().toISOString()}={}){
 const q=await dlmm.quoteCreatePosition({strategy});
 const binRent=amount(q.binArrayCost,'binArrayCost');
 let bitmapRent=amount(q.bitmapExtensionCost??0,'bitmapExtensionCost');
 const count=q.binArraysCount==null?(binRent===0?0:Math.round(binRent/BIN_ARRAY_FEE_SOL)):Number(q.binArraysCount);
 if(!Number.isInteger(count)||count<0)throw Error('Invalid SDK binArraysCount');
 if(q.binArraysCount==null&&Math.abs(binRent-count*BIN_ARRAY_FEE_SOL)>1e-9)throw Error('Unknown bin array count');
 if(bitmapRent>0){if(typeof bitmapExists!=='function')throw Error('Bitmap existence must be checked');const exists=await bitmapExists();if(typeof exists!=='boolean')throw Error('Bitmap existence unknown');if(exists)bitmapRent=0;}
 const position=amount(q.positionCost,'positionCost')+amount(q.positionReallocCost??0,'positionReallocCost');
 const refundableRentSol=position+2*amount(tokenAccountFeeSol,'tokenAccountFeeSol');
 if(!Number.isInteger(openTransactions)||openTransactions<1)throw Error('Invalid transaction count');
 const openTxFeeSol=amount(txFeeSol,'txFeeSol')*openTransactions;
 const nonrefRentSol=binRent+bitmapRent;
 return {known:true,at:now(),minBinId:strategy.minBinId,maxBinId:strategy.maxBinId,newBinArrays:count,binArrayRentSol:binRent,bitmapRentSol:bitmapRent,nonrefRentSol,openTxFeeSol,nonrefTotalSol:nonrefRentSol+openTxFeeSol,refundableRentSol};
}
function rejection(cost,max=.05){
 if(!Number.isFinite(max)||max<0)throw Error('MAX_NONREFUND_SOL must be finite and >= 0');
 if(cost?.skipCheck)return null;
 if(!cost?.known||!Number.isFinite(cost.nonrefTotalSol))return 'Biaya non-refundable belum dapat dihitung (RPC/SDK); coba lagi';
 if(max===0||cost.nonrefTotalSol<=max+1e-12)return null;
 return `Non-refundable ${cost.nonrefTotalSol.toFixed(6)} SOL (${cost.newBinArrays} bin array baru; rent ${cost.nonrefRentSol.toFixed(6)} + tx ${cost.openTxFeeSol.toFixed(6)}) > maks ${max.toFixed(6)} SOL`;
}
function fast(dlmm,min,max,{sdk,txFeeSol=.000025,tokenAccountFeeSol=0,skipReason}={}){
 const width=max-min+1,per=Number(sdk.MAX_BIN_ARRAY_SIZE||70),lo=Math.floor(min/per),hi=Math.max(Math.floor(max/per),lo+1),bitmap=dlmm.lbPair?.binArrayBitmap||[];let possible=0;
 for(let i=lo;i<=hi;i++){const bit=i+512,chunk=bitmap[Math.floor(bit/64)];if(bit<0||bit>=1024||!chunk||!(BigInt(chunk.toString())&(1n<<BigInt(bit%64))))possible++;}
 const binRent=possible*Number(sdk.BIN_ARRAY_FEE||BIN_ARRAY_FEE_SOL),bitmapRent=(lo< -512||hi>511)&&!dlmm.binArrayBitmapExtension?Number(sdk.BIN_ARRAY_BITMAP_FEE||.01180416):0;
 const refundableRentSol=Number(sdk.POSITION_FEE||.05740608)+Math.max(0,width-70)*Number(sdk.POSITION_BIN_DATA_SIZE||112)*6960/1e9+2*tokenAccountFeeSol,openTxFeeSol=3*txFeeSol;
 return {known:true,estimated:true,skipCheck:true,skipReason,at:new Date().toISOString(),minBinId:min,maxBinId:max,newBinArrays:possible,binArrayRentSol:binRent,bitmapRentSol:bitmapRent,nonrefRentSol:binRent+bitmapRent,openTxFeeSol,nonrefTotalSol:binRent+bitmapRent+openTxFeeSol,refundableRentSol,estimateNote:'Upper bound from already-loaded bitmap; zero bit may mean empty existing array. SDK correction pending, no rent RPC awaited.'};
}
module.exports={estimate,rejection,fast,BIN_ARRAY_FEE_SOL};
