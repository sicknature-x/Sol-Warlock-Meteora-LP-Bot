'use strict';
const {parseQuote}=require('./paper-capital');
// One paper-only public quote queue. Never signs, submits a swap, or accesses a key.
function create({fetch:request=globalThis.fetch,now=()=>Date.now(),wait=ms=>new Promise(r=>setTimeout(r,ms)),minGapMs=1500,cacheMs=15000,baseBackoffMs=30000,log=()=>{}}={}){
 let chain=Promise.resolve(),lastStart=-Infinity,blockedUntil=0,failures=0;const cache=new Map();
 function resultError(message){return {ok:false,error:message,inUi:0,outUi:0};}
 async function perform(inputMint,outputMint,raw,inDec,outDec,slippageBps){
  const key=[inputMint,outputMint,String(raw),inDec,outDec,slippageBps].join(':'),hit=cache.get(key);
  if(hit&&now()-hit.at<cacheMs)return {...hit.value,quoteCacheAgeMs:now()-hit.at};
  if(now()<blockedUntil)return resultError(`Jupiter cooldown ${Math.ceil((blockedUntil-now())/1000)}s; using on-chain mark`);
  const delay=Math.max(0,lastStart+minGapMs-now());if(delay)await wait(delay);
  if(now()<blockedUntil)return resultError('Jupiter cooldown; using on-chain mark');
  lastStart=now();
  try{
   const url=`https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${raw}&slippageBps=${slippageBps}`;
   const r=await request(url,{signal:AbortSignal.timeout(15000)});
   if(r.status===429){
    failures++;const header=r.headers?.get?.('retry-after');let retry=Number(header)*1000;
    if(header&&!Number.isFinite(retry))retry=Math.max(0,Date.parse(header)-now());
    const backoff=Math.max(baseBackoffMs*Math.min(4,2**(failures-1)),Number.isFinite(retry)?retry:0);
    blockedUntil=now()+backoff;log(`Jupiter 429: paper quote backoff ${Math.ceil(backoff/1000)}s; on-chain marks remain available`);
    return resultError(`Jupiter 429; cooldown ${Math.ceil(backoff/1000)}s`);
   }
   if(!r.ok)return resultError(`Jupiter HTTP ${r.status}`);
   const q=await r.json(),parsed=parseQuote(q,inDec,outDec);
   if(!parsed.ok)return {...q,...parsed};
   failures=0;const value={...q,...parsed};cache.set(key,{at:now(),value});
   if(cache.size>64)cache.delete(cache.keys().next().value);
   return value;
  }catch(e){return resultError(String(e.message||e).slice(0,180));}
 }
 function quote(...args){const job=chain.then(()=>perform(...args));chain=job.catch(()=>{});return job;}
 return {quote,status:()=>({blockedUntil,failures,cacheSize:cache.size,minGapMs})};
}
module.exports={create};
