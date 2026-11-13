require('./env-config').load(__dirname);
// Meteora DLMM LP bot (config C2 + optional same-position M-reshape).
// Secrets are never logged or written. Paper mode never loads the private key, never signs, never sends.
const fs = require('fs');
const path = require('path');
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, ComputeBudgetProgram, VersionedTransaction, Transaction } = require('@solana/web3.js');
const _dl = require('@meteora-ag/dlmm');
const DLMM = _dl.default || _dl;
const {
  StrategyType, ResizeSide, calculateSpotDistribution, calculateBidAskDistribution,
  toAmountsBothSideByStrategy, quoteCreatePosition, POSITION_FEE, TOKEN_ACCOUNT_FEE,
  MAX_BINS_PER_POSITION, MAX_RESIZE_LENGTH,
} = _dl;
const BN = require('bn.js');
const bs58 = require('bs58').default || require('bs58');
const { createCloseAccountInstruction } = require('@solana/spl-token');
const reshapeCore = require('./reshape-core');
const antirug = require('./antirug');
const telegram = require('./telegram-notify');
const paperCap = require('./paper-capital');
const paperSettings = require('./paper-settings');
const antiPvp = require('./anti-pvp');
const feeTurnover = require('./fee-turnover');   // skip small overheated pools (24h fees / TVL)
const jup = require('./jupiter-config');   // optional JUPITER_API_KEY -> api.jup.ag (own rate limit); keyless -> lite-api (shared, many 429)
const rugSticky = require('./rug-sticky');   // a token flagged rugged/danger/high score stays blocked even if RugCheck later answers clean
const screenReasons = require('./screen-reasons');
const tvlDrop = require('./tvl-drop');
const entryReasons = require('./entry-reasons');
const screenSource = require('./pool-screen-source');
const paperFunding = require('./paper-funding');
const paperRuns = require('./paper-runs');
const paperCommands = require('./paper-commands');
const screenRefresh=require('./paper-screen-refresh');
const paperUsdc = require('./paper-usdc');
const paperExit = require('./paper-exit-policy');
const liveGeometry = require('./live-geometry');   // entry range / shape split = the dry run's
const liveOpenExec = require('./live-open-exec'); // order of the entry deposit transactions (unit-tested with a fake DLMM)
const liveCloseExec = require('./live-close-exec'); // swap back == dry run: token->USDC direct + whole SOL pile->USDC
const liveReshapeExec = require('./live-reshape-exec'); // reshape + compound on the same position == paperReshape
const liveRepositionExec = require('./live-reposition-exec'); // OOR-right reposition == paperRepositionRight
const livePositions = require('./live-positions'); // up to MAX_POSITIONS at once, same pick rules as the paper cycle
const liveExit = require('./live-exit');   // live exit decisions = the dry-run code (paper-usdc.exitQuote + paper-exit-policy.decide)
const multi = require('./paper-multi');
const quotePnl=require('./paper-quote-pnl');
const paperHistory=require('./paper-history');
const entryCost=require('./paper-entry-cost');
const strategy=require('./paper-strategy');
const entryPolicy=require('./paper-entry-policy');
const capitalAsset=require('./paper-capital-asset');
const swapRoute=require('./swap-route-config');
const paperReconcile=require('./paper-reconcile');
const slBlacklist=require('./paper-sl-blacklist');
const walletStore = require('./wallet-store');
const liveControl = require('./live-control');

const DIR = process.env.LP_BOT_DIR || '/workspace/lp-bot';
const PAPER_DIR = path.join(DIR, 'paper');
const historyArchivePolicy=entryPolicy.readArchivePolicy(PAPER_DIR);
let lastArchiveCount=-1;
const REAL_WALLET = require('./bot-wallet-address').botWalletAddress();   // public address of the bot's own stored wallet; null until a key is stored (never hard-coded)
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MAX_BINS = Number((MAX_BINS_PER_POSITION && MAX_BINS_PER_POSITION.toString()) || 1400);
const MAX_RESIZE = Number((MAX_RESIZE_LENGTH && MAX_RESIZE_LENGTH.toString()) || 91);

const PAPER = (process.env.PAPER ?? '1') === '1';
if (PAPER) process.env.DRY_RUN = '1';
const DRY = (process.env.DRY_RUN ?? '1') !== '0';

if (!DRY && process.env.LIVE_CONFIRMED !== '1') {
  console.error('REFUSING LIVE START: set DRY_RUN=0 and LIVE_CONFIRMED=1 only after Tuan approves and the wallet is funded.');
  process.exit(1);
}
if (!DRY && fs.existsSync(path.join(DIR, 'STOP'))) {
  console.error('REFUSING LIVE START: STOP is present at ' + path.join(DIR, 'STOP') + '. Leave it unless Tuan approves a live start.');
  process.exit(1);
}
if (!DRY) { // Tuan rule: live must be identical to dry run (one setting set, same behaviour). Refuse to start while any difference remains.
  const __parity = require('./parity-check').analyse().debt;
  if (__parity.length) {
    console.error('REFUSING LIVE START: live masih berbeda dari dry run: ' + __parity.join(', ') + '. Samakan dulu (node parity-check.js).');
    process.exit(1);
  }
}

const CFG = {
  PAPER, DRY_RUN: DRY,
  ONCE: process.argv.includes('--once'),
  RPC: require('./rpc-config').url(),   // custom SOLANA_RPC_URL > HELIUS_API_KEY > public endpoint
  POLL_SEC: +(process.env.POLL_SEC || 300),
  POSITION_SOL: +(process.env.POSITION_SOL || 2),
  POSITION_USD: process.env.POSITION_USD ? +process.env.POSITION_USD : 0,
  RESERVE_SOL: +(process.env.RESERVE_SOL || 0.15),
  TP: +(process.env.TP || 0.20),
  MAX_HOURS: +(process.env.MAX_HOURS || 12),
  // Fee/TVL: period fees / current TVL from Meteora datapi (default 30m, >= 2%).
  FT_WINDOW: (['30m','1h','2h','4h','12h','24h'].includes(process.env.FT_WINDOW) ? process.env.FT_WINDOW : '30m'),
  MIN_FT: +(process.env.MIN_FT || 1),
  MAX_PUMP1H: +(process.env.MAX_PUMP1H || 0.15),
  MIN_AGE_H: +(process.env.MIN_AGE_H || 24),
  MIN_LIQ_USD: +(process.env.MIN_LIQ_USD || 10000),
  MAX_POS_TVL_FRAC: +(process.env.MAX_POS_TVL_FRAC || 0.05),
  MAX_POSITIONS:5,CAPITAL_ASSET:'USDC',MAX_LIQ_USD:100000,MAX_NONREFUND_SOL:.05,REOPEN_COOLDOWN_MIN:30,MAX_PUMP24H_PCT:200,POSITION_USDC:0,UPPER_BUFFER_BINS:0,OOR_RIGHT_CONFIRM_POLLS:2,OOR_RIGHT_MIN_BINS:5,OOR_RIGHT_REPOSITION_MIN_PNL_PCT:-3,RUGCHECK_STICKY_DAYS:7,FEE_TURNOVER_MAX_PCT:60,FEE_TURNOVER_TVL_BELOW_USD:25000,OOR_RIGHT_MIN_PROFIT_PCT:.5,OOR_RIGHT_MAX_REPOSITIONS:2,
  MIN_BIN_STEP: +(process.env.MIN_BIN_STEP || 100),
  MAX_BIN_STEP: +(process.env.MAX_BIN_STEP || 400),
  MIN_VOL_1H: +(process.env.MIN_VOL_1H || 1000),
  MAX_PUMP_24H: +(process.env.MAX_PUMP_24H || 0.50),
  VOL_SPIKE_1H_OF_24H: +(process.env.VOL_SPIKE_1H_OF_24H || 0.50),
  EMERGENCY_DROP: +(process.env.EMERGENCY_DROP || 0.20),
  DEPTH: +(process.env.DEPTH || 0.5),
  SLIPPAGE_PCT: +(process.env.SLIPPAGE_PCT || 1),
  PRIORITY_MICROLAMPORTS: +(process.env.PRIORITY_MICROLAMPORTS || 50000),
  TX_FEE_SOL: +(process.env.TX_FEE_SOL || 0.000025),
  // Anti-rug checks default ON (set RUGCHECK=0 or CHECK_TOP_HOLDERS=0 to disable).
  RUGCHECK: process.env.RUGCHECK !== '0',
  MAX_RUGCHECK_SCORE_NORM: +(process.env.MAX_RUGCHECK_SCORE_NORM || 50),
  CHECK_TOP_HOLDERS: process.env.CHECK_TOP_HOLDERS !== '0',
  MAX_TOP10_HOLD: +(process.env.MAX_TOP10_HOLD || 0.30),
  MAX_DEV_HOLD: +(process.env.MAX_DEV_HOLD || 0.10),
  // Live reshape remains opt-in (RESHAPE=1). Paper always runs the shadow variant set below.
  RESHAPE: process.env.RESHAPE === '1',
  PAPER_VIRTUAL_SOL: +(process.env.PAPER_VIRTUAL_SOL || 5.30),
  PAPER_USDC: +(process.env.PAPER_USDC || paperCap.DEFAULT_USDC_START),
  USDC_BUFFER: +(process.env.USDC_BUFFER || paperCap.DEFAULT_USDC_BUFFER),
  GAS_BUFFER_SOL: +(process.env.GAS_BUFFER_SOL || paperCap.DEFAULT_GAS_BUFFER_SOL),
  PAPER_DAYS: +(process.env.PAPER_DAYS || 7),
};

// Parallel paper variants share one entry decision. Reshape trigger = price dropped N bins
// since last reshape (or since entry). Baseline never reshapes or compounds mid-hold.
// Final paper strategy: N5 only (reshape every 5 bins, compound on reshape).
// Shadow books kept commented so they can be restored without a rewrite.
const VARIANTS = [
  // { id: 'baseline', n: null, reshape: false, compound: false, label: 'baseline: no reshape, no compound' },
  { id: 'N5',  n: 5,  reshape: true, compound: true, label: 'reshape when price down 5 bins; compound on reshape' },
  // { id: 'N10', n: 10, reshape: true, compound: true, label: 'reshape when price down 10 bins; compound on reshape' },
];
function primaryBook(state) {
  const id = VARIANTS[0] && VARIANTS[0].id;
  return (state && state.books && id) ? state.books[id] : undefined;
}
const F = (n, paper = CFG.PAPER) => path.join(paper ? PAPER_DIR : DIR, n);
const now = () => new Date().toISOString();
const wib = (d = new Date()) => new Date(d).toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' }) + ' WIB';

function log(msg) {
  msg=swapRoute.cleanMessage(require('./env-config').redact(msg));
  const tag = CFG.PAPER ? ' [PAPER]' : (CFG.DRY_RUN ? ' [DRY]' : '');
  const l = `[${wib()}]${tag} ${msg}`;
  console.log(l);
  try {
    if (CFG.PAPER) {
      fs.mkdirSync(PAPER_DIR, { recursive: true });
      fs.appendFileSync(path.join(PAPER_DIR, 'bot.log'), l + '\n');
    } else {
      fs.appendFileSync(path.join(DIR, 'bot.log'), l + '\n');
    }
  } catch { /* ignore log IO */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, { tries = 3, baseMs = 500, label = 'op' } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      log(`${label} failed (${i + 1}/${tries}): ${e.message}`);
      if (i + 1 < tries) await sleep(baseMs * Math.pow(2, i));
    }
  }
  throw last;
}

async function getJSON(url, opt = {}, tries = 3) {
  return withRetry(async () => {
    const r = await fetch(url, { ...opt, signal: AbortSignal.timeout(opt.timeoutMs || 15000) });
    if (!r.ok) throw new Error(`${r.status} ${url.slice(0, 100)}`);
    return r.json();
  }, { tries, baseMs: 600, label: 'http ' + url.replace(/^https:\/\//, '').slice(0, 40) });
}

function loadState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return { position: null, history: [], lastScan: null, virtual: null, reshapes: [] }; }
}
function saveState(s, file) {
  if (!CFG.PAPER && s && (Array.isArray(s.positions) || s.__active !== undefined)) s = livePositions.persistView(s);   // live: positions[] on disk, position = first
  if(CFG.PAPER&&path.dirname(file)===PAPER_DIR){const tmp=file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(s,null,2));fs.renameSync(tmp,file);}
  else fs.writeFileSync(file, JSON.stringify(s, null, 2));
}

const conn = new Connection(CFG.RPC, 'confirmed');
let wallet = null; // only set in live mode
const USER_PUB = REAL_WALLET ? new PublicKey(REAL_WALLET) : PublicKey.default;   // placeholder for unsigned paper tx builds when no wallet is stored

function loadWallet() {
  // Encrypted store first (memory only). Env SOLANA_BOT_PRIVATE_KEY is fallback. Never log the secret.
  try {
    if (walletStore.hasKey()) return walletStore.loadKeypair();
  } catch (e) {
    log('wallet store unavailable; trying env fallback');
  }
  const raw = (process.env.PRIVATE_KEY || process.env.SOLANA_BOT_PRIVATE_KEY || '').trim();
  if (!raw) throw new Error('no wallet key in encrypted store or environment');
  try {
    return walletStore.parseSecretKey(raw);
  } catch {
    throw new Error('wallet key in environment is invalid');
  }
}

async function realSolBal(pk = (REAL_WALLET ? USER_PUB : null)) {
  if (!pk) return null;   // no wallet stored yet
  return (await withRetry(() => conn.getBalance(pk), { tries: 3, label: 'getBalance' })) / LAMPORTS_PER_SOL;
}

let solUsdCache = { t: 0, px: 0 };
async function solUsd() {
  if (Date.now() - solUsdCache.t < 60_000 && solUsdCache.px) return solUsdCache.px;
  try {
    const j = await getJSON('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', {}, 2);
    const px = +j?.solana?.usd;
    if (px > 0) { solUsdCache = { t: Date.now(), px }; return px; }
  } catch (e) { log('coingecko sol usd: ' + e.message); }
  try {
    const j = await getJSON('https://api.dexscreener.com/latest/dex/tokens/' + SOL, {}, 2);
    const px = +(j?.pairs?.[0]?.priceUsd || 0);
    if (px > 0) { solUsdCache = { t: Date.now(), px }; return px; }
  } catch (e) { log('dexscreener sol usd: ' + e.message); }
  return solUsdCache.px || 0;
}

async function targetPositionSol(poolTvlUsd) {
  const px = await solUsd();
  let want = CFG.POSITION_SOL;
  if (CFG.POSITION_USD > 0) {
    if (!px) throw new Error('POSITION_USD set but SOL/USD price unavailable');
    want = CFG.POSITION_USD / px;
  }
  const capUsd = (poolTvlUsd || 0) * CFG.MAX_POS_TVL_FRAC;
  const capSol = px && capUsd > 0 ? capUsd / px : want;
  const actual = Math.min(want, capSol);
  return { want, actual, capped: actual + 1e-12 < want, tvlUsd: poolTvlUsd, capUsd, solUsd: px };
}

function createdAtSec(p) {
  const t = +p.created_at || 0;
  return t > 1e12 ? t / 1000 : t;
}

