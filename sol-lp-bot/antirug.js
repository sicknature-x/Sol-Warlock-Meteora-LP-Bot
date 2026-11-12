// Pure anti-rug entry and emergency-stop helpers. No network, no wallet, no side effects.
'use strict';

const DEFAULTS = {
  MIN_AGE_H: 24,
  MIN_LIQ_USD: 25000,
  FT_WINDOW: '30m',
  MIN_FT: 2,
  MAX_PUMP_24H: 0.50,
  VOL_SPIKE_1H_OF_24H: 0.50,
  EMERGENCY_DROP: 0.30,
  MAX_TOP10_HOLD: 0.30,
  MAX_DEV_HOLD: 0.10,
  MAX_RUGCHECK_SCORE_NORM: 50,
};

// Owners of vault / LP / AMM token accounts to exclude from holder concentration.
const KNOWN_LP_PROGRAMS = new Set([
  'LBUZKhRxPF3XUpBCjp4YzTKgLcc2qhUcySJttmKcGcX', // Meteora DLMM
  'Eo7WjKq67rjJMSDBcAtzmzWoMVGjp5VMkVmHgNsuWQne', // Meteora DAMM v1
  'cpamdpZCGKUy5JxQXB4dcpGUSFkN2pdC2SxbD1e4MwS', // Meteora DAMM v2 / CPAMM
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium CPMM
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpool
  '9W959DqEETiSZjVw6AKywwXz6GWYmCh9ENS7LXVxNqK', // Orca v1
  'PhoeNiXZ8ByJGLubaCcVKrD1WJrFaRyVfBUAMeBPwM', // Phoenix
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // pump.fun
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // PumpSwap
  'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG', // Moonshot
]);

function shouldEmergencyStop(entryPrice, currentPrice, threshold = DEFAULTS.EMERGENCY_DROP) {
  if (!(entryPrice > 0) || !(currentPrice >= 0) || !(threshold > 0)) return false;
  // Compare in price space so a exact 30% drop is not tripped by float error on (p/p0 - 1).
  return currentPrice < entryPrice * (1 - threshold);
}

function evaluatePump24h(change, max = DEFAULTS.MAX_PUMP_24H) {
  if (change == null || !Number.isFinite(+change)) return { ok: false, why: 'no 24h price history' };
  if (+change > max) {
    return { ok: false, why: `pump24h=${(+change * 100).toFixed(1)}%>${(max * 100).toFixed(0)}%` };
  }
  return { ok: true, pump24h: +change };
}

// Old token still dumping: pool older than minAgeH AND 24h price change below maxPump24hPct (percent; 0 = any drop).
// Old token hard block (mode BLOCK_ALL): pool age above maxAgeH, regardless of price. Unknown age (no created_at) blocks too.
function evaluateOldToken(ageH, maxAgeH = 400) {
  if (ageH == null || !Number.isFinite(+ageH)) return { ok: false, why: 'token tua: umur pool tidak diketahui' };
  if (+ageH > maxAgeH) return { ok: false, why: `token tua: umur ${(+ageH).toFixed(0)}j > maks ${maxAgeH}j` };
  return { ok: true };
}
function evaluateOldDump(ageH, change, minAgeH = 400, maxPump24hPct = 0) {
  if (!(+ageH > minAgeH)) return { ok: true };
  if (change == null || !Number.isFinite(+change)) return { ok: false, why: `token tua lagi dump: umur ${(+ageH).toFixed(0)}j > ${minAgeH}j, harga 24j tidak ada` };
  if (+change * 100 < maxPump24hPct) return { ok: false, why: `token tua lagi dump: umur ${(+ageH).toFixed(0)}j > ${minAgeH}j & ${+change < 0 ? 'dump' : 'naik'} 24j ${(+change * 100).toFixed(0)}% < ${maxPump24hPct}%` };
  return { ok: true };
}

