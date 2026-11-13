'use strict';
// Reclaim the rent (~0.00203928 SOL each) locked in EMPTY SPL token accounts of the bot wallet. Safe path:
//  - scan() is read-only; claim() is only reached from an authenticated, confirmed miniapp POST (never automatic, never run by tooling).
//  - works any time (live ON or OFF): mints of positions still open in the live state are never touched, so a bot mid-flow keeps its accounts.
//  - only classic SPL Token accounts owned by this wallet with amount == 0, no delegate, no close authority other than the wallet, not wSOL (native), not the USDC account.
//  - the rent ALWAYS goes back to the wallet itself (destination = owner); nothing else can be a destination.
//  - every transaction is simulated first; the first simulation error aborts the whole run; a fresh re-scan happens right before sending.
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const BATCH = 6;          // close instructions per transaction (well under the size limit)
const MAX_ACCOUNTS = 60;  // per click; a second click continues

// Pure: decide whether one parsed token account may be closed. `a` = element of getParsedTokenAccountsByOwner().value
function classify(a, owner, protectedMints) {
  const info = a && a.account && a.account.data && a.account.data.parsed && a.account.data.parsed.info;
  if (!info) return { ok: false, why: 'unparsed' };
  if (a.account.owner && String(a.account.owner) !== TOKEN_PROGRAM) return { ok: false, why: 'not-classic-spl' };
  if (String(info.owner) !== String(owner)) return { ok: false, why: 'owner-mismatch' };
  if (info.state && info.state !== 'initialized') return { ok: false, why: 'state-' + info.state };
  if (String(info.tokenAmount && info.tokenAmount.amount) !== '0') return { ok: false, why: 'has-balance' };
  if (info.isNative) return { ok: false, why: 'native-wsol' };
  if (info.mint === USDC) return { ok: false, why: 'usdc-kept' };
  if (protectedMints && protectedMints.has(info.mint)) return { ok: false, why: 'protected-open-position' };
  if (info.mint === WSOL) return { ok: false, why: 'wsol-kept' };
  if (info.delegate && Number(info.delegatedAmount && info.delegatedAmount.amount) > 0) return { ok: false, why: 'has-delegate' };
  if (info.closeAuthority && String(info.closeAuthority) !== String(owner)) return { ok: false, why: 'foreign-close-authority' };
  const lamports = Number(a.account.lamports);
  if (!Number.isFinite(lamports) || lamports <= 0) return { ok: false, why: 'no-lamports' };
  return { ok: true, mint: info.mint, lamports };
}

async function scan({ conn, owner, PublicKey, protectedMints }) {
  const pk = new PublicKey(String(owner));
  const res = await conn.getParsedTokenAccountsByOwner(pk, { programId: new PublicKey(TOKEN_PROGRAM) });
  const accounts = [], skipped = {};
  for (const a of res.value) {
    const c = classify(a, pk.toBase58(), protectedMints);
    if (c.ok) accounts.push({ pubkey: a.pubkey.toBase58 ? a.pubkey.toBase58() : String(a.pubkey), mint: c.mint, lamports: c.lamports });
    else skipped[c.why] = (skipped[c.why] || 0) + 1;
  }
  const totalLamports = accounts.reduce((n, x) => n + x.lamports, 0);
  return { owner: pk.toBase58(), total: res.value.length, count: accounts.length, accounts, skipped, totalLamports, totalSol: totalLamports / 1e9 };
}

const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

// deps: { conn, keypair, web3:{PublicKey,Transaction}, spl:{createCloseAccountInstruction}, send(tx)->signature, simulate(tx)->{err}, log }
async function claim(deps) {
  const { conn, keypair, web3, spl, send, simulate, protectedMints, log = () => {} } = deps;
  const owner = keypair.publicKey;
  const fresh = await scan({ conn, owner: owner.toBase58(), PublicKey: web3.PublicKey, protectedMints });   // never trust a stale preview
  const todo = fresh.accounts.slice(0, MAX_ACCOUNTS);
  if (!todo.length) return { ok: true, closed: 0, reclaimedSol: 0, signatures: [], note: 'tidak ada token account kosong' };
  const txs = chunk(todo, BATCH).map(group => {
    const tx = new web3.Transaction();
    for (const a of group) tx.add(spl.createCloseAccountInstruction(new web3.PublicKey(a.pubkey), owner, owner, []));
    return { tx, group };
  });
  // 1) simulate everything first; any error aborts before anything is sent
  for (const { tx, group } of txs) {
    const sim = await simulate(tx, group);
    if (sim && sim.err) return { ok: false, error: 'simulasi gagal, tidak ada transaksi dikirim', detail: JSON.stringify(sim.err).slice(0, 200), closed: 0, signatures: [] };
  }
  // 2) send one by one; stop at the first failure and report exactly what was closed
  const signatures = []; let closed = 0, lamports = 0;
  for (const { tx, group } of txs) {
    try { const sig = await send(tx, group); signatures.push(sig); closed += group.length; lamports += group.reduce((n, a) => n + a.lamports, 0); log('rent claim tx ' + sig); }
    catch (e) { return { ok: false, error: 'kirim gagal: ' + String(e && e.message || e).slice(0, 160), closed, reclaimedSol: lamports / 1e9, signatures }; }
  }
  return { ok: true, closed, reclaimedSol: lamports / 1e9, signatures, remaining: Math.max(0, fresh.count - closed) };
}

module.exports = { classify, scan, claim, chunk, USDC, WSOL, TOKEN_PROGRAM, BATCH, MAX_ACCOUNTS };