// ---------- scan ----------
async function pump1h(pool) {
  try {
    const j = await getJSON(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/minute?aggregate=1&limit=90&currency=token`, {}, 2);
    const l = j?.data?.attributes?.ohlcv_list || [];
    if (l.length) {
      const tNow = l[0][0], cNow = l[0][4];
      const old = l.find((x) => x[0] <= tNow - 3600);
      if (old && old[4] > 0) return cNow / old[4] - 1;
    }
  } catch (e) { log(`  ohlcv gecko fail ${pool.slice(0, 6)}: ${e.message}`); }
  try {
    const j = await getJSON(`https://api.dexscreener.com/latest/dex/pairs/solana/${pool}`, {}, 2);
    const ch = j?.pair?.priceChange?.h1 ?? j?.pairs?.[0]?.priceChange?.h1;
    if (ch != null && isFinite(+ch)) return +ch / 100;
  } catch (e) { log(`  ohlcv dexscreener fail ${pool.slice(0, 6)}: ${e.message}`); }
  return null;
}

async function pump24h(pool) {
  try {
    const j = await getJSON(`https://api.dexscreener.com/latest/dex/pairs/solana/${pool}`, {}, 2);
    const pair = j?.pair || j?.pairs?.[0];
    const ch = pair?.priceChange?.h24;
    if (ch != null && isFinite(+ch)) return +ch / 100;
  } catch (e) { log(`  ohlcv24 dexscreener fail ${pool.slice(0, 6)}: ${e.message}`); }
  try {
    const j = await getJSON(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/hour?aggregate=1&limit=26&currency=token`, {}, 2);
    const l = j?.data?.attributes?.ohlcv_list || [];
    if (l.length) {
      const tNow = l[0][0], cNow = l[0][4];
      const old = l.find((x) => x[0] <= tNow - 86400);
      if (old && old[4] > 0) return cNow / old[4] - 1;
    }
  } catch (e) { log(`  ohlcv24 gecko fail ${pool.slice(0, 6)}: ${e.message}`); }
  return null;
}

const dexSearchCache = new Map();
// Free public DexScreener search (no key). Fail-open: on error anti PvP uses Meteora universe pools only.
async function dexSearchPairs(q) {
  const key = String(q || '').trim().toLowerCase();
  if (!key) return { pairs: [] };
  const hit = dexSearchCache.get(key);
  if (hit && Date.now() - hit.t < (hit.r.error ? 2 * 60_000 : 10 * 60_000)) return hit.r;
  let r;
  try { const j = await getJSON(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(key)}`, { timeoutMs: 8000 }, 1); r = { pairs: (j?.pairs || []).filter((x) => x?.chainId === 'solana') }; }
  catch (e) { r = { pairs: [], error: e.message }; }
  dexSearchCache.set(key, { t: Date.now(), r }); if (dexSearchCache.size > 500) dexSearchCache.delete(dexSearchCache.keys().next().value);
  return r;
}

let screenDiagBusy = false; const entryPassCache = new Map();
const pairCache = new Map();
// Display-only DexScreener pair read (h1/h24 price change) for pools that never reached the pump checks. Cached 5 min.
async function diagPair(pool, allow) {
  const hit = pairCache.get(pool); if (hit && Date.now() - hit.t < 20 * 60_000) return hit.v;
  if (!allow()) return null;
  let v = null;
  try { const j = await getJSON(`https://api.dexscreener.com/latest/dex/pairs/solana/${pool}`, { timeoutMs: 8000 }, 1); const pair = j?.pair || j?.pairs?.[0];
    const h1 = pair?.priceChange?.h1, h24 = pair?.priceChange?.h24; v = { h1: h1 != null && isFinite(+h1) ? +h1 / 100 : null, h24: h24 != null && isFinite(+h24) ? +h24 / 100 : null }; } catch { v = null; }
  if (v) { pairCache.set(pool, { t: Date.now(), v }); if (pairCache.size > 300) pairCache.delete(pairCache.keys().next().value); }
  await sleep(250); return v;
}

const rugCache = new Map();
async function fetchRugCheck(mint) {
  const hit = rugCache.get(mint);
  const ttl = hit?.report?.error ? 5 * 60_000 : 30 * 60_000;
  if (hit && Date.now() - hit.t < ttl) return hit.report;
  try {
    const report = await getJSON(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, { timeoutMs: 15000 }, 2);
    rugCache.set(mint, { t: Date.now(), report });
    return report;
  } catch (e) {
    const report = { error: e.message };
    rugCache.set(mint, { t: Date.now(), report });
    return report;
  }
}

async function mintOk(mint) {
  const a = await withRetry(() => conn.getParsedAccountInfo(new PublicKey(mint)), { tries: 3, label: 'mint' });
  const info = a.value?.data?.parsed?.info;
  if (!info) return { ok: false, why: 'mint unreadable' };
  if (info.freezeAuthority) return { ok: false, why: 'freeze authority set' };
  if (info.mintAuthority) return { ok: false, why: 'mint authority set' };
  return { ok: true, program: a.value.owner.toBase58(), supply: +info.supply || 0, decimals: info.decimals };
}

async function top10Hold(mint, supply, exclude = []) {
  try {
    const r = await conn.getTokenLargestAccounts(new PublicKey(mint));
    const ex = new Set(exclude.filter(Boolean));
    const accs = r.value.filter((a) => !ex.has(a.address.toBase58()));
    const top = accs.slice(0, 10).reduce((s, a) => s + +(a.uiAmount || 0), 0);
    const dec = accs[0]?.decimals ?? 0;
    const sup = supply > 0 ? supply / 10 ** dec : 0;
    const frac = sup > 0 ? top / sup : null;
    return { frac, top, supply: sup };
  } catch (e) {
    return { frac: null, error: e.message };
  }
}

async function fetchPool(address) {
  return getJSON(`https://dlmm.datapi.meteora.ag/pools/${address}`, {}, 3);
}

function feeTvl(p, window = CFG.FT_WINDOW) {
  const v = p?.fee_tvl_ratio?.[window];
  return Number.isFinite(+v) ? +v : null;
}

const entryCostCache=new Map(),pendingEntryCosts=new Map();
function fastEntryCost(dlmm,min,max,g,pool){const why=strategy.reason(g),cost=entryCost.fast(dlmm,min,max,{sdk:_dl,txFeeSol:CFG.TX_FEE_SOL,tokenAccountFeeSol:TOKEN_ACCOUNT_FEE,skipReason:why}),key=pool+':'+min+':'+max;cost.pendingKey=key;
 if(!pendingEntryCosts.has(key)){const slot={at:Date.now()};pendingEntryCosts.set(key,slot);quotePaperEntryCost(dlmm,min,max).then(v=>{slot.cost=v;}).catch(e=>{slot.error=String(e.message);});}
 log(why+'; '+pool+'; biaya estimasi atas '+cost.nonrefTotalSol.toFixed(6)+' SOL; SDK async correction');return cost;}
function reconcileEntryCosts(state){for(const b of Object.values(state.books||{}))for(const p of multi.positions(b)){if(!p.strategySettings)p.strategySettings=strategy.snapshot(CFG);const old=p.entryCostEstimate,ready=pendingEntryCosts.get(old?.pendingKey)?.cost;if(old?.estimated&&old.pendingKey&&(!pendingEntryCosts.has(old.pendingKey)||(pendingEntryCosts.get(old.pendingKey)?.error&&Date.now()-(pendingEntryCosts.get(old.pendingKey)?.at||0)>60000))){const slot={at:Date.now()};pendingEntryCosts.set(old.pendingKey,slot);DLMM.create(conn,new PublicKey(p.pool)).then(d=>quotePaperEntryCost(d,old.minBinId,old.maxBinId)).then(c=>{slot.cost=c;}).catch(e=>{slot.error=String(e.message);});}if(!ready||!old?.estimated)continue;
 const delta=(old.refundableRentSol+old.nonrefRentSol)-(ready.refundableRentSol+ready.nonrefRentSol);if((p.reserveSol||0)+delta<0){log('rent correction ditunda: reserve insufficient '+p.name);continue;}p.reserveSol=(p.reserveSol||0)+delta;p.rentPaidSol=ready.refundableRentSol+ready.nonrefRentSol;p.rentRefundableSol=ready.refundableRentSol;p.rentNonRefundableSol=ready.nonrefRentSol;p.entryCostEstimate={...ready,skipCheck:true,skipReason:old.skipReason,reconciledFromEstimate:true};
 if(p.openContext?.snapshot)p.openContext.snapshot.entryCostEstimate={...p.entryCostEstimate,originalEstimate:old};
 const line='rent SDK correction '+p.name+' reserveSOL '+(p.reserveSol-delta).toFixed(8)+' -> '+p.reserveSol.toFixed(8)+'; nonref '+old.nonrefRentSol+' -> '+ready.nonrefRentSol;log(line);paperSettings.audit(PAPER_DIR,'action='+line);}}

async function quotePaperEntryCost(dlmm,minBinId,maxBinId){
 return entryCost.estimate(dlmm,{minBinId,maxBinId,strategyType:StrategyType.Spot},{txFeeSol:CFG.TX_FEE_SOL,tokenAccountFeeSol:TOKEN_ACCOUNT_FEE,bitmapExists:async()=>{
  const pda=_dl.deriveBinArrayBitmapExtension(dlmm.pubkey,dlmm.program.programId)[0];return !!(await conn.getAccountInfo(pda));
 }});
}
async function screenEntryCost(p,policy){
 let geo;try{geo=strategy.geometry(Number(p.pool_config.bin_step),policy,MAX_BINS);}catch(e){return {known:false,error:e.message};}if(strategy.skip(geo)){const key='skip:'+p.address,why=strategy.reason(geo);if(!entryCostCache.has(key)){log('screen '+p.name+': '+why);entryCostCache.set(key,{time:Date.now()});if(entryCostCache.size>128)entryCostCache.delete(entryCostCache.keys().next().value);}return {skipCheck:true,known:false,skipReason:why,geometry:geo};}
 const key=p.address+':'+JSON.stringify(strategy.snapshot(policy)),old=entryCostCache.get(key);
 if(old&&Date.now()-old.time<60000)return old.cost;
 try{const d=await DLMM.create(conn,new PublicKey(p.address)),a=await d.getActiveBin(),step=Number(p.pool_config.bin_step),n=geo.n;
 const cost=await quotePaperEntryCost(d,a.binId-n+1,a.binId+geo.upper);
 entryCostCache.set(key,{time:Date.now(),cost});if(entryCostCache.size>128)entryCostCache.delete(entryCostCache.keys().next().value);return cost;
 }catch{return {known:false,at:now()};}
}

let scanInFlight = null;
function scan() {
  if (!scanInFlight) scanInFlight = performScan({ ...CFG }).then(picks=>{scan.picks=picks;return picks;}).finally(() => { scanInFlight = null; });
  return scanInFlight;
}
async function performScan(policy,opts={}) {
  let recentHistory=[],recentEntries=[];if(policy.PAPER){try{const book=JSON.parse(fs.readFileSync(F('state.json'),'utf8')).books?.[VARIANTS[0].id]||{};recentHistory=book.history||[];recentEntries=recentHistory.concat(multi.positions(book));}catch{}}else{recentHistory=scan.liveHistory||[];recentEntries=recentHistory.concat(scan.liveOpen||[]);}   // live: its own closed trades + open position, same filters as the dry run
  const scanStartedAt=now(),refreshRequest=screenRefresh.read(PAPER_DIR),manualWarnings=[];
  const universe = opts.targetAddress?{pools:[await fetchPool(opts.targetAddress)],topFees:[]}:await screenSource.fetchUniverse(getJSON, policy, log);
  const soft=(p,why)=>{if(opts.targetAddress===p.address&&opts.allowOverride){manualWarnings.push(why);return false;}bump(why);return true;};
  const seen = new Map(universe.pools.map(p => [p.address,p]));
  const reasonsByAddress = new Map();
  const nowS = Date.now() / 1000;
  const rej = {};
  let screeningPool = null;
  const bump = (k) => { rej[k] = (rej[k] || 0) + 1; if (screeningPool) reasonsByAddress.set(screeningPool.address, [k]); };
  const c = [...seen.values()].filter((p) => {
    screeningPool = p;
    const sanity=screenSource.sanityReason(p,policy.MIN_LIQ_USD);
    if(sanity)return bump(sanity),false;
    if (![SOL,USDC].includes(p.token_y?.address)) return bump('quote not SOL/USDC'), false;
    if (p.is_blacklisted) return bump('blacklisted'), false;
    const ftEv = antirug.evaluateFeeTvl(feeTvl(p), policy.MIN_FT, policy.FT_WINDOW);
    if (!ftEv.ok&&soft(p,ftEv.why))return false;
    if (!((p.tvl || 0) >= policy.MIN_LIQ_USD)) return bump(`tvl<$${policy.MIN_LIQ_USD}`), false;
    if ((nowS - createdAtSec(p)) / 3600 < policy.MIN_AGE_H&&soft(p,`age<${policy.MIN_AGE_H}h`))return false;
    const bs = p.pool_config?.bin_step;
    if ((bs < policy.MIN_BIN_STEP || bs > policy.MAX_BIN_STEP)&&soft(p,`bin_step outside ${policy.MIN_BIN_STEP}-${policy.MAX_BIN_STEP}`))return false;
    if (policy.MAX_LIQ_USD>0 && p.tvl>policy.MAX_LIQ_USD)return bump(`tvl>$${policy.MAX_LIQ_USD}`),false;
    if (!(p.token_y_amount > 1)) return bump('no quote liquidity'), false;
    if ((p.volume?.['1h'] || 0) < policy.MIN_VOL_1H&&soft(p,'vol1h low'))return false;
    const spike = antirug.evaluateVolSpike(p.volume?.['1h'], p.volume?.['24h'], policy.VOL_SPIKE_1H_OF_24H);
    if (!spike.ok&&soft(p,spike.why))return false;
    const fto = feeTurnover.evaluate(p, policy);
    if (!fto.ok&&soft(p,fto.why))return false;
    return true;
  }).sort((a,b)=>screenSource.priority(a,b,policy.CAPITAL_ASSET));
  log(`scan: ${seen.size} pools fetched, ${c.length} pass basic filters; rejects=${JSON.stringify(rej)}`);
  const near = [...seen.values()].filter((p) => {
    if (p.token_y?.address !== SOL || p.is_blacklisted) return false;
    if (!((p.tvl || 0) >= policy.MIN_LIQ_USD)) return false;
    if ((nowS - createdAtSec(p)) / 3600 < policy.MIN_AGE_H) return false;
    const ev = antirug.evaluateFeeTvl(feeTvl(p), policy.MIN_FT, policy.FT_WINDOW);
    return !ev.ok;
  }).sort((a, b) => (feeTvl(b) || 0) - (feeTvl(a) || 0));
  if (near.length) {
    log(`near-threshold (SOL + tvl>=$${policy.MIN_LIQ_USD} + age>=${policy.MIN_AGE_H}h, ${policy.FT_WINDOW} fee/TVL < ${policy.MIN_FT}%): `
      + near.slice(0, 8).map((p) => {
        const v = feeTvl(p);
        return `${p.name} ${p.address.slice(0, 6)} ft${policy.FT_WINDOW}=${v == null ? 'n/a' : v.toFixed(3)}% tvl=$${p.tvl.toFixed(0)}`;
      }).join('; '));
  }
  const picks = [];
  const diag = new Map(), D = (p) => { let x = diag.get(p.address); if (!x) diag.set(p.address, x = {}); return x; }; // display-only records, never read by the decision
  const skip = (tag, why) => { bump(why); log(`  skip ${tag}: ${why}`); };
  // Manual pick with the confirmed override: filter-type rejections become warnings (returns false = keep going). Safety rejections (TVL min/max, quote, RugCheck, mint authority, insiders, holders) stay hard and never use this.
  const skipSoft = (p, tag, why) => { if (opts.targetAddress === p.address && opts.allowOverride) { manualWarnings.push(why); return false; } skip(tag, why); return true; };
  const ff = antiPvp.filterFlags(policy, { RUGCHECK: true, CHECK_TOP_HOLDERS: true }), filtersOn = ff.master;
  const fOn = (k) => ({ PUMP1H_FILTER_ENABLED: ff.pump1h, PUMP24H_FILTER_ENABLED: ff.pump24h, CHECK_INSIDERS: ff.insiders })[k];
  const pvpMode = ff.antiPvp;
  const pvpUniverse = [...seen.values()].map(antiPvp.fromPool);
  log(`token filters: master=${filtersOn ? 'ON' : 'OFF'} pump1h=${fOn('PUMP1H_FILTER_ENABLED')} pump24h=${fOn('PUMP24H_FILTER_ENABLED')} rugcheck=${!!policy.RUGCHECK} topHolders=${!!policy.CHECK_TOP_HOLDERS} insiders=${fOn('CHECK_INSIDERS')}(<=${policy.MAX_INSIDER_PCT ?? 25}%) antiPvp=${pvpMode}(twin liq>=$${policy.ANTI_PVP_MIN_LIQ_USD ?? 10000}) tvlDrop=${ff.tvlDrop}(>=${policy.TVL_DROP_MAX_PCT ?? 45}%) slBlacklist=${policy.SL_BLACKLIST_ENABLED !== false}`);
  for (const p of c.slice(0,40)) {
    screeningPool = p;
    const ageH = (nowS - createdAtSec(p)) / 3600;
    const tag = `${p.name} ${p.address.slice(0, 6)} ft${policy.FT_WINDOW}=${(feeTvl(p) ?? 0).toFixed(2)}% tvl=$${p.tvl.toFixed(0)} age=${ageH.toFixed(1)}h bs=${p.pool_config.bin_step}`;
    if(policy.SL_BLACKLIST_ENABLED!==false&&slBlacklist.has(PAPER_DIR,p.token_x?.address)&&skipSoft(p,p.name,'SL blacklist'))continue;
    {const cooldown=entryPolicy.cooldownReason(recentHistory,p.address,policy.REOPEN_COOLDOWN_MIN);if(cooldown&&skipSoft(p,tag,cooldown))continue;}
    if (ff.tvlDrop) { const ev = tvlDrop.evaluatePool(p, recentEntries, policy.TVL_DROP_MAX_PCT ?? 45); if (!ev.ok && skipSoft(p, tag, ev.why)) continue; }
    if (ff.oldDump && policy.OLD_TOKEN_MODE === 'BLOCK_ALL') { const ot = antirug.evaluateOldToken(Number(p.created_at) > 0 ? ageH : null, policy.OLD_DUMP_MIN_AGE_H ?? 400); if (!ot.ok && skipSoft(p, tag, ot.why)) continue; }
    {p.entryCostEstimate=await screenEntryCost(p,policy);const why=entryCost.rejection(p.entryCostEstimate,policy.MAX_NONREFUND_SOL??.05);if(why&&skipSoft(p,tag,why))continue;}
    let pvp = null;
    if (pvpMode !== 'OFF') {
      const ds = await dexSearchPairs(p.token_x?.symbol || p.name?.split('-')[0]);
      if (ds.error) log(`  anti PvP ${p.name}: dexscreener gagal (${ds.error}); pakai pool Meteora saja`);
      pvp = antiPvp.evaluate({ self: antiPvp.fromPool(p), entries: [...pvpUniverse, ...ds.pairs.map(antiPvp.fromDexPair)], mode: pvpMode, minLiq: policy.ANTI_PVP_MIN_LIQ_USD ?? 10000 });
      D(p).pvp = pvp;
      if (!pvp.ok && skipSoft(p, tag, pvp.why)) continue;
    }
    let pu = null;
    if (fOn('PUMP1H_FILTER_ENABLED')) {
    try { pu = await pump1h(p.address); } catch (e) { skip(tag, `ohlcv error ${e.message}`); await sleep(1500); continue; }
    await sleep(800);
    D(p).pu = pu;
    if (pu == null) { skip(tag, 'no 1h price history'); continue; }
    if(pu>policy.MAX_PUMP1H&&soft(p,`pump1h=${(pu*100).toFixed(1)}%`)){log(`  skip ${tag}: pump1h=${(pu*100).toFixed(1)}%`);continue;}
    }
    let pu24 = null;
    if (fOn('PUMP24H_FILTER_ENABLED')) {
    try { pu24 = await pump24h(p.address); } catch (e) { skip(tag, `ohlcv24 error ${e.message}`); await sleep(800); continue; }
    D(p).pu24 = pu24;
    const pump24 = antirug.evaluatePump24h(pu24, policy.MAX_PUMP_24H);
    if(!pump24.ok&&skipSoft(p,tag,pump24.why))continue;
    }
    if (ff.oldDump && policy.OLD_TOKEN_MODE !== 'BLOCK_ALL' && ageH > (policy.OLD_DUMP_MIN_AGE_H ?? 400)) {
      if (pu24 == null) { try { pu24 = await pump24h(p.address); } catch (e) { skip(tag, `token tua: ohlcv24 error ${e.message}`); await sleep(800); continue; } D(p).pu24 = pu24; }
      const od = antirug.evaluateOldDump(ageH, pu24, policy.OLD_DUMP_MIN_AGE_H ?? 400, policy.OLD_DUMP_MAX_PUMP24H ?? 0);
      if (!od.ok && skipSoft(p, tag, od.why)) continue;
    }
    const m = await mintOk(p.token_x.address);
    D(p).mint = m;
    if (!m.ok) { skip(tag, m.why); continue; }
    let report = null, rcInfo = null;
    if (policy.RUGCHECK) {
      const rs = await rugSticky.check({ dir: PAPER_DIR, mint: p.token_x.address, days: policy.RUGCHECK_STICKY_DAYS ?? 7, symbol: p.token_x.symbol || p.name, pool: p.address, fetch: fetchRugCheck, evaluate: (r) => antirug.evaluateRugCheck(r, policy), log });
      report = rs.report; rcInfo = rs.rc;
      if (!rs.ok) { skip(tag, rs.why); continue; }
    }
    let ins = null;
    if (fOn('CHECK_INSIDERS')) {
      if (!report) report = await fetchRugCheck(p.token_x.address);
      ins = antirug.evaluateInsiders(report, policy);
      if (!ins.ok) { skip(tag, ins.why); continue; }
    }
    let top = { frac: null, devFrac: null };
    if (policy.CHECK_TOP_HOLDERS) {
      const fromReport = report && !report.error ? antirug.evaluateHoldersFromReport(report, [p.reserve_x, p.address], policy) : null;
      if (fromReport && fromReport.ok) {
        top = { frac: fromReport.top10Frac, devFrac: fromReport.devFrac };
      } else if (fromReport && fromReport.why && fromReport.why !== 'holder concentration unknown') {
        skip(tag, fromReport.why);
        continue;
      } else {
        // RugCheck missing holder rows: fail-closed RPC fallback (exclude pool reserve).
        const rpc = await top10Hold(p.token_x.address, m.supply, [p.reserve_x]);
        if (rpc.frac == null) { skip(tag, `holder concentration unknown${rpc.error ? ' (' + rpc.error + ')' : ''}`); continue; }
        const ev = antirug.evaluateHolders({ top10Frac: rpc.frac, devFrac: fromReport?.devFrac ?? null }, policy);
        if (!ev.ok) { skip(tag, ev.why); continue; }
        top = { frac: ev.top10Frac, devFrac: ev.devFrac };
      }
    }
    log(`  PASS ${tag} pump1h=${pu == null ? 'off' : (pu * 100).toFixed(1) + '%'} pump24h=${pu24 == null ? 'off' : (pu24 * 100).toFixed(1) + '%'}${rcInfo ? ' rugScore=' + (rcInfo.scoreNorm ?? 'n/a') : ''}${ins ? ` insider=${ins.pct == null ? 'n/a' : ins.pct.toFixed(1) + '%'}` : ''}${pvp ? ` antiPvP=${pvp.twins.length ? 'kept(' + pvp.twins.length + ' kembar)' : 'ok'}` : ''}${top.frac != null ? ` top10=${(top.frac * 100).toFixed(1)}%` : ''}${top.devFrac != null ? ` dev=${(top.devFrac * 100).toFixed(1)}%` : ''}`);
    picks.push({ ...p, pump1h: pu, pump24h: pu24, top10: top.frac, devHold: top.devFrac, entryInsiderPct: ins ? ins.pct : (report && !report.error ? antirug.evaluateInsiders(report, policy).pct : null) });
    // Check all basic candidates for honest pass/reject UI; auto entry still uses picks.slice(0,1).
  }
  log(`scan final: ${picks.length} pass all filters; rejects=${JSON.stringify(rej)}`);
  if(opts.targetAddress){
    if(!picks.length)throw Error('Filter wajib / screening terbaru menolak: '+JSON.stringify(rej));
    const acknowledged=new Set((opts.confirmedReasons||[]).map(screenRefresh.category));
    const fresh=manualWarnings.filter(x=>!acknowledged.has(screenRefresh.category(x)));
    if(fresh.length)throw Error('Filter gagal baru, perlu konfirmasi ulang: '+fresh.join('; '));
    picks[0].manualWarnings=manualWarnings;return picks;
  }
  const passed = new Set(picks.map(p=>p.address));
  const basic = new Set(c.map(p=>p.address));
  const displayed = new Map(universe.topFees.map(p=>[p.address,p]));
  for (const p of c) displayed.set(p.address,p);
  for (const p of seen.values()) if(screenSource.sanityReason(p,policy.MIN_LIQ_USD)) displayed.set(p.address,p);
  const decisionMs=Date.now()-Date.parse(scanStartedAt); // open/skip decision is final here; everything below is display-only
  const toRow=(p)=> {
    let reasons = reasonsByAddress.get(p.address) || [];
    const cooldown=entryPolicy.cooldownReason(recentHistory,p.address,policy.REOPEN_COOLDOWN_MIN);if(cooldown&&!reasons.includes(cooldown))reasons=[...reasons,cooldown];
    if(![SOL,USDC].includes(p.token_y?.address)) reasons=[`quote ${p.token_y?.symbol||'unsupported'}`];
    // UI includes age/TVL failures even if quote is the first rejection.
    if((Date.now()/1000-createdAtSec(p))/3600<policy.MIN_AGE_H && !reasons.some(r=>r.startsWith('age<'))) reasons=[...reasons,`age<${policy.MIN_AGE_H}h`];
    if((p.tvl||0)<policy.MIN_LIQ_USD && !reasons.some(r=>r.startsWith('tvl<'))) reasons=[...reasons,`tvl<$${policy.MIN_LIQ_USD}`];
    if(policy.MAX_LIQ_USD>0&&p.tvl>policy.MAX_LIQ_USD&&!reasons.some(r=>r.startsWith('tvl>')))reasons=[...reasons,`tvl>$${policy.MAX_LIQ_USD}`];
    const status=passed.has(p.address)?'passed':basic.has(p.address)&&!reasons.length?'pending':'rejected';
    if(status==='pending')reasons=['belum diperiksa penuh pada scan ini; diperiksa ulang saat Open'];
    if(!p.entryCostEstimate){try{const g=strategy.geometry(Number(p.pool_config?.bin_step),policy,MAX_BINS);if(strategy.skip(g))p.entryCostEstimate={skipCheck:true,known:false,skipReason:strategy.reason(g),geometry:g};}catch{}}
    {const row=screenSource.row(p,reasons,status,policy.MIN_LIQ_USD);row.allReasons=null;return row;}
  };
  // Open positions are always listed (pinned on top) with "alasan dibuka", even when they left top fees / basic filters.
  let openPosNow=[];try{openPosNow=multi.positions(JSON.parse(fs.readFileSync(F('state.json'),'utf8')).books?.[VARIANTS[0].id])||[];}catch{}
  const openSet=new Set(openPosNow.map(x=>x.pool));
  const latestOf=(p,x={})=>p?{ft30mPct:feeTvl(p),tvlUsd:p.tvl,ageH:(nowS-createdAtSec(p))/3600,binStep:p.pool_config?.bin_step,vol1hUsd:p.volume?.['1h'],vol24hUsd:p.volume?.['24h'],marketCapUsd:p.token_x?.market_cap,
    pump1hPct:x.pu==null?null:x.pu*100,pump24hPct:x.pu24==null?null:x.pu24*100,insiderPct:x.report&&!x.report.error?antirug.evaluateInsiders(x.report,policy).pct:null}:null;
  const openRow=(pos,p)=>{const r=p?toRow(p):{name:pos.name,address:pos.pool,mintX:pos.mintX,quote:pos.quoteSymbol||'SOL',quoteMint:pos.quoteMint,ft30m:null,fees30mUsd:null,tvl:null,marketCapUsd:null,binStep:pos.binStep,baseFeePct:pos.baseFeePct??null,ageH:null,
      reasons:['tidak ada di daftar pool scan ini'],status:'rejected',sanityRejected:false,source:'open-position',hawkfiVerified:false,allReasons:null};
    r.isOpen=true;r.openInfo=entryReasons.build(pos,{policy,pass:entryPassCache.get(pos.pool+'|'+pos.openedAt)||null,latest:latestOf(p)});return r;};
  const display = [...openPosNow.map(pos=>openRow(pos,seen.get(pos.pool))),...screenSource.sortRows([...displayed.values()].filter(p=>!openSet.has(p.address)).map(toRow))];
  scan.last = { at:now(), atWib:wib(),startedAt:scanStartedAt,requestId:refreshRequest?.id,policy:screenRefresh.policy(policy),policyKey:screenRefresh.signature(policy), fetched:seen.size, basic:c.length, passed:picks.length, rejects:rej,
    filters:{REOPEN_COOLDOWN_MIN:policy.REOPEN_COOLDOWN_MIN,MAX_PUMP24H_PCT:policy.MAX_PUMP24H_PCT,MAX_LIQ_USD:policy.MAX_LIQ_USD,MAX_NONREFUND_SOL:policy.MAX_NONREFUND_SOL,MIN_FT:policy.MIN_FT,MIN_LIQ_USD:policy.MIN_LIQ_USD,MIN_AGE_H:policy.MIN_AGE_H,MIN_BIN_STEP:policy.MIN_BIN_STEP,MAX_BIN_STEP:policy.MAX_BIN_STEP,FILTERS_ENABLED:filtersOn,PUMP1H_FILTER_ENABLED:fOn('PUMP1H_FILTER_ENABLED'),PUMP24H_FILTER_ENABLED:fOn('PUMP24H_FILTER_ENABLED'),RUGCHECK:!!policy.RUGCHECK,CHECK_TOP_HOLDERS:!!policy.CHECK_TOP_HOLDERS,CHECK_INSIDERS:fOn('CHECK_INSIDERS'),MAX_INSIDER_PCT:policy.MAX_INSIDER_PCT,ANTI_PVP_MODE:pvpMode,ANTI_PVP_MIN_LIQ_USD:policy.ANTI_PVP_MIN_LIQ_USD,TVL_DROP_FILTER_ENABLED:ff.tvlDrop,TVL_DROP_MAX_PCT:policy.TVL_DROP_MAX_PCT},
    source:universe.source,sourceLabel:universe.sourceLabel,sourceReason:universe.sourceReason,
    hawkfiEndpoint:universe.hawkfiEndpoint,hawkfiVerified:false,coverage:universe.coverage,
    display, near:near.slice(0,8).map(p=>screenSource.row(p,[`fee/tvl${policy.FT_WINDOW}<${policy.MIN_FT}%`])),
    candidates:picks.map(p=>screenSource.row(p,[],'passed',policy.MIN_LIQ_USD)) };
  if(policy.PAPER){
    fs.mkdirSync(PAPER_DIR,{recursive:true});
    const temp=F(`screening.${process.pid}.tmp`);fs.writeFileSync(temp,JSON.stringify(scan.last,null,2));fs.renameSync(temp,F('screening.json'));
  }
  log(`scan timing: decision ${(decisionMs/1000).toFixed(1)}s (keputusan open/skip selesai; alasan lengkap dihitung di background, tidak menunda open)`);
  if(policy.PAPER&&!screenDiagBusy){screenDiagBusy=true;const snap=scan.last;
    (async()=>{
      const openExtra=[];
      for(const pos of openPosNow){const key=pos.pool+'|'+pos.openedAt;
        if(!entryPassCache.has(key)){const sn=pos.openContext?.snapshot||{};let pass=null;if(sn.pump1hPct==null||sn.insiderPct==null){try{pass=entryReasons.findPass(fs.readFileSync(F('bot.log'),'utf8'),pos.pool,pos.name,pos.openedAt);}catch{}}entryPassCache.set(key,pass);if(entryPassCache.size>200)entryPassCache.delete(entryPassCache.keys().next().value);}
        if(seen.has(pos.pool)&&!displayed.has(pos.pool))openExtra.push(seen.get(pos.pool));
        if(!seen.has(pos.pool)){try{const p=await fetchPool(pos.pool);if(p&&p.address){openExtra.push(p);const r=snap.display.find(x=>x.address===pos.pool);if(r)Object.assign(r,toRow(p),{reasons:['tidak masuk top fees / filter dasar scan ini'],status:'rejected'});}}catch(e){log('open pool stats: '+e.message);}await sleep(250);}}
      const diagT0=Date.now(),diagReasons=new Map(),diagLatest=new Map(),diagStats={rug:0,dex:0,pair:0,unchecked:0};
      try{
        const ffD=antiPvp.filterFlags(policy,{RUGCHECK:true,CHECK_TOP_HOLDERS:true}),MAX_NEW=6,budgetEnd=Date.now()+10000,canFetch=()=>Date.now()<budgetEnd;
        let openPos=[];try{openPos=multi.positions(JSON.parse(fs.readFileSync(F('state.json'),'utf8')).books?.[VARIANTS[0].id]);}catch{}
        const slMints=policy.PAPER?slBlacklist.read(PAPER_DIR).mints:{};
        const order=[...openExtra,...[...displayed.values()].sort((a,b)=>Number(basic.has(b.address))-Number(basic.has(a.address))||(feeTvl(b)||0)-(feeTvl(a)||0))];
        for(const p of order){
          const d=diag.get(p.address)||{},mint=p.token_x?.address;
          let report;
          if(mint&&(policy.RUGCHECK||policy.CHECK_TOP_HOLDERS||ffD.insiders)){const rc=rugCache.get(mint);if(rc&&Date.now()-rc.t<(rc.report?.error?5*60_000:60*60_000))report=rc.report;else if(diagStats.rug<MAX_NEW&&canFetch()){diagStats.rug++;report=await fetchRugCheck(mint);await sleep(250);}}
          let pvp=d.pvp;
          if(pvp===undefined&&ffD.antiPvp!=='OFF'){const q=String(p.token_x?.symbol||p.name?.split('-')[0]||'').trim().toLowerCase(),hit=q&&dexSearchCache.get(q);let ds=null;
            if(hit&&Date.now()-hit.t<(hit.r.error?2*60_000:30*60_000))ds=hit.r;else if(q&&diagStats.dex<MAX_NEW&&canFetch()){diagStats.dex++;ds=await dexSearchPairs(q);await sleep(250);}
            if(ds)pvp=antiPvp.evaluate({self:antiPvp.fromPool(p),entries:[...pvpUniverse,...ds.pairs.map(antiPvp.fromDexPair)],mode:ffD.antiPvp,minLiq:policy.ANTI_PVP_MIN_LIQ_USD??10000});}
          let pu=d.pu,pu24=d.pu24,pumpSource=null;
          if((ffD.pump1h&&pu===undefined)||((ffD.pump24h||(ffD.oldDump&&policy.OLD_TOKEN_MODE!=='BLOCK_ALL'&&(nowS-createdAtSec(p))/3600>(policy.OLD_DUMP_MIN_AGE_H??400)))&&pu24===undefined)){const pr=await diagPair(p.address,()=>diagStats.pair<MAX_NEW&&canFetch()&&(diagStats.pair++,true));if(pr){if(pu===undefined)pu=pr.h1;if(pu24===undefined)pu24=pr.h24;pumpSource='DexScreener';}}
          const list=screenReasons.evaluate(p,{policy,nowS,flags:ffD,sl:mint?slMints[mint]||null:null,cooldown:policy.PAPER?entryPolicy.cooldownReason(recentHistory,p.address,policy.REOPEN_COOLDOWN_MIN):null,
            open:{samePool:openPos.some(x=>x.pool===p.address),caPoolName:(openPos.find(x=>x.mintX===mint&&x.pool!==p.address)||{}).name||null,count:openPos.length,max:policy.MAX_POSITIONS},
            entryCost:p.entryCostEstimate||undefined,pu,pu24,pumpSource,mint:d.mint,report,pvp,rugSticky:mint&&policy.RUGCHECK&&(policy.RUGCHECK_STICKY_DAYS??7)>0?rugSticky.get(PAPER_DIR,mint,policy.RUGCHECK_STICKY_DAYS??7):null,holdersExclude:[p.reserve_x,p.address],
            prevTvl:tvlDrop.entryTvl(tvlDrop.previousEntry(recentEntries.concat(openPos),p))});
          diagStats.unchecked+=list.filter(x=>x.s==='unchecked').length;diagReasons.set(p.address,list);diagLatest.set(p.address,{pu,pu24,report});
        }
      }catch(e){log('screen reasons diagnostics failed: '+e.message);}

      if(scan.last!==snap){log('alasan lengkap: dilewati, sudah ada scan baru');return;}
      for(const r of snap.display){r.allReasons=diagReasons.get(r.address)||null;
        if(r.isOpen){const pos=openPosNow.find(x=>x.pool===r.address);const p=seen.get(r.address)||openExtra.find(x=>x.address===r.address);r.isOpen=true;r.openInfo=entryReasons.build(pos,{policy,pass:entryPassCache.get(pos.pool+'|'+pos.openedAt)||null,latest:latestOf(p,diagLatest.get(r.address)||{})});}}
      snap.reasonsAt=now();
      const temp=F(`screening.${process.pid}.tmp`);fs.writeFileSync(temp,JSON.stringify(snap,null,2));fs.renameSync(temp,F('screening.json'));
      log(`scan timing: alasan lengkap ${((Date.now()-diagT0)/1000).toFixed(1)}s di background (${diagReasons.size} pool; fetch baru rugcheck=${diagStats.rug} dexsearch=${diagStats.dex} pair=${diagStats.pair}; belum dicek=${diagStats.unchecked})`);
    })().catch(e=>log('screen reasons background failed: '+e.message)).finally(()=>{screenDiagBusy=false;});
  }
  return picks;
}

let lastRefreshAttempt=0,lastRefreshKey='';
function tickScreenRefresh(){
 if(!CFG.PAPER||scanInFlight)return;
 let last=scan.last;try{if(!last)last=JSON.parse(fs.readFileSync(F('screening.json')));}catch{}
 const key=screenRefresh.signature(CFG)+(screenRefresh.read(PAPER_DIR)?.id||'');
 if(screenRefresh.status(PAPER_DIR,CFG,last).stale&&(key!==lastRefreshKey||Date.now()-lastRefreshAttempt>=30000)){lastRefreshKey=key;lastRefreshAttempt=Date.now();scan().catch(e=>log('screen refresh error: '+e.message));}
}

// ---------- strategy / bin math ----------
function binsForDepth(binStep, depth = CFG.DEPTH) {
  const bs = binStep / 1e4;
  if (!(bs > 0) || !(depth > 0) || depth >= 1) return 1;
  return Math.max(1, Math.ceil(Math.log(1 / (1 - depth)) / Math.log(1 + bs)));
}

function bnUi(bn, dec) {
  const s = bn.toString();
  if (!dec) return +s;
  const pad = s.padStart(dec + 1, '0');
  return +(pad.slice(0, -dec) + '.' + pad.slice(-dec));
}

function amountsFromBps(dist, total, side /* 'x' | 'y' */) {
  const out = [];
  for (const d of dist) {
    const bps = +(d[side === 'x' ? 'xAmountBpsOfTotal' : 'yAmountBpsOfTotal'] || 0);
    const amt = total * bps / 10_000;
    if (amt > 0) out.push({ binId: d.binId, amount: amt });
  }
  return out;
}

async function strategyAmounts(dlmm, { minBinId, maxBinId, amountX, amountY, strategyType }) {
  const active = await dlmm.getActiveBin();
  const binStep = Number(dlmm.lbPair.binStep);
  const decX = dlmm.tokenX.mint.decimals;
  const decY = dlmm.tokenY.mint.decimals;
  try {
    const rows = toAmountsBothSideByStrategy(
      active.binId, binStep, minBinId, maxBinId,
      new BN(Math.floor(amountX * 10 ** decX)),
      new BN(Math.floor(amountY * 10 ** decY)),
      active.xAmount || new BN(0), active.yAmount || new BN(0),
      strategyType, dlmm.tokenX.mint, dlmm.tokenY.mint, dlmm.clock,
    );
    return rows.map((r) => ({ binId: r.binId, x: bnUi(r.amountX, decX), y: bnUi(r.amountY, decY) }));
  } catch (e) {
    log('toAmountsBothSideByStrategy fallback to bps: ' + e.message);
    const ids = [];
    for (let i = minBinId; i <= maxBinId; i++) ids.push(i);
    const dist = strategyType === StrategyType.BidAsk
      ? calculateBidAskDistribution(active.binId, ids)
      : calculateSpotDistribution(active.binId, ids);
    const xs = amountsFromBps(dist, amountX, 'x');
    const ys = amountsFromBps(dist, amountY, 'y');
    const map = new Map();
    for (const r of xs) map.set(r.binId, { binId: r.binId, x: r.amount, y: 0 });
    for (const r of ys) {
      const row = map.get(r.binId) || { binId: r.binId, x: 0, y: 0 };
      row.y += r.amount;
      map.set(r.binId, row);
    }
    return [...map.values()];
  }
}

function mergeAmounts(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const r of list) {
      const row = map.get(r.binId) || { binId: r.binId, x: 0, y: 0 };
      row.x += r.x || 0;
      row.y += r.y || 0;
      map.set(r.binId, row);
    }
  }
  return [...map.values()].sort((a, b) => a.binId - b.binId);
}