function evaluateVolSpike(vol1h, vol24h, ratio = DEFAULTS.VOL_SPIKE_1H_OF_24H) {
  const v1 = +vol1h || 0;
  const v24 = +vol24h;
  if (!Number.isFinite(v24) || !(v24 > 0)) {
    if (v1 > 0) return { ok: false, why: 'volume spike from ~zero (no 24h volume)' };
    return { ok: false, why: 'volume 24h missing' };
  }
  if (v1 > ratio * v24) {
    return {
      ok: false,
      why: `vol spike 1h=${v1.toFixed(0)} > ${ratio * 100}% of 24h=${v24.toFixed(0)}`,
      ratio: v1 / v24,
    };
  }
  return { ok: true, ratio: v1 / v24 };
}

function createdAtSec(p) {
  const t = +p?.created_at || 0;
  return t > 1e12 ? t / 1000 : t;
}

function evaluateAgeTvl(pool, nowS, cfg = DEFAULTS) {
  const minLiq = cfg.MIN_LIQ_USD ?? DEFAULTS.MIN_LIQ_USD;
  const minAge = cfg.MIN_AGE_H ?? DEFAULTS.MIN_AGE_H;
  const tvl = +(pool?.tvl || 0);
  if (!(tvl >= minLiq)) return { ok: false, why: `tvl<$${minLiq}`, tvl };
  const ageH = (nowS - createdAtSec(pool)) / 3600;
  if (!(ageH >= minAge)) return { ok: false, why: `age<${minAge}h`, ageH, tvl };
  return { ok: true, ageH, tvl };
}

function getMintAuthority(report) {
  if (!report || typeof report !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(report, 'mintAuthority')) return report.mintAuthority;
  if (report.token && Object.prototype.hasOwnProperty.call(report.token, 'mintAuthority')) return report.token.mintAuthority;
  return undefined;
}

function getFreezeAuthority(report) {
  if (!report || typeof report !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(report, 'freezeAuthority')) return report.freezeAuthority;
  if (report.token && Object.prototype.hasOwnProperty.call(report.token, 'freezeAuthority')) return report.token.freezeAuthority;
  return undefined;
}

function evaluateRugCheck(report, cfg = DEFAULTS) {
  const maxScore = cfg.MAX_RUGCHECK_SCORE_NORM ?? DEFAULTS.MAX_RUGCHECK_SCORE_NORM;
  if (!report || typeof report !== 'object') return { ok: false, why: 'rugcheck report missing' };
  if (report.error) return { ok: false, why: `rugcheck failed: ${report.error}` };
  if (report.rugged === true) return { ok: false, why: 'rugcheck rugged=true' };
  const mintAuth = getMintAuthority(report);
  const freezeAuth = getFreezeAuthority(report);
  if (mintAuth === undefined) return { ok: false, why: 'rugcheck mint authority unknown' };
  if (freezeAuth === undefined) return { ok: false, why: 'rugcheck freeze authority unknown' };
  if (mintAuth) return { ok: false, why: 'mint authority active' };
  if (freezeAuth) return { ok: false, why: 'freeze authority active' };
  const risks = Array.isArray(report.risks) ? report.risks : [];
  const danger = risks.filter((r) => String(r?.level || '').toLowerCase() === 'danger');
  if (danger.length) {
    return { ok: false, why: `rugcheck danger: ${danger.map((r) => r.name || 'risk').join(', ')}` };
  }
  const score = report.score_normalised ?? report.scoreNormalized;
  if (score != null && Number.isFinite(+score) && +score >= maxScore) {
    return { ok: false, why: `rugcheck score_normalised=${score}>=${maxScore}` };
  }
  return { ok: true, scoreNorm: score ?? null };
}

function lpAddressSet(report, extraExclude = []) {
  const s = new Set((extraExclude || []).filter(Boolean));
  for (const m of report?.markets || []) {
    for (const k of [
      'pubkey', 'liquidity_a_account', 'liquidity_b_account', 'liquidityAAccount', 'liquidityBAccount',
      'mint_lp_account', 'mint_a_account', 'mint_b_account', 'mintLpAccount',
    ]) {
      if (m?.[k]) s.add(m[k]);
    }
    if (m?.lp?.address) s.add(m.lp.address);
    if (m?.lp?.lpMint) s.add(m.lp.lpMint);
  }
  return s;
}

