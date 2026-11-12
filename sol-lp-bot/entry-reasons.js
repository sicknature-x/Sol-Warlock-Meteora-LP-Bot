'use strict';
// Display-only "alasan dibuka" for open positions: which filters the pool passed at entry, value vs limit.
// Never used by the open/skip decision. Sources, in order: entry snapshot recorded at open -> bot.log PASS line at entry -> latest scan (labelled).
const fs = require('fs');
const num = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(+v) ? +v : null);
const usd = (v) => (v == null ? '—' : Math.abs(v) >= 1e6 ? '$' + (v / 1e6).toFixed(2) + 'M' : Math.abs(v) >= 1e3 ? '$' + (v / 1e3).toFixed(1) + 'k' : '$' + Math.round(v));
const sgn = (v, d = 1) => (v < 0 ? 'dump ' + v.toFixed(d) : '+' + v.toFixed(d)) + '%';

// Parse "PASS <name> <prefix> ft30m=..% tvl=$.. age=..h bs=.. pump1h=..% pump24h=..% [insider=..%] [antiPvP=..] [top10=..%] [dev=..%]"
function parsePass(line) {
  const m = line.match(/^\[(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) WIB\].*PASS (\S+) (\S+) ft30m=([\d.]+)% tvl=\$([\d.]+) age=([\d.]+)h bs=(\d+)(.*)$/);
  if (!m) return null;
  const rest = m[9], g = (k) => { const x = rest.match(new RegExp(' ' + k + '=(-?[\\d.]+)%')); return x ? +x[1] : null; };
  const pvp = rest.match(/ antiPvP=(\S+)/);
  return { at: new Date(`${m[1]}T${m[2]}+07:00`).toISOString(), wib: `${m[1]} ${m[2]} WIB`, name: m[3], prefix: m[4], ft30mPct: +m[5], tvlUsd: +m[6], ageH: +m[7], binStep: +m[8],
    pump1hPct: g('pump1h'), pump24hPct: g('pump24h'), insiderPct: g('insider'), top10Pct: g('top10'), devPct: g('dev'), antiPvp: pvp ? pvp[1] : null };
}
// Last PASS line for this pool within 15 min before (or 2 s after) openedAt.
function findPass(text, pool, name, openedAt) {
  const t = Date.parse(openedAt); if (!Number.isFinite(t) || !text) return null;
  let best = null;
  for (const line of text.split('\n')) {
    if (!line.includes(' PASS ' + name + ' ')) continue;
    const p = parsePass(line); if (!p || !String(pool).startsWith(p.prefix)) continue;
    const d = Date.parse(p.at); if (d <= t + 2000 && t - d <= 15 * 60_000) best = p;
  }
  return best;
}
// pos: open position; opts: { policy (current), pass (parsed PASS line or null), latest: { ft30mPct, tvlUsd, ageH, binStep, vol1hUsd, vol24hUsd, marketCapUsd, pump1hPct, pump24hPct, insiderPct } | null }
function build(pos, { policy = {}, pass = null, latest = null } = {}) {
  const c = pos.openContext || {}, s = c.snapshot || {}, P = { ...policy, ...(s.policy || {}) }, lim = s.policy ? 'saat entry' : 'setting sekarang';
  const out = [], src = { snap: 'data entry', log: 'log PASS ' + (pass ? pass.wib : ''), latest: 'scan terbaru, bukan saat entry' };
  const pick = (k, alt) => { const a = num(s[k]); if (a !== null) return [a, src.snap]; const b = pass ? num(pass[alt || k]) : null; if (b !== null) return [b, src.log]; const l = latest ? num(latest[k]) : null; return l !== null ? [l, src.latest] : [null, null]; };
  const line = (k, ok, t, from) => out.push({ k, s: ok === null ? 'info' : ok ? 'pass' : 'warn', t: t + (from ? ` (${from})` : '') });
  let [v, f] = pick('ft30mPct'); if (v !== null) line('ft', P.MIN_FT == null ? null : v >= P.MIN_FT, `Fee/TVL 30m: ${v.toFixed(2)}% ≥ ${P.MIN_FT}%`, f);
  [v, f] = pick('tvlUsd'); if (v !== null) line('tvl', P.MIN_LIQ_USD == null ? null : v >= P.MIN_LIQ_USD && !(P.MAX_LIQ_USD > 0 && v > P.MAX_LIQ_USD), `TVL: ${usd(v)} (min ${usd(P.MIN_LIQ_USD)}${P.MAX_LIQ_USD > 0 ? ', maks ' + usd(P.MAX_LIQ_USD) : ''})`, f);
  [v, f] = pick('ageH'); if (v !== null) line('age', P.MIN_AGE_H == null ? null : v >= P.MIN_AGE_H, `Umur pool: ${v.toFixed(1)} jam ≥ ${P.MIN_AGE_H} jam`, f);
  [v, f] = pick('binStep'); if (v !== null) line('bin_step', P.MIN_BIN_STEP == null ? null : v >= P.MIN_BIN_STEP && v <= P.MAX_BIN_STEP, `Bin step: ${v} (${P.MIN_BIN_STEP}–${P.MAX_BIN_STEP})`, f);
  const v1 = pick('vol1hUsd'), v24 = pick('vol24hUsd');
  if (v1[0] !== null && v24[0] !== null && v24[0] > 0) line('vol_spike', P.VOL_SPIKE_1H_OF_24H == null ? null : v1[0] / v24[0] <= P.VOL_SPIKE_1H_OF_24H, `Volume: 1 jam ${usd(v1[0])} = ${(v1[0] / v24[0] * 100).toFixed(0)}% dari 24 jam ${usd(v24[0])} ≤ maks ${Math.round((P.VOL_SPIKE_1H_OF_24H ?? 0) * 100)}%`, v1[1]);
  const ec = s.entryCostEstimate || pos.entryCostEstimate;
  if (ec && num(ec.nonrefTotalSol) !== null) line('entry_cost', ec.skipCheck ? null : ec.nonrefTotalSol <= (P.MAX_NONREFUND_SOL ?? 0.05), `Biaya non-refundable: ${(+ec.nonrefTotalSol).toFixed(5)} SOL${ec.skipCheck ? ' (cek batas dilewati: range kecil)' : ' ≤ maks ' + (P.MAX_NONREFUND_SOL ?? 0.05) + ' SOL'}`, src.snap);
  [v, f] = pick('pump1hPct'); if (v !== null) line('pump1h', P.MAX_PUMP1H == null ? null : v <= P.MAX_PUMP1H * 100, `Harga 1 jam: ${sgn(v)} ≤ maks ${Math.round(P.MAX_PUMP1H * 100)}% (${lim})`, f);
  [v, f] = pick('pump24hPct'); if (v !== null) line('pump24h', P.MAX_PUMP_24H == null ? null : v <= P.MAX_PUMP_24H * 100, `Harga 24 jam: ${sgn(v)} ≤ maks ${Math.round(P.MAX_PUMP_24H * 100)}% (${lim})`, f);
  [v, f] = pick('insiderPct'); if (v !== null) line('insider', v <= (P.MAX_INSIDER_PCT ?? 25), `Insider/cluster: ${v.toFixed(1)}% ≤ maks ${P.MAX_INSIDER_PCT ?? 25}%`, f);
  [v, f] = pick('top10Pct'); if (v !== null) line('top10', P.MAX_TOP10_HOLD == null ? null : v <= P.MAX_TOP10_HOLD * 100, `Top 10 holder: ${v.toFixed(1)}% ≤ maks ${Math.round((P.MAX_TOP10_HOLD ?? 0) * 100)}%`, f);
  [v, f] = pick('devPct'); if (v !== null) line('dev', P.MAX_DEV_HOLD == null ? null : v <= P.MAX_DEV_HOLD * 100, `Dev/creator: ${v.toFixed(1)}% ≤ maks ${Math.round((P.MAX_DEV_HOLD ?? 0) * 100)}%`, f);
  if (pass && pass.antiPvp) line('anti_pvp', true, `Anti PvP: ${pass.antiPvp === 'ok' ? 'tidak ada kembar' : pass.antiPvp.replace(/^kept\((\d+) kembar\)$/, 'dipilih sebagai yang tertua/terbesar ($1 kembar)')}`, src.log);
  [v, f] = pick('marketCapUsd'); if (v !== null) line('mc', null, `MC: ${usd(v)}`, f);
  if (s.passedAllFilters === true) out.unshift({ k: 'summary', s: 'pass', t: 'Lolos semua filter saat entry' });
  else if (s.passedAllFilters === false) out.unshift({ k: 'summary', s: 'warn', t: '⚠ Dibuka manual dengan filter gagal: ' + (s.failedFilters || []).join('; ') });
  return { source: c.source || null, reason: c.reason || null, openedAt: pos.openedAt, list: out };
}
module.exports = { parsePass, findPass, build };
