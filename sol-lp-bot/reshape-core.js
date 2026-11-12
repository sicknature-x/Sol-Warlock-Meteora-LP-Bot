// Pure inventory helpers for same-position M-reshape. No RPC, no keys, no signing.
// Token Bid-Ask is always [active+1, origMaxBinId] — the position's original upper edge.

function tokenReshapeRange(origMaxBinId, activeBin) {
  const rightMin = activeBin + 1;
  const rightMax = origMaxBinId;
  return { rightMin, rightMax, ok: rightMax >= rightMin };
}

function reshapeTxCount({ compoundedSol }) {
  // claim + remove token bins + add token Bid-Ask, plus add SOL compound when fees were added on the left
  return 3 + (compoundedSol ? 1 : 0);
}

function sumXY(bins) {
  let x = 0, y = 0;
  for (const b of Object.values(bins || {})) { x += b.x || 0; y += b.y || 0; }
  return { x, y };
}

function withdrawTokenSide(bins, activeBin) {
  let tokenX = 0;
  const ids = [];
  for (const [id, b] of Object.entries(bins || {})) {
    const binId = +id;
    if (binId > activeBin && (b.x || 0) > 0) {
      tokenX += b.x;
      b.x = 0;
      ids.push(binId);
    }
  }
  ids.sort((a, b) => a - b);
  return { tokenX, ids };
}

function applyTokenReadd(bins, rows, activeBin, origMaxBinId, expectedX) {
  let placed = 0;
  for (const r of rows || []) {
    if (r.binId <= activeBin || r.binId > origMaxBinId) continue;
    const row = bins[r.binId] || { x: 0, y: 0, binPrice: r.binPrice };
    row.x = (row.x || 0) + (r.x || 0);
    if (!row.binPrice && r.binPrice) row.binPrice = r.binPrice;
    bins[r.binId] = row;
    placed += r.x || 0;
  }
  const dust = (expectedX || 0) - placed;
  if (dust > 1e-12 && origMaxBinId > activeBin) {
    const row = bins[origMaxBinId] || { x: 0, y: 0 };
    row.x = (row.x || 0) + dust;
    bins[origMaxBinId] = row;
    placed += dust;
  }
  return { placed };
}

function maxOccupiedBin(bins) {
  let m = -Infinity;
  for (const [id, b] of Object.entries(bins || {})) {
    if ((b.x || 0) > 1e-18 || (b.y || 0) > 1e-18) m = Math.max(m, +id);
  }
  return m;
}

function applySolCompoundToLeft(bins, rows, activeBin) {
  let added = 0;
  for (const r of rows || []) {
    if (r.binId >= activeBin) continue;
    const row = bins[r.binId] || { x: 0, y: 0, binPrice: r.binPrice };
    row.y = (row.y || 0) + (r.y || 0);
    if (!row.binPrice && r.binPrice) row.binPrice = r.binPrice;
    bins[r.binId] = row;
    added += r.y || 0;
  }
  return { added };
}

function claimFees(pos) {
  return { feeX: pos.feeX || 0, feeY: pos.feeY || 0 };
}

function resetClaimedFees(pos) {
  pos.feeX = 0;
  pos.feeY = 0;
}

// Equal-weight fallback (tests / conservation). Production uses SDK Bid-Ask for the same range.
function equalSplitX(rightMin, rightMax, amountX) {
  const n = rightMax - rightMin + 1;
  if (n <= 0) return [];
  return Array.from({ length: n }, (_, i) => ({ binId: rightMin + i, x: amountX / n, y: 0 }));
}

function bidAskHeavyRightX(rightMin, rightMax, amountX) {
  const n = rightMax - rightMin + 1;
  if (n <= 0) return [];
  const weights = Array.from({ length: n }, (_, i) => i + 1); // heavier at far right
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((w, i) => ({ binId: rightMin + i, x: amountX * w / sum, y: 0 }));
}

function equalSplitY(leftMin, leftMax, amountY) {
  const n = leftMax - leftMin + 1;
  if (n <= 0 || !(amountY > 0)) return [];
  return Array.from({ length: n }, (_, i) => ({ binId: leftMin + i, x: 0, y: amountY / n }));
}

/**
 * Apply one reshape to a virtual position using provided row distributors.
 * Claimed feeX is included in the token re-add; claimed feeY goes to the left; fees are reset.
 */
function applyReshapeInventory(pos, { activeBin, tokenRows, solRows }) {
  const range = tokenReshapeRange(pos.origMaxBinId, activeBin);
  if (!range.ok) return { skipped: 'no room on the right within original position edge', ...range };

  const { feeX, feeY } = claimFees(pos);
  const { x: xBefore } = sumXY(pos.bins);
  const { tokenX } = withdrawTokenSide(pos.bins, activeBin);
  const amountX = tokenX + feeX;

  if (!(amountX > 0) && !(feeY > 0)) return { skipped: 'no token-side inventory or fees to reshape', tokenX, feeX, feeY, ...range };

  const rows = tokenRows || bidAskHeavyRightX(range.rightMin, range.rightMax, amountX);
  applyTokenReadd(pos.bins, rows, activeBin, pos.origMaxBinId, amountX);

  let compoundedSol = 0;
  if (feeY > 0) {
    const leftRows = solRows || equalSplitY(pos.minBinId, activeBin - 1, feeY);
    const r = applySolCompoundToLeft(pos.bins, leftRows, activeBin);
    compoundedSol = r.added;
    pos.feesCompoundedSol = (pos.feesCompoundedSol || 0) + feeY;
  }
  pos.feesCompoundedX = (pos.feesCompoundedX || 0) + feeX;
  resetClaimedFees(pos);

  const { x: xAfter, y: yAfter } = sumXY(pos.bins);
  const txs = reshapeTxCount({ compoundedSol: feeY > 0 });
  return {
    ok: true,
    rightMin: range.rightMin,
    rightMax: range.rightMax,
    tokenX,
    feeXAdded: feeX,
    feeYAdded: feeY,
    amountX,
    xBefore,
    xAfter,
    yAfter,
    txs,
    maxOccupiedBin: maxOccupiedBin(pos.bins),
    feesReset: pos.feeX === 0 && pos.feeY === 0,
  };
}

module.exports = {
  tokenReshapeRange, reshapeTxCount, sumXY, withdrawTokenSide, applyTokenReadd,
  maxOccupiedBin, applySolCompoundToLeft, claimFees, resetClaimedFees,
  equalSplitX, bidAskHeavyRightX, equalSplitY, applyReshapeInventory,
};