function knownInfo(known, key) {
  if (!known || !key) return {};
  return known[key] || {};
}

function isExcludedHolder(h, lpSet, known) {
  const addr = h?.address;
  const owner = h?.owner;
  if (addr && lpSet.has(addr)) return true;
  if (owner && lpSet.has(owner)) return true;
  if (owner && KNOWN_LP_PROGRAMS.has(owner)) return true;
  if (addr && KNOWN_LP_PROGRAMS.has(addr)) return true;
  const info = { ...knownInfo(known, addr), ...knownInfo(known, owner) };
  const label = `${info.name || ''} ${info.type || ''} ${info.tag || ''}`.toLowerCase();
  if (/(\blp\b|pool|vault|amm|clmm|dlmm|\bprogram\b|market|raydium|meteora|orca|pumpswap|pump\.fun)/.test(label)) return true;
  return false;
}

// RugCheck `pct` is 0–100. Values already in 0–1 fraction are also accepted if every value is <= 1
// and the sum would otherwise exceed 100% — we treat the documented 0–100 form as default.
function holderPctFraction(pct, treatAsPercent) {
  const n = +pct || 0;
  return treatAsPercent ? n / 100 : n;
}

function looksLikePercentScale(holders) {
  const vals = (holders || []).map((h) => +h.pct || 0);
  if (!vals.length) return true;
  return vals.some((v) => v > 1);
}

function extractHolderStats(report, extraExclude = []) {
  const holders = report?.topHolders || report?.top_holders || [];
  const lpSet = lpAddressSet(report, extraExclude);
  const known = report?.knownAccounts || report?.known_accounts || {};
  const asPct = looksLikePercentScale(holders);
  const included = [];
  for (const h of holders) {
    if (isExcludedHolder(h, lpSet, known)) continue;
    included.push({
      address: h.address,
      owner: h.owner,
      frac: holderPctFraction(h.pct, asPct),
    });
  }
  const top10Frac = included.slice(0, 10).reduce((s, h) => s + h.frac, 0);
  const creator = report?.creator || report?.tokenMeta?.updateAuthority || null;
  let devFrac = null;
  if (creator) {
    const hit = included.find((h) => h.address === creator || h.owner === creator)
      || holders.filter((h) => !isExcludedHolder(h, lpSet, known) || h.address === creator || h.owner === creator)
        .find((h) => h.address === creator || h.owner === creator);
    if (hit) devFrac = hit.frac != null ? hit.frac : holderPctFraction(hit.pct, asPct);
  }
  return { top10Frac, devFrac, includedCount: included.length, creator };
}

function evaluateFeeTvl(ft, min = DEFAULTS.MIN_FT, window = DEFAULTS.FT_WINDOW) {
  const label = `fee/tvl${window}`;
  if (ft == null || !Number.isFinite(+ft)) return { ok: false, why: `${label} missing` };
  if (+ft < min) return { ok: false, why: `${label}<${min}%` };
  return { ok: true, ft: +ft, window };
}

function evaluateHolders({ top10Frac, devFrac } = {}, cfg = DEFAULTS) {
  const maxTop = cfg.MAX_TOP10_HOLD ?? DEFAULTS.MAX_TOP10_HOLD;
  const maxDev = cfg.MAX_DEV_HOLD ?? DEFAULTS.MAX_DEV_HOLD;
  if (top10Frac == null || !Number.isFinite(+top10Frac)) {
    return { ok: false, why: 'holder concentration unknown' };
  }
  if (+top10Frac > maxTop) {
    return { ok: false, why: `top10 holders=${(+top10Frac * 100).toFixed(1)}%>${(maxTop * 100).toFixed(0)}%` };
  }
  if (devFrac != null && Number.isFinite(+devFrac) && +devFrac > maxDev) {
    return { ok: false, why: `dev/creator hold=${(+devFrac * 100).toFixed(1)}%>${(maxDev * 100).toFixed(0)}%` };
  }
  return { ok: true, top10Frac: +top10Frac, devFrac: devFrac == null ? null : +devFrac };
}