function emptyBinsMap(rows) {
  const m = {};
  for (const r of rows) m[r.binId] = { x: r.x || 0, y: r.y || 0 };
  return m;
}

function applyPriceToBins(bins, activeBinId, poolBinsById, currentPrice) {
  // Recompute composition from original deposited amounts? We store current x/y and also base (value at bin price is conserved within a bin).
  // Walk each bin and set x/y from conserved inventory at the bin's price vs active.
  const out = {};
  for (const [idStr, b] of Object.entries(bins)) {
    const binId = +idStr;
    const inv = (b.y || 0) + (b.x || 0) * (b.binPrice || currentPrice || 0);
    // Use stored binPrice if present; otherwise currentPrice is a poor substitute — we keep x/y and only convert when crossing.
    out[binId] = { x: b.x || 0, y: b.y || 0, binPrice: b.binPrice };
  }
  return out;
}

function convertBinsForActive(bins, activeBinId, poolBinsById) {
  // Conserved value at each bin's own price: value = y + x * binPrice.
  // binId < active: all Y; binId > active: all X; active: follow pool x/y ratio.
  const out = {};
  for (const [idStr, b] of Object.entries(bins)) {
    const binId = +idStr;
    const px = b.binPrice || 0;
    const val = (b.y || 0) + (b.x || 0) * (px || 0);
    let x = b.x || 0, y = b.y || 0;
    if (px > 0) {
      if (binId < activeBinId) { y = val; x = 0; }
      else if (binId > activeBinId) { x = val / px; y = 0; }
      else {
        const pb = poolBinsById.get(binId);
        const pX = pb ? bnUi(pb.xAmount, /* filled later */ (pb._decX || 0)) : 0;
        // if we don't have decimals on pool bin, use price-split 50/50-by-value of pool
        if (pb && px > 0) {
          const poolX = +(pb.xUi ?? 0), poolY = +(pb.yUi ?? 0);
          const poolVal = poolY + poolX * px;
          if (poolVal > 0) {
            const yFrac = poolY / poolVal;
            y = val * yFrac;
            x = (val - y) / px;
          } else { y = val; x = 0; }
        }
      }
    }
    out[binId] = { x, y, binPrice: px };
  }
  return out;
}

function sumXY(bins) {
  let x = 0, y = 0;
  for (const b of Object.values(bins)) { x += b.x || 0; y += b.y || 0; }
  return { x, y };
}

function markValue(bins, price, feeX, feeY) {
  const { x, y } = sumXY(bins);
  return y + x * price + (feeY || 0) + (feeX || 0) * price;
}

function shareInActive(bins, activeBinId, poolBinsById, price) {
  const ours = bins[activeBinId];
  if (!ours) return 0;
  const ourV = (ours.y || 0) + (ours.x || 0) * price;
  const pb = poolBinsById.get(activeBinId);
  const poolV = pb ? (pb.yUi || 0) + (pb.xUi || 0) * price : 0;
  const den = poolV + ourV;
  return den > 0 ? ourV / den : (ourV > 0 ? 1 : 0);
}

async function readPoolBins(dlmm, minBinId, maxBinId) {
  const decX = dlmm.tokenX.mint.decimals;
  const decY = dlmm.tokenY.mint.decimals;
  const { activeBin, bins } = await dlmm.getBinsBetweenLowerAndUpperBound(minBinId, maxBinId);
  const map = new Map();
  for (const b of bins) {
    b.xUi = bnUi(b.xAmount, decX);
    b.yUi = bnUi(b.yAmount, decY);
    b._decX = decX;
    map.set(b.binId, b);
  }
  return { activeBin, bins, map, decX, decY };
}

async function binPriceUi(dlmm, binId, fallback) {
  try {
    const raw = +dlmm.fromPricePerLamport(+require('@meteora-ag/dlmm').getPriceOfBinByBinId(binId, Number(dlmm.lbPair.binStep)));
    // getPriceOfBinByBinId returns Decimal price-per-lamport-ish; fromPricePerLamport converts to UI
    if (isFinite(raw) && raw > 0) return raw;
  } catch { /* fall through */ }
  return fallback;
}

function attachBinPrices(dlmm, binsMap, priceUi, activeBinId) {
  const binStep = Number(dlmm.lbPair.binStep);
  const { getPriceOfBinByBinId } = require('@meteora-ag/dlmm');
  for (const [idStr, b] of Object.entries(binsMap)) {
    const binId = +idStr;
    if (b.binPrice > 0) continue;
    try {
      const ppl = +getPriceOfBinByBinId(binId, binStep);
      const ui = +dlmm.fromPricePerLamport(ppl);
      b.binPrice = ui > 0 ? ui : priceUi * Math.pow(1 + binStep / 1e4, binId - activeBinId);
    } catch {
      b.binPrice = priceUi * Math.pow(1 + binStep / 1e4, binId - activeBinId);
    }
  }
}

// ---------- paper journal ----------
function ensurePaperDirs() {
  fs.mkdirSync(PAPER_DIR, { recursive: true });
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

const HIST_COLS = [
  'variant', 'pair', 'pool', 'entry_wib', 'exit_wib', 'hold', 'sol_size_requested', 'sol_size_actual',
  'tvl_cap_applied', 'spot_sol', 'bidask_sol', 'min_bin', 'max_bin', 'n_bins', 'range_pct',
  'entry_price', 'exit_price', 'fees_earned_sol', 'il_sol', 'rent_paid_sol', 'rent_refunded_sol',
  'network_fees_sol', 'swap_cost_sol', 'swap_cost_usd', 'usdc_in', 'usdc_out', 'gas_used_sol',
  'pnl_usd', 'pnl_pct', 'net_pnl_sol', 'net_pnl_usd', 'net_pnl_pct', 'exit_reason',
  'sol_usd', 'reshapes', 'quote_mint', 'quote_symbol', 'deposit_quote', 'fees_earned_quote', 'fees_earned_usd',
  ...Object.keys(paperHistory.csv({})),
];

function historyRow(h) {
  return {
    ...paperHistory.csv(h),
    variant: h.variant, pair: h.name, pool: h.pool, entry_wib: h.entryWib, exit_wib: h.exitWib, hold: h.hold,
    sol_size_requested: h.sizeWant, sol_size_actual: h.depositSol, tvl_cap_applied: h.tvlCapped,
    spot_sol: h.spotSol, bidask_sol: h.bidaskSol, min_bin: h.minBinId, max_bin: h.maxBinId,
    n_bins: h.nBins, range_pct: h.rangePct, entry_price: h.entryPrice, exit_price: h.exitPrice,
    fees_earned_sol: h.feesEarnedSol, il_sol: h.ilSol, rent_paid_sol: h.rentPaidSol,
    rent_refunded_sol: h.rentRefundedSol, network_fees_sol: h.networkFeesSol, swap_cost_sol: h.swapCostSol,
    swap_cost_usd: h.swapCostUsd, usdc_in: h.usdcIn, usdc_out: h.usdcOut, gas_used_sol: h.gasUsedSol,
    pnl_usd: h.pnlUsd, pnl_pct: h.pnlPct,
    net_pnl_sol: h.netPnlSol, net_pnl_usd: h.netPnlUsd, net_pnl_pct: h.netPnlPct,
    exit_reason: h.reason, sol_usd: h.solUsd, reshapes: h.reshapes || 0,quote_mint:h.quoteMint||SOL,quote_symbol:h.quoteSymbol||'SOL',deposit_quote:h.depositQuote??h.depositSol,fees_earned_quote:h.feesEarnedQuote??h.feesEarnedSol,fees_earned_usd:h.feesEarnedUsd,
  };
}

function writeHistoryFile(file, history) {
  const lines = [HIST_COLS.join(',')];
  for (const h of history) lines.push(HIST_COLS.map((c) => csvEscape(historyRow(h)[c])).join(','));
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

function writeAllHistory(state) {
  const combined = [];
  for (const v of VARIANTS) {
    const hist = state.books?.[v.id]?.history || [];
    writeHistoryFile(F(`history_${v.id}.csv`), entryPolicy.visible(hist,historyArchivePolicy));
    combined.push(...hist);
  }
  combined.sort((a, b) => String(a.closedAt || '').localeCompare(String(b.closedAt || '')));
  const archived=combined.filter(h=>entryPolicy.archived(h,historyArchivePolicy));
  writeHistoryFile(F('history.csv'), entryPolicy.visible(combined,historyArchivePolicy));
  writeHistoryFile(F('history-archived-over500.csv'),archived);
  if(historyArchivePolicy&&lastArchiveCount!==archived.length){const note=`uid=${process.env.TELEGRAM_ALLOWED_ID} action=history-archive count=${archived.length}; entry>500 AND repeat-pool/manual before cutoff=${historyArchivePolicy.cutoff}; originals retained in state/archive, cash/equity unchanged`;log(note);paperSettings.audit(PAPER_DIR,note);lastArchiveCount=archived.length;}
}

function bookStats(book, v, live = null, solUsdPx = 0) {
  const closed = entryPolicy.visible(book.history,historyArchivePolicy);
  const pnlUsdOf = (h) => (h.pnlUsd != null ? +h.pnlUsd : +h.netPnlUsd || 0);
  const pnlSolOf = (h) => (h.netPnlSol != null ? +h.netPnlSol : (solUsdPx ? pnlUsdOf(h) / solUsdPx : 0));
  const wins = closed.filter(h=>h.capitalAsset==='SOL'?(h.pnlCapital??h.netPnlSol??0)>0:(pnlUsdOf(h)>0||(pnlUsdOf(h)===0&&pnlSolOf(h)>0))).length;
  const totalUsd = closed.reduce((s, h) => s + pnlUsdOf(h), 0);
  const totalAllUsd = (book.history || []).reduce((s, h) => s + pnlUsdOf(h), 0);
  const totalSol = closed.reduce((s, h) => s + pnlSolOf(h), 0);
  const positions=multi.positions(book),pos=positions[0];
  const usdc=+(book.virtual?.usdc||0);
  const leftoverSol=positions.reduce((n,p)=>n+(p.reserveSol||0),+(book.virtual?.sol||0));
  const marked=p=>markValue(p.bins,p.lastPrice||p.entryPrice,p.feeX||0,p.feeY||0)*paperUsdc.quoteUsd(p,solUsdPx)+((p.reserveSol||0)+(p.rentRefundableSol||0))*(p.lastSolUsd||solUsdPx);
  const positionValueUsd=positions.reduce((n,p)=>n+(p.lastLive?.exitUsdc??p.lastExitUsdc??marked(p)),0);
  const equityUsd=usdc+positionValueUsd+(+(book.virtual?.sol||0)+ +(book.virtual?.capitalSol||0))*solUsdPx;
  const equitySol=solUsdPx?equityUsd/solUsdPx:0;
  const totalDepositedUsdc=book.virtual?.totalDepositedUsdc??book.virtual?.usdcStart??CFG.PAPER_USDC;
  return {
    capitalAsset:book.virtual?.capitalAsset||'USDC',freeCapitalSol:book.virtual?.capitalSol||0,totalDepositedSol:book.virtual?.totalDepositedSol??null,solDepositBasisAt:book.virtual?.solDepositBasisAt,solDepositBasisNote:book.virtual?.solDepositBasisNote,equityPnlSol:book.virtual?.totalDepositedSol!=null?equitySol-book.virtual.totalDepositedSol:null,
    variant: v.id, n: v.n, reshape: v.reshape, compound: v.compound, label: v.label,
    virtualStartUsdc: book.virtual?.usdcStart != null ? book.virtual.usdcStart : CFG.PAPER_USDC,
    virtualUsdc: +usdc.toFixed(6),
    quotePnlTotals:quotePnl.totals(positions.map(p=>p.lastLive?.pnlQuote!=null?p.lastLive:quotePnl.fromPosition(p))),
    positionValueUsd, openCount: positions.length, maxPositions: CFG.MAX_POSITIONS,
    leftoverSol: +leftoverSol.toFixed(8),
    totalDepositedUsdc,
    equityPnlUsd: +(equityUsd-totalDepositedUsdc).toFixed(4),
    equityUsd: +equityUsd.toFixed(4),
    equitySol: solUsdPx ? +equitySol.toFixed(6) : null,
    solUsd: solUsdPx || null,
    archivedCount:(book.history||[]).filter(h=>entryPolicy.archived(h,historyArchivePolicy)).length,
    trades: closed.length, wins, losses: closed.length - wins,
    winRate: closed.length ? +(wins / closed.length * 100).toFixed(1) : null,
    totalNetPnlUsd: +totalUsd.toFixed(4),
    totalNetPnlAllUsd: +totalAllUsd.toFixed(4), archivedPnlUsd: +(totalAllUsd - totalUsd).toFixed(4), tradesAll: (book.history || []).length,
    totalNetPnlSol: +totalSol.toFixed(6),
    avgNetPnlUsd: closed.length ? +(totalUsd / closed.length).toFixed(4) : null,
    avgNetPnlSol: closed.length ? +(totalSol / closed.length).toFixed(6) : null,
    reshapes: (book.reshapes || []).length,
    open: pos ? {
      name: pos.name, pool: pos.pool, openedWib: pos.entryWib, depositSol: pos.depositSol,depositQuote:paperUsdc.depositQuote(pos),quoteSymbol:paperUsdc.quoteSymbol(pos),
      usdcIn: pos.usdcIn, gasBufferSol: pos.gasBufferSol,
      shape: pos.shape, reshapes: pos.reshapes || 0, entryActiveBin: pos.entryActiveBin,
      lastReshapeActiveBin: pos.lastReshapeActiveBin, minBinId: pos.minBinId, maxBinId: pos.maxBinId,
    } : null,
  };
}

function writeOpen(state, extra = {}) {
  const v = VARIANTS[0];
  const b = state.books[v.id];
  fs.writeFileSync(F('positions_open.json'), JSON.stringify({
    updated: now(), updatedWib: wib(),
    paper: true, dryRun: true,
    strategy: { id: v.id, n: v.n, reshape: v.reshape, compound: v.compound, label: v.label },
    virtualUsdc: b?.virtual?.usdc ?? null,
    leftoverSol: b?.virtual?.sol ?? null,
    positions: multi.positions(b).map(p=>({position:publicPos(p),live:p.lastLive||null,leftoverSol:p.reserveSol||0})),
    openCount:multi.positions(b).length,maxPositions:CFG.MAX_POSITIONS,
    position: publicPos(multi.positions(b)[0]),
    live: multi.positions(b)[0]?.lastLive || null,
  }, null, 2));
}

function writeSummary(state, extra = {}) {
  const v = VARIANTS[0];
  const stats = bookStats(state.books[v.id], v, extra.lives?.[v.id], extra.solUsd || solUsdCache.px || 0);
  const sum = {
    updated: now(), updatedWib: wib(), paper: true,
    startedWib: state.meta?.startedWib, endsWib: state.meta?.endsWib, endsAt: state.meta?.endsAt,
    strategy: { id: v.id, n: v.n, reshape: v.reshape, compound: v.compound, label: v.label },
    filters: {
      ftWindow: CFG.FT_WINDOW, minFt: CFG.MIN_FT, minLiqUsd: CFG.MIN_LIQ_USD, minAgeH: CFG.MIN_AGE_H,
      maxPump1h: CFG.MAX_PUMP1H, maxPump24h: CFG.MAX_PUMP_24H, volSpike1hOf24h: CFG.VOL_SPIKE_1H_OF_24H,
      emergencyDrop: CFG.EMERGENCY_DROP, maxPosTvlFrac: CFG.MAX_POS_TVL_FRAC,
      rugcheck: CFG.RUGCHECK, maxTop10Hold: CFG.MAX_TOP10_HOLD, maxDevHold: CFG.MAX_DEV_HOLD,
      positionSol: CFG.POSITION_SOL, paperUsdc: CFG.PAPER_USDC, usdcBuffer: CFG.USDC_BUFFER,
      gasBufferSol: CFG.GAS_BUFFER_SOL, tp: CFG.TP,tpUsdPct:CFG.TP_USD_PCT,oorRightClose:CFG.OOR_RIGHT_CLOSE,trailingEnabled:CFG.TRAIL_ENABLED,oorMaxMin:CFG.OOR_MAX_MIN,maxHours: CFG.MAX_HOURS,
    },
    exitRule: `Basis setiap posisi = aset modal saat entry (USDC/SOL). TP +${CFG.TP_USD_PCT}%; OOR right confirm ${CFG.OOR_RIGHT_CONFIRM_POLLS} polls, profit >=${CFG.OOR_RIGHT_MIN_PROFIT_PCT}% aset modal posisi or reposition max ${CFG.OOR_RIGHT_MAX_REPOSITIONS}; quote unavailable waits 10 consecutive polls before on-chain estimate; failed reopen retries without closing; emergency NET aset modal posisi PnL <= -${CFG.EMERGENCY_DROP*100}%, max ${CFG.MAX_HOURS}h; trailing=${CFG.TRAIL_ENABLED}, left OOR timeout=${CFG.OOR_MAX_MIN}m`,
    reshapeTrigger: 'Active bin moved down 5 bins since last reshape, or since entry if none yet. Compound quote-token fees on reshape. No % token or time cooldown.',
    stats,
    quoteApi:CFG.PAPER?paperQuoteClient.status():undefined,
    // Bounded public journal: costs are already included in USDC PnL, not subtracted again.
    closedRecent: entryPolicy.visible(state.books[v.id]?.history,historyArchivePolicy).slice(-100).map((r) => ({
      capitalAsset:r.capitalAsset||'USDC',capitalInSol:r.initialCapitalInSol||r.capitalInSol,pnlCapital:r.pnlCapital,pnlCapitalPct:r.pnlCapitalPct,
      name: r.name, pool: r.pool, mintX: r.mintX, closedAt: r.closedAt,
      openedAt: r.openedAt, reason: r.reason, closeReasonText:r.closeReasonText||paperHistory.closeReason(r),openSource:r.openSource,openReason:r.openReason,openContext:r.openContext,currentLegOpenContext:r.currentLegOpenContext,entryLegs:r.entryLegs,corrected:r.corrected,correction:r.correction?{...r.correction,original:{pnlQuote:r.correction.original.pnlQuote,pnlQuoteUsd:r.correction.original.pnlQuoteUsd,pnlUsd:r.correction.original.pnlUsd,usdcOut:r.correction.original.usdcOut}}:undefined,usdcIn: r.usdcIn, usdcOut: r.usdcOut,
      pnlQuote:r.pnlQuote,pnlQuoteUsd:r.pnlQuoteUsd,quoteSymbol:r.quoteSymbol,
      pnlUsd: r.pnlUsd ?? r.netPnlUsd, pnlPct: r.pnlPct ?? r.netPnlPct,
      swapCostUsd: r.swapCostUsd, gasUsedSol: r.gasUsedSol, hold: r.hold,
    })),
    lastScan: state.lastScan ? { at: state.lastScan.at, atWib: state.lastScan.atWib, n: (state.lastScan.candidates || []).length, fetched: state.lastScan.fetched, basic: state.lastScan.basic, rejects: state.lastScan.rejects || null, openResult: state.lastScan.openResult || null,openResults:state.lastScan.openResults||[] } : null,
    ...extra,
  };
  fs.writeFileSync(F('summary.json'), JSON.stringify(sum, null, 2));
  return sum;
}

function loadPreservedMeta() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(PAPER_DIR, 'config.json'), 'utf8'));
    if (cfg?.endsAt) return cfg;
  } catch { /* none */ }
  return null;
}

function paperMeta(state) {
  const preserved = state.meta?.endsAt ? state.meta : loadPreservedMeta();
  const variantNote = {
    maxPositions: CFG.MAX_POSITIONS,
    variants: VARIANTS.map((v) => ({ id: v.id, n: v.n, reshape: v.reshape, compound: v.compound })),
    reshapeTrigger: 'activeBin dropped by N since last reshape or entry',
  };
  const filterNote = {
    minLiqUsd: CFG.MIN_LIQ_USD, minAgeH: CFG.MIN_AGE_H, ftWindow: CFG.FT_WINDOW, minFt: CFG.MIN_FT, maxPump1h: CFG.MAX_PUMP1H,
    maxPump24h: CFG.MAX_PUMP_24H, volSpike1hOf24h: CFG.VOL_SPIKE_1H_OF_24H,
    emergencyDrop: CFG.EMERGENCY_DROP, maxPosTvlFrac: CFG.MAX_POS_TVL_FRAC,
    rugcheck: CFG.RUGCHECK, maxRugcheckScoreNorm: CFG.MAX_RUGCHECK_SCORE_NORM,
    checkTopHolders: CFG.CHECK_TOP_HOLDERS, maxTop10Hold: CFG.MAX_TOP10_HOLD,
    maxDevHold: CFG.MAX_DEV_HOLD,
  };
  if (preserved?.endsAt) {
    // Keep the original 7-day window and bankroll; refresh strategy/filter documentation only.
    state.meta = { ...preserved, ...variantNote, ...filterNote, strategy: 'N5' };
    delete state.meta.minFt1h;
    fs.writeFileSync(F('config.json'), JSON.stringify(state.meta, null, 2));
    return state.meta;
  }
  const start = Date.now();
  const end = start + CFG.PAPER_DAYS * 24 * 3600 * 1000;
  state.meta = {
    startedAt: new Date(start).toISOString(), startedWib: wib(start),
    endsAt: new Date(end).toISOString(), endsWib: wib(end),
    days: CFG.PAPER_DAYS, usdcStart: CFG.PAPER_USDC,
    positionSol: CFG.POSITION_SOL, reserveSol: CFG.RESERVE_SOL,
    ...filterNote, ...variantNote,
  };
  fs.writeFileSync(F('config.json'), JSON.stringify(state.meta, null, 2));
  return state.meta;
}

