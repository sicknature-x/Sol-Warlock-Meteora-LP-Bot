'use strict';
// Supported public interfaces only: HawkFi's published Swagger + Meteora's documented API.
// HawkFi's published /pool is 24h-only; never mislabel it as 30m or invent a timeframe param.
const HAWKFI_POOLS = 'https://api2.hawksight.co/pools';
const METEORA_POOLS = 'https://dlmm.datapi.meteora.ag/pools';
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
let probeCache = null;
async function probeHawkfi(getJSON) {
  if (probeCache && Date.now() - probeCache.at < 600000) return probeCache;
  let reason;
  try {
    const url = new URL(HAWKFI_POOLS);
    for (const [k,v] of Object.entries({page:0,limit:80,sortedBy:'fees',orderBy:'desc',protocol:'meteora'})) url.searchParams.set(k,v);
    const j = await getJSON(url.toString(), {timeoutMs:12000}, 1);
    const pools = Array.isArray(j) ? j : j.pools;
    reason = Array.isArray(pools) && !pools.length
      ? 'HawkFi public /pools kosong; API /pool yang terdokumentasi hanya menyediakan fees_24h, bukan 30m'
      : 'HawkFi public API belum memiliki skema fees/TVL 30m yang terdokumentasi; 24h tidak dipakai sebagai 30m';
  } catch (e) { reason = 'HawkFi public API gagal: ' + String(e.message).replace(/https?:\/\/\S+/g,'[endpoint]').slice(0,160); }
  probeCache = { at:Date.now(), endpoint:HAWKFI_POOLS, ok:false, reason };
  return probeCache;
}
async function fetchUniverse(getJSON, cfg, log=()=>{}) {
  const probe = await probeHawkfi(getJSON);
  log('screen source: Meteora datapi 30m');
  const seen = new Map();
  const query = async (filter, sort, page=1) => {
    const u=new URL(METEORA_POOLS);u.searchParams.set('page',page);u.searchParams.set('page_size',100);u.searchParams.set('sort_by',sort);
    if(filter)u.searchParams.set('filter_by',filter);
    const j=await getJSON(u.toString(),{timeoutMs:20000},2);
    if(!Array.isArray(j.data))throw new Error('invalid Meteora pools response');
    for(const p of j.data) if(p.address) seen.set(p.address,p);
    if(seen.size>5000)throw new Error('screen safety limit: >5000 pools; refusing incomplete universe');
    return j;
  };
  // Paginate the ENTIRE entry-eligible metric universe BEFORE quote/age/risk filters.
  // Prevents tiny-TVL high-ratio pools crowding $10k+ pools out of the first 200 rows.
  const filter=`tvl>=${cfg.MIN_LIQ_USD}${cfg.MAX_LIQ_USD>0?` && tvl<=${cfg.MAX_LIQ_USD}`:""} && fee_tvl_ratio_${cfg.FT_WINDOW}>=${cfg.MIN_FT}`;
  const first=await query(filter,'fee_30m:desc');
  const pages=Number(first.pages)||1;
  if(pages>50)throw new Error('screen safety limit: >50 eligible pages; refusing incomplete universe');
  for(let page=2;page<=pages;page++)await query(filter,'fee_30m:desc',page);
  // Separate all-quote top-fee table for transparent rejects (including young/USDC pools).
  const fees=await query('', 'fee_30m:desc');
  const near=await query(`tvl>=${cfg.MIN_LIQ_USD} && token_y=${SOL}`,`fee_tvl_ratio_${cfg.FT_WINDOW}:desc`);
  return { pools:[...seen.values()], topFees:fees.data.slice(0,30), source:'meteora-fallback',
    sourceLabel:'Meteora datapi 30m', sourceReason:probe.reason,
    hawkfiEndpoint:probe.endpoint, hawkfiVerified:false,
    coverage:{ eligiblePages:pages, eligibleTotal:first.total, eligibleComplete:true, topFeesCount:fees.data.length,
      totalPools:fees.total, nearCount:near.data.length }, fetchedAt:new Date().toISOString() };
}
function ft(p,window='30m') {
  const v=p?.fee_tvl_ratio?.[window];return v!=null&&Number.isFinite(+v)?+v:null;
}
function sanityReason(p,minTvl=10000) {
  const tvl=Number(p.tvl), ratio=ft(p);
  if(!Number.isFinite(tvl)||tvl<=0||tvl<0.005)return 'TVL $0';
  if(tvl<minTvl)return `tvl<$${minTvl}`;
  if(ratio==null||ratio<0)return 'fee/TVL invalid';
  if(ratio>1000)return 'fee/TVL >1000% (invalid)';
  return null;
}
function priority(a,b,asset='USDC'){const preferred=asset==='SOL'?SOL:USDC;return (a.token_y?.address===preferred?0:1)-(b.token_y?.address===preferred?0:1)||(ft(b)||0)-(ft(a)||0);}
function sortRows(rows,limit=60) {
  const good=rows.filter(r=>!r.sanityRejected).sort((a,b)=>(b.ft30m??-Infinity)-(a.ft30m??-Infinity));
  const bad=rows.filter(r=>r.sanityRejected).sort((a,b)=>Number(b.reasons?.includes('TVL $0'))-Number(a.reasons?.includes('TVL $0'))||(b.fees30mUsd||0)-(a.fees30mUsd||0));
  // Keep explicit invalid rows visible at the bottom even when the healthy list is full.
  const keep=good.slice(0,Math.max(0,limit-Math.min(limit,10,bad.length)));
  return [...keep,...bad.slice(0,limit-keep.length)];
}
function row(p,reasons=[],status='rejected',minTvl=10000) {
  const sanity=sanityReason(p,minTvl);
  return {entryCostEstimate:p.entryCostEstimate||null,name:p.name,address:p.address,mintX:p.token_x?.address,quote:p.token_y?.symbol||p.token_y?.address||'?',quoteMint:p.token_y?.address,
    ft30m:sanity?null:ft(p),fees30mUsd:p.fees?.['30m']??null,tvl:p.tvl,marketCapUsd:p.token_x?.market_cap??null,
    binStep:p.pool_config?.bin_step,baseFeePct:p.pool_config?.base_fee_pct??null,
    ageH:Number(p.created_at)>0?Math.max(0,(Date.now()/1000-(Number(p.created_at)>1e12?Number(p.created_at)/1000:Number(p.created_at)))/3600):null,createdAt:p.created_at,
    reasons:sanity?[sanity,...reasons.filter(r=>r!==sanity)]:reasons,status:sanity?'rejected':status,sanityRejected:!!sanity,
    source:'meteora-fallback',hawkfiVerified:false};
}
module.exports={fetchUniverse,probeHawkfi,ft,row,sanityReason,priority,sortRows,HAWKFI_POOLS,METEORA_POOLS};
