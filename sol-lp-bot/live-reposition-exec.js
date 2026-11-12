'use strict';
// OOR-right reposition for live == paperRepositionRight (dry run): close this leg to USDC, then open a NEW position on the same pool with
// ONLY this leg's proceeds as budget (never newly topped-up cash), same strategySettings, and carry the accounting (initialUsdcIn, realizedPnlCarryUsd, fees carry,
// openedAt, peaks, rightRepositions). The pool is checked (fetch + sanity + proceeds > 1 USDC) BEFORE anything is closed, so a bad pool defers the reposition and the
// old position stays open (retry next poll), like the dry run. All IO is injected; this module signs nothing.
function carryFields(old, leg, pos, number, pxUsd) {
  const feesUsd = (old.feesCarryUsd || 0) + (leg.row?.feesSol || 0) * (pxUsd || 0);
  const set = {
    initialUsdcIn: old.initialUsdcIn || old.usdcIn,
    realizedPnlCarryUsd: (old.realizedPnlCarryUsd || 0) + leg.usdcOut - old.usdcIn,
    feesCarryUsd: feesUsd, swapCostCarryUsd: old.swapCostCarryUsd || 0, gasCarrySol: old.gasCarrySol || 0,
    riskEntryPrice: old.riskEntryPrice || old.entryPrice,
    legOpenedAt: pos.openedAt, openedAt: old.openedAt, entryWib: old.entryWib,
    rightRepositions: number, oorRightPolls: 0,
    openContext: old.openContext, openSource: old.openSource, openReason: old.openReason,
    initialEntryQuoteAmount: old.initialEntryQuoteAmount || old.entryQuoteAmount || old.depositSol,
  };
  for (const k of ['peakPnlCapital', 'peakPnlUsd', 'peakPnlPctUsdc', 'peakPnlAt']) if (old[k] != null) set[k] = old[k];
  Object.assign(pos, set); return set;
}
async function reposition({ state, val, settings, pxUsd, deps }) {
  const old = state.position, number = (old.rightRepositions || 0) + 1, { log = () => {}, now = () => new Date().toISOString() } = deps;
  let pool;
  try {
    pool = await deps.fetchPool(old.pool);
    const bad = deps.sanityReason(pool, settings.MIN_LIQ_USD); if (bad) throw new Error(bad);
    if (!(Math.max(0, val.usdcOut) > 1)) throw new Error('Proceeds too small to reposition');
  } catch (e) {
    old.repositionRetryCount = (old.repositionRetryCount || 0) + 1; old.repositionRetryAt = now();
    old.repositionRetryError = String(e.message).replace(/https?:\/\/\S+/g, '[endpoint]').slice(0, 160);
    log(`reposition kanan ditunda ${old.name}: ${old.repositionRetryError}; retry=${old.repositionRetryCount}; posisi lama tetap terbuka`);
    return { done: false, deferred: true };
  }
  const leg = await deps.closeLeg(state);                       // intermediate close: no history row, position object stays until replaced
  const proceeds = Math.max(0, leg.usdcOut);
  state.position = null;
  let opened = null;
  try { opened = await deps.openNew(pool, { source: 'reposition', strategySettings: old.strategySettings, positionBudgetUsdc: proceeds }); }
  catch (e) { log('reposition reopen error: ' + e.message); }
  if (!state.position) {                                         // the leg is already closed on chain: it becomes an ordinary close, never a lost trade
    const row = { ...leg.row, reason: 'oor_right_reposition_failed_reopen' };
    state.history.push(row); log(`ERROR reposition ${old.name}: reopen failed after the leg closed (${opened?.skipped || opened?.error || 'no position'}); recorded as a normal close, cash is USDC`);
    return { done: true, reopened: false, row };
  }
  const set = carryFields(old, leg, state.position, number, pxUsd);
  log(`REPOSITION KANAN #${number} ${old.name}: range ${state.position.minBinId}..${state.position.maxBinId}; carryPnL=${set.realizedPnlCarryUsd.toFixed(4)} USDC`);
  return { done: true, reopened: true, number, set };
}
module.exports = { reposition, carryFields };
