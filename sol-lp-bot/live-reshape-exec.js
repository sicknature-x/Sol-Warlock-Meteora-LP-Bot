'use strict';
// Reshape + compound for live == paperReshape (dry run). Same trigger (price down N bins from lastReshapeActiveBin ?? entryActiveBin),
// same guard (leftover SOL must cover the tx fees), same range (reshape-core.tokenReshapeRange: [active+1 .. origMaxBinId]),
// same steps on the SAME position: claim fees -> remove ONLY token-side bins (> active) -> re-add token-only (RESHAPE_SHAPE) -> compound claimed quote fees to the left (COMPOUND_SPOT_PCT).
// Every chain call is injected (dlmm / send / wallet balances), so the sequence is unit-tested with fakes; this module signs nothing.
const core = require('./reshape-core');
function trigger({ pos, activeBinId, settings, stop }) {
  if (stop || settings.RESHAPE_ENABLED === false) return { due: false };
  const n = settings.RESHAPE_N ?? 5, anchor = pos.lastReshapeActiveBin ?? pos.entryActiveBin, down = anchor - activeBinId;
  return { due: down >= n, down, n, anchor };
}
async function reshape({ pos, positionKey, slippage, dlmm, positionData, activeBinId, settings, txFee, StrategyType, BN, wallet, send, getTokenRaw, getSolBalance, sleep = async () => {}, log = () => {}, retries = 3 }) {
  const compoundOn = settings.COMPOUND_ENABLED !== false;
  const d = positionData, decX = pos.decX;
  const qDec = 10 ** (pos.quoteDecimals ?? 9), feeXui = Number(d.feeX.toString()) / 10 ** decX, feeYui = Number(d.feeY.toString()) / qDec;   // quote decimals: 9 SOL pool, 6 USDC pool
  const txsGuess = core.reshapeTxCount({ compoundedSol: compoundOn && feeYui > 0 }), txCostGuess = txsGuess * txFee;
  const pile = pos.leftoverSol != null ? pos.leftoverSol : Math.max(0, (await getSolBalance()) - (pos.walletBefore || 0));   // = the dry run's book.virtual.sol: THIS position's own SOL
  if (pile + 1e-12 < txCostGuess) return { skipped: 'leftover SOL buffer cannot cover reshape tx fees', leftoverSol: pile, txCostGuess };
  const range = core.tokenReshapeRange(pos.origMaxBinId, activeBinId);
  const tokenBins = (d.positionBinData || []).filter(b => b.binId > activeBinId && Number(b.positionXAmount) > 0).sort((a, b) => a.binId - b.binId);
  const tokenOnChain = tokenBins.reduce((s, b) => s + Number(b.positionXAmount), 0) / 10 ** decX;
  if (!(tokenOnChain + (compoundOn ? feeXui : 0) > 0)) return { skipped: 'no token-side inventory or token fees to reshape', ...range };
  if (!range.ok) return { skipped: 'no room on the right within original position edge', ...range };   // checked BEFORE withdrawing: nothing is taken out
  const run = async (name, fn) => { let last; for (let i = 1; i <= retries; i++) { try { return await fn(); } catch (e) { last = e; log(`  reshape ${name} failed (${i}/${retries}): ${e.message}`); await sleep(2000); } } throw last; };
  const tokenBefore = await getTokenRaw();
  const owner = wallet.publicKey, position = positionKey || pos.position;
  // 1) claim all fees (token fees feeX and quote fees feeY land in the wallet)
  const claimTxs = await run('claim', async () => { const t = await dlmm.claimSwapFee({ owner, position }); return Array.isArray(t) ? t : [t]; });
  for (const [i, tx] of claimTxs.entries()) await run('claim send', () => send(tx, [wallet], `reshape-claim ${i + 1}/${claimTxs.length}`));
  // 2) withdraw ONLY the token-side bins (> active); the quote side is never withdrawn
  if (tokenBins.length) {
    const rm = await run('remove token bins', () => dlmm.removeLiquidity({ user: owner, position, fromBinId: tokenBins[0].binId, toBinId: tokenBins[tokenBins.length - 1].binId, bps: new BN(10000), shouldClaimAndClose: false }));
    for (const [i, tx] of rm.entries()) await run('remove send', () => send(tx, [wallet], `reshape-remove ${i + 1}/${rm.length}`));
  }
  await sleep(2000);
  const amountRaw = (await getTokenRaw()) - tokenBefore;       // withdrawn X + claimed feeX (feeX only when compound is on, like the dry run)
  const feeXRaw = BigInt(Math.floor(feeXui * 10 ** decX));
  const readdRaw = compoundOn ? amountRaw : amountRaw - (feeXRaw < amountRaw ? feeXRaw : amountRaw);
  const shape = settings.RESHAPE_SHAPE === 'SPOT' ? StrategyType.Spot : StrategyType.BidAsk;
  let tokenAdded = false, errors = [];
  pos.reshapePending = readdRaw > 0n ? { amountRaw: readdRaw.toString(), rightMin: range.rightMin, rightMax: range.rightMax, shape: settings.RESHAPE_SHAPE || 'BIDASK' } : null;   // persisted by the caller: a crash/failure after the withdrawal can resume
  if (readdRaw > 0n) {
    try { await readd({ dlmm, pos, owner, position, StrategyType, BN, wallet, send, run, plan: pos.reshapePending, slippage }); tokenAdded = true; pos.reshapePending = null; }
    catch (e) { errors.push('token re-add: ' + e.message); log('  ERROR reshape token re-add failed; tokens stay in the wallet, retried next poll: ' + e.message); }
  }
  // 3) compound claimed quote fees to the LEFT bins (add only), COMPOUND_SPOT_PCT split like the dry run
  let compounded = 0;
  if (compoundOn && feeYui >= 1e-8 && (tokenAdded || readdRaw === 0n)) {
    if (activeBinId > pos.minBinId) {
      const w = (settings.COMPOUND_SPOT_PCT ?? 50) / 100, totalLam = Math.floor(feeYui * qDec), spotLam = Math.floor(totalLam * w), bidLam = totalLam - spotLam;
      try {
        for (const [type, lam, nm] of [[StrategyType.Spot, spotLam, 'spot'], [StrategyType.BidAsk, bidLam, 'bidask']]) {
          if (!(lam > 0)) continue;
          const txs = await run('compound add ' + nm, async () => { const t = await dlmm.addLiquidityByStrategyChunkable({ positionPubKey: position, totalXAmount: new BN(0), totalYAmount: new BN(lam), strategy: { minBinId: pos.minBinId, maxBinId: activeBinId - 1, strategyType: type }, user: owner, slippage }); return Array.isArray(t) ? t : [t]; });
          for (const [i, tx] of txs.entries()) await run('compound send', () => send(tx, [wallet], `reshape-compound-${nm} ${i + 1}/${txs.length}`));
        }
        compounded = feeYui;
      } catch (e) { errors.push('compound: ' + e.message); log('  ERROR compound failed, fees stay in the wallet pile: ' + e.message); }
    } else log('  cannot compound quote fees to the left: no bins below active (dry run would extend the position lower; live keeps the fees in the pile)');
  }
  return { ok: tokenAdded || readdRaw === 0n, tokenAdded, compounded, errors, range, amountX: Number(readdRaw) / 10 ** decX, feeXAdded: compoundOn ? feeXui : 0, txs: txsGuess, txCost: txsGuess * txFee, tokenBins: tokenBins.length };
}
async function readd({ dlmm, owner, position, StrategyType, BN, wallet, send, run, plan, slippage }) {
  const type = plan.shape === 'SPOT' ? StrategyType.Spot : StrategyType.BidAsk;
  const txs = await run('token add', async () => { const t = await dlmm.addLiquidityByStrategyChunkable({ positionPubKey: position, totalXAmount: new BN(plan.amountRaw), totalYAmount: new BN(0), strategy: { minBinId: plan.rightMin, maxBinId: plan.rightMax, strategyType: type }, user: owner, slippage }); return Array.isArray(t) ? t : [t]; });
  for (const [i, tx] of txs.entries()) await run('token add send', () => send(tx, [wallet], `reshape-add-token ${i + 1}/${txs.length}`));
}
// Resume a re-add that was interrupted after the withdrawal (position keeps reshapePending until it succeeds).
async function resumePending(args) {
  const { pos } = args; if (!pos.reshapePending) return { resumed: false };
  const run = async (name, fn) => { let last; for (let i = 1; i <= 3; i++) { try { return await fn(); } catch (e) { last = e; await (args.sleep || (async () => {}))(2000); } } throw last; };
  await readd({ ...args, owner: args.wallet.publicKey, position: args.positionKey || pos.position, run, plan: pos.reshapePending });
  pos.reshapePending = null; return { resumed: true };
}
module.exports = { trigger, reshape, resumePending };
