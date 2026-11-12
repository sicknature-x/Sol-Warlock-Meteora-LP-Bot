'use strict';
// Entry geometry for live = the dry run's (paperOpenSingle / paperOpenUsdc): the SAME strategy.geometry, the SAME range formula, the SAME OPEN_SHAPE / OPEN_SPOT_PCT split.
// Pure: no IO, no chain. liveOpen (bot.js) and the tests both call this.
const POSITION_LIMIT = 70;   // bins in a standard DLMM position; a wider range needs an extended position (createExtendedEmptyPosition + addLiquidityByStrategyChunkable)
function planEntry({ strategy, binStep, activeBinId, policy, maxBins }) {
  const g = strategy.geometry(binStep, policy, maxBins);         // throws when the range cannot be built (same as the dry run)
  const minBinId = activeBinId - g.n + 1;                        // paperOpenSingle: const minBinId = active.binId - n + 1
  const maxBinId = activeBinId + g.upper;                        // paperOpenSingle: active.binId + upper (token-side buffer above the entry active bin)
  const width = maxBinId - minBinId + 1;
  const split = policy.OPEN_SHAPE === 'SPOT' ? 1 : policy.OPEN_SHAPE === 'BIDASK' ? 0 : (policy.OPEN_SPOT_PCT ?? 50) / 100;   // paperOpenSingle: split
  return { n: g.n, upper: g.upper, minBinId, maxBinId, width, wide: width > POSITION_LIMIT, split, geometry: g };
}
module.exports = { planEntry, POSITION_LIMIT };