async function ensureUsdcCapital(state) {
  const existing = state.meta && state.meta.capital;
  const already = existing && existing.mode === 'usdc500';
  const hasTrade = VARIANTS.some((v) => {
    const b = state.books && state.books[v.id];
    return multi.positions(b).length>0 || ((b && b.history) || []).length > 0;
  });
  if (already) {
    for (const v of VARIANTS) {
      const b = state.books && state.books[v.id];
      if (b && b.virtual && b.virtual.usdc == null && !b.position && !((b.history || []).length)) {
        b.virtual = paperCap.emptyVirtual(CFG.PAPER_USDC);
      }
    }
    return { ...(existing || {}), justReset: false };
  }
  if (hasTrade) {
    log('WARN: capital is not usdc500 but a trade or open position exists; leaving books unchanged');
    return { justReset: false, blocked: true, mode: existing && existing.mode };
  }
  let px = 0;
  try { px = await solUsd(); } catch (e) { log('sol usd at capital switch: ' + (e.message || e)); }
  const gas = paperCap.computeGasBufferSol({ txFee: CFG.TX_FEE_SOL, floor: CFG.GAS_BUFFER_SOL });
  const cap = {
    mode: 'usdc500',
    usdcStart: CFG.PAPER_USDC,
    usdcBuffer: CFG.USDC_BUFFER,
    gasBufferSol: CFG.GAS_BUFFER_SOL,
    gasBufferNeeded: gas.needed,
    gasBufferRaw: gas.raw,
    gasBufferMargin: gas.margin,
    solUsdAtSwitch: px || null,
    switchedWib: wib(),
    windowKept: true,
    startedWib: state.meta && state.meta.startedWib,
    endsWib: state.meta && state.meta.endsWib,
    note: '500 USDC only. At open, swap USDC->SOL for position size plus extra SOL for rent and tx fees (GAS_BUFFER_SOL). At close, refund rent and swap all remaining SOL back to USDC. No separate gas wallet.',
  };
  state.meta = { ...(state.meta || {}), capital: cap, usdcStart: CFG.PAPER_USDC };
  delete state.meta.virtualStart;
  for (const v of VARIANTS) {
    if (!state.books[v.id]) continue;
    state.books[v.id].virtual = paperCap.emptyVirtual(CFG.PAPER_USDC);
    state.books[v.id].history = [];
    state.books[v.id].reshapes = [];
    state.books[v.id].position = null;
  }
  fs.writeFileSync(F('config.json'), JSON.stringify(state.meta, null, 2));
  log(`capital reset: ${CFG.PAPER_USDC} USDC only (no separate SOL gas wallet). GAS_BUFFER_SOL=${CFG.GAS_BUFFER_SOL} (computed need=${gas.needed.toFixed(4)} raw=${gas.raw.toFixed(4)} SOL, margin=${gas.margin}). SOL/USD at switch=${px || 'n/a'}. Window kept ${state.meta.startedWib} -> ${state.meta.endsWib}.`);
  return { ...cap, justReset: true, gas };
}

function initBooks(state) {
  if (!state.books) state.books = {};
  const allowed = new Set(VARIANTS.map((v) => v.id));
  for (const id of Object.keys(state.books)) {
    if (!allowed.has(id) && !state.books[id]?.position) delete state.books[id];
  }
  for (const v of VARIANTS) {
    if (!state.books[v.id]) {
      state.books[v.id] = {
        id: v.id, n: v.n, reshape: v.reshape, compound: v.compound,
        virtual: paperCap.emptyVirtual(CFG.PAPER_USDC),
        position: null, history: [], reshapes: [],
      };
    }
  }
}

function allFlat(state) { return VARIANTS.every((v) => !multi.positions(state.books[v.id]).length); }
function anyOpen(state) { return !allFlat(state); }

function cloneBins(bins) {
  const o = {};
  for (const [k, b] of Object.entries(bins || {})) o[k] = { x: b.x || 0, y: b.y || 0, binPrice: b.binPrice };
  return o;
}

function paperStopRequested() {
  return fs.existsSync(path.join(PAPER_DIR, 'STOP'));
}

let lastAppliedSettingsKey = '';
const BASE_TOKEN_CHECKS={RUGCHECK:CFG.RUGCHECK,CHECK_TOP_HOLDERS:CFG.CHECK_TOP_HOLDERS};
function applyPaperSettings({ logAlways = false } = {}) {
  // Shared settings file is the source of truth for paper and live (same N5 strategy + filters).
  const values = paperSettings.currentValues(PAPER_DIR);
  const key = JSON.stringify(values);
  const changed = key !== lastAppliedSettingsKey;
  for(const k of strategy.KEYS)if(values[k]!==undefined)CFG[k]=values[k];
  CFG.DEPTH=values.RANGE_DOWN_PCT/100;CFG.MAX_POS_TVL_FRAC=values.MAX_POSITION_TVL_PCT/100;
  CFG.MIN_FT = values.MIN_FT;
  CFG.MIN_LIQ_USD = values.MIN_LIQ_USD;
  CFG.MIN_AGE_H = values.MIN_AGE_H;
  for(const k of ['OOR_RIGHT_REPOSITION_MIN_PNL_PCT','FEE_TURNOVER_MAX_PCT','FEE_TURNOVER_TVL_BELOW_USD','RUGCHECK_STICKY_DAYS','OOR_RIGHT_MIN_BINS','NOTIFY_RESHAPE','MAX_POSITIONS','CAPITAL_ASSET','REOPEN_COOLDOWN_MIN','MAX_PUMP24H_PCT','MAX_LIQ_USD','MAX_NONREFUND_SOL','MIN_BIN_STEP','MAX_BIN_STEP','POSITION_USDC','UPPER_BUFFER_BINS','OOR_RIGHT_CONFIRM_POLLS','OOR_RIGHT_MIN_PROFIT_PCT','OOR_RIGHT_MAX_REPOSITIONS'])CFG[k]=values[k];
  CFG.TP = values.TP;
  for(const k of ['TP_USD_PCT','OOR_RIGHT_CLOSE','TRAIL_ENABLED','TRAIL_ARM_PCT','TRAIL_DROP_PCT','OOR_MAX_MIN','EMERGENCY_TP_ENABLED','EMERGENCY_TP_TRIGGER_RANGE_PCT','EMERGENCY_TP_PCT','EMERGENCY_SLPLUS_ENABLED','EMERGENCY_SLPLUS_ARM_PCT','EMERGENCY_SLPLUS_LOCK_PCT','EMERGENCY_SLPLUS_CONFIRM_POLLS','EMERGENCY_SLPLUS_FLOOR_PCT','EMERGENCY_SLPLUS_FLOOR_POLLS','SL_BLACKLIST_ENABLED','STALE_CLOSE_ENABLED','STALE_EXIT_MODE','STALE_EXIT_PCT']) CFG[k]=values[k];
  CFG.EMERGENCY_DROP = values.EMERGENCY_DROP;
  CFG.MAX_HOURS = values.MAX_HOURS;
  CFG.GAS_BUFFER_SOL = values.GAS_BUFFER_SOL;
  CFG.MAX_PUMP1H = values.MAX_PUMP1H;
  CFG.MAX_PUMP_24H = values.MAX_PUMP24H_PCT/100;
  CFG.VOL_SPIKE_1H_OF_24H = values.VOL_SPIKE_1H_OF_24H;
  // Live and dry run share ONE setting set (Tuan rule, 12 Nov 2026): these used to come from env only and could differ between the two modes.
  CFG.FT_WINDOW = values.FT_WINDOW; CFG.MAX_TOP10_HOLD = values.MAX_TOP10_HOLD; CFG.MAX_DEV_HOLD = values.MAX_DEV_HOLD; CFG.USDC_BUFFER = values.USDC_BUFFER;
  CFG.RESHAPE = values.RESHAPE_ENABLED !== false; CFG.RESERVE_SOL = values.GAS_BUFFER_SOL;
  CFG.POSITION_USD = values.POSITION_USDC; CFG.POSITION_SOL = 0; // position size is USD via POSITION_USDC (legacy SOL sizing is unused)
  for(const k of ['FILTERS_ENABLED','PUMP1H_FILTER_ENABLED','PUMP24H_FILTER_ENABLED','RUGCHECK_ENABLED','TOP_HOLDERS_ENABLED','CHECK_INSIDERS','MAX_INSIDER_PCT','ANTI_PVP_MODE','ANTI_PVP_MIN_LIQ_USD','OLD_DUMP_FILTER_ENABLED','OLD_TOKEN_MODE','OLD_DUMP_MIN_AGE_H','OLD_DUMP_MAX_PUMP24H','TVL_DROP_FILTER_ENABLED','TVL_DROP_MAX_PCT'])CFG[k]=values[k];
  // Effective RugCheck / holder flags: env base (RUGCHECK / CHECK_TOP_HOLDERS) AND master AND per-filter toggle.
  {const ff=antiPvp.filterFlags(values,BASE_TOKEN_CHECKS);CFG.RUGCHECK=ff.rugcheck;CFG.CHECK_TOP_HOLDERS=ff.topHolders;}
  if (VARIANTS[0]) VARIANTS[0].n = values.RESHAPE_N;
  if (changed || logAlways) {
    log(`paper settings applied: MIN_FT=${values.MIN_FT}% MIN_LIQ_USD=${values.MIN_LIQ_USD} MIN_AGE_H=${values.MIN_AGE_H} BIN_STEP=${values.MIN_BIN_STEP}..${values.MAX_BIN_STEP} POSITION_USDC=${values.POSITION_USDC} UPPER_BUFFER_BINS=${values.UPPER_BUFFER_BINS} rightConfirm=${values.OOR_RIGHT_CONFIRM_POLLS} RESHAPE_N=${values.RESHAPE_N} TP_USDC=${values.TP_USD_PCT}% rightOor=${values.OOR_RIGHT_CLOSE} trailing=${values.TRAIL_ENABLED} emergencyTp=${values.EMERGENCY_TP_ENABLED}(priceDrop>=${values.EMERGENCY_TP_TRIGGER_RANGE_PCT}% of open lower range -> TP ${values.EMERGENCY_TP_PCT}%) leftOorMin=${values.OOR_MAX_MIN} emergency=${values.EMERGENCY_DROP} maxHours=${values.MAX_HOURS} GAS_BUFFER_SOL=${values.GAS_BUFFER_SOL} pump1h=${values.MAX_PUMP1H} pump24h=${values.MAX_PUMP_24H} volSpike=${values.VOL_SPIKE_1H_OF_24H} tokenFilters=${values.FILTERS_ENABLED?'ON':'OFF'}(pump1h=${values.PUMP1H_FILTER_ENABLED} pump24h=${values.PUMP24H_FILTER_ENABLED} rugcheck=${values.RUGCHECK_ENABLED} topHolders=${values.TOP_HOLDERS_ENABLED} insiders=${values.CHECK_INSIDERS}<=${values.MAX_INSIDER_PCT}% antiPvp=${values.ANTI_PVP_MODE}>=$${values.ANTI_PVP_MIN_LIQ_USD})`);
    lastAppliedSettingsKey = key;
  }
  return values;
}

// ---------- paper valuation / fees / open / reshape / close ----------
async function fetchMarket(pool, minBinId, maxBinId) {
  const dlmm = await DLMM.create(conn, new PublicKey(pool));
  const active = await dlmm.getActiveBin();
  const price = +dlmm.fromPricePerLamport(+active.price);
  const minB = Math.min(minBinId, active.binId - 2);
  const maxB = Math.max(maxBinId, active.binId + 2);
  const { map } = await readPoolBins(dlmm, minB, maxB);
  let stats = null;
  try { stats = await fetchPool(pool); } catch (e) { log('pool stats: ' + e.message); }
  const pxUsd = await solUsd();
  let estimatedTokenSwapFeeRate=(+(stats?.pool_config?.base_fee_pct??.3))/100;
  try{const totalPct=+dlmm.getDynamicFee();if(Number.isFinite(totalPct)&&totalPct>=0)estimatedTokenSwapFeeRate=totalPct/100;}catch{}
  return { dlmm, active, price, map, stats, pxUsd,estimatedTokenSwapFeeRate,estimatedSolSwapFeeRate:.0005 };
}

function applySnapshotToPos(pos, mkt) {
  attachBinPrices(mkt.dlmm, pos.bins, mkt.price, mkt.active.binId);
  pos.bins = convertBinsForActive(pos.bins, mkt.active.binId, mkt.map);
  const share = shareInActive(pos.bins, mkt.active.binId, mkt.map, mkt.price);
  const feesCum = mkt.stats?.cumulative_metrics?.fees ?? null;
  const pxUsd = paperUsdc.quoteUsd(pos,mkt.pxUsd);
  const price = mkt.price;
  const activeId = mkt.active.binId;
  if (pos.lastFeesCum != null && feesCum != null && feesCum >= pos.lastFeesCum && pxUsd > 0) {
    const deltaUsd = feesCum - pos.lastFeesCum;
    const inRange = !!pos.bins[activeId] || (activeId >= pos.minBinId && activeId <= pos.maxBinId);
    if (inRange && deltaUsd > 0 && share > 0) {
      const feeSol = (deltaUsd / pxUsd) * share;
      const pb = mkt.map.get(activeId);
      const poolY = pb?.yUi || 0, poolX = pb?.xUi || 0;
      const poolVal = poolY + poolX * price;
      const yFrac = poolVal > 0 ? poolY / poolVal : 1;
      pos.feeY = (pos.feeY || 0) + feeSol * yFrac;
      if (price > 0) pos.feeX = (pos.feeX || 0) + (feeSol * (1 - yFrac)) / price;
    }
  } else if (pos.lastFeesCum != null && (feesCum == null || feesCum < pos.lastFeesCum) && mkt.stats?.fees?.['30m'] && pxUsd > 0) {
    const elapsed = (Date.now() - (pos.lastPollAt || Date.parse(pos.openedAt))) / 1000;
    const deltaUsd = (+mkt.stats.fees['30m']) * Math.min(elapsed, 1800) / 1800;
    if (!!pos.bins[activeId] && share > 0 && deltaUsd > 0) {
      pos.feeY = (pos.feeY || 0) + (deltaUsd / pxUsd) * share;
    }
  }
  pos.lastFeesCum = feesCum;
  pos.lastPollAt = Date.now();
  pos.lastShare = share;
  pos.lastActiveBin = activeId;
  // Public telemetry uses the same paper inventory/price snapshot, never a separate simulation.
  pos.lastPrice = mkt.price;
  pos.lastSolUsd = mkt.pxUsd;
  pos.poolFees24hUsd = mkt.stats?.fees?.['24h'] ?? null;
  const value = markValue(pos.bins, price, pos.feeX || 0, pos.feeY || 0);
  const inv = markValue(pos.bins, price, 0, 0);
  const inRange = activeId >= pos.minBinId && activeId <= pos.maxBinId;
  return { ...mkt, value, inv, inRange, share };
}

// Buffered entry: quote on/below active, token above active; 50% Spot + 50% Bid-Ask per side.
async function initialPaperBins(dlmm,p,{minBinId,maxBinId,activeBin,depositQuote,price,quoteMint,quoteDecimals,policy=CFG}){
 const left=activeBin-minBinId+1,right=maxBinId-activeBin;
 const tokenSpendQuote=depositQuote*right/(left+right),entryQuoteY=depositQuote-tokenSpendQuote;
 const decX=dlmm.tokenX.mint.decimals;
 let buy={ok:true,outUi:0};   // quote-only entry (no bins above active): nothing to buy
 if(right>0){buy=await jupiterQuote(quoteMint,p.token_x.address,BigInt(Math.floor(tokenSpendQuote*10**quoteDecimals)),quoteDecimals,decX);
 if(!buy.ok||!(buy.outUi>0))throw Error('Token-side Jupiter quote failed: '+(buy.error||'empty'));}
 const entryTokenX=buy.outUi,rows=[];
 const spot=policy.OPEN_SHAPE==='SPOT'?1:policy.OPEN_SHAPE==='BIDASK'?0:(policy.OPEN_SPOT_PCT??50)/100;
 for(const [strategyType,weight] of [[StrategyType.Spot,spot],[StrategyType.BidAsk,1-spot]]){
  if(weight===0)continue;
  rows.push(...await strategyAmounts(dlmm,{minBinId,maxBinId:activeBin,amountX:0,amountY:entryQuoteY*weight,strategyType}));
  if(right>0)rows.push(...await strategyAmounts(dlmm,{minBinId:activeBin+1,maxBinId,amountX:entryTokenX*weight,amountY:0,strategyType}));
 }
 const bins=emptyBinsMap(mergeAmounts(rows));attachBinPrices(dlmm,bins,price,activeBin);
 const sum=sumXY(bins);
 if(Math.abs(sum.y-entryQuoteY)>Math.max(.000001,entryQuoteY*.001)||Math.abs(sum.x-entryTokenX)>Math.max(.000001,entryTokenX*.001))throw Error('Two-sided allocation mismatch');
 return {bins,entryTokenX,entryQuoteY,tokenSpendQuote,tokenSwapCostQuote:Math.max(0,tokenSpendQuote-entryTokenX*price)};
}

async function paperOpenUsdc(p,state,opts={}) {
 const policy={...CFG,...(opts.strategySettings||{})};
  if(!CFG.PAPER||!CFG.DRY_RUN)throw new Error('USDC quote execution is paper-only');
  const dlmm=await DLMM.create(conn,new PublicKey(p.address));
  const active=await dlmm.getActiveBin(),binStep=Number(p.pool_config.bin_step);
  const n=strategy.geometry(binStep,policy,MAX_BINS).n;
  const minBinId=active.binId-n+1,maxBinId=active.binId+strategy.geometry(binStep,policy,MAX_BINS).upper;
  const priceUi=+dlmm.fromPricePerLamport(+active.price),px=await solUsd();
  const g=strategy.geometry(binStep,policy,MAX_BINS);const cost=strategy.skip(g)?fastEntryCost(dlmm,minBinId,maxBinId,g,p.address):await quotePaperEntryCost(dlmm,minBinId,maxBinId);p.entryCostEstimate=cost;
  const reject=entryCost.rejection(cost,CFG.MAX_NONREFUND_SOL);if(reject){log('OPEN ditolak: '+p.name+' '+reject);return {skipped:reject};}
  const rentRef=cost.refundableRentSol,rentNon=cost.nonrefRentSol,openFees=cost.openTxFeeSol;
  const gas=paperCap.computeGasBufferSol({rentRefundable:rentRef,rentNonRefundable:rentNon,txFee:CFG.TX_FEE_SOL,floor:policy.GAS_BUFFER_SOL});
  const book0=primaryBook(state);let funding=null,capitalSpentSol=null;
  if(opts.capitalAsset==='SOL'){
   if(!(opts.positionBudgetSol>gas.buffer))return {skipped:'SOL tidak cukup untuk buffer + LP'};
   funding=await capitalAsset.exchange(opts.positionBudgetSol-gas.buffer,'SOL','USDC',px,jupiterQuote,CFG.TX_FEE_SOL);
   book0.virtual.usdc=funding.out;book0.virtual.sol=gas.buffer;capitalSpentSol=opts.positionBudgetSol;
  }
  const plan=await paperUsdc.planUsdcOpen({cash:Math.min(book0.virtual.usdc,opts.positionBudgetUsdc??(CFG.POSITION_USDC>0?CFG.POSITION_USDC:book0.virtual.usdc)),existingSol:book0.virtual.sol||0,capUsd:(p.tvl||0)*((policy.MAX_POSITION_TVL_PCT??5)/100),
    gasBuffer:gas.buffer,rentRef,rentNon,openFees,solUsd:px,usdcBuffer:opts.capitalAsset==='SOL'?0:CFG.USDC_BUFFER,quote:jupiterQuote});
  if(!plan.ok){log('USDC open skipped: '+plan.why);return {skipped:plan.why};}
  if(funding){const unused=Math.max(0,book0.virtual.usdc-plan.usdcSpent);if(unused>1e-6){const back=await capitalAsset.exchange(unused,'USDC','SOL',px,jupiterQuote,CFG.TX_FEE_SOL);capitalSpentSol-=back.out;}book0.virtual.usdc=plan.usdcSpent;}

  const shape=await initialPaperBins(dlmm,p,{minBinId,maxBinId,activeBin:active.binId,depositQuote:plan.depositQuote,price:priceUi,quoteMint:USDC,quoteDecimals:6,policy});
  const bins=shape.bins,half=shape.entryQuoteY/2;
  const split=policy.OPEN_SHAPE==='SPOT'?1:policy.OPEN_SHAPE==='BIDASK'?0:policy.OPEN_SPOT_PCT/100;
  const template={strategySettings:strategy.snapshot(policy),capitalAsset:opts.capitalAsset||'USDC',capitalInSol:capitalSpentSol,paper:true,pool:p.address,name:p.name,mintX:p.token_x.address,decX:dlmm.tokenX.mint.decimals,
    quoteMint:USDC,quoteSymbol:'USDC',quoteDecimals:6,depositQuote:plan.depositQuote,feesCompoundedQuote:0,
    minBinId,maxBinId,origMinBinId:minBinId,origMaxBinId:maxBinId,nBins:n+strategy.geometry(binStep,policy,MAX_BINS).upper,binStep,upperBufferBins:strategy.geometry(binStep,policy,MAX_BINS).upper,entryTokenX:shape.entryTokenX,entryQuoteY:shape.entryQuoteY,
    rangePct:-(1-Math.pow(1+binStep/1e4,-n))*100,entryPrice:priceUi,entryActiveBin:active.binId,
    openedAt:now(),entryWib:wib(),tvlUsd:p.tvl,tvlCapped:plan.depositQuote>=(p.tvl||0)*((policy.MAX_POSITION_TVL_PCT??5)/100)-1e-6,
    baseFeePct:p.pool_config?.base_fee_pct??null,poolFees24hUsd:p.fees?.['24h']??null,lastPrice:priceUi,lastSolUsd:px,solUsdEntry:px,
    shape:'open-'+String(policy.OPEN_SHAPE||'MIXED').toLowerCase(),spotQuote:shape.entryQuoteY*split,bidaskQuote:shape.entryQuoteY*(1-split),usdcIn:capitalSpentSol!=null?capitalSpentSol*px:plan.usdcIn,usdcSpent:plan.usdcSpent,solCarryInUsd:plan.solCarryInUsd,
    solBought:plan.boughtSol,gasBufferSol:gas.buffer,gasUsdc:plan.gasUsdc,leftoverSolAtOpen:plan.reserve,openSwapCostUsd:plan.openSwapCostUsd+shape.tokenSwapCostQuote+(funding?.costUsd||0),
    rentPaidSol:rentRef+rentNon,rentRefundableSol:rentRef,rentNonRefundableSol:rentNon,networkFeesSol:openFees,
    feeX:0,feeY:0,feesCompoundedX:0,lastFeesCum:p.cumulative_metrics?.fees??null,lastPollAt:Date.now(),
    lastActiveBin:active.binId,lastReshapeActiveBin:active.binId,reshapes:0};
  const sdkBuild=cost.skipCheck?{ok:true,skipped:'PAPER wide-range: optional build/rent RPC not awaited'}:await buildOpenTxs(dlmm,template,half);
  for(const v of VARIANTS){
    const book=state.books[v.id];
    book.position={...template,variant:v.id,position:Keypair.generate().publicKey.toBase58(),walletBeforeUsdc:book.virtual.usdc,walletBeforeSol:book.virtual.sol,bins:cloneBins(bins),sdkBuild};
    setOpenContext(book.position,p,opts);quotePnl.ensureEntry(book.position);
    book.virtual.usdc-=plan.usdcSpent;book.virtual.sol=plan.reserve;
    if(!opts.silent)log(`PAPER OPEN [${v.id}] ${p.name}: spent ${plan.usdcSpent.toFixed(4)} USDC; deposit ${plan.depositQuote.toFixed(4)} USDC (two-sided), buffer swap ${plan.gasUsdc.toFixed(4)} USDC -> ${plan.boughtSol.toFixed(6)} SOL; gas reserve ${plan.reserve.toFixed(6)} SOL; token purchase ${shape.tokenSpendQuote.toFixed(4)} USDC ${quotePnl.logFields(quotePnl.fromPosition(book.position))}`);
  }
  if(!opts.silent)try{telegram.notifyOpen({openContext:primaryBook(state).position.openContext,...quotePnl.fromPosition(primaryBook(state).position),name:p.name,pool:p.address,quoteSymbol:'USDC',depositQuote:plan.depositQuote,usdcIn:plan.usdcIn,gasBufferSol:gas.buffer,leftoverSol:plan.reserve,
    minBinId,maxBinId,rangePct:template.rangePct,entryPrice:priceUi,ft30m:feeTvl(p,'30m'),tvl:p.tvl,bins,activeBin:active.binId,shape:template.shape}).catch(()=>{});}catch{}
  return {opened:true,paper:true,capitalSpentSol,quote:'USDC',depositQuote:plan.depositQuote,minBinId,maxBinId,entryActiveBin:active.binId};
}

function setOpenContext(pos,p,opts={}){
 const c=paperHistory.capture(p,{...opts,capitalAsset:pos.capitalAsset||'USDC',capitalInSol:pos.capitalInSol??null,strategy:pos.variant||VARIANTS[0].id,settings:{...CFG,...(pos.strategySettings||{})},at:pos.openedAt});
 pos.entryCostEstimate=JSON.parse(JSON.stringify(p.entryCostEstimate||null));c.snapshot.strategySettings=pos.strategySettings;pos.openContext=c;pos.openSource=c.source;pos.openReason=c.reason;
}

