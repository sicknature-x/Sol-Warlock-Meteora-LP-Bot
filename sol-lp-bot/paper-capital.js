// Pure paper-capital helpers: 500 USDC book, extra SOL bought at open for rent/gas, all SOL
// swapped back to USDC at close. No network, no wallet, no signing.
'use strict';

const POSITION_RENT_SOL = 0.05740608;
const ATA_RENT_SOL = 0.00203928;
const BIN_ARRAY_RENT_SOL = 0.07143744;
const DEFAULT_TX_FEE_SOL = 0.000025;
const DEFAULT_USDC_START = 0; // fresh installs start at $0 until modal is set / capital added
const DEFAULT_USDC_BUFFER = 0.10;
// Floor for extra SOL bought at open. Covers position+ATA rent, two bin arrays,
// a generous open/reshape/close/swap tx budget, and margin. See computeGasBufferSol().
const DEFAULT_GAS_BUFFER_SOL = 0.30;
const DEFAULT_MARGIN = 1.15;
const OPEN_TXS = 2;
const CLOSE_TXS = 3;
const SWAP_TXS = 3; // USDC->SOL open, token->SOL close, SOL->USDC close
const RESHAPE_TXS_BUDGET = 15 * 5; // up to ~15 N5 reshapes, ~5 txs each

function computeGasBufferSol(opts = {}) {
  const rentRefundable = opts.rentRefundable != null ? +opts.rentRefundable : (POSITION_RENT_SOL + ATA_RENT_SOL);
  const rentNonRefundable = opts.rentNonRefundable != null ? +opts.rentNonRefundable : (2 * BIN_ARRAY_RENT_SOL);
  const txFee = opts.txFee != null ? +opts.txFee : DEFAULT_TX_FEE_SOL;
  const openTxs = opts.openTxs != null ? +opts.openTxs : OPEN_TXS;
  const closeTxs = opts.closeTxs != null ? +opts.closeTxs : CLOSE_TXS;
  const swapTxs = opts.swapTxs != null ? +opts.swapTxs : SWAP_TXS;
  const reshapeTxs = opts.reshapeTxs != null ? +opts.reshapeTxs : RESHAPE_TXS_BUDGET;
  const margin = opts.margin != null ? +opts.margin : DEFAULT_MARGIN;
  const floor = opts.floor != null ? +opts.floor : DEFAULT_GAS_BUFFER_SOL;
  const txs = (openTxs + closeTxs + swapTxs + reshapeTxs) * txFee;
  const raw = rentRefundable + rentNonRefundable + txs;
  const needed = raw * margin;
  const buffer = Math.max(floor, needed);
  return {
    buffer,
    needed,
    floor,
    raw,
    margin,
    breakdown: { rentRefundable, rentNonRefundable, txs, openTxs, closeTxs, swapTxs, reshapeTxs, txFee },
  };
}

function parseQuote(q, inDec, outDec) {
  if (!q || q.outAmount == null) return { ok: false, error: (q && q.error) || 'quote missing' };
  const inAmount = +q.inAmount || 0;
  const outAmount = +q.outAmount || 0;
  const inUi = inAmount / 10 ** inDec;
  const outUi = outAmount / 10 ** outDec;
  return {
    ok: true,
    inUi,
    outUi,
    inAmount,
    outAmount,
    impact: +(q.priceImpactPct || 0),
  };
}

function swapCostUsd({ inUi, outUi, inIsUsd, outIsUsd, solUsd }) {
  const inUsd = inIsUsd ? inUi : inUi * solUsd;
  const outUsd = outIsUsd ? outUi : outUi * solUsd;
  if (!(solUsd > 0) && (!inIsUsd || !outIsUsd)) return null;
  return inUsd - outUsd;
}