function evaluateHoldersFromReport(report, extraExclude = [], cfg = DEFAULTS) {
  if (!report || report.error) return { ok: false, why: 'holder concentration unknown' };
  const holders = report.topHolders || report.top_holders;
  if (!holders || !holders.length) return { ok: false, why: 'holder concentration unknown' };
  const stats = extractHolderStats(report, extraExclude);
  return { ...evaluateHolders(stats, cfg), ...stats };
}

// Insider / cluster check from RugCheck report (fields verified on a live report 2026-11-11):
// insiderNetworks[] {id,size,type,tokenAmount,currentHolding,activeAccounts}, token.supply (raw units),
// graphInsidersDetected (wallet count), topHolders[].insider (bool). pct = max(sum networks currentHolding / supply,
// sum pct of topHolders flagged insider). Report error -> reject (fail-closed); report without any insider data -> pass (unknown).
function evaluateInsiders(report, cfg = {}) {
  const max = cfg.MAX_INSIDER_PCT ?? 25;
  if (!report || typeof report !== 'object') return { ok: false, why: 'insider: rugcheck report missing' };
  if (report.error) return { ok: false, why: `insider: rugcheck gagal (${report.error})` };
  const nets = Array.isArray(report.insiderNetworks) ? report.insiderNetworks : null;
  const holders = report.topHolders || report.top_holders || [];
  const asPct = looksLikePercentScale(holders);
  const flagged = holders.filter((h) => h && h.insider === true);
  const supply = +(report.token?.supply ?? report.supply);
  // Sanity: k linked wallets cannot hold more than the k biggest holders combined (or >100%).
  // RugCheck sometimes reports impossible currentHolding (e.g. 107% of supply); such networks are ignored.
  const sortedPct = holders.map((h) => holderPctFraction(h.pct, asPct) * 100).sort((x, y) => y - x);
  const bound = (k) => (k > 0 && k <= sortedPct.length ? sortedPct.slice(0, k).reduce((x, y) => x + y, 0) : 100) + 0.5;
  let netPct = null, ignored = 0;
  if (nets && supply > 0) netPct = nets.reduce((s, n) => { const pc = Math.max(0, +n?.currentHolding || 0) / supply * 100; if (pc > bound(+n?.size || 0)) { ignored++; return s; } return s + pc; }, 0);
  const flagPct = flagged.reduce((s, h) => s + holderPctFraction(h.pct, asPct) * 100, 0);
  if (netPct == null && !flagged.length) return { ok: true, unknown: true, pct: null, networks: 0 };
  const pct = Math.max(netPct || 0, flagPct);
  const info = { pct, ignoredNetworks: ignored, networks: nets ? nets.length : 0, wallets: report.graphInsidersDetected ?? null, flaggedTopHolders: flagged.length };
  if (pct > max) return { ok: false, ...info, why: `insider network=${pct.toFixed(1)}%>${max}% supply (${info.networks - ignored} jaringan, ${info.wallets ?? '?'} wallet)` };
  return { ok: true, ...info };
}

module.exports = {
  evaluateInsiders,
  DEFAULTS,
  KNOWN_LP_PROGRAMS,
  shouldEmergencyStop,
  evaluatePump24h,
  evaluateOldDump,
  evaluateOldToken,
  evaluateVolSpike,
  createdAtSec,
  evaluateAgeTvl,
  evaluateFeeTvl,
  getMintAuthority,
  getFreezeAuthority,
  evaluateRugCheck,
  extractHolderStats,
  evaluateHolders,
  evaluateHoldersFromReport,
};