async function paperOpenAll(p,state,opts={}) {
 if(!CFG.PAPER||!CFG.DRY_RUN)throw Error('Multi-position execution is paper-only');
 const book=primaryBook(state);multi.migrate(book);
 if(multi.positions(book).length>=CFG.MAX_POSITIONS)return {skipped:'Slot penuh'};
 if(multi.duplicate(book,p.address,p.token_x?.address))return {skipped:'Token (CA) atau pool sudah dibuka'};
 if((book.virtual.capitalAsset||'USDC')==='SOL'){
  const px=await solUsd(),cash=book.virtual.capitalSol||0,slots=CFG.MAX_POSITIONS-book.positions.length;
  const allocation=CFG.POSITION_USDC>0?(cash+1e-12>=CFG.POSITION_USDC/px?CFG.POSITION_USDC/px:0):cash/slots;
  if(!(allocation>0)||!(px>0))return {skipped:'Saldo SOL tidak cukup untuk budget'};
  const leg={...book,positions:undefined,position:null,virtual:{...book.virtual,usdc:allocation*px,sol:0,capitalSol:0}};
  const result=await paperOpenSingle(p,{...state,books:{[VARIANTS[0].id]:leg}},{...opts,capitalAsset:'SOL',positionBudgetSol:allocation,silent:true});
  if(result.opened){const pos=leg.position,spent=pos.capitalInSol;if(!Number.isFinite(spent)||spent>cash+1e-9||spent<0)throw Error('Invalid SOL capital spend');pos.reserveSol=leg.virtual.sol||0;book.virtual.capitalSol=Math.max(0,cash-spent);book.positions.push(pos);
   if(!opts.silent){log(`PAPER OPEN [${VARIANTS[0].id}] ${pos.name}: spent ${spent.toFixed(8)} SOL capital; pool quote=${pos.quoteSymbol}; gas from SOL balance; freeSOL=${book.virtual.capitalSol.toFixed(8)}`);try{telegram.notifyOpen({openContext:pos.openContext,...quotePnl.fromPosition(pos),name:pos.name,pool:pos.pool,quoteSymbol:pos.quoteSymbol,depositQuote:pos.depositQuote,sizeSol:pos.depositSol,usdcIn:pos.usdcIn,gasBufferSol:pos.gasBufferSol,leftoverSol:pos.reserveSol,minBinId:pos.minBinId,maxBinId:pos.maxBinId,entryPrice:pos.entryPrice,bins:pos.bins,activeBin:pos.entryActiveBin}).catch(()=>{});}catch{}}
  }return result;
 }
 const allocation=multi.budget(book,CFG);
 if(!(allocation>1))return {skipped:'Saldo USDC tidak cukup'};
 const leg={...book,positions:undefined,position:null,virtual:{...book.virtual,usdc:allocation,sol:0}};
 const result=await paperOpenSingle(p,{...state,books:{[VARIANTS[0].id]:leg}},opts);
 if(result.opened)multi.append(book,leg,allocation);
 return result;
}

async function paperOpenSingle(p, state,opts={}) {
 const policy={...CFG,...(opts.strategySettings||{})};
  if(opts.source!=='reposition'&&CFG.SL_BLACKLIST_ENABLED!==false&&slBlacklist.has(PAPER_DIR,p.token_x?.address)){log('OPEN ditolak '+p.name+': SL blacklist');return {skipped:'SL blacklist: token pernah kena stop loss'};}
  if(opts.source!=='reposition'){const why=entryPolicy.cooldownReason(primaryBook(state)?.history,p.address,CFG.REOPEN_COOLDOWN_MIN);if(why){log('OPEN ditolak '+p.name+': '+why);return {skipped:why};}}
  if(CFG.MAX_LIQ_USD>0&&p.tvl>CFG.MAX_LIQ_USD){const why=`tvl>$${CFG.MAX_LIQ_USD}`;log('OPEN ditolak '+p.name+': '+why);return {skipped:why};}
  if(p.token_y?.address===USDC)return paperOpenUsdc(p,state,opts);
  const dlmm = await DLMM.create(conn, new PublicKey(p.address));
  const active = await dlmm.getActiveBin();
  const binStep = Number(p.pool_config.bin_step);
  const n = strategy.geometry(binStep,policy,MAX_BINS).n;
  const maxBinId = active.binId + strategy.geometry(binStep,policy,MAX_BINS).upper; // token-side buffer above entry active
  const minBinId = active.binId - n + 1;
  const priceUi = +dlmm.fromPricePerLamport(+active.price);
  const lowPrice = priceUi * Math.pow(1 + binStep / 1e4, -n);
  const rangePct = -((1 - lowPrice / priceUi) * 100);
  const g=strategy.geometry(binStep,policy,MAX_BINS);const cost=strategy.skip(g)?fastEntryCost(dlmm,minBinId,maxBinId,g,p.address):await quotePaperEntryCost(dlmm,minBinId,maxBinId);p.entryCostEstimate=cost;
  const reject=entryCost.rejection(cost,CFG.MAX_NONREFUND_SOL);if(reject){log('OPEN ditolak: '+p.name+' '+reject);return {skipped:reject};}
  const rentRef=cost.refundableRentSol,rentNon=cost.nonrefRentSol,openFees=cost.openTxFeeSol;
  const px = await solUsd();
  if (!(px > 0)) {
    log(`  NOT opening: SOL/USD price unavailable`);
    return { skipped: 'sol usd unavailable' };
  }
  const gasPlan = paperCap.computeGasBufferSol({
    rentRefundable: rentRef,
    rentNonRefundable: rentNon,
    txFee: CFG.TX_FEE_SOL,
    floor: policy.GAS_BUFFER_SOL,
  });
  const extraSol = gasPlan.buffer;
  const book0 = primaryBook(state);
  const spend = opts.capitalAsset==='SOL'?{ok:opts.positionBudgetSol>extraSol,why:'SOL budget cannot cover gas buffer',usdcToSwap:opts.positionBudgetSol*px,usdcForPosition:Math.max(0,opts.positionBudgetSol-extraSol)*px,capped:false}:paperCap.planOpenSpend({
    usdcCash: Math.min(book0?.virtual?.usdc||0,opts.positionBudgetUsdc??(CFG.POSITION_USDC>0?CFG.POSITION_USDC:book0?.virtual?.usdc||0)),
    usdcBuffer: CFG.USDC_BUFFER,
    capUsd: (p.tvl || 0) * ((policy.MAX_POSITION_TVL_PCT??5)/100),
    extraSol,
    solUsd: px,
  });
  log(`open plan ${p.name} ${p.address}: activeBin=${active.binId} price=${priceUi.toExponential(4)} SOL, bins ${minBinId}..${maxBinId} (${n} bins, range=${rangePct.toFixed(1)}%), USDC cash=${(book0 && book0.virtual && book0.virtual.usdc || 0).toFixed(2)} extraSol=${extraSol.toFixed(4)} (need=${gasPlan.needed.toFixed(4)} raw=${gasPlan.raw.toFixed(4)}) rentRef=${rentRef.toFixed(4)} rentNon=${rentNon.toFixed(4)} txFees=${openFees.toFixed(6)} solUsd=${px.toFixed(2)}${spend.ok ? ` usdcToSwap=${spend.usdcToSwap.toFixed(4)} posUsd=${spend.usdcForPosition.toFixed(4)}${spend.capped ? ` CAPPED at 5% TVL (tvl=$${(p.tvl || 0).toFixed(0)})` : ''}` : ` SKIP ${spend.why}`}`);
  if (!spend.ok) {
    log(`  NOT opening: ${spend.why}`);
    return { skipped: spend.why, spend, extraSol };
  }
  const usdcRaw = BigInt(Math.floor(spend.usdcToSwap * 1e6));
  const qOpen = opts.capitalAsset==='SOL'?{ok:true,inUi:opts.positionBudgetSol*px,outUi:opts.positionBudgetSol}:await jupiterQuote(USDC, SOL, usdcRaw, 6, 9);
  if (!qOpen.ok || !(qOpen.outUi > 0)) {
    log(`  NOT opening: Jupiter USDC->SOL quote failed (${qOpen.error || 'n/a'})`);
    return { skipped: 'jupiter USDC->SOL quote failed', error: qOpen.error };
  }
  const openSwapCostUsd = opts.capitalAsset==='SOL'?0:paperCap.swapCostUsd({ inUi: qOpen.inUi, outUi: qOpen.outUi, inIsUsd: true, outIsUsd: false, solUsd: px }) || 0;
  const alloc = paperCap.allocateOpenSol(qOpen.outUi, { rentRef, rentNon, openFees, extraSol });
  if (!alloc.ok) {
    log(`  NOT opening: ${alloc.why} (bought ${qOpen.outUi.toFixed(6)} SOL)`);
    return { skipped: alloc.why, solBought: qOpen.outUi };
  }
  const capSol = ((p.tvl || 0) * ((policy.MAX_POSITION_TVL_PCT??5)/100)) / px;
  let deposit = alloc.deposit;
  let reserve = alloc.reserve;
  if (deposit > capSol) {
    reserve += deposit - capSol;
    deposit = capSol;
  }
  const sizing = {
    want: spend.usdcForPosition / px,
    actual: deposit,
    capped: spend.capped || deposit + 1e-12 < spend.usdcForPosition / px,
    tvlUsd: p.tvl,
    capUsd: (p.tvl || 0) * ((policy.MAX_POSITION_TVL_PCT??5)/100),
    solUsd: px,
  };
  const shape=await initialPaperBins(dlmm,p,{minBinId,maxBinId,activeBin:active.binId,depositQuote:deposit,price:priceUi,quoteMint:SOL,quoteDecimals:9,policy});
  const half=shape.entryQuoteY/2,bins0=shape.bins;
  let stats = null;
  try { stats = await fetchPool(p.address); } catch { /* optional */ }
  const split=policy.OPEN_SHAPE==='SPOT'?1:policy.OPEN_SHAPE==='BIDASK'?0:policy.OPEN_SPOT_PCT/100;
  const template = {
    strategySettings:strategy.snapshot(policy),
    capitalAsset:opts.capitalAsset||'USDC',capitalInSol:opts.capitalAsset==='SOL'?opts.positionBudgetSol:null,
    paper: true, pool: p.address, name: p.name, mintX: p.token_x.address, decX: dlmm.tokenX.mint.decimals,
    quoteMint:SOL,quoteSymbol:'SOL',quoteDecimals:9,depositQuote:sizing.actual,feesCompoundedQuote:0,
    baseFeePct: p.pool_config?.base_fee_pct ?? p.pool_config?.base_fee_percentage ?? p.base_fee_percentage ?? null,
    poolFees24hUsd: p.fees?.['24h'] ?? null,
    lastPrice: priceUi, lastSolUsd: px,
    minBinId, maxBinId, origMinBinId: minBinId, origMaxBinId: maxBinId,
    nBins: n+strategy.geometry(binStep,policy,MAX_BINS).upper, upperBufferBins:strategy.geometry(binStep,policy,MAX_BINS).upper,entryTokenX:shape.entryTokenX,entryQuoteY:shape.entryQuoteY, binStep, rangePct, entryPrice: priceUi, entryActiveBin: active.binId,
    openedAt: now(), entryWib: wib(),
    depositSol: sizing.actual, sizeWant: sizing.want, tvlCapped: sizing.capped,
    tvlUsd: p.tvl, solUsdEntry: sizing.solUsd, spotSol:shape.entryQuoteY*split,bidaskSol:shape.entryQuoteY*(1-split), shape: 'open-'+String(policy.OPEN_SHAPE||'MIXED').toLowerCase(),
    usdcIn: qOpen.inUi, solBought: qOpen.outUi, openSwapCostUsd:openSwapCostUsd+shape.tokenSwapCostQuote*px, gasBufferSol: extraSol,
    leftoverSolAtOpen: reserve,
    rentPaidSol: rentRef + rentNon, rentRefundableSol: rentRef, rentNonRefundableSol: rentNon,
    networkFeesSol: openFees, feeX: 0, feeY: 0, feesCompoundedSol: 0, feesCompoundedX: 0,
    lastFeesCum: stats?.cumulative_metrics?.fees ?? null, lastPollAt: Date.now(),
    lastActiveBin: active.binId, lastReshapeActiveBin: active.binId,
    reshapes: 0, sdkBuild: null,
  };
  // Build-only once (no sign, no send)
  const sdkBuild = cost.skipCheck?{ok:true,skipped:'PAPER wide-range: optional build/rent RPC not awaited'}:await buildOpenTxs(dlmm, template, half);
  for (const v of VARIANTS) {
    const book = state.books[v.id];
    const posKp = Keypair.generate();
    const pos = {
      ...template,
      variant: v.id,
      position: posKp.publicKey.toBase58(),
      walletBeforeUsdc: book.virtual.usdc,
      walletBeforeSol: book.virtual.sol,
      bins: cloneBins(bins0),
      sdkBuild,
    };
    book.virtual.usdc = (book.virtual.usdc || 0) - qOpen.inUi;
    book.virtual.sol = reserve;
    setOpenContext(pos,p,opts);quotePnl.ensureEntry(pos);
    book.position = pos;
    if(!opts.silent)log(`  PAPER OPEN [${v.id}] ${p.name}: spent ${qOpen.inUi.toFixed(4)} USDC -> ${qOpen.outUi.toFixed(4)} SOL (deposit ${deposit.toFixed(4)}, gas leftover ${reserve.toFixed(4)}, swapCost $${openSwapCostUsd.toFixed(4)}), USDC now ${book.virtual.usdc.toFixed(4)} ${quotePnl.logFields(quotePnl.fromPosition(pos))}`);
  }
  log(`  sdkBuild=${sdkBuild.ok ? 'ok' : sdkBuild.error || 'n/a'} (built, not signed)`);
  const opened = {capitalSpentSol:opts.capitalAsset==='SOL'?opts.positionBudgetSol:null, opened: true, paper: true, variants: VARIANTS.map((v) => v.id), sizeWant: sizing.want, sizeActual: sizing.actual, capped: sizing.capped, minBinId, maxBinId, n, priceUi, entryActiveBin: active.binId, sdkBuild };
  if(!opts.silent)try {
    const openedPos = primaryBook(state) && primaryBook(state).position;
    telegram.notifyOpen({
      openContext:openedPos.openContext,...quotePnl.fromPosition(openedPos),
      name: p.name, pool: p.address, sizeSol: sizing.actual,
      usdcIn: qOpen.inUi, gasBufferSol: extraSol, leftoverSol: reserve,
      minBinId, maxBinId, rangePct, entryPrice: priceUi,
      ft30m: feeTvl(p, '30m'), tvl: p.tvl,
      bins: openedPos && openedPos.bins, activeBin: active.binId,
      lastActiveBin: active.binId, shape: openedPos && openedPos.shape,
    }).catch(() => {});
  } catch { /* notify must never crash the bot */ }
  return opened;
}

function publicPos(pos) {
  if (!pos) return null;
  const { bins, ...rest } = pos;
  const { x, y } = sumXY(pos.bins || {});
  let binShape = null;
  try { binShape = require('./bin-shape').chartModel(pos); } catch { /* chart is optional */ }
  return { ...rest, inventory: { x, y, nBins: Object.keys(pos.bins || {}).length }, binShape };
}

async function buildOpenTxs(dlmm, pos, half) {
  const out = { ok: false, notes: [] };
  try {
    const kp = Keypair.generate();
    const tx1 = await dlmm.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: kp.publicKey,
      totalXAmount: new BN(Math.floor((pos.entryTokenX||0)/2*10**pos.decX)),
      totalYAmount: new BN(Math.floor(half * 10 ** (pos.quoteDecimals||9))),
      strategy: { minBinId: pos.minBinId, maxBinId: pos.maxBinId, strategyType: StrategyType.Spot },
      user: USER_PUB,
      slippage: CFG.SLIPPAGE_PCT,
    });
    out.tx1Ixs = tx1.instructions?.length ?? tx1.length ?? 'n/a';
    out.notes.push('open tx1 (init+Spot) built, not signed, not sent');
    out.notes.push('open tx2 (add Bid-Ask on same position) would be dlmm.addLiquidityByStrategy — not built because the position is virtual');
    out.ok = true;
    out.wouldUseSamePosition = true;
  } catch (e) {
    out.error = e.message;
    out.notes.push('build-only open failed: ' + e.message);
  }
  return out;
}

async function compoundFeesToLeft(pos, snap, tag = '') {
  const feeY = pos.feeY || 0;
  if (feeY < 1e-8) return { added: 0 };
  const leftIds = [];
  for (let i = pos.minBinId; i < snap.active.binId; i++) leftIds.push(i);
  if (!leftIds.length) {
    const n = strategy.geometry(pos.binStep,{...CFG,...(pos.strategySettings||{})},MAX_BINS).n;
    const wantMin = snap.active.binId - n;
    if (wantMin < pos.minBinId) {
      const room = MAX_BINS - (pos.maxBinId - pos.minBinId + 1);
      const add = Math.min(pos.minBinId - wantMin, room, MAX_RESIZE);
      if (add > 0) {
        pos.minBinId -= add;
        for (let i = pos.minBinId; i < pos.minBinId + add; i++) leftIds.push(i);
        log(`  ${tag}extend LOWER +${add} bins to ${pos.minBinId} so quote fees can be added on the left`);
      }
    }
    for (let i = pos.minBinId; i < snap.active.binId; i++) if (!leftIds.includes(i)) leftIds.push(i);
  }
  if (!leftIds.length) {
    log(`  ${tag}cannot compound SOL fees to the left: no bins below active and cannot extend`);
    return { added: 0, skipped: 'no left bins' };
  }
  const weight=(pos.strategySettings?.COMPOUND_SPOT_PCT??50)/100;
  const half = feeY * weight;
  const spot = weight>0?await strategyAmounts(snap.dlmm, { minBinId: Math.min(...leftIds), maxBinId: Math.max(...leftIds), amountX: 0, amountY: half, strategyType: StrategyType.Spot }):[];
  const bid = weight<1?await strategyAmounts(snap.dlmm, { minBinId: Math.min(...leftIds), maxBinId: Math.max(...leftIds), amountX: 0, amountY: feeY-half, strategyType: StrategyType.BidAsk }):[];
  const merged = mergeAmounts(spot, bid);
  attachBinPrices(snap.dlmm, emptyBinsMap(merged), snap.price, snap.active.binId);
  reshapeCore.applySolCompoundToLeft(pos.bins, merged, snap.active.binId);
  // copy bin prices for new left bins
  for (const r of merged) {
    if (r.binId >= snap.active.binId) continue;
    if (pos.bins[r.binId] && r.binPrice) pos.bins[r.binId].binPrice = pos.bins[r.binId].binPrice || r.binPrice;
  }
  pos.feesCompoundedQuote = paperUsdc.compoundedQuote(pos) + feeY;
  if(!paperUsdc.isUsdc(pos)) pos.feesCompoundedSol = pos.feesCompoundedQuote;
  pos.feeY = 0;
  log(`  ${tag}compound-on-reshape: ${feeY.toFixed(6)} quote fees added to left bins (nothing withdrawn)`);
  return { added: feeY };
}

async function paperReshape(pos, snap, book, variant, sdkCache, opts = {}) {
  const active = snap.active.binId;
  const tag = `[${variant.id}] `;
  const origMax = pos.origMaxBinId;
  const txsGuess = reshapeCore.reshapeTxCount({ compoundedSol: opts.compound !== false && variant.compound && (pos.feeY || 0) > 0 });
  const txCostGuess = txsGuess * CFG.TX_FEE_SOL;
  if ((book.virtual.sol || 0) + 1e-12 < txCostGuess) {
    log(`  ${tag}reshape skipped: leftover gas SOL ${(book.virtual.sol || 0).toFixed(6)} < tx ${txCostGuess.toFixed(6)}`);
    return { skipped: 'leftover SOL buffer cannot cover reshape tx fees', leftoverSol: book.virtual.sol, txCostGuess };
  }
  const range = reshapeCore.tokenReshapeRange(origMax, active);
  const savedFees=reshapeCore.claimFees(pos),compoundEnabled=opts.compound!==false&&variant.compound;const feeX=compoundEnabled?savedFees.feeX:0,feeY=compoundEnabled?savedFees.feeY:0;

  // SOL fees to the left first (add only). Token fees stay in feeX until the re-add below.
  let solAdded = 0;
  if (opts.compound !== false && variant.compound && feeY > 0) {
    const c = await compoundFeesToLeft(pos, snap, tag);
    solAdded = c.added || 0;
  }

  const tokenBins = Object.entries(pos.bins)
    .map(([id, b]) => ({ binId: +id, ...b }))
    .filter((b) => b.binId > active && (b.x || 0) > 0)
    .sort((a, b) => a.binId - b.binId);
  const { tokenX } = reshapeCore.withdrawTokenSide(pos.bins, active);
  const amountX = tokenX + feeX;
  if (!(amountX > 0)) {
    // restore nothing to withdraw; SOL may already have been compounded and feeY reset
    return { skipped: 'no token-side inventory or token fees to reshape', tokenX, feeX, ...range };
  }
  if (!range.ok) {
    // Put tokens back into the bins we just cleared? We already withdrew. If no room, we must not lose tokens.
    // This happens only if active >= origMax (price at/above original upper edge) — unusual after a down-N trigger.
    log(`  ${tag}reshape aborted: no room in [${range.rightMin}..${range.rightMax}] (original right edge=${origMax}). Restoring withdrawn X.`);
    // put tokenX back onto the last original bin if it exists, else origMax
    const rest = pos.bins[origMax] || { x: 0, y: 0 };
    rest.x = (rest.x || 0) + tokenX;
    pos.bins[origMax] = rest;
    return { skipped: 'no room on the right within original position edge', tokenX, feeX, ...range };
  }

  const bidRows = await strategyAmounts(snap.dlmm, {
    minBinId: range.rightMin, maxBinId: range.rightMax, amountX, amountY: 0, strategyType:pos.strategySettings?.RESHAPE_SHAPE==='SPOT'?StrategyType.Spot:StrategyType.BidAsk,
  });
  attachBinPrices(snap.dlmm, emptyBinsMap(bidRows), snap.price, active);
  reshapeCore.applyTokenReadd(pos.bins, bidRows, active, origMax, amountX);
  pos.feesCompoundedX = (pos.feesCompoundedX || 0) + feeX;
  pos.feeX = 0; // feeY already reset if compounded; keep it 0
  if (pos.feeY && solAdded > 0) pos.feeY = 0;
  if(compoundEnabled)reshapeCore.resetClaimedFees(pos);else{pos.feeX=savedFees.feeX;pos.feeY=savedFees.feeY;}

  pos.shape = pos.strategySettings?.RESHAPE_SHAPE==='SPOT'?'reshape-spot':'M-double-bidask';
  pos.reshapes = (pos.reshapes || 0) + 1;
  pos.lastReshapeActiveBin = active;
  // claim + remove + add token, and add SOL compound when we did that
  const txs = reshapeCore.reshapeTxCount({ compoundedSol: solAdded > 0 });
  const txCost = txs * CFG.TX_FEE_SOL;
  pos.networkFeesSol += txCost;
  book.virtual.sol = (book.virtual.sol || 0) - txCost;
  if (book.virtual.sol < 0) {
    log(`  ${tag}WARN leftover gas SOL went negative (${book.virtual.sol.toFixed(8)}); clamping to 0`);
    book.virtual.sol = 0;
  }

  let sdk = sdkCache?.build;
  if (!sdk) {
    sdk = await buildReshapeTxs(snap.dlmm, pos, { rightMin: range.rightMin, rightMax: range.rightMax, tokenX: amountX, tokenBins, feeX });
    if (sdkCache) sdkCache.build = sdk;
  }
  const ev = {
    at: now(), atWib: wib(), variant: variant.id, n: variant.n, pool: pos.pool, name: pos.name,
    trigger: `active down N=${variant.n} to ${active}`,
    entryActiveBin: pos.entryActiveBin, lastReshapeActiveBin: pos.lastReshapeActiveBin,
    activeBin: active, tokenX, feeXAdded: feeX, feeYAdded: solAdded, amountX,
    rightMin: range.rightMin, rightMax: range.rightMax, origMaxBinId: origMax,
    minBinId: pos.minBinId, maxBinId: pos.maxBinId, samePosition: true,
    txs, txCost, sdk,
  };
  book.reshapes.push(ev);
  fs.appendFileSync(F('reshapes.jsonl'), JSON.stringify(ev) + '\n');
  log(`  ${tag}RESHAPE #${pos.reshapes} ${pos.name}: right=${range.rightMin}..${range.rightMax} (orig edge ${origMax}, no upper extend). token re-add X=${amountX.toExponential(4)} (withdrawn ${tokenX.toExponential(4)} + feeX ${feeX.toExponential(4)}). quote fees compounded=${solAdded.toFixed(6)} ${paperUsdc.quoteSymbol(pos)}. fees reset. txs=${txs}. Left quote untouched. shape=M.`);
  try {
    if (CFG.NOTIFY_RESHAPE === true) telegram.notifyReshape({
      name: pos.name, pool: pos.pool, n: variant.n, reshapes: pos.reshapes, quoteSymbol:paperUsdc.quoteSymbol(pos),
      activeBin: active, rightMin: range.rightMin, rightMax: range.rightMax,
      amountX, tokenX, feeXAdded: feeX, feeYAdded: solAdded,
      bins: pos.bins, minBinId: pos.minBinId, maxBinId: pos.maxBinId,
      lastActiveBin: active, shape: pos.shape,
    }).catch(() => {});
  } catch { /* notify must never crash the bot */ }
  return ev;
}

async function buildReshapeTxs(dlmm, pos, plan) {
  const out = { ok: false, samePosition: true, notes: [], plan: { rightMin: plan.rightMin, rightMax: plan.rightMax, tokenX: plan.tokenX } };
  out.notes.push('ALL reshape steps target the SAME position account: ' + pos.position);
  out.notes.push('1) claimSwapFee — compound via add, not a second position');
  out.notes.push('2) removeLiquidity only on token-side bins (binId > active). Quote-side never withdrawn.');
  out.notes.push('3) token Bid-Ask from active+1 to origMaxBinId (original upper edge); no increasePositionLength Upper in the normal case');
  out.notes.push('4) addLiquidityByStrategy SAME position, token-only Bid-Ask (withdrawn X + claimed feeX)');
  out.notes.push('5) addLiquidityByStrategy SAME position, claimed SOL fees to the left, add only');
  out.notes.push('txs: claim + remove + add token + add SOL compound when feeY was added');
  try {
    await dlmm.removeLiquidity({
      user: USER_PUB, position: new PublicKey(pos.position),
      fromBinId: plan.tokenBins[0]?.binId ?? plan.rightMin,
      toBinId: plan.tokenBins[plan.tokenBins.length - 1]?.binId ?? plan.rightMax,
      bps: new BN(10000), shouldClaimAndClose: false,
    });
    out.notes.push('removeLiquidity unexpectedly built (no sign/send)');
  } catch (e) {
    out.notes.push('removeLiquidity build skipped as expected (virtual position not on-chain): ' + String(e.message || e).slice(0, 180));
  }
  out.ok = true;
  return out;
}