// How much USDC to spend so the quote covers position (capped) plus extra SOL for rent/gas.
function planOpenSpend({ usdcCash, usdcBuffer = DEFAULT_USDC_BUFFER, capUsd, extraSol, solUsd, slippagePad = 1.01 }) {
  const avail = Math.max(0, (+usdcCash || 0) - (+usdcBuffer || 0));
  if (!(solUsd > 0) || !(extraSol >= 0)) return { ok: false, why: 'sol price or gas buffer missing' };
  const extraUsd = extraSol * solUsd * slippagePad;
  if (avail <= extraUsd) return { ok: false, why: 'not enough USDC after gas buffer', avail, extraUsd };
  const cap = capUsd != null && capUsd > 0 ? capUsd : Infinity;
  const usdcForPosition = Math.min(avail - extraUsd, cap);
  if (!(usdcForPosition > 1)) return { ok: false, why: 'position USDC too small after cap/buffer', usdcForPosition };
  const usdcToSwap = Math.min(avail, usdcForPosition + extraUsd);
  return {
    ok: true,
    avail,
    usdcForPosition,
    extraUsd,
    usdcToSwap,
    capped: cap < Infinity && usdcForPosition + 1e-9 < (avail - extraUsd),
  };
}

// Split bought SOL into deposit vs leftover reserve after paying open rent + open tx fees.
function allocateOpenSol(solBought, { rentRef = 0, rentNon = 0, openFees = 0, extraSol = 0 } = {}) {
  const openCost = (+rentRef || 0) + (+rentNon || 0) + (+openFees || 0);
  const leftoverAfterCost = (+solBought || 0) - openCost;
  if (!(leftoverAfterCost > 0)) {
    return { ok: false, why: 'bought SOL cannot cover rent and open fees', solBought, openCost };
  }
  const reserveTarget = Math.max(0, (+extraSol || 0) - openCost);
  const reserve = Math.min(leftoverAfterCost, reserveTarget);
  const deposit = leftoverAfterCost - reserve;
  if (!(deposit > 0)) {
    return { ok: false, why: 'no SOL left to deposit after rent/gas reserve', solBought, openCost, reserve };
  }
  return { ok: true, deposit, reserve, openCost, rentRef, rentNon, openFees };
}

function closeSolPile({ positionSol = 0, leftoverSol = 0, rentRefund = 0, closeFees = 0 } = {}) {
  const pile = (+positionSol || 0) + (+leftoverSol || 0) + (+rentRefund || 0) - (+closeFees || 0);
  return pile;
}

function closeRoundTrip({
  usdcIn,
  usdcOut,
  openSwapCostUsd = 0,
  tokenSwapCostUsd = 0,
  solSwapCostUsd = 0,
  gasUsedSol = 0,
  solUsd,
} = {}) {
  const swapCostUsd = (+openSwapCostUsd || 0) + (+tokenSwapCostUsd || 0) + (+solSwapCostUsd || 0);
  const pnlUsd = (+usdcOut || 0) - (+usdcIn || 0);
  const pnlPct = usdcIn > 0 ? (pnlUsd / usdcIn) * 100 : 0;
  const pnlSolEq = solUsd > 0 ? pnlUsd / solUsd : null;
  const pnlUsdAfterGas = solUsd > 0 ? pnlUsd - (+gasUsedSol || 0) * solUsd : pnlUsd;
  return {
    usdcIn: +usdcIn || 0,
    usdcOut: +usdcOut || 0,
    swapCostUsd,
    gasUsedSol: +gasUsedSol || 0,
    pnlUsd,
    pnlPct,
    pnlSolEq,
    pnlUsdAfterGas,
  };
}

function gasUsedSol({ rentPaid = 0, rentRefunded = 0, networkFees = 0 } = {}) {
  return Math.max(0, (+rentPaid || 0) - (+rentRefunded || 0) + (+networkFees || 0));
}

function emptyVirtual(usdcStart = DEFAULT_USDC_START) {
  return {
    usdcStart,
    usdc: usdcStart,
    sol: 0,
  };
}

module.exports = {
  POSITION_RENT_SOL,
  ATA_RENT_SOL,
  BIN_ARRAY_RENT_SOL,
  DEFAULT_TX_FEE_SOL,
  DEFAULT_USDC_START,
  DEFAULT_USDC_BUFFER,
  DEFAULT_GAS_BUFFER_SOL,
  DEFAULT_MARGIN,
  computeGasBufferSol,
  parseQuote,
  swapCostUsd,
  planOpenSpend,
  allocateOpenSol,
  closeSolPile,
  closeRoundTrip,
  gasUsedSol,
  emptyVirtual,
};
