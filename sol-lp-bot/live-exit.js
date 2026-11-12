'use strict';
// Live exit DECISIONS use exactly the dry-run code (Tuan rule: live == dry run, one behaviour).
//   net USDC PnL : paper-usdc.exitQuote   (same swap-cost / Jupiter-quote model as the dry run)
//   the rule     : paper-exit-policy.decide (SL on net PnL, TP, TP Emergency, TP Emergency SL+ and BEP floor, OOR right, stale, trailing ...)
// This module never signs, sends or reads keys; the quote function and chain amounts are injected. liveClose() (bot.js) executes the returned reason.
const paperUsdc = require('./paper-usdc');
const paperExit = require('./paper-exit-policy');
const SOL = 'So11111111111111111111111111111111111111112';

// Valuation adapter: the dry run simulates bins; live knows the exact on-chain amounts (x token, y SOL, fees) from liveValuation().
function asPaperPos(pos, v) {
  return {
    ...pos,
    bins: { onchain: { x: +v.x || 0, y: +v.y || 0 } },
    feeX: +v.fx || 0, feeY: +v.fy || 0,
    quoteMint: pos.quoteMint || SOL,
    capitalAsset: 'USDC',                       // live capital is USDC -> SOL, same model as the dry run default
    usdcIn: pos.usdcIn, initialUsdcIn: pos.initialUsdcIn ?? pos.usdcIn,
    rentRefundableSol: pos.rentRefundableSol || 0,
    realizedPnlCarryUsd: pos.realizedPnlCarryUsd || 0,
  };
}
async function liveVal({ pos, v, pxUsd, quote, txFee }) {
  return paperUsdc.exitQuote({
    pos: asPaperPos(pos, v),
    book: { virtual: { sol: pos.leftoverSol ?? 0 } },     // SOL left from the open buffer (like book.virtual.sol in the dry run)
    snap: { price: v.price, pxUsd },
    quote, txFee,
  });
}
const policyFor = (pos, CFG) => ({ ...CFG, ...(pos.strategySettings || {}) });   // same as dry run: global settings overlaid by the position's entry snapshot
// Mutates `pos` exactly like the dry run does (peak, deep drawdown, SL+ state, poll counters) so the caller must persist it.
async function decideLiveExit({ pos, v, pxUsd, quote, txFee, CFG, pollId, stopReason = null }) {
  const val = await liveVal({ pos, v, pxUsd, quote, txFee });
  const reason = paperExit.decide({ pos, val, activeBin: v.activeBinId, settings: policyFor(pos, CFG), pollId, stopReason });
  return { reason, val };
}
module.exports = { asPaperPos, liveVal, policyFor, decideLiveExit };