const jupGetJSON=jup.wrap(getJSON,m=>log(m));
const QUOTE_REFRESH_MS=30000;   // a position whose value is far from every exit threshold asks Jupiter at most this often; near a threshold it asks every poll
const paperQuoteClient=require('./paper-quote-client').create({fetch:(...args)=>fetch(...args),log,apiKey:()=>jup.key(),onKeyRejected:()=>jup.reject(m=>log(m))});
async function jupiterQuote(inputMint, outputMint, rawAmount, inDec, outDec, slippageBps = 300) {
  const raw = typeof rawAmount === 'bigint' ? rawAmount : BigInt(Math.max(0, Math.floor(Number(rawAmount) || 0)));
  if (raw === 0n) return { ok: true, skipped: 'zero', inUi: 0, outUi: 0, inAmount: '0', outAmount: '0', impact: 0 };
  if(CFG.PAPER)return paperQuoteClient.quote(inputMint,outputMint,raw,inDec,outDec,slippageBps);
  try {
    const q = await swapRoute.swapQuote({connection:conn,getJSON:jupGetJSON,inputMint,outputMint,amount:raw,slippageBps});
    const parsed = paperCap.parseQuote(q, inDec, outDec);
    return Object.assign(q, parsed);
  } catch (e) {
    return { ok: false, error: e.message, inUi: 0, outUi: 0 };
  }
}

async function jupiterQuoteXtoSol(mintX, uiAmount, decX) {
  const raw = BigInt(Math.max(0, Math.floor(uiAmount * 10 ** decX)));
  if (raw === 0n) return { outSol: 0, impact: 0, ok: true, skipped: 'no X' };
  const q = await jupiterQuote(mintX, SOL, raw, decX, 9);
  if (q.skipped) return { outSol: 0, impact: 0, ok: true, skipped: q.skipped };
  if (!q.ok) return { outSol: null, ok: false, error: q.error };
  return { outSol: q.outUi, impact: q.impact || 0, ok: true };
}

async function paperClose(book,variant,reason,snap,quoteCache={},exitVal=null,opts={}){
 const pos=book.position,tag=`[${variant.id}] `;
 if(!snap){const m=await fetchMarket(pos.pool,pos.minBinId,pos.maxBinId);snap=applySnapshotToPos(pos,m);}
 const val=exitVal||await paperUsdc.exitQuote({pos,book,snap,quote:jupiterQuote,txFee:CFG.TX_FEE_SOL});
 const unit=paperUsdc.quoteUsd(pos,snap.pxUsd),comp=paperUsdc.compoundedQuote(pos);
 const feesQuote=comp+(pos.feesCompoundedX||0)*snap.price+(pos.feeY||0)+(pos.feeX||0)*snap.price;
 const feesUsd=feesQuote*unit+(pos.feesCarryUsd||0);
 const gasUsed=(pos.gasCarrySol||0)+paperCap.gasUsedSol({rentPaid:pos.rentPaidSol||0,rentRefunded:val.rentBack,networkFees:(pos.networkFeesSol||0)+val.closeFees});
 const holdH=(Date.now()-Date.parse(pos.openedAt))/3.6e6;
 const swapCostUsd=(pos.swapCostCarryUsd||0)+(pos.openSwapCostUsd||0)+val.tokenSwapCostUsd+val.solSwapCostUsd;
 const rec={...((({bins,sdkBuild,...r})=>r)(pos)),variant:variant.id,reshapeN:pos.strategySettings?.RESHAPE_N??variant.n,
  closedAt:now(),exitWib:wib(),reason,hold:`${Math.floor(holdH)}h ${Math.round((holdH%1)*60)}m`,holdHours:+holdH.toFixed(3),exitPrice:snap.price,
  quoteMint:paperUsdc.quoteMint(pos),quoteSymbol:paperUsdc.quoteSymbol(pos),depositQuote:paperUsdc.depositQuote(pos),
  feesEarnedQuote:feesQuote,feesEarnedUsd:feesUsd,feesEarnedSol:paperUsdc.isUsdc(pos)?null:feesQuote,
  ilSol:paperUsdc.isUsdc(pos)?null:(val.y-comp)+(val.x-(pos.feesCompoundedX||0))*snap.price-paperUsdc.depositQuote(pos),
  rentPaidSol:pos.rentPaidSol||0,rentRefundedSol:val.rentBack,networkFeesSol:(pos.networkFeesSol||0)+val.closeFees,
  swapCostSol:swapCostUsd/snap.pxUsd,swapCostUsd,openSwapCostUsd:pos.openSwapCostUsd||0,tokenSwapCostUsd:val.tokenSwapCostUsd,solSwapCostUsd:val.solSwapCostUsd,
  usdcIn:pos.initialUsdcIn||pos.usdcIn,usdcOut:(pos.initialUsdcIn||pos.usdcIn)+val.pnlUsd,legUsdcIn:pos.usdcIn,legUsdcOut:val.usdcOut,gasUsedSol:gasUsed,pnlUsd:val.pnlUsd,pnlPct:val.pnlPct,
  capitalAsset:pos.capitalAsset||'USDC',pnlCapital:pos.capitalAsset==='SOL'?val.pnlCapital:val.pnlUsd,pnlCapitalPct:val.pnlPct,solOut:val.solOut,
  netPnlUsd:val.pnlUsd,netPnlPct:val.pnlPct,netPnlSol:pos.capitalAsset==='SOL'?val.pnlCapital:val.pnlUsd/snap.pxUsd,solUsd:snap.pxUsd,
  y:val.y,x:val.x,solPile:val.solPile,valuationBasis:val.valuationBasis,quoted:val.quoted,
  estimatesNote:pos.capitalAsset==='SOL'?'Paper close: native SOL retained; X and non-native quote swapped to SOL; gas/refundable rent included exactly once. USD is mark-to-market.':'Paper close: Y stays USDC for USDC quote, X->USDC and all native SOL incl refundable rent->USDC via Jupiter quotes. Gas/swap are included in usdcOut; not subtracted twice.'};
 rec.riskPolicyVersion=pos.capitalAsset==='SOL'?'net-sol-v1-quote-wait10':'net-usdc-v2-quote-wait10';rec.closeReasonText=paperHistory.closeReason(rec);
 Object.assign(rec,quotePnl.calculate({pos,valueQuote:snap.value??markValue(pos.bins,snap.price,pos.feeX||0,pos.feeY||0),solUsd:snap.pxUsd,val}));
 if(pos.capitalAsset==='SOL')book.virtual.capitalSol=(book.virtual.capitalSol||0)+val.solOut;else book.virtual.usdc=(book.virtual.usdc||0)+val.usdcOut;book.virtual.sol=0;
 if(!opts.intermediate)book.history.push(rec);book.position=null;
 // SL blacklist: record every stop-loss close by token mint (recorded even if the rule is off; the rule controls skipping).
 if(!opts.intermediate&&slBlacklist.isStopLoss(reason))try{if(slBlacklist.add(PAPER_DIR,{mint:pos.mintX,symbol:pos.name,pool:pos.pool,reason,closedAt:rec.closedAt,source:'auto'})){const l='SL blacklist add '+pos.name+' '+pos.mintX;log(l);paperSettings.audit(PAPER_DIR,'action='+l);}}catch(e){log('SL blacklist add failed: '+e.message);}
 if(!opts.silent)log(`${tag}CLOSE ${pos.name} reason=${reason} pnlUsd=${val.pnlUsd.toFixed(4)} (${val.pnlPct.toFixed(3)}%) usdc ${pos.usdcIn.toFixed(4)}->${val.usdcOut.toFixed(4)} swapCostUsd=${swapCostUsd.toFixed(4)} gasUsed=${gasUsed.toFixed(6)} quote=${rec.quoteSymbol} basis=${val.valuationBasis} usdcCash=${book.virtual.usdc.toFixed(4)} ${quotePnl.logFields(rec)}`);
 if(!opts.intermediate&&!opts.silent)try{(reason==='emergency_stop'?telegram.notifyEmergency:telegram.notifyClose)(rec).catch(()=>{});}catch{}
 return rec;
}

async function paperRepositionRight(state,book,v,snap,val){
 const old=book.position,number=(old.rightRepositions||0)+1;
 const work=JSON.parse(JSON.stringify(book)),workState={...state,books:{[v.id]:work}};
 const rec=await paperClose(work,v,'oor_right_reposition_leg',snap,{},val,{intermediate:true,silent:true});
 try{
  const pool=await fetchPool(old.pool);
  const bad=screenSource.sanityReason(pool,CFG.MIN_LIQ_USD);if(bad)throw Error(bad);
  // Never pull newly topped-up free cash into this position: recycle only this leg's exit proceeds.
  const proceeds=Math.max(0,val.usdcOut),freeUsdcBefore=work.virtual.usdc;
  if(old.capitalAsset==='SOL')work.virtual.usdc=proceeds;
  if(!(proceeds>1))throw Error('Proceeds too small to reposition');
  const result=await paperOpenSingle(pool,workState,{silent:true,source:'reposition',strategySettings:old.strategySettings,capitalAsset:old.capitalAsset||'USDC',positionBudgetUsdc:proceeds,positionBudgetSol:val.solOut});if(!result.opened)throw Error(result.skipped||'Open failed');
  const pos=work.position;
  if(old.capitalAsset==='SOL'){work.virtual.usdc=freeUsdcBefore;work.virtual.capitalSol=(book.virtual.capitalSol||0)+val.solOut-pos.capitalInSol;pos.initialCapitalInSol=old.initialCapitalInSol||old.capitalInSol;pos.realizedPnlCarrySol=(old.realizedPnlCarrySol||0)+val.solOut-old.capitalInSol;}
  pos.currentLegOpenContext=pos.openContext;pos.entryLegs=[...(old.entryLegs||[]),pos.openContext];
  pos.openContext=old.openContext;pos.openSource=old.openSource;pos.openReason=old.openReason;
  pos.pnlQuoteCarry=rec.pnlQuote||0;pos.initialEntryQuoteAmount=old.initialEntryQuoteAmount||old.entryQuoteAmount||old.depositQuote||old.depositSol;
  pos.displaySolUsdEntry=old.displaySolUsdEntry||old.solUsdEntry;
  pos.rightRepositions=number;pos.oorRightPolls=0;
  pos.initialUsdcIn=old.initialUsdcIn||old.usdcIn;
  pos.realizedPnlCarryUsd=(old.realizedPnlCarryUsd||0)+val.usdcOut-old.usdcIn;
  pos.feesCarryUsd=rec.feesEarnedUsd;pos.swapCostCarryUsd=rec.swapCostUsd;pos.gasCarrySol=rec.gasUsedSol;
  pos.riskEntryPrice=old.riskEntryPrice||old.entryPrice;
  pos.legOpenedAt=pos.openedAt;pos.openedAt=old.openedAt;pos.entryWib=old.entryWib;
  for(const k of ['peakPnlCapital','peakPnlUsd','peakPnlPctUsdc','peakPnlAt'])if(old[k]!=null)pos[k]=old[k];
  const event={capitalAsset:old.capitalAsset||'USDC',pnlCapital:val.pnlCapital,at:now(),atWib:wib(),name:old.name,pool:old.pool,number,pnlUsd:val.pnlUsd,pnlPct:val.pnlPct,reason:`net ${val.pnlPct.toFixed(3)}% < minimum ${CFG.OOR_RIGHT_MIN_PROFIT_PCT}%`,minBinId:pos.minBinId,maxBinId:pos.maxBinId,activeBin:pos.entryActiveBin,carryPnlUsd:pos.realizedPnlCarryUsd};
  Object.assign(book,work); // commit the complete paper close+reopen, never a partial leg
  book.rightRepositionEvents=book.rightRepositionEvents||[];book.rightRepositionEvents.push(event);
  try{fs.appendFileSync(F('repositions.jsonl'),JSON.stringify(event)+'\n');}catch{}
  log(`REPOSITION KANAN #${number} ${old.name}: ${event.reason}; range ${pos.minBinId}..${pos.maxBinId}; carryPnL=${pos.realizedPnlCarryUsd.toFixed(4)} USDC; swaps/gas/rent included ${quotePnl.logFields(rec)}`);
  try{paperSettings.audit(PAPER_DIR,`action=paper-reposition-right number=${number} pool=${old.pool} pnlPct=${val.pnlPct} carry=${pos.realizedPnlCarryUsd}`);}catch{}
  try{telegram.notifyReposition({...event,openContext:pos.currentLegOpenContext,pnlQuote:rec.pnlQuote,pnlQuoteUsd:rec.pnlQuoteUsd,displaySolUsdEntry:rec.displaySolUsdEntry,displaySolUsd:rec.displaySolUsd,solPriceChangePct:rec.solPriceChangePct,bins:pos.bins,lastActiveBin:pos.entryActiveBin,shape:pos.shape,quoteSymbol:pos.quoteSymbol}).catch(()=>{});}catch{}
  return true;
 }catch(e){
  // DRY RUN transaction failed: old inventory/cash/range stay OPEN; retry next poll.
  old.repositionRetryCount=(old.repositionRetryCount||0)+1;old.repositionRetryAt=now();
  old.repositionRetryError=String(e.message).replace(/https?:\/\/\S+/g,'[endpoint]').slice(0,160);
  log(`reposition kanan ditunda ${old.name}: ${old.repositionRetryError}; retry=${old.repositionRetryCount}; posisi lama tetap terbuka`);
  return false;
 }
}

async function evaluateManualPool(r){
 const picks=await performScan({...CFG},{targetAddress:r.pool,allowOverride:!!r.overrideFailedFilters,confirmedReasons:r.confirmedReasons||[]});return picks[0];
}
async function syncCapitalState(state){
 const px=await solUsd();let changed=false;
 for(const book of Object.values(state.books||{})){
  changed=await capitalAsset.sync(book,CFG.CAPITAL_ASSET||'USDC',px,{quote:jupiterQuote,txFee:CFG.TX_FEE_SOL,log,audit:line=>paperSettings.audit(PAPER_DIR,line)})||changed;
  for(const p of multi.positions(book))if(!p.capitalAsset){p.capitalAsset='USDC';changed=true;}
 }if(changed)saveState(state,F('state.json'));return changed;
}
async function processPaperRequests(state){
 if(!CFG.PAPER||!CFG.DRY_RUN||!fs.existsSync(path.join(DIR,'STOP')))return 0;
 const audit=line=>paperSettings.audit(PAPER_DIR,line),save=s=>saveState(s,F('state.json'));
 reconcileEntryCosts(state);
 let n=paperRuns.applyPending(state,PAPER_DIR,{save,audit,log});
 n+=paperFunding.applyPending(state,PAPER_DIR,{save,audit,log});
 await syncCapitalState(state);
 n+=await paperCommands.applyPending(state,PAPER_DIR,{save,audit,log,afterCommit:async(notice,receipt)=>{
  if(!receipt.result.ok){screenRefresh.request(PAPER_DIR,{reason:'manual action rejected; update screening'});return;}
  for(const c of notice?.capitalConversions||[]){const line=`action=paper-capital-conversion manual-switch ${c.from}->${c.to} input=${c.input} output=${c.output} costUsd=${c.costUsd} basis=${c.basis}`;log(line);audit(line);}
  if(notice?.closed){const r=notice.closed;log(`[${VARIANTS[0].id}] CLOSE ${r.name} reason=${r.reason} pnlUsd=${r.pnlUsd.toFixed(4)} (manual committed) ${quotePnl.logFields(r)}`);try{telegram.notifyClose(r).catch(()=>{});}catch{}}
  if(notice?.opened){const p=notice.opened;log(`PAPER OPEN [${VARIANTS[0].id}] ${p.name}: spent ${p.usdcIn.toFixed(4)} USDC (manual committed) ${quotePnl.logFields(quotePnl.fromPosition(p))}`);try{telegram.notifyOpen({openContext:p.openContext,...quotePnl.fromPosition(p),name:p.name,pool:p.pool,quoteSymbol:p.quoteSymbol,sizeSol:p.depositSol,depositQuote:p.depositQuote,usdcIn:p.usdcIn,gasBufferSol:p.gasBufferSol,leftoverSol:p.leftoverSolAtOpen,minBinId:p.minBinId,maxBinId:p.maxBinId,rangePct:p.rangePct,entryPrice:p.entryPrice,ft30m:notice.ft30m,tvl:p.tvlUsd,bins:p.bins,activeBin:p.entryActiveBin,shape:p.shape}).catch(()=>{});}catch{}}
 },execute:async r=>{
  if(!fs.existsSync(path.join(DIR,'STOP'))||paperStopRequested())throw Error('Paper action dikunci saat live/pause');
  const b=primaryBook(state),v=VARIANTS[0];multi.migrate(b);
  if(r.type==='open'||r.type==='switch'){
   const end=Date.parse(state.meta?.endsAt);if(!Number.isFinite(end)||Date.now()>=end)throw Error('Window paper berakhir/tidak tersedia');
   if(r.type==='open'&&b.positions.length>=CFG.MAX_POSITIONS)throw Error('Slot penuh; pilih posisi yang diganti');
   const target=r.type==='switch'?b.positions.find(p=>p.pool===r.expectedPool&&p.openedAt===r.expectedOpenedAt):null;
   if(r.type==='switch'&&!target)throw Error('Posisi pilihan berubah; konfirmasi ulang');
   const p=await evaluateManualPool(r);if(!p)throw Error('Pool tidak lolos screening terbaru');
   if(multi.duplicate(b,p.address,p.token_x?.address,target))throw Error('Token (CA) atau pool sudah dibuka');
   let closed=null,capitalConversions=[];
   if(target){
    const leg=multi.view(b,target),mkt=await fetchMarket(target.pool,target.minBinId,target.maxBinId),snap=applySnapshotToPos(target,mkt);
    const val=await paperUsdc.exitQuote({pos:target,book:leg,snap,quote:jupiterQuote,txFee:CFG.TX_FEE_SOL});
    if(!val.quoted)throw Error('Quote Jupiter close gagal; posisi lama dipertahankan');
    closed=await paperClose(leg,v,'manual_switch_to_'+r.pool,snap,{},val,{silent:true});
    multi.commit(b,target,leg);
    const nc=(b.capitalConversions||[]).length;await capitalAsset.sync(b,CFG.CAPITAL_ASSET||'USDC',snap.pxUsd,{quote:jupiterQuote,txFee:CFG.TX_FEE_SOL});capitalConversions=(b.capitalConversions||[]).slice(nc);
   }
   if(b.positions.length>=CFG.MAX_POSITIONS)throw Error('Slot masih penuh; tingkatkan MAX_POSITIONS atau tutup posisi');
   const opened=await paperOpenAll(p,state,{silent:true,source:r.type,requestId:r.id,updatedBy:r.updatedBy});if(!opened.opened)throw Error(opened.skipped||'Open gagal; perubahan di-rollback');
   return {ok:true,type:r.type,pool:r.pool,name:p.name,overriddenFilters:p.manualWarnings||[],closedPnlUsd:closed?.pnlUsd,_notify:{closed,opened:b.positions.at(-1),ft30m:feeTvl(p),capitalConversions}};
  }
  const pos=b.positions.find(p=>p.pool===r.pool&&p.openedAt===r.openedAt);
  if(!pos)throw Error('Posisi sudah berubah/tutup; refresh dulu');
  const leg=multi.view(b,pos),mkt=await fetchMarket(r.pool,pos.minBinId,pos.maxBinId),snap=applySnapshotToPos(pos,mkt);
  const val=await paperUsdc.exitQuote({pos,book:leg,snap,quote:jupiterQuote,txFee:CFG.TX_FEE_SOL});
  const rec=await paperClose(leg,v,'manual_close',snap,{},val,{silent:true});
  multi.commit(b,pos,leg);
  return {ok:true,type:'close',pool:r.pool,pnlUsd:rec.pnlUsd,_notify:{closed:rec}};
 }});
 if(n){await syncCapitalState(state);writeAllHistory(state);writeOpen(state);writeSummary(state);await writePaperStatus(state);}
 return n;
}

