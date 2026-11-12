// Anti PvP: detect "twin" tokens (same normalized symbol/name, DIFFERENT mint CA).
// Pure helpers, no network. Different pools of the same CA are never twins.
// Normalization: NFKD, lowercase, strip non [a-z0-9] (so "$DACITY", "Dacity Coin" -> "dacity..."),
// then strip ONE trailing "coin" or "token" if >=3 chars remain ("dacitycoin" -> "dacity").
// "ai" is NOT stripped (too many real names end in ai, e.g. "kai", "sai"). Keys < 2 chars are ignored.
// A twin only counts if its best liquidity >= minLiq (default 10k USD), so dead pump.fun clones are ignored.
// KEEP_BIGGEST: among self + counted twins keep the one with the LARGEST liquidity (best pool/pair liquidity across Meteora + DexScreener);
// tie-break OLDER (earliest pool/pair createdAt), then CA string. Age alone never wins: an ancient twin (e.g. 1 year old, tiny liquidity) does not block the real, bigger token.
// Market cap is NOT used (easy to fake on clones).
'use strict';
const SUFFIXES = ['coin', 'token'];
const MODES = ['KEEP_BIGGEST', 'SKIP_ALL', 'OFF'];

function normKey(s) {
  if (s == null) return null;
  let k = String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const suf of SUFFIXES) if (k.length - suf.length >= 3 && k.endsWith(suf)) { k = k.slice(0, -suf.length); break; }
  return k.length >= 2 ? k : null;
}
function keysOf(t) { return [...new Set([normKey(t?.symbol), normKey(t?.name)].filter(Boolean))]; }
const ms = (t) => { t = +t || 0; return t > 0 ? (t > 1e12 ? t : t * 1000) : null; };
function fromPool(p) {
  return { mint: p?.token_x?.address, symbol: p?.token_x?.symbol, name: p?.token_x?.name, liqUsd: +p?.tvl || 0,
    createdAtMs: ms(p?.created_at), source: 'meteora' };
}
function fromDexPair(x) {
  if (x?.chainId && x.chainId !== 'solana') return null;
  return { mint: x?.baseToken?.address, symbol: x?.baseToken?.symbol, name: x?.baseToken?.name,
    liqUsd: +x?.liquidity?.usd || 0, createdAtMs: ms(x?.pairCreatedAt), source: 'dexscreener' };
}
function merge(entries) {
  const by = new Map();
  for (const e of entries) {
    if (!e || !e.mint) continue;
    const o = by.get(e.mint) || { mint: e.mint, symbol: e.symbol, name: e.name, liqUsd: 0, createdAtMs: null, sources: [] };
    o.liqUsd = Math.max(o.liqUsd, +e.liqUsd || 0);
    if (e.createdAtMs > 0) o.createdAtMs = o.createdAtMs == null ? e.createdAtMs : Math.min(o.createdAtMs, e.createdAtMs);
    if (!o.symbol && e.symbol) o.symbol = e.symbol;
    if (!o.name && e.name) o.name = e.name;
    if (!o.sources.includes(e.source)) o.sources.push(e.source);
    by.set(e.mint, o);
  }
  return by;
}
const short = (m) => (m ? m.slice(0, 4) + '…' + m.slice(-4) : '?');
const cmp = (a, b) => (b.liqUsd - a.liqUsd) || ((a.createdAtMs ?? Infinity) - (b.createdAtMs ?? Infinity)) || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0);   // biggest liquidity first, then older

// self: entry for the candidate token; entries: every known pool/pair entry (may include self's own pools).
function evaluate({ self, entries = [], mode = 'KEEP_BIGGEST', minLiq = 10000 } = {}) {
  if (mode === 'OFF' || !MODES.includes(mode)) return { ok: true, mode: 'OFF', twins: [] };
  const keys = new Set(keysOf(self));
  if (!self?.mint || !keys.size) return { ok: true, mode, twins: [], note: 'no symbol/name key' };
  const by = merge([self, ...entries]);
  const me = by.get(self.mint);
  const twins = [...by.values()].filter((e) => e.mint !== self.mint && e.liqUsd >= minLiq && keysOf(e).some((k) => keys.has(k))).sort(cmp);
  if (!twins.length) return { ok: true, mode, twins: [] };
  const more = twins.length > 1 ? ` +${twins.length - 1} lain` : '';
  if (mode === 'SKIP_ALL') return { ok: false, mode, twins, why: `anti PvP: kembar dengan ${short(twins[0].mint)} (${twins[0].symbol || '?'})${more}` };
  const rank = [me, ...twins].sort(cmp);
  if (rank[0].mint === self.mint) return { ok: true, mode, twins, kept: self.mint };
  return { ok: false, mode, twins, kept: rank[0].mint, why: `anti PvP: kembar dengan ${short(rank[0].mint)} (${rank[0].symbol || '?'}, lebih besar)${more}` };
}
// Effective token-filter switches: master FILTERS_ENABLED gates every optional token filter; per-filter values are kept.
function filterFlags(v = {}, base = { RUGCHECK: true, CHECK_TOP_HOLDERS: true }) {
  const master = v.FILTERS_ENABLED !== false, on = (k) => master && v[k] !== false;
  return { master, pump1h: on('PUMP1H_FILTER_ENABLED'), pump24h: on('PUMP24H_FILTER_ENABLED'),
    rugcheck: !!base.RUGCHECK && on('RUGCHECK_ENABLED'), topHolders: !!base.CHECK_TOP_HOLDERS && on('TOP_HOLDERS_ENABLED'),
    insiders: on('CHECK_INSIDERS'), oldDump: on('OLD_DUMP_FILTER_ENABLED'), tvlDrop: on('TVL_DROP_FILTER_ENABLED'),
    antiPvp: master ? (MODES.includes(v.ANTI_PVP_MODE) ? v.ANTI_PVP_MODE : 'KEEP_BIGGEST') : 'OFF' };
}
module.exports = { filterFlags, MODES, SUFFIXES, normKey, keysOf, fromPool, fromDexPair, merge, evaluate, short };
