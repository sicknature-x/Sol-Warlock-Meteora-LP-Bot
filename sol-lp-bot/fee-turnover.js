'use strict';
// Fee-turnover guard: skip small, "overheated" pools. Turnover = fees collected in 24h / TVL. History check (50 closed trades): both stop losses (X-SOL, Huang) had turnover 78-86%
// at entry with TVL $13-22k, and never showed a profit. Rule = turnover > FEE_TURNOVER_MAX_PCT AND TVL < FEE_TURNOVER_TVL_BELOW_USD.
// Pure function used by the shared screening (dry run and live). Missing fee data -> not blocked (cannot be evaluated).
function evaluate(pool, cfg = {}) {
  const maxPct = Number(cfg.FEE_TURNOVER_MAX_PCT ?? 0);
  if (!(maxPct > 0)) return { ok: true, off: true };
  const fees = Number(pool?.fees?.['24h']), tvl = Number(pool?.tvl);
  if (!Number.isFinite(fees) || !(tvl > 0)) return { ok: true, unknown: true };
  const pct = 100 * fees / tvl, cap = Number(cfg.FEE_TURNOVER_TVL_BELOW_USD ?? 0);
  if (pct > maxPct && (!(cap > 0) || tvl < cap)) return { ok: false, pct, why: `fee turnover 24h ${pct.toFixed(0)}% > ${maxPct}%${cap > 0 ? ` (tvl $${Math.round(tvl)} < $${cap})` : ''}` };
  return { ok: true, pct };
}
module.exports = { evaluate };