function exitQuotePriority(p){
 const c={...CFG,...(p.strategySettings||{})},active=p.lastActiveBin,pct=p.lastLive?.pnlPct??p.lastPnlPctUsdc;
 if((Number.isFinite(pct)&&pct<=-100*(c.EMERGENCY_DROP??.2))||paperExit.staleCheck(p,{pnlPct:pct},{...c,MAX_HOURS:c.MAX_HOURS??12}).close)return 5;
 const tpEff=paperExit.effectiveTp(p,c).pct;
 if((active>p.maxBinId&&((active-p.maxBinId)>=(c.OOR_RIGHT_MIN_BINS??0)||(Number.isFinite(pct)&&pct>=(c.OOR_RIGHT_MIN_PROFIT_PCT??.5))))||(Number.isFinite(pct)&&pct>=tpEff))return 4;   // just above the range and waiting (net below take-profit) is not 'about to exit'
 if(active>=p.maxBinId-1||(Number.isFinite(pct)&&pct>=tpEff-1))return 1;
 return 0;
}
async function paperCycle(state) {
 applyPaperSettings();
 await processPaperRequests(state);
 const parent=primaryBook(state);multi.migrate(parent);reconcileEntryCosts(state);
 const meta=paperMeta(state),ended=Date.now()>=Date.parse(meta.endsAt);
 const stop=paperStopRequested()||ended,reasonStop=ended?'paper 7d window ended':'paper STOP';
 const v=VARIANTS[0],pollId=state.paperPollSequence=(state.paperPollSequence||0)+1;
 const scanFresh=!!(scan.last&&scan.picks&&scan.last.at!==state.lastScan?.at),entryRetry=!!(state.nextEntryRetryAt&&Date.now()>=state.nextEntryRetryAt),exitWaiting=parent.positions.some(p=>exitQuotePriority(p)>=4),entryWaiting=!!(!exitWaiting&&scan.last&&scan.picks?.some(p=>!multi.duplicate(parent,p.address,p.token_x?.address))&&parent.positions.length<CFG.MAX_POSITIONS&&(scanFresh||entryRetry)&&!stop&&!screenRefresh.status(PAPER_DIR,CFG,scan.last).stale);
 // A pending entry reserves quote capacity; OOR, TP, emergency and trailing still request real quotes.

 // Sequential market reads keep RPC and RAM bounded; an errored pool never blocks other exits.
 for(const original of [...parent.positions].sort((a,b)=>exitQuotePriority(b)-exitQuotePriority(a))){
  const book=multi.view(parent,original),pos=book.position;
  try{
   const mkt=await fetchMarket(pos.pool,pos.minBinId,pos.maxBinId);pos.priceUnavailablePolls=0;
   const sdkCache={},quoteCache={};
      let snap=applySnapshotToPos(pos,mkt);
      // Old positions are migrated in place; inventory/capital/open time are never reset.
      pos.quoteMint=pos.quoteMint||SOL;pos.quoteSymbol=paperUsdc.quoteSymbol(pos);pos.quoteDecimals=paperUsdc.isUsdc(pos)?6:9;
      pos.depositQuote=paperUsdc.depositQuote(pos);pos.feesCompoundedQuote=paperUsdc.compoundedQuote(pos);
      let val;
      if((entryWaiting||(pos.lastQuoteAt&&Date.now()-pos.lastQuoteAt<QUOTE_REFRESH_MS))&&snap.inRange){
       val=await paperUsdc.exitQuote({pos,book,snap,quote:async()=>({ok:false,error:'Quote capacity reserved for pending entry; on-chain mark'}),txFee:CFG.TX_FEE_SOL});
       const risk={...CFG,...(pos.strategySettings||{})};
       if(risk.TRAIL_ENABLED||val.pnlPct>=paperExit.effectiveTp(pos,risk).pct-1||val.pnlPct<=-100*(risk.EMERGENCY_DROP??.2)+1||(pos.slPlusArmed&&val.pnlPct<=Number(risk.EMERGENCY_SLPLUS_LOCK_PCT??0.1)+1))val=await paperUsdc.exitQuote({pos,book,snap,quote:jupiterQuote,txFee:CFG.TX_FEE_SOL});
      }else val=await paperUsdc.exitQuote({pos,book,snap,quote:jupiterQuote,txFee:CFG.TX_FEE_SOL});
      if(val.quoted){pos.lastQuoteAt=Date.now();if(Number.isFinite(val.tokenHaircut))pos.lastTokenHaircut=val.tokenHaircut;}   // calibration for the on-chain-mark fallback
      const policy={...CFG,...(pos.strategySettings||{})},pv={...v,n:policy.RESHAPE_N,reshape:policy.RESHAPE_ENABLED??true,compound:policy.COMPOUND_ENABLED??true}; // emergency derives from val.pnlPct (net USDC), never token-price drop
      let exitReason=paperExit.decide({pos,val,activeBin:snap.active.binId,settings:policy,pollId,stopReason:stop?reasonStop:null});
      if(!exitReason&&pv.reshape&&!stop){
        const anchor=pos.lastReshapeActiveBin??pos.entryActiveBin,down=anchor-snap.active.binId;
        if(down>=pv.n){
          try{
            const ev=await paperReshape(pos,snap,book,pv,sdkCache,{compound:pv.compound});
            if(ev?.skipped)log(`  [${v.id}] reshape skipped: ${ev.skipped} (downBins=${down}, N=${v.n})`);
            if(ev&&!ev.skipped){
              snap={...snap,value:markValue(pos.bins,snap.price,pos.feeX||0,pos.feeY||0),inv:markValue(pos.bins,snap.price,0,0)};
              val=await paperUsdc.exitQuote({pos,book,snap,quote:jupiterQuote,txFee:CFG.TX_FEE_SOL});
              exitReason=paperExit.decide({pos,val,activeBin:snap.active.binId,settings:policy,pollId});
            }
          }catch(e){log(`[${v.id}] reshape: `+e.message);}
        }
      }
      const ageH=(Date.now()-Date.parse(pos.openedAt))/3.6e6;
      const feesQuote=paperUsdc.compoundedQuote(pos)+(pos.feesCompoundedX||0)*snap.price+(pos.feeY||0)+(pos.feeX||0)*snap.price;
      const live={...quotePnl.calculate({pos,valueQuote:snap.value,solUsd:snap.pxUsd,val}),valueQuote:snap.value,quoteSymbol:paperUsdc.quoteSymbol(pos),valueUsd:val.positionValueUsd,
        valueSol:paperUsdc.isUsdc(pos)?null:snap.value,pnlSol:paperUsdc.isUsdc(pos)?null:snap.value-pos.depositQuote,
        capitalAsset:pos.capitalAsset||'USDC',pnlCapital:pos.capitalAsset==='SOL'?val.pnlCapital:val.pnlUsd,pnlCapitalPct:val.pnlPct,exitSol:val.solOut,
        pnlUsd:val.pnlUsd,pnlPct:val.pnlPct,pnlUsdcPct:pos.usdcIn?100*val.pnlUsd/(pos.initialUsdcIn||pos.usdcIn):0,exitUsdc:val.usdcOut,estimatedTokenSwapFeeRate:val.estimatedTokenSwapFeeRate,estimatedSolSwapFeeRate:val.estimatedSolSwapFeeRate,quoted:val.quoted,valuationBasis:val.valuationBasis,
        feesQuote,feesUsd:feesQuote*paperUsdc.quoteUsd(pos,snap.pxUsd)+(pos.feesCarryUsd||0),feesSol:paperUsdc.isUsdc(pos)?null:feesQuote,
        peakPnlUsd:pos.peakPnlUsd,peakPnlPctUsdc:pos.peakPnlPctUsdc,peakPnlAt:pos.peakPnlAt,oorRightPolls:pos.oorRightPolls||0,rightRepositions:pos.rightRepositions||0,
        ageH,price:snap.price,inRange:snap.inRange,share:snap.share,shape:pos.shape,reshapes:pos.reshapes||0,
        activeBin:snap.active.binId,entryActiveBin:pos.entryActiveBin,lastReshapeActiveBin:pos.lastReshapeActiveBin,
        downBins:(pos.lastReshapeActiveBin??pos.entryActiveBin)-snap.active.binId};
      live.quoteUnavailablePolls=pos.quoteUnavailablePolls||0;live.repositionRetryCount=pos.repositionRetryCount||0;
      pos.lastLive=live;
      if(snap.active.binId>pos.maxBinId&&!val.quoted)log(`quote wait ${pos.name}: ${pos.quoteUnavailablePolls}/${policy.QUOTE_FAILURE_POLLS??10} consecutive failed polls; ${pos.quoteUnavailablePolls<(policy.QUOTE_FAILURE_POLLS??10)?'hold + retry next poll':'on-chain valuation allowed for OOR decision'}; emergency basis=net ${pos.capitalAsset||'USDC'}`);
      log(`monitor [${v.id}] ${pos.name}: value=${live.valueQuote.toFixed(6)} ${live.quoteSymbol} pnlUsdc=${val.pnlUsd.toFixed(4)} pnlUsdcPct=${val.pnlPct.toFixed(4)}% exitUsdc=${val.usdcOut.toFixed(4)} peakUsd=${Number(pos.peakPnlUsd??0).toFixed(4)} quoted=${val.quoted} feesUsd=${live.feesUsd.toFixed(4)} age=${ageH.toFixed(2)}h inRange=${snap.inRange} shape=${pos.shape} active=${snap.active.binId} range=${pos.minBinId}..${pos.maxBinId} ${quotePnl.logFields(live)}`);
      if(exitReason==='oor_right_reposition'){
        const repositioned=await paperRepositionRight({...state,books:{[v.id]:book}},book,v,snap,val);
        if(repositioned&&book.position)book.position.lastLive=null;
      }else if(exitReason){
        if(!val.quoted)log(`exit fallback ${pos.name}: ${val.quoteErrors.join('; ')}; conservative paper valuation, not a Jupiter-verified TP`);
        await paperClose(book,v,exitReason,snap,quoteCache,val);
      }
  }catch(e){pos.priceUnavailablePolls=(pos.priceUnavailablePolls||0)+1;log(`monitor ${pos.name} error: ${e.message}; hold/retry (no fresh on-chain price); failedPricePolls=${pos.priceUnavailablePolls}`);}
  finally{multi.commit(parent,original,book);saveState(state,F('state.json'));}
 }
 await syncCapitalState(state);
 // Consume each completed screening exactly once, never open from an obsolete policy.
 const fresh=scan.last&&scan.picks&&(scan.last.at!==state.lastScan?.at||(state.nextEntryRetryAt&&Date.now()>=state.nextEntryRetryAt));
 if(fresh&&!screenRefresh.status(PAPER_DIR,CFG,scan.last).stale){
  state.lastScan={...scan.last,openResults:[]};state.nextEntryRetryAt=null;
  if(!stop&&!parent.positions.some(p=>exitQuotePriority(p)>=4)){
   const preferred=(parent.virtual.capitalAsset||'USDC')==='SOL'?SOL:USDC,eligible=scan.picks.filter(p=>!multi.duplicate(parent,p.address,p.token_x?.address));
   const picks=eligible.some(p=>p.token_y?.address===preferred)?eligible.filter(p=>p.token_y?.address===preferred):eligible;
   for(const p of picks){
    if(parent.positions.length>=CFG.MAX_POSITIONS)break;
    if(multi.duplicate(parent,p.address,p.token_x?.address))continue;
    // A settings write/pause during the network scan must not use stale eligibility.
    applyPaperSettings();
    if(paperStopRequested()||Date.now()>=Date.parse(meta.endsAt)||screenRefresh.status(PAPER_DIR,CFG,scan.last).stale)break;
    try{
     const result=await paperOpenAll(p,state);
     state.lastScan.openResults.push({pool:p.name,address:p.address,at:now(),...result});
     if(result.skipped){log('OPEN TERTUNDA '+p.name+': '+result.skipped+(p.entryCostEstimate?.skipCheck?'; nonref BYPASS, bukan penghalang':''));if(/Jupiter|quote|cooldown|429/i.test(result.skipped))state.nextEntryRetryAt=Math.max(Date.now()+30000,paperQuoteClient.status().blockedUntil||0);}
     if(result.opened)saveState(state,F('state.json'));
    }catch(e){log('open error: '+e.message);state.lastScan.openResults.push({pool:p.name,address:p.address,at:now(),error:e.message});if(/Jupiter|quote|cooldown|429/i.test(e.message))state.nextEntryRetryAt=Math.max(Date.now()+30000,paperQuoteClient.status().blockedUntil||0);}
   }
  }
 }
 if(stop&&allFlat(state)){const mk=path.join(PAPER_DIR,'ARCHIVE_ON_LIVE');if(fs.existsSync(mk)){   // Live ON asked: save this dry run by number, prepare run N+1
  try{let m={};try{m=JSON.parse(fs.readFileSync(mk,'utf8'));}catch{}
   const res=paperRuns.archiveForLive(state,PAPER_DIR,{save:s=>saveState(s,F('state.json')),audit:l=>{try{paperSettings.audit(PAPER_DIR,l);}catch{}},log,endedBy:'live-on',nextModal:m.nextModal});
   if(res.ok){fs.unlinkSync(mk);log('dry run disimpan sebagai run #'+res.run+' ('+res.archived+'); run berikutnya #'+res.newRun+' siap setelah Live OFF');}else log('arsip dry run untuk Live ON ditunda: '+res.error);
  }catch(e){log('arsip dry run untuk Live ON gagal (diulang): '+e.message);}
 }}
 writeAllHistory(state);writeOpen(state);writeSummary(state);
 await writePaperStatus(state);await writeLiveStatusPointer(state);saveState(state,F('state.json'));
 if(ended&&allFlat(state)){
  fs.writeFileSync(path.join(PAPER_DIR,'ENDED'),wib()+'\n');
  try{telegram.notifyWindowEnd(telegram.statusFromState(state)).catch(()=>{});}catch{}
 }
 try{telegram.maybeDailySummary(telegram.statusFromState(state)).catch(()=>{});}catch{}
 return stop&&allFlat(state);
}

// ---------- live (guarded) helpers kept for a future approved start ----------
function addPriority(tx) {
  const has = tx.instructions.some((i) => i.programId.equals(ComputeBudgetProgram.programId) && i.data[0] === 3);
  if (!has) tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CFG.PRIORITY_MICROLAMPORTS }));
  return tx;
}
async function send(tx, signers, label) {
  if (CFG.PAPER || CFG.DRY_RUN || process.env.LIVE_CONFIRMED !== '1') {
    throw new Error('send() blocked: paper/dry-run or LIVE_CONFIRMED missing');
  }
  addPriority(tx);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash; tx.feePayer = wallet.publicKey; tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 5 });
  const c = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  if (c.value.err) throw new Error(`${label} failed ${sig} ${JSON.stringify(c.value.err)}`);
  log(`  tx ${label} confirmed ${sig}`);
  return sig;
}

async function liveOpen(p, state, opts = {}) {
  // Same open-time guards as the dry run (paperOpenSingle / paperOpenUsdc); nothing has been sent yet when any of them rejects.
  const policy = { ...CFG, ...(opts.strategySettings || {}) };   // a reposition keeps the settings the position was opened with, like paperOpenSingle
  if (opts.source !== 'reposition' && CFG.SL_BLACKLIST_ENABLED !== false && slBlacklist.has(PAPER_DIR, p.token_x?.address)) { log('OPEN ditolak ' + p.name + ': SL blacklist'); return { skipped: 'SL blacklist: token pernah kena stop loss' }; }
  { const why = entryPolicy.cooldownReason(state.history || [], p.address, CFG.REOPEN_COOLDOWN_MIN); if (why) { log('OPEN ditolak ' + p.name + ': ' + why); return { skipped: why }; } }
  if (CFG.MAX_LIQ_USD > 0 && p.tvl > CFG.MAX_LIQ_USD) { const why = `tvl>$${CFG.MAX_LIQ_USD}`; log('OPEN ditolak ' + p.name + ': ' + why); return { skipped: why }; }
  { const why = entryCost.rejection(p.entryCostEstimate, CFG.MAX_NONREFUND_SOL ?? .05); if (why) { log('OPEN ditolak: ' + p.name + ' ' + why); return { skipped: why }; } }   // MAX_NONREFUND_SOL
  const dlmm = await DLMM.create(conn, new PublicKey(p.address));
  const active = await dlmm.getActiveBin();
  const binStep = Number(p.pool_config.bin_step);
  // Entry geometry = the dry run's (live-geometry.js -> strategy.geometry): the range includes the active bin plus UPPER_BUFFER_BINS above it.
  let plan;
  try { plan = liveGeometry.planEntry({ strategy, binStep, activeBinId: active.binId, policy, maxBins: MAX_BINS }); }
  catch (e) { return { skipped: 'geometry: ' + e.message }; }
  const { minBinId, maxBinId } = plan;
  const priceUi = +dlmm.fromPricePerLamport(+active.price);
  let quote = { positionCost: 0, binArrayCost: 0, bitmapExtensionCost: 0, positionReallocCost: 0 };
  try { quote = await dlmm.quoteCreatePosition({ strategy: { minBinId, maxBinId, strategyType: StrategyType.Spot } }); }
  catch (e) { log('quoteCreatePosition failed: ' + e.message); }
  const rentRef = (quote.positionCost || 0) + (typeof TOKEN_ACCOUNT_FEE === 'number' ? TOKEN_ACCOUNT_FEE : 0.00203928);
  const rentNon = (quote.binArrayCost || 0) + (quote.bitmapExtensionCost || 0);
  const px = await solUsd();
  if (!(px > 0)) return { skipped: 'sol usd unavailable' };
  const usdcBal = await liveUsdcBal(wallet.publicKey);
  const solBal = await realSolBal(wallet.publicKey);
  if (p.token_y?.address === USDC) return liveOpenUsdcPool({ p, state, opts, policy, dlmm, active, binStep, plan, priceUi, rentRef, rentNon, px, usdcBal, solBal });   // USDC-quoted pool: same plan as paperOpenUsdc
  const gasPlan = paperCap.computeGasBufferSol({
    rentRefundable: rentRef, rentNonRefundable: rentNon, txFee: CFG.TX_FEE_SOL, floor: CFG.GAS_BUFFER_SOL,
  });
  const extraSol = gasPlan.buffer;
  const spend = paperCap.planOpenSpend({
    usdcCash: Math.min(usdcBal, opts.positionBudgetUsdc ?? (CFG.POSITION_USDC > 0 ? CFG.POSITION_USDC : usdcBal)), usdcBuffer: CFG.USDC_BUFFER, capUsd: (p.tvl || 0) * CFG.MAX_POS_TVL_FRAC, extraSol, solUsd: px,
  });
  log(`open plan ${p.name}: bins ${minBinId}..${maxBinId}, USDC=${usdcBal.toFixed(2)} SOL=${solBal.toFixed(4)} extraSol=${extraSol.toFixed(4)} solUsd=${px.toFixed(2)}${spend.ok ? ` usdcToSwap=${spend.usdcToSwap.toFixed(2)}` : ' SKIP ' + spend.why}`);
  if (!spend.ok) return { skipped: spend.why, spend };
  if (solBal < liveControl.MIN_LIVE_SOL) return { skipped: 'insufficient SOL fee reserve', solBal };
  if (CFG.DRY_RUN) return { dry: true, skipped: 'dry-run does not open a live position; use PAPER=1 for paper trades or Go Live from the mini app' };
  const swapIn = await jupiterSwapLive(USDC, SOL, BigInt(Math.floor(spend.usdcToSwap * 1e6)), 6, 9, 'usdc-to-sol-open');
  if (!swapIn.ok || !(swapIn.outUi > 0)) return { skipped: 'usdc->sol swap failed', error: swapIn.error };
  const openFees = 2 * CFG.TX_FEE_SOL;
  const alloc = paperCap.allocateOpenSol(swapIn.outUi, { rentRef, rentNon, openFees, extraSol });
  if (!alloc.ok) return { skipped: alloc.why };
  const capSol = ((p.tvl || 0) * CFG.MAX_POS_TVL_FRAC) / px;
  let deposit = alloc.deposit;
  if (deposit > capSol) deposit = capSol;
  const sizing = { want: spend.usdcForPosition / px, actual: deposit, capped: spend.capped, tvlUsd: p.tvl, capUsd: (p.tvl || 0) * CFG.MAX_POS_TVL_FRAC, solUsd: px };
  const posKp = Keypair.generate();
  const balBefore = solBal;
  const recordPosition = () => {
    state.position = { pool: p.address, name: p.name, mintX: p.token_x.address, decX: p.token_x.decimals, position: posKp.publicKey.toBase58(), minBinId, maxBinId, openedAt: now(), entryPrice: priceUi, depositSol: sizing.actual, sizeWant: sizing.want, tvlCapped: sizing.capped, walletBefore: balBefore, usdcIn: swapIn.inUi, solBought: swapIn.outUi, gasBufferSol: extraSol, stage: 'spot', rentPaidSol: rentRef + rentNon, rentRefundableSol: rentRef, spotSol: sizing.actual / 2, bidaskSol: sizing.actual / 2,
      // everything the shared exit policy needs (same fields the dry run keeps on a position)
      tvlUsd: p.tvl, binStep, entryActiveBin: active.binId, capitalAsset: 'USDC', quoteMint: SOL, initialUsdcIn: swapIn.inUi, leftoverSol: alloc.reserve,
      baseFeePct: p.pool_config?.base_fee_pct ?? p.pool_config?.base_fee_percentage ?? null, strategySettings: opts.strategySettings || strategy.snapshot(CFG), openSource: opts.source || 'scan' };
    Object.assign(state.position, { spotSol: sizing.actual * plan.split, bidaskSol: sizing.actual * (1 - plan.split), upperBufferBins: plan.upper, nBins: plan.width, origMinBinId: minBinId, origMaxBinId: maxBinId, shape: 'open-' + String(CFG.OPEN_SHAPE || 'MIXED').toLowerCase() });
  };
  const dep = await liveOpenExec.openDeposit({
    dlmm, plan, actualSol: sizing.actual, posKp, wallet, send, BN, StrategyType, lamports: LAMPORTS_PER_SOL, slippage: CFG.SLIPPAGE_PCT, log,
    onCreated: async ({ update }) => { if (!update) recordPosition(); saveState(state, path.join(DIR, 'state.json')); },
  });
  if (dep.complete) state.position.stage = 'full';
  else { state.position.depositSol = dep.depositedLamports / LAMPORTS_PER_SOL; state.position.spotSol = Math.min(state.position.spotSol, state.position.depositSol); state.position.bidaskSol = Math.max(0, state.position.depositSol - state.position.spotSol); }
  saveState(state, path.join(DIR, 'state.json'));
  return { opened: true, complete: dep.complete, width: plan.width, wide: plan.wide };
}

// USDC-quoted pool == paperOpenUsdc: the quote side IS USDC (no USDC->SOL conversion for the deposit); only the native SOL buffer for rent/fees is bought.
// Sizing uses the SAME planner as the dry run (paper-usdc.planUsdcOpen) with the real Jupiter quote.
async function liveOpenUsdcPool({ p, state, opts, policy, dlmm, active, binStep, plan, priceUi, rentRef, rentNon, px, usdcBal, solBal }) {
  const { minBinId, maxBinId } = plan, openFees = 2 * CFG.TX_FEE_SOL;
  const gas = paperCap.computeGasBufferSol({ rentRefundable: rentRef, rentNonRefundable: rentNon, txFee: CFG.TX_FEE_SOL, floor: policy.GAS_BUFFER_SOL ?? CFG.GAS_BUFFER_SOL });
  const pl = await paperUsdc.planUsdcOpen({ cash: Math.min(usdcBal, opts.positionBudgetUsdc ?? (CFG.POSITION_USDC > 0 ? CFG.POSITION_USDC : usdcBal)), existingSol: 0, capUsd: (p.tvl || 0) * ((policy.MAX_POSITION_TVL_PCT ?? 5) / 100),
    gasBuffer: gas.buffer, rentRef, rentNon, openFees, solUsd: px, usdcBuffer: CFG.USDC_BUFFER, quote: jupiterQuote });
  log(`open plan ${p.name} (USDC pool): bins ${minBinId}..${maxBinId}, USDC=${usdcBal.toFixed(2)} SOL=${solBal.toFixed(4)} ${pl.ok ? `deposit=${pl.depositQuote.toFixed(2)} USDC gasUsdc=${pl.gasUsdc.toFixed(2)}` : 'SKIP ' + pl.why}`);
  if (!pl.ok) return { skipped: pl.why };
  if (solBal < liveControl.MIN_LIVE_SOL) return { skipped: 'insufficient SOL fee reserve', solBal };
  if (CFG.DRY_RUN) return { dry: true, skipped: 'dry-run does not open a live position; use PAPER=1 for paper trades or Go Live from the mini app' };
  let bought = 0;
  if (pl.gasUsdc > 0) {
    const sw = await jupiterSwapLive(USDC, SOL, BigInt(Math.floor(pl.gasUsdc * 1e6)), 6, 9, 'usdc-to-sol-gas-open');
    if (!sw.ok || !(sw.outUi > 0)) return { skipped: 'usdc->sol gas swap failed', error: sw.error };
    bought = sw.outUi;
  }
  const reserve = bought - rentRef - rentNon - openFees;
  if (reserve < 3 * CFG.TX_FEE_SOL) return { skipped: 'native buffer cannot cover rent + open + close fees', bought };
  const posKp = Keypair.generate(), balBefore = solBal, usdcIn = pl.depositQuote + pl.gasUsdc;
  const recordPosition = () => {
    state.position = { pool: p.address, name: p.name, mintX: p.token_x.address, decX: p.token_x.decimals, position: posKp.publicKey.toBase58(), minBinId, maxBinId, openedAt: now(), entryPrice: priceUi, depositSol: pl.depositQuote, tvlCapped: pl.depositQuote >= (p.tvl || 0) * ((policy.MAX_POSITION_TVL_PCT ?? 5) / 100) - 1e-6, walletBefore: balBefore, usdcIn, solBought: bought, gasBufferSol: gas.buffer, stage: 'spot', rentPaidSol: rentRef + rentNon, rentRefundableSol: rentRef,
      tvlUsd: p.tvl, binStep, entryActiveBin: active.binId, capitalAsset: 'USDC', quoteMint: USDC, quoteSymbol: 'USDC', quoteDecimals: 6, depositQuote: pl.depositQuote, initialUsdcIn: usdcIn, leftoverSol: reserve,
      baseFeePct: p.pool_config?.base_fee_pct ?? p.pool_config?.base_fee_percentage ?? null, strategySettings: opts.strategySettings || strategy.snapshot(CFG), openSource: opts.source || 'scan' };
    Object.assign(state.position, { spotQuote: pl.depositQuote * plan.split, bidaskQuote: pl.depositQuote * (1 - plan.split), upperBufferBins: plan.upper, nBins: plan.width, origMinBinId: minBinId, origMaxBinId: maxBinId, shape: 'open-' + String(policy.OPEN_SHAPE || 'MIXED').toLowerCase() });
  };
  const dep = await liveOpenExec.openDeposit({ dlmm, plan, actualSol: pl.depositQuote, posKp, wallet, send, BN, StrategyType, lamports: 1e6, slippage: CFG.SLIPPAGE_PCT, log,
    onCreated: async ({ update }) => { if (!update) recordPosition(); saveState(state, path.join(DIR, 'state.json')); } });
  if (dep.complete) state.position.stage = 'full';
  else { state.position.depositSol = dep.depositedLamports / 1e6; state.position.depositQuote = state.position.depositSol; }
  saveState(state, path.join(DIR, 'state.json'));
  return { opened: true, complete: dep.complete, usdcPool: true, width: plan.width, wide: plan.wide };
}

async function liveValuation(pos) {
  const dlmm = await DLMM.create(conn, new PublicKey(pos.pool));
  const p = await dlmm.getPosition(new PublicKey(pos.position));
  const active = await dlmm.getActiveBin();
  const price = +dlmm.fromPricePerLamport(+active.price);
  const dX = 10 ** dlmm.tokenX.mint.decimals, dY = 10 ** dlmm.tokenY.mint.decimals, d = p.positionData;   // quote decimals: 9 for SOL pools, 6 for USDC pools
  const x = +d.totalXAmount / dX, y = +d.totalYAmount / dY, fx = +d.feeX.toString() / dX, fy = +d.feeY.toString() / dY;
  const value = y + x * price + fy + fx * price;
  return { dlmm, p, price, x, y, fx, fy, fees: fy + fx * price, value, pnl: value / pos.depositSol - 1, activeBinId: active.binId, inRange: active.binId >= d.lowerBinId && active.binId <= d.upperBinId };
}


async function liveSwapAllToSol(mintX) {
  const mint = new PublicKey(mintX);
  const accs = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, { mint });
  const amt = accs.value.reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
  if (amt === 0n) { log('  no leftover token to swap'); return; }
  const q = await jupiterQuote(mintX,SOL,amt,accs.value[0].account.data.parsed.info.tokenAmount.decimals,9);
  if(!q.ok)throw Error('Jupiter token close quote failed: '+q.error);
  log(`  jupiter quote: ${amt} raw token -> ${(+q.outAmount / 1e9).toFixed(5)} SOL, impact=${q.priceImpactPct}`);
  if (CFG.DRY_RUN || CFG.PAPER || process.env.LIVE_CONFIRMED !== '1') return;
  const s = await jupGetJSON('https://lite-api.jup.ag/swap/v1/swap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quoteResponse: q, ...swapRoute.swapBodyParams(q), userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto' }) });
  const vtx = VersionedTransaction.deserialize(Buffer.from(s.swapTransaction, 'base64')); vtx.sign([wallet]);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const sig = await conn.sendRawTransaction(vtx.serialize(), { maxRetries: 5 });
  const c = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  if (c.value.err) throw new Error('jupiter swap failed ' + sig); log('  tx jupiter-swap confirmed ' + sig);
  try {
    for (const a of accs.value) {
      const tx = new Transaction().add(createCloseAccountInstruction(a.pubkey, wallet.publicKey, wallet.publicKey, [], a.account.owner));
      await send(tx, [wallet], 'close-ata');
    }
  } catch (e) { log('  close ATA skipped: ' + e.message); }
}

async function liveClose(state, reason, opts = {}) {
  const pos = state.position;
  const v = await liveValuation(pos);
  log(`CLOSE ${pos.name} reason=${reason} pnl=${(v.pnl * 100).toFixed(2)}% value=${v.value.toFixed(4)} SOL`);
  if (CFG.DRY_RUN || CFG.PAPER) throw new Error('liveClose called in dry/paper');
  const solBeforeRemove = await realSolBal(wallet.publicKey);
  const txs = await v.dlmm.removeLiquidity({ user: wallet.publicKey, position: new PublicKey(pos.position), fromBinId: v.p.positionData.lowerBinId, toBinId: v.p.positionData.upperBinId, bps: new BN(10000), shouldClaimAndClose: true });
  for (const [i, tx] of txs.entries()) await send(tx, [wallet], `remove-claim-close ${i + 1}/${txs.length}`);
  await sleep(3000);
  const receivedSol = (await realSolBal(wallet.publicKey)) - solBeforeRemove;   // quote side (SOL pools) + refunded rent - close fees
  // Swap back exactly like the dry run (paper-usdc.exitQuote): token -> USDC directly, then the position's whole SOL pile -> USDC.
  const sb = await liveCloseExec.swapBack({
    pos, sleep, log, pileSol: (pos.quoteMint === USDC ? 0 : 0) + Math.max(0, (pos.leftoverSol || 0) + receivedSol),
    getUsdcBalance: () => liveUsdcBal(wallet.publicKey),
    getSolBalance: () => realSolBal(wallet.publicKey),
    getToken: async () => { const accs = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(pos.mintX) }); const raw = accs.value.reduce((t, a) => t + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n); return { raw, decimals: accs.value[0]?.account.data.parsed.info.tokenAmount.decimals ?? pos.decX, accounts: accs.value }; },
    swapTokenToUsdc: (raw, dec) => jupiterSwapLive(pos.mintX, USDC, raw, dec, 6, 'token-to-usdc-close'),
    swapSolToUsdc: raw => jupiterSwapLive(SOL, USDC, raw, 9, 6, 'sol-pile-to-usdc-close'),
    closeTokenAccounts: async tok => { for (const a of tok.accounts) await send(new Transaction().add(createCloseAccountInstruction(a.pubkey, wallet.publicKey, wallet.publicKey, [], a.account.owner)), [wallet], 'close-ata'); },
  });
  if (!sb.complete) log('  ERROR swap back incomplete, leftover stays in the wallet: ' + sb.errors.join(' | '));
  const after = await realSolBal(wallet.publicKey);
  const afterUsdc = sb.usdcAfter;
  const realized = after - pos.walletBefore;
  const basisUsdc = pos.initialUsdcIn || pos.usdcIn, pnlUsd = sb.usdcOut - basisUsdc, pnlPct = basisUsdc > 0 ? 100 * pnlUsd / basisUsdc : 0;   // same definition as paperClose
  log(`  USDC out ${sb.usdcOut.toFixed(4)} for ${basisUsdc.toFixed(4)} in: ${pnlUsd.toFixed(4)} USDC (${pnlPct.toFixed(3)}%); wallet SOL back to ${after.toFixed(4)} (was ${pos.walletBefore.toFixed(4)} before the position)`);
  // SL blacklist: record every stop-loss close by token mint, exactly like paperClose (the rule controls skipping at screening/open).
  if (!opts.intermediate && slBlacklist.isStopLoss(reason)) { try { if (slBlacklist.add(PAPER_DIR, { mint: pos.mintX, symbol: pos.name, pool: pos.pool, reason, closedAt: now(), source: 'auto' })) log('SL blacklist add ' + pos.name + ' ' + pos.mintX); } catch (e) { log('SL blacklist add failed: ' + e.message); } }
  const row = { ...pos, closedAt: now(), reason, estPnlPct: +(v.pnl * 100).toFixed(2), estValueSol: +v.value.toFixed(5), feesSol: +v.fees.toFixed(5), realizedSol: +realized.toFixed(5), usdcIn: basisUsdc, usdcOut: sb.usdcOut, legUsdcIn: pos.usdcIn, legUsdcOut: sb.usdcOut, pnlUsd, pnlPct, netPnlUsd: pnlUsd, netPnlPct: pnlPct, pnlCapital: pnlUsd, pnlCapitalPct: pnlPct, solPile: sb.solPile, swapBackComplete: sb.complete, swapBackErrors: sb.errors };
  if (!opts.intermediate) { state.history.push(row); state.position = null; saveState(state, path.join(DIR, 'state.json')); }
  log(`  closed${opts.intermediate ? ' (reposition leg)' : ''}. wallet ${after.toFixed(4)} SOL, USDC ${afterUsdc.toFixed(2)}`);
  return { usdcOut: sb.usdcOut, row };
}

