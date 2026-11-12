'use strict';
// The ORDER of on-chain calls for the entry deposit. It signs nothing itself: every chain call goes through the injected dlmm / send / wallet,
// so the exact sequence (create -> Spot share -> BidAsk share; narrow or extended position) is unit-tested with a fake DLMM.
// Dry run MIXED shape = Spot share first, then BidAsk share (OPEN_SPOT_PCT). A share of 0 is skipped; the shares sum EXACTLY to the planned lamports.
async function openDeposit({ dlmm, plan, actualSol, posKp, wallet, send, BN, StrategyType, lamports = 1e9, slippage, onCreated, log = () => {} }) {
  const total = Math.floor(actualSol * lamports);
  const spotLam = Math.floor(total * plan.split), bidLam = total - spotLam;
  const parts = [];
  if (spotLam > 0) parts.push({ type: StrategyType.Spot, name: 'spot', lam: spotLam });
  if (bidLam > 0) parts.push({ type: StrategyType.BidAsk, name: 'bidask', lam: bidLam });
  if (!parts.length) throw new Error('nothing to deposit');
  const paramsFor = part => ({ positionPubKey: posKp.publicKey, totalXAmount: new BN(0), totalYAmount: new BN(part.lam), strategy: { minBinId: plan.minBinId, maxBinId: plan.maxBinId, strategyType: part.type }, user: wallet.publicKey, slippage });
  let deposited = 0, complete = true, created = false;   // created = the position exists on chain
  for (const [i, part] of parts.entries()) {
    const params = paramsFor(part);
    try {
      if (i === 0) {
        if (!plan.wide) {
          const tx = await dlmm.initializePositionAndAddLiquidityByStrategy(params);
          await send(tx, [wallet, posKp], 'open-' + part.name); created = true;
        } else {
          const tx0 = await dlmm.createExtendedEmptyPosition(plan.minBinId, plan.maxBinId, posKp.publicKey, wallet.publicKey);
          await send(tx0, [wallet, posKp], 'open-extended-empty'); created = true;
          await onCreated({ depositedLamports: 0 });                       // the position exists on chain: record it before depositing
          const txs = await dlmm.addLiquidityByStrategyChunkable(params);
          for (const [j, t] of txs.entries()) await send(t, [wallet], `add-${part.name} ${j + 1}/${txs.length}`);
        }
        deposited += part.lam;
        if (!plan.wide) await onCreated({ depositedLamports: deposited }); // narrow: created together with the first deposit
        else await onCreated({ depositedLamports: deposited, update: true });
      } else {
        if (!plan.wide) { const tx = await dlmm.addLiquidityByStrategy(params); await send(tx, [wallet], 'add-' + part.name); }
        else { const txs = await dlmm.addLiquidityByStrategyChunkable(params); for (const [j, t] of txs.entries()) await send(t, [wallet], `add-${part.name} ${j + 1}/${txs.length}`); }
        deposited += part.lam;
      }
    } catch (e) {
      if (!created) throw e;                                                // nothing exists on chain yet: the caller aborts
      log(`  WARN ${part.name} add failed, position holds only ${deposited / lamports} SOL: ${e.message}`);
      complete = false; break;
    }
  }
  return { complete, depositedLamports: deposited, totalLamports: total, parts: parts.map(p => ({ name: p.name, lam: p.lam })) };
}
module.exports = { openDeposit };
