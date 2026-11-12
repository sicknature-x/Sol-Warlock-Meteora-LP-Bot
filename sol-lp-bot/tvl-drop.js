"use strict";
// Pure helper: skip a new entry if this token's TVL dropped >= threshold vs its most recent previous entry.
// Never used to close open positions. No network.
const num = (v) => (v != null && v !== "" && Number.isFinite(+v) ? +v : null);
function usd(n) {
  n = +n || 0;
  return "$" + (Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(2) + "M" : Math.abs(n) >= 1e3 ? (n / 1e3).toFixed(1) + "k" : n.toFixed(0));
}
function entryTvl(h) {
  if (!h) return null;
  const a = num(h.tvlUsd);
  if (a !== null) return a;
  return num(h.openContext && h.openContext.snapshot && h.openContext.snapshot.tvlUsd);
}
function sameToken(a, b) {
  const ma = a && (a.mintX || a.mint || (a.token_x && a.token_x.address));
  const mb = b && (b.mintX || b.mint || (b.token_x && b.token_x.address));
  if (ma && mb) return ma === mb;
  const na = a && a.name, nb = b && b.name;
  return !!(na && nb && na === nb);
}
function previousEntry(entries, candidate, at) {
  const t = at != null ? Date.parse(at) : Date.now();
  if (!Number.isFinite(t)) return null;
  let best = null, bestT = -Infinity;
  for (const h of entries || []) {
    if (!h || !sameToken(h, candidate)) continue;
    const ht = Date.parse(h.openedAt);
    if (!Number.isFinite(ht) || ht >= t) continue;
    if (ht > bestT) { best = h; bestT = ht; }
  }
  return best;
}
function limText(maxPct) {
  const n = +maxPct;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
function reason(dropPct, prevTvl, currentTvl, maxPct) {
  return `TVL turun ${(+dropPct).toFixed(1)}% sejak entry terakhir (${usd(prevTvl)} → ${usd(currentTvl)}) ≥ maks ${limText(maxPct)}%`;
}
function evaluate(currentTvl, prevTvl, maxPct = 45) {
  const cur = num(currentTvl), prev = num(prevTvl), lim = num(maxPct);
  if (cur === null || prev === null || !(prev > 0) || lim == null) return { ok: true };
  const dropPct = (prev - cur) / prev * 100;
  if (!(dropPct >= lim)) return { ok: true, dropPct, prevTvl: prev, currentTvl: cur, maxPct: lim };
  return { ok: false, dropPct, prevTvl: prev, currentTvl: cur, maxPct: lim, why: reason(dropPct, prev, cur, lim) };
}
function evaluatePool(pool, entries, maxPct, at) {
  const prev = previousEntry(entries, pool, at);
  return { ...evaluate(num(pool && pool.tvl), entryTvl(prev), maxPct), prev };
}
function hitsInHistory(history, maxPct = 45) {
  const rows = [...(history || [])].filter((h) => h && h.openedAt)
    .sort((a, b) => String(a.openedAt).localeCompare(String(b.openedAt)) || String(a.closedAt || "").localeCompare(String(b.closedAt || "")));
  const out = [];
  for (const h of rows) {
    const ev = evaluatePool(Object.assign({ tvl: entryTvl(h) }, h), rows, maxPct, h.openedAt);
    if (!ev.ok) out.push({ row: h, ...ev });
  }
  return out;
}
module.exports = { num, usd, entryTvl, sameToken, previousEntry, evaluate, evaluatePool, hitsInHistory, reason };
