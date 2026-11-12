// Display-only: list EVERY reason a pool would not be opened (no short-circuit). Pure; no network.
// Never used for the open decision (bot.js keeps its original filter chain); only for the mini app cards.
'use strict';
const antirug = require('./antirug'), screenSource = require('./pool-screen-source'), entryCost = require('./paper-entry-cost'), tvlDrop = require('./tvl-drop');
const SOL = 'So11111111111111111111111111111111111111112', USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const usd = (n) => { n = +n || 0; return '$' + (Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : Math.abs(n) >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : n.toFixed(0)); };
const pct = (x, d = 1) => (+x).toFixed(d) + '%';
const createdAtSec = (p) => { const t = +p?.created_at || 0; return t > 1e12 ? t / 1000 : t; };
// ctx: { policy, nowS, flags (anti-pvp filterFlags), sl (blacklist entry|null), cooldown (string|null), open {samePool, caPoolName, count, max},
//        entryCost (estimate|undefined), pu, pu24 (number|null|undefined), pumpSource, mint ({ok,why}|undefined), report (obj|undefined), pvp (obj|undefined) }
function evaluate(p, ctx) {
  const out = [], fail = (k, t) => out.push({ k, t, s: 'fail' }), todo = (k, t) => out.push({ k, t: t + ': belum dicek', s: 'unchecked' }), info = (k, t) => out.push({ k, t, s: 'info' });
  const P = ctx.policy || {}, nowS = ctx.nowS ?? Date.now() / 1000, F = ctx.flags || {};
  // --- basic filters (same order/limits as bot.js basic filter) ---
  const sanity = screenSource.sanityReason(p, P.MIN_LIQ_USD);
  if (sanity && !sanity.startsWith('tvl<')) fail('sanity', 'Data pool: ' + sanity);
  const q = p.token_y?.address;
  if (![SOL, ...(P.PAPER !== false ? [USDC] : [])].includes(q)) fail('quote', `Quote: ${p.token_y?.symbol || '?'} (harus SOL/USDC)`);
  if (p.is_blacklisted) fail('meteora_blacklist', 'Pool diblacklist Meteora');
  const ftv = screenSource.ft(p), ftEv = antirug.evaluateFeeTvl(ftv, P.MIN_FT, P.FT_WINDOW || '30m');
  if (!ftEv.ok) fail('fee_tvl', ftv == null || !Number.isFinite(+ftv) ? `Fee/TVL ${P.FT_WINDOW || '30m'}: tidak ada data` : `Fee/TVL ${P.FT_WINDOW || '30m'}: ${(+ftv).toFixed(2)}% < ${P.MIN_FT}%`);
  if (!((p.tvl || 0) >= P.MIN_LIQ_USD)) fail('tvl_min', `TVL: ${usd(p.tvl)} < min ${usd(P.MIN_LIQ_USD)}`);
  const ageH = (nowS - createdAtSec(p)) / 3600;
  if (ageH < P.MIN_AGE_H) fail('age', `Umur pool: ${ageH.toFixed(1)} jam < ${P.MIN_AGE_H} jam`);
  const bs = p.pool_config?.bin_step;
  if (bs < P.MIN_BIN_STEP || bs > P.MAX_BIN_STEP) fail('bin_step', `Bin step: ${bs} di luar ${P.MIN_BIN_STEP}–${P.MAX_BIN_STEP}`);
  if (P.MAX_LIQ_USD > 0 && p.tvl > P.MAX_LIQ_USD) fail('tvl_max', `TVL: ${usd(p.tvl)} > maks ${usd(P.MAX_LIQ_USD)}`);
  if (!(p.token_y_amount > 1)) fail('quote_liq', 'Likuiditas quote: kosong');
  const v1 = p.volume?.['1h'] || 0;
  if (v1 < P.MIN_VOL_1H) fail('vol1h', `Volume 1 jam: ${usd(v1)} < min ${usd(P.MIN_VOL_1H)}`);
  const spike = antirug.evaluateVolSpike(p.volume?.['1h'], p.volume?.['24h'], P.VOL_SPIKE_1H_OF_24H);
  if (!spike.ok) fail('vol_spike', spike.ratio != null ? `Vol spike: 1 jam ${usd(v1)} = ${pct(spike.ratio * 100, 0)} dari 24 jam ${usd(p.volume?.['24h'])} > maks ${pct(P.VOL_SPIKE_1H_OF_24H * 100, 0)}` : 'Vol spike: ' + spike.why);
  // --- token / book checks ---
  if (P.PAPER !== false && P.SL_BLACKLIST_ENABLED !== false && ctx.sl) fail('sl_blacklist', ctx.sl.source === 'manual' || /manual/.test(ctx.sl.reason || '') ? `Blacklist: blok manual (${ctx.sl.reason || 'manual'})` : `SL blacklist: pernah kena SL (${ctx.sl.reason || 'stop loss'})`);
  if (ctx.cooldown) fail('cooldown', ctx.cooldown);
  if (ctx.open?.samePool) info('open', 'Sudah open di pool ini');
  else if (ctx.open?.caPoolName) fail('open_ca', `CA sama sudah open: ${ctx.open.caPoolName}`);
  if (ctx.open && ctx.open.count >= ctx.open.max && !ctx.open.samePool) info('slots', `Slot penuh: ${ctx.open.count}/${ctx.open.max} posisi`);
  if (P.PAPER !== false) {
    if (ctx.entryCost === undefined) todo('entry_cost', 'Biaya non-refundable open');
    else { const why = entryCost.rejection(ctx.entryCost, P.MAX_NONREFUND_SOL ?? 0.05); if (why) fail('entry_cost', 'Biaya open: ' + why); }
  }
  if (F.antiPvp && F.antiPvp !== 'OFF') {
    if (ctx.pvp === undefined) todo('anti_pvp', 'Anti PvP');
    else if (!ctx.pvp.ok) fail('anti_pvp', `Anti PvP (${F.antiPvp === 'SKIP_ALL' ? 'skip semua kembar' : 'ambil yang terbesar'}): ` + ctx.pvp.why.replace(/^anti PvP: /, '') + (ctx.pvp.twins?.length ? ' — ' + ctx.pvp.twins.slice(0, 3).map((x) => `${x.symbol || '?'} ${x.mint.slice(0, 4)}…${x.mint.slice(-4)} liq ${usd(x.liqUsd)}`).join(', ') : ''));
  }
  const src = ctx.pumpSource ? ` (${ctx.pumpSource})` : '';
  if (F.pump1h) {
    if (ctx.pu === undefined) todo('pump1h', 'Pump 1 jam');
    else if (ctx.pu === null) fail('pump1h', 'Pump 1 jam: data harga tidak ada');
    else if (ctx.pu > P.MAX_PUMP1H) fail('pump1h', `Pump 1 jam: ${pct(ctx.pu * 100)} > maks ${pct(P.MAX_PUMP1H * 100, 0)}${src}`);
  }
  if (F.pump24h) {
    if (ctx.pu24 === undefined) todo('pump24h', 'Pump 24 jam');
    else if (ctx.pu24 === null) fail('pump24h', 'Pump 24 jam: data harga tidak ada');
    else if (ctx.pu24 > P.MAX_PUMP_24H) fail('pump24h', `Pump 24 jam: ${pct(ctx.pu24 * 100)} > maks ${pct(P.MAX_PUMP_24H * 100, 0)}${src}`);
  }
  if (F.tvlDrop) {
    const ev = tvlDrop.evaluate(p.tvl, ctx.prevTvl, P.TVL_DROP_MAX_PCT ?? 45);
    if (!ev.ok) fail('tvl_drop', ev.why);
  }
  if (F.oldDump && P.OLD_TOKEN_MODE === 'BLOCK_ALL') {
    if (!(Number(p.created_at) > 0)) fail('old_token', 'Token tua: umur pool tidak diketahui');
    else if (ageH > (P.OLD_DUMP_MIN_AGE_H ?? 400)) fail('old_token', `Token tua: umur ${ageH.toFixed(0)}j > maks ${P.OLD_DUMP_MIN_AGE_H ?? 400}j`);
  } else if (F.oldDump && ageH > (P.OLD_DUMP_MIN_AGE_H ?? 400)) {
    const lim = P.OLD_DUMP_MAX_PUMP24H ?? 0;
    if (ctx.pu24 === undefined) todo('old_dump', 'Token tua lagi dump');
    else if (ctx.pu24 === null) fail('old_dump', `Token tua lagi dump: umur ${ageH.toFixed(0)}j > ${P.OLD_DUMP_MIN_AGE_H ?? 400}j, harga 24 jam tidak ada`);
    else if (ctx.pu24 * 100 < lim) fail('old_dump', `Token tua lagi dump: umur ${ageH.toFixed(0)}j > ${P.OLD_DUMP_MIN_AGE_H ?? 400}j & ${ctx.pu24 < 0 ? 'dump' : 'pump'} 24j ${pct(ctx.pu24 * 100, 0)} < ${lim}%${src}`);
  }
  if (ctx.mint && !ctx.mint.ok) fail('mint', 'Mint on-chain: ' + ctx.mint.why);
  const rep = ctx.report, needReport = P.RUGCHECK || P.CHECK_TOP_HOLDERS || F.insiders;
  if (needReport && rep === undefined) {
    if (P.RUGCHECK) todo('rugcheck', 'RugCheck'); if (P.CHECK_TOP_HOLDERS) todo('holders', 'Top holder/dev'); if (F.insiders) todo('insider', 'Insider/cluster');
  } else if (needReport && rep && rep.error) {
    fail('rugcheck', `RugCheck gagal: ${rep.error}`);
  } else if (rep) {
    if (P.RUGCHECK) {
      if (rep.rugged === true) fail('rugcheck', 'RugCheck: rugged');
      const ma = antirug.getMintAuthority(rep), fa = antirug.getFreezeAuthority(rep);
      if (ma === undefined) fail('rugcheck', 'RugCheck: mint authority tidak diketahui'); else if (ma) fail('rugcheck', 'RugCheck: mint authority aktif');
      if (fa === undefined) fail('rugcheck', 'RugCheck: freeze authority tidak diketahui'); else if (fa) fail('rugcheck', 'RugCheck: freeze authority aktif');
      for (const r of (Array.isArray(rep.risks) ? rep.risks : []).filter((r) => String(r?.level || '').toLowerCase() === 'danger')) fail('rugcheck', `RugCheck risiko danger: ${r.name || 'risk'}${r.value ? ' (' + r.value + ')' : ''}`);
      const sc = rep.score_normalised ?? rep.scoreNormalized, max = P.MAX_RUGCHECK_SCORE_NORM ?? 50;
      if (sc != null && Number.isFinite(+sc) && +sc >= max) fail('rugcheck', `RugCheck skor: ${sc} ≥ maks ${max}`);
    }
    if (P.CHECK_TOP_HOLDERS) {
      const holders = rep.topHolders || rep.top_holders;
      if (!holders || !holders.length) todo('holders', 'Top holder/dev (fallback RPC)');
      else {
        const st = antirug.extractHolderStats(rep, ctx.holdersExclude || []), mt = P.MAX_TOP10_HOLD ?? 0.3, md = P.MAX_DEV_HOLD ?? 0.1;
        if (st.top10Frac > mt) fail('holders', `Top 10 holder: ${pct(st.top10Frac * 100)} > maks ${pct(mt * 100, 0)}`);
        if (st.devFrac != null && st.devFrac > md) fail('dev', `Dev/creator: ${pct(st.devFrac * 100)} > maks ${pct(md * 100, 0)}`);
      }
    }
    if (F.insiders) {
      const ins = antirug.evaluateInsiders(rep, P);
      if (!ins.ok) fail('insider', `Insider/cluster: ${ins.pct != null ? pct(ins.pct) : '?'} supply > maks ${P.MAX_INSIDER_PCT ?? 25}% (${(ins.networks || 0) - (ins.ignoredNetworks || 0)} jaringan, ${ins.wallets ?? '?'} wallet)`);
    }
  }
  return out;
}
module.exports = { evaluate };