// ---------- status ----------
async function writeLiveStatusPointer(state, extra = {}) {
  // Refresh root status.json with live wallet balance + paper pointer; do not wipe history.
  let root;
  try { root = JSON.parse(fs.readFileSync(path.join(DIR, 'status.json'), 'utf8')); }
  catch { root = {}; }
  let bal = null;
  try { bal = await realSolBal(); } catch (e) { log('status real balance: ' + e.message); }
  const next = {
    ...root,
    updated: now(), updatedWib: wib(),
    dryRun: CFG.DRY_RUN,
    paper: CFG.PAPER,
    wallet: REAL_WALLET,
    solBalance: bal,
    solBalanceNote: 'on-chain balance of the bot wallet (read-only)',
    rpc: CFG.RPC.replace(/\?.*/, '?…'),
    config: {
      ...(root.config || {}),
      positionSol: CFG.POSITION_SOL, positionUsd: CFG.POSITION_USD || null,
      reserveSol: CFG.RESERVE_SOL, tp: CFG.TP, maxHours: CFG.MAX_HOURS,
      shape: '50% Spot + 50% BidAsk (left); reshape to M (token Bid-Ask on the right, quote left kept)',
      range: 'active-1 .. -50%', ar: 'off',
      reshape: CFG.RESHAPE, minLiqUsd: CFG.MIN_LIQ_USD, minAgeH: CFG.MIN_AGE_H, maxPosTvlFrac: CFG.MAX_POS_TVL_FRAC,
      maxPump24h: CFG.MAX_PUMP_24H, emergencyDrop: CFG.EMERGENCY_DROP, rugcheck: CFG.RUGCHECK,
    },
    paperRun: CFG.PAPER ? {
      running: true,
      dir: PAPER_DIR,
      startedWib: state.meta?.startedWib,
      endsWib: state.meta?.endsWib,
      virtualBalanceSol: primaryBook(state)?.virtual?.cash,
      variants: VARIANTS.map((v) => v.id),
      summary: path.join(PAPER_DIR, 'summary.json'),
      stopHow: 'touch /workspace/lp-bot/paper/STOP  (do not remove /workspace/lp-bot/STOP)',
    } : (root.paperRun || null),
    lastScan: CFG.PAPER ? undefined : (state.lastScan || root.lastScan),
    closedTrades: root.closedTrades || [],
    totalRealizedSol: root.totalRealizedSol,
    ...extra,
  };
  // never let paper overwrite live trade history
  if (root.closedTrades) next.closedTrades = root.closedTrades;
  if (!CFG.PAPER) { const ps = livePositions.list(state); next.positions = ps; if (root.position || ps.length) next.position = ps[0] || null; }
  fs.writeFileSync(path.join(DIR, 'status.json'), JSON.stringify(next, null, 2));
}

async function writePaperStatus(state, extra = {}) {
  const st = {
    updated: now(), updatedWib: wib(), paper: true, dryRun: true,
    walletReal: REAL_WALLET,
    realSolBalance: extra.realSol ?? null,
    virtualUsdc: primaryBook(state)?.virtual?.usdc,
    leftoverSol: primaryBook(state)?.virtual?.sol,
    config: {
      paperUsdc: CFG.PAPER_USDC, usdcBuffer: CFG.USDC_BUFFER, gasBufferSol: CFG.GAS_BUFFER_SOL,
      positionSol: CFG.POSITION_SOL, reserveSol: CFG.RESERVE_SOL, tp: CFG.TP,tpUsdPct:CFG.TP_USD_PCT,oorRightClose:CFG.OOR_RIGHT_CLOSE,trailingEnabled:CFG.TRAIL_ENABLED,oorMaxMin:CFG.OOR_MAX_MIN,maxHours: CFG.MAX_HOURS,
      minLiqUsd: CFG.MIN_LIQ_USD, minAgeH: CFG.MIN_AGE_H, ftWindow: CFG.FT_WINDOW, minFt: CFG.MIN_FT, maxPosTvlFrac: CFG.MAX_POS_TVL_FRAC,
      maxPump24h: CFG.MAX_PUMP_24H, volSpike1hOf24h: CFG.VOL_SPIKE_1H_OF_24H,
      emergencyDrop: CFG.EMERGENCY_DROP, rugcheck: CFG.RUGCHECK, maxTop10Hold: CFG.MAX_TOP10_HOLD,
      maxDevHold: CFG.MAX_DEV_HOLD,
      shapeInitial: '50% Spot + 50% Bid-Ask; quote below/on active; token only if UPPER_BUFFER_BINS>0 (default 0 = quote only)',
      shapeAfterReshape: 'M: left quote kept as-is + compounded quote fees; right token-only Bid-Ask heavier at far right',
      reshapeTrigger: 'active bin down N since last reshape or entry',
      variants: VARIANTS.map((v) => ({ id: v.id, n: v.n, reshape: v.reshape, compound: v.compound })),
      ar: 'off',
    },
    meta: state.meta,
    strategy: VARIANTS[0] && { id: VARIANTS[0].id, n: VARIANTS[0].n, reshape: VARIANTS[0].reshape, compound: VARIANTS[0].compound },
    positions: multi.positions(primaryBook(state)).map(publicPos),
    openCount:multi.positions(primaryBook(state)).length,maxPositions:CFG.MAX_POSITIONS,
    position: publicPos(multi.positions(primaryBook(state))[0]),
    lastScan: state.lastScan,
    ...extra,
  };
  fs.writeFileSync(F('status.json'), JSON.stringify(st, null, 2));
}

async function liveUsdcBal(pk) {
  const owner = pk || (wallet && wallet.publicKey);
  if (!owner) return 0;
  try {
    const accs = await conn.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(USDC) });
    const raw = accs.value.reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
    return Number(raw) / 1e6;
  } catch (e) {
    log('usdc balance: ' + e.message);
    return 0;
  }
}

async function jupiterSwapLive(inputMint, outputMint, rawAmount, inDec, outDec, label) {
  const raw = typeof rawAmount === 'bigint' ? rawAmount : BigInt(Math.max(0, Math.floor(Number(rawAmount) || 0)));
  if (raw === 0n) return { ok: true, skipped: 'zero', inUi: 0, outUi: 0 };
  const q = await jupiterQuote(inputMint, outputMint, raw, inDec, outDec);
  if (!q.ok) return { ok: false, error: q.error };
  log(`  jupiter ${label}: ${q.inUi} -> ${q.outUi} (quote)`);
  if (CFG.DRY_RUN || CFG.PAPER || process.env.LIVE_CONFIRMED !== '1') {
    return { ok: true, dry: true, inUi: q.inUi, outUi: q.outUi, quote: q };
  }
  const s = await jupGetJSON('https://lite-api.jup.ag/swap/v1/swap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: q,
      ...swapRoute.swapBodyParams(q),
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
  });
  const vtx = VersionedTransaction.deserialize(Buffer.from(s.swapTransaction, 'base64'));
  vtx.sign([wallet]);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const sig = await conn.sendRawTransaction(vtx.serialize(), { maxRetries: 5 });
  const c = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  if (c.value.err) throw new Error(`${label} swap failed`);
  log(`  tx jupiter-${label} confirmed ${sig}`);
  return { ok: true, inUi: q.inUi, outUi: q.outUi, sig };
}

async function livePositionCycle(state, stop) {
  const v = await liveValuation(state.position);
  const ageH = (Date.now() - Date.parse(state.position.openedAt)) / 3.6e6;
  const live = { valueSol: +v.value.toFixed(5), pnlSol: +(v.value - state.position.depositSol).toFixed(5), pnlPct: +(v.pnl * 100).toFixed(2), feesSol: +v.fees.toFixed(5), ageH: +ageH.toFixed(2), price: v.price, inRange: v.inRange };
  state.position.lastActiveBin = v.activeBinId;   // exitQuotePriority() reads it, like the dry run
  log(`monitor ${state.position.name}: value=${live.valueSol} SOL pnl=${live.pnlPct}% fees=${live.feesSol} age=${live.ageH}h inRange=${v.inRange}`);
  // Same decision code as the dry run (live-exit.js -> paper-usdc.exitQuote + paper-exit-policy.decide). Only the executor (liveClose) is live-specific.
  let exitReason = stop ? 'STOP file' : null, decisionVal = null;
  if (!stop) {
    try {
      const pollId = state.livePollSequence = (state.livePollSequence || 0) + 1;
      const r = await liveExit.decideLiveExit({ pos: state.position, v, pxUsd: await solUsd(), quote: jupiterQuote, txFee: CFG.TX_FEE_SOL, CFG, pollId });
      live.pnlUsdcPct = +r.val.pnlPct.toFixed(2); live.pnlUsd = +r.val.pnlUsd.toFixed(2); live.quoted = !!r.val.quoted;
      exitReason = r.reason; decisionVal = r.val; state.position.lastLive = { pnlPct: live.pnlUsdcPct };
    } catch (e) { log('exit decision error (position held, retry next poll): ' + e.message); }
    if (exitReason === 'oor_right_reposition') {
      exitReason = null;
      try {
        const rr = await liveRepositionExec.reposition({ state, val: decisionVal, settings: { ...CFG, ...(state.position.strategySettings || {}) }, pxUsd: await solUsd(),
          deps: { log, fetchPool, sanityReason: screenSource.sanityReason, closeLeg: s2 => liveClose(s2, 'oor_right_reposition_leg', { intermediate: true }), openNew: (pool, o) => liveOpen(pool, state, o) } });
        saveState(state, path.join(DIR, 'state.json'));
        if (rr.done) return live;
      } catch (e) { log('reposition error (position held if still open, retry next poll): ' + e.message); }
    }
    // Reshape / compound: same trigger, guard and steps as paperReshape (live-reshape-exec.js). Runs only when the exit policy did not close the position.
    if (!exitReason) {
      try {
        const pos0 = state.position, pol = { ...CFG, ...(pos0.strategySettings || {}) };
        const tokRaw = async () => { const accs = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(pos0.mintX) }); return accs.value.reduce((t, a) => t + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n); };
        const rctx = { pos: pos0, positionKey: new PublicKey(pos0.position), slippage: CFG.SLIPPAGE_PCT, dlmm: v.dlmm, positionData: v.p.positionData, activeBinId: v.activeBinId, settings: pol, txFee: CFG.TX_FEE_SOL, StrategyType, BN, wallet, send, getTokenRaw: tokRaw, getSolBalance: () => realSolBal(wallet.publicKey), sleep, log };
        if (pos0.reshapePending) { await liveReshapeExec.resumePending(rctx); log('  reshape: interrupted token re-add finished'); saveState(state, path.join(DIR, 'state.json')); }
        const trg = liveReshapeExec.trigger({ pos: pos0, activeBinId: v.activeBinId, settings: pol, stop });
        if (trg.due) {
          const ev = await liveReshapeExec.reshape(rctx);
          if (ev.skipped) log(`  reshape skipped: ${ev.skipped} (downBins=${trg.down}, N=${trg.n})`);
          else {
            pos0.reshapes = (pos0.reshapes || 0) + 1; pos0.lastReshapeActiveBin = v.activeBinId; pos0.networkFeesSol = (pos0.networkFeesSol || 0) + ev.txCost; pos0.leftoverSol = Math.max(0, (pos0.leftoverSol || 0) - ev.txCost);
            pos0.feesCompoundedQuote = (pos0.feesCompoundedQuote || 0) + (ev.compounded || 0); pos0.feesCompoundedX = (pos0.feesCompoundedX || 0) + (ev.feeXAdded || 0);
            pos0.shape = pol.RESHAPE_SHAPE === 'SPOT' ? 'reshape-spot' : 'M-double-bidask';
            saveState(state, path.join(DIR, 'state.json'));
            log(`  RESHAPE #${pos0.reshapes} ${pos0.name}: right=${ev.range.rightMin}..${ev.range.rightMax} token re-add X=${ev.amountX} compounded=${(ev.compounded || 0).toFixed(6)} ${ev.errors.length ? 'ERRORS: ' + ev.errors.join(' | ') : ''}`);
            // like the dry run: re-value after the reshape and decide again with the same policy
            const v2 = await liveValuation(pos0), pollId2 = state.livePollSequence = (state.livePollSequence || 0) + 1;
            const r2 = await liveExit.decideLiveExit({ pos: pos0, v: v2, pxUsd: await solUsd(), quote: jupiterQuote, txFee: CFG.TX_FEE_SOL, CFG, pollId: pollId2 });
            exitReason = r2.reason === 'oor_right_reposition' ? null : r2.reason;
          }
        }
      } catch (e) { log('reshape error (position held, retry next poll): ' + e.message); }
    }
  }
  if (exitReason) await liveClose(state, exitReason);
  else saveState(state, path.join(DIR, 'state.json'));   // persist peak / TP-emergency / SL+ state exactly like the dry run
  return live;
}

async function liveCycle(state) {
  applyPaperSettings();
  const stop = fs.existsSync(path.join(DIR, 'STOP'));
  const noNew = fs.existsSync(path.join(DIR, 'NO_NEW'));
  state.positions = livePositions.list(state).slice(); state.position = null; state.__active = null;
  const lives = [];
  for (const pos of [...state.positions]) {
    try { const live = await livePositions.withPos(state, pos, () => livePositionCycle(state, stop)); if (live) lives.push(live); }
    catch (e) { log(`position cycle error ${pos.name} (held, retry next poll): ${e.message}`); }
  }
  saveState(state, path.join(DIR, 'state.json'));
  if (state.positions.length) await writeLiveStatusPointer(state, { live: lives[0], lives });
  if (stop) { if (state.positions.length) return false; log('STOP file present, no position -> exiting'); await writeLiveStatusPointer(state); return true; }   // exit only when flat
  if (noNew) {
    log('NO_NEW present: not opening a new live position (existing holds would still be managed)');
    await writeLiveStatusPointer(state, { noNew: true });
    return false;
  }
  if (state.positions.length >= CFG.MAX_POSITIONS) { await writeLiveStatusPointer(state, { lives }); return false; }   // slots full, like the dry run
  if (state.positions.some(p => exitQuotePriority(p) >= 4)) { log('a position is about to exit: not opening a new one this poll (same gate as the dry run)'); await writeLiveStatusPointer(state, { lives }); return false; }
  scan.liveHistory = state.history || []; scan.liveOpen = state.positions;   // same cooldown / TVL-drop inputs as the dry run, from live's own trades
  const picks = await scan();
  state.lastScan = { at: now(), fetched: scan.last?.fetched, basic: scan.last?.basic, rejects: scan.last?.rejects || null, candidates: picks.map((p) => ({ name: p.name, address: p.address, ftWindow: CFG.FT_WINDOW, ft: feeTvl(p), ft30m: feeTvl(p, '30m'), ft1h: feeTvl(p, '1h'), tvl: p.tvl, binStep: p.pool_config.bin_step, pump1h: p.pump1h, pump24h: p.pump24h, top10: p.top10 })) };
  if (!picks.length) log('no candidate passes all filters');
  const sel = livePositions.selectPicks({ picks, positions: state.positions, max: CFG.MAX_POSITIONS, preferredMint: USDC });   // capital is USDC: prefer USDC-quoted pools when any exist, like the paper cycle
  state.lastScan.openResults = [];
  for (const p of sel.chosen) {
    if (state.positions.length >= CFG.MAX_POSITIONS) break;
    if (livePositions.duplicate(state.positions, p.address, p.token_x?.address)) continue;
    applyPaperSettings();
    if (fs.existsSync(path.join(DIR, 'STOP')) || fs.existsSync(path.join(DIR, 'NO_NEW'))) break;
    try {
      state.position = null; state.__active = null;
      const r = await liveOpen(p, state);
      livePositions.syncPositions(state); state.position = null;
      state.lastScan.openResult = { pool: p.name, ...r }; state.lastScan.openResults.push({ pool: p.name, address: p.address, at: now(), ...r });
    } catch (e) { livePositions.syncPositions(state); state.position = null; log('open error: ' + e.message); state.lastScan.openResult = { pool: p.name, error: e.message }; state.lastScan.openResults.push({ pool: p.name, address: p.address, at: now(), error: e.message }); }
  }
  saveState(state, path.join(DIR, 'state.json'));
  await writeLiveStatusPointer(state);
  return false;
}

(async () => {
  if (process.argv.includes('--scan-only')) {
    if (!CFG.PAPER || !CFG.DRY_RUN) throw new Error('--scan-only requires PAPER=1 DRY_RUN=1');
    applyPaperSettings();
    await scan();
    console.log(JSON.stringify({scanOnly:true,...scan.last}));
    // Diagnostic only: never load/save state, open/close/reshape, notify or read a private key.
    process.exit(0);
  }
  if (CFG.PAPER) {
    ensurePaperDirs();
    // Never load the private key in paper mode.
    let real = null;
    try { real = await realSolBal(); } catch (e) { log('real wallet balance unavailable: ' + e.message); }
    const state = loadState(F('state.json'));
    paperMeta(state); // preserves endsAt from paper/config.json if present
    initBooks(state);
    applyPaperSettings({ logAlways: true });
    const capInfo = await ensureUsdcCapital(state);
    paperFunding.initialize(state,CFG.PAPER_USDC);
    for(const v of VARIANTS){
      const b=state.books[v.id],legacy=!Array.isArray(b.positions)&&b.position;
      multi.migrate(b);
      for(const p of b.positions){quotePnl.ensureEntry(p);if(p.lastLive&&p.lastLive.pnlQuote==null)Object.assign(p.lastLive,quotePnl.fromPosition(p));}
      if(legacy){
        log(`portfolio migration: retained ${legacy.name} ${legacy.pool}, opened ${legacy.entryWib}, entry/range/inventory/PnL unchanged; isolated native reserve ${legacy.reserveSol} SOL; MAX_POSITIONS=${CFG.MAX_POSITIONS}`);
        paperSettings.audit(PAPER_DIR,`action=paper-portfolio-migration pool=${legacy.pool} openedAt=${legacy.openedAt} maxPositions=${CFG.MAX_POSITIONS}`);
      }
    }
    const provenanceCount=paperHistory.backfill(state,paperHistory.readEvidence(PAPER_DIR));
    if(provenanceCount){log(`history provenance backfill: ${provenanceCount} records; unknown metrics explicitly null; no trading data changed`);paperSettings.audit(PAPER_DIR,`action=paper-open-provenance-backfill records=${provenanceCount} source=bot.log+commands/applied unknowns=explicit`);}
    const correction=await paperReconcile.apply(state);
    if(correction){
      saveState(state,F('state.json')); // persist receipt + row + cash atomically before further trading
      const line='action=approved-paper-history-correction '+JSON.stringify(correction);
      log(line);paperSettings.audit(PAPER_DIR,line);
    }
    const startUsdc = (primaryBook(state) && primaryBook(state).virtual && primaryBook(state).virtual.usdc) || CFG.PAPER_USDC;
    log('Jupiter: '+jup.describe());log('RPC: '+require('./rpc-config').describe());log(`start PAPER: real wallet ${REAL_WALLET || '(belum ada key wallet)'} on-chain=${real == null ? 'n/a' : real.toFixed(5)} SOL (unused). strategy=N5 (reshape every 5 bins, compound on reshape; single book, live-like). capital=${startUsdc} USDC only, GAS_BUFFER_SOL=${CFG.GAS_BUFFER_SOL} (extra SOL bought at each open for rent/tx, leftovers swapped back at close; no separate gas wallet), usdcBuffer=${CFG.USDC_BUFFER}, minLiq=$${CFG.MIN_LIQ_USD}, minAge=${CFG.MIN_AGE_H}h, minFt=${CFG.MIN_FT}%/${CFG.FT_WINDOW}, pump24h<=${CFG.MAX_PUMP_24H * 100}%, emergencyNetUsdcDrop=${CFG.EMERGENCY_DROP * 100}%, rugcheck=${CFG.RUGCHECK}, tvlCap=${CFG.MAX_POS_TVL_FRAC * 100}%, TP_USDC=${CFG.TP_USD_PCT}%, rightOorClose=${CFG.OOR_RIGHT_CLOSE}, trailing=${CFG.TRAIL_ENABLED}, maxHold=${CFG.MAX_HOURS}h, window ${state.meta.startedWib} -> ${state.meta.endsWib}. Private key not loaded. Live STOP file left in place; paper stop is paper/STOP or pm2 stop lp-paper.`);
    log('paper valuation audit applied: bin prices/invariants verified; fallback = on-chain token mark minus SDK swap fee, native SOL conversion estimate 5 bps; Jupiter queue 1500ms + cache/backoff. Approved policy: unavailable OOR quote waits 10 polls; failed reopen retries; emergency is net entry capital asset (USDC/SOL), not token price.');
    saveState(state, F('state.json'));
    writeAllHistory(state);
    writeOpen(state);
    writeSummary(state);
    try { telegram.installProcessHandlers(); } catch { /* ignore */ }
    try {
      const nr = await telegram.notifyStartup(telegram.statusFromState(state));
      log(nr && nr.ok ? `telegram startup notify delivered` : `telegram startup notify not sent${nr && nr.skipped ? ' (' + nr.skipped + ')' : (nr && nr.error ? ' (' + nr.error + ')' : '')}`);
    } catch (e) { log('telegram startup notify failed (bot continues)'); }
    if (capInfo && capInfo.justReset && !(state.meta.capital && state.meta.capital.telegramSent)) {
      try {
        const cr = await telegram.notifyCapitalChange({
          usdcStart: CFG.PAPER_USDC,
          gasBufferSol: CFG.GAS_BUFFER_SOL,
          gasNeeded: capInfo.gasBufferNeeded,
          gasRaw: capInfo.gasBufferRaw,
          solUsd: capInfo.solUsdAtSwitch,
          startedWib: state.meta.startedWib,
          endsWib: state.meta.endsWib,
          switchedWib: capInfo.switchedWib,
        });
        log(cr && cr.ok ? 'telegram capital-change notify delivered' : `telegram capital-change notify not sent${cr && cr.skipped ? ' (' + cr.skipped + ')' : (cr && cr.error ? ' (' + cr.error + ')' : '')}`);
        if (cr && cr.ok && state.meta.capital) {
          state.meta.capital.telegramSent = true;
          state.meta.capital.telegramSentWib = wib();
          fs.writeFileSync(F('config.json'), JSON.stringify(state.meta, null, 2));
          saveState(state, F('state.json'));
        }
      } catch (e) { log('telegram capital-change notify failed (bot continues)'); }
    }
    let lastOpenScreenAt = 0;
    tickScreenRefresh();
    while (true) {
      let exit = false;
      try { exit = await paperCycle(state); }
      catch (e) {
        log('cycle error: ' + (e.stack || e.message).split('\n').slice(0, 4).join(' / '));
        try { telegram.notifyError(e, 'cycle error').catch(() => {}); } catch { /* ignore */ }
        await sleep(15000);
      }
      if (exit || CFG.ONCE) break;
      // Screening must not freeze at the entry scan while a position is held.
      // Network-only background scan; the serialized cycle consumes results and opens free slots.
      if (Date.now() - lastOpenScreenAt >= 300000) {
        lastOpenScreenAt = Date.now();
        scan().catch(e => log('screen background error: ' + e.message));
      }
      for (let i = 0; i < CFG.POLL_SEC / 5; i++) {
        await sleep(5000);
        try { applyPaperSettings();tickScreenRefresh();await processPaperRequests(state); }catch(e){log('paper request error: '+e.message);}
        try { telegram.maybeDailySummary(telegram.statusFromState(state)).catch(() => {}); } catch { /* ignore */ }
        if (paperStopRequested() || Date.now() >= Date.parse(state.meta.endsAt)) break;
        // Flat scans stay at 5 min; an open position refreshes inventory + active bin every ~10 sec.
        if ((anyOpen(state) && i >= 1) || (scan.last?.at && scan.last.at!==state.lastScan?.at)) break;
      }
    }
    log('paper exit');
    process.exit(0);
  }

  wallet = loadWallet();
  log(`start: wallet ${wallet.publicKey.toBase58()} rpc=[configured] DRY_RUN=${CFG.DRY_RUN} LIVE_CONFIRMED=${process.env.LIVE_CONFIRMED === '1'} balance=${(await realSolBal(wallet.publicKey)).toFixed(5)} SOL`);
  const state = loadState(path.join(DIR, 'state.json'));
  while (true) {
    let exit = false;
    try { exit = await liveCycle(state); }
    catch (e) { log('cycle error: ' + (e.stack || e.message).split('\n').slice(0, 3).join(' / ')); }
    if (exit || CFG.ONCE) break;
    for (let i = 0; i < CFG.POLL_SEC / 5; i++) {
      await sleep(5000);
      if (fs.existsSync(path.join(DIR, 'STOP'))) break;
    }
  }
  log('exit');
  process.exit(0);
})().catch((e) => { log('fatal: ' + (e.stack || e.message)); process.exit(1); });
