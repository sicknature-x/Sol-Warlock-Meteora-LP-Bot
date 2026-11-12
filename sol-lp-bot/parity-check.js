'use strict';
// READ-ONLY static check (Tuan rule, 12 Nov 2026): live and dry run must use ONE setting set and ONE behaviour. No live-only strategy knobs.
// Reads bot.js (+ the shared settings schema) only. Never loads state, keys or the network. `node parity-check.js` prints a report; exit 1 on NEW divergence.
const fs = require('fs'), path = require('path');
const ROOT = __dirname;
// Execution infrastructure that may differ between modes (not strategy): mode flags, RPC, fees, polling.
// Code that sends transactions can only be proven on chain. A feature counts as equal to the dry run only after TUAN records a supervised small live test
// (node record-live-verification.js <feature> "what was tested + tx signatures"). Writing the code is never enough to open Go Live.
const REQUIRED_VERIFICATIONS = ['entry-geometry', 'swapback', 'usdc-quoted-pools', 'oor-reposition', 'reshape-compound', 'multi-position'];
function verifications(root) { try { return JSON.parse(fs.readFileSync(path.join(root, 'live-verification.json'), 'utf8')).features || {}; } catch (e) { return {}; } }
const INFRA_OK = new Set(['DRY_RUN', 'PAPER', 'RPC', 'TX_FEE_SOL', 'SLIPPAGE_PCT', 'PRIORITY_MICROLAMPORTS', 'PAPER_USDC', 'PAPER_VIRTUAL_SOL', 'PAPER_DAYS', 'ONCE', 'POLL_SEC']);
// Divergences that exist TODAY and are known (12 Nov 2026). New ones fail the test; fixed ones must be removed from this list.
const KNOWN_DEBT = [
  'unverified:entry-geometry', 'unverified:swapback', 'unverified:usdc-quoted-pools', 'unverified:oor-reposition', 'unverified:reshape-compound', 'unverified:multi-position',   // each needs a supervised small live test recorded by Tuan
];
function block(src, from, toMarker) { const a = src.indexOf(from); if (a < 0) throw Error('marker not found: ' + from); const b = src.indexOf(toMarker, a); if (b < 0) throw Error('end marker not found: ' + toMarker); return src.slice(a, b); }
function analyse(root = ROOT) {
  const src = fs.readFileSync(path.join(root, 'bot.js'), 'utf8');
  // keys the shared settings file overwrites in CFG on every cycle
  const fn = block(src, 'function applyPaperSettings', 'return values;');
  const shared = new Set([...fn.matchAll(/CFG\.([A-Z][A-Z0-9_]+)\s*=/g)].map(m => m[1]));
  for (const m of fn.matchAll(/for\s*\(const k of \[([^\]]*)\]\)/g)) for (const x of m[1].matchAll(/'([A-Z0-9_]+)'/g)) shared.add(x[1]);
  if (/for\(const k of strategy\.KEYS\)/.test(fn)) require(path.join(root, 'paper-strategy')).KEYS.forEach(k => shared.add(k));
  // live code path: from the first live* function to the process entry point
  const first = Math.min(...[...src.matchAll(/async function live[A-Z]\w*/g)].map(m => m.index));
  const end = src.indexOf('(async () => {', src.indexOf('async function liveCycle'));
  const live = src.slice(first, end);
  const usedLive = [...new Set([...live.matchAll(/CFG\.([A-Z][A-Z0-9_]+)/g)].map(m => m[1]))].sort();
  const liveOnly = usedLive.filter(k => !shared.has(k) && !INFRA_OK.has(k));
  const debt = liveOnly.map(k => 'key:' + k);
  // the per-position part (decide / reshape / reposition) lives in livePositionCycle, the open loop in liveCycle: the live cycle is both
  const liveCycleSrc = block(src, 'async function livePositionCycle', 'async function liveCycle') + block(src, 'async function liveCycle', '(async () => {');
  const usesPaperExit = /liveExit\.decideLiveExit\(|paperExit\.decide\(/.test(liveCycleSrc);
  if (!usesPaperExit) debt.push('logic:live-exit-is-not-paper-exit-policy');
  const lo = src.indexOf('async function liveOpen'), liveOpenSrc = src.slice(lo, src.indexOf('async function ', lo + 10));
  if (!/CFG\.POSITION_USDC/.test(liveOpenSrc)) debt.push('logic:live-sizing-ignores-shared-position-budget');
  if (!/liveGeometry\.planEntry\(|strategy\.geometry\(/.test(liveOpenSrc)) debt.push('logic:live-entry-geometry-differs');
  const ver = verifications(root);
  for (const f of REQUIRED_VERIFICATIONS) if (!(ver[f] && ver[f].verifiedBy && ver[f].at)) debt.push('unverified:' + f);
  // screening: performScan is shared, but branches gated on policy.PAPER make live screen differently
  const ps = src.indexOf('async function performScan'); const pe = (() => { const m = /\n(?:async )?function /g; m.lastIndex = ps + 20; const r = m.exec(src); return r ? r.index : src.length; })();
  const paperOnly = src.slice(ps, pe).split('\n').filter(l => /policy\.PAPER/.test(l) && !/screenDiagBusy|screenReasons\.evaluate|mkdirSync|writeFileSync|slBlacklist\.read|scan\.liveHistory/.test(l) && !/^\s*if\s*\(policy\.PAPER\)\s*\{\s*$/.test(l));
  if (paperOnly.length) debt.push('logic:live-screening-has-paper-only-branches');
  for (const need of ['MAX_NONREFUND_SOL', 'MAX_LIQ_USD', 'slBlacklist', 'cooldownReason']) if (!liveOpenSrc.includes(need)) { debt.push('logic:live-open-skips-paper-open-guards'); break; }
  const lc0 = src.indexOf('async function liveClose'), liveCloseSrc = src.slice(lc0, src.indexOf('// ---------- status', lc0));
  if (!/slBlacklist\.add\(|slBlacklist\.isStopLoss\(/.test(liveCloseSrc)) debt.push('logic:live-close-does-not-record-sl-blacklist');
  if (!/liveReposition\w*\(|liveRepositionExec\.reposition\(/.test(src)) debt.push('logic:live-no-oor-reposition');
  // swap back: the dry run valuates token->USDC directly (paper-usdc.exitQuote). Live must execute the same route; a SOL hop or a kept reserve makes it differ.
  if (/liveSwapAllToSol\(|LIVE_SOL_RESERVE/.test(liveCloseSrc)) debt.push('logic:live-swapback-differs');
  if (!/liveReshape\w*\(|liveReshapeExec\.reshape\(/.test(src)) debt.push('logic:live-no-reshape-compound');
  if (!/CFG\.MAX_POSITIONS/.test(liveCycleSrc) || !/livePositions\.selectPicks\(/.test(liveCycleSrc)) debt.push('logic:live-single-position');
  return { sharedCount: shared.size, shared: [...shared].sort(), usedLive, liveOnly, usesPaperExit, debt: [...new Set(debt)].sort(), paperOnlyScreening: paperOnly.length, infraOnly: usedLive.filter(k => INFRA_OK.has(k) && !shared.has(k)) };
}
function compare(a = analyse()) {
  const added = a.debt.filter(d => !KNOWN_DEBT.includes(d));
  const resolved = KNOWN_DEBT.filter(d => !a.debt.includes(d));
  return { added, resolved };
}
module.exports = { analyse, compare, KNOWN_DEBT, INFRA_OK, REQUIRED_VERIFICATIONS };
if (require.main === module) {
  const a = analyse(), c = compare(a);
  console.log(`Setelan bersama menimpa ${a.sharedCount} kunci CFG tiap siklus. Jalur live memakai ${a.usedLive.length} kunci CFG.`);
  console.log('Infrastruktur (boleh beda):', a.infraOnly.join(', ') || '-');
  console.log('\nPERBEDAAN live vs dry run yang masih ada (' + a.debt.length + '):');
  for (const d of a.debt) console.log('  -', d);
  if (c.resolved.length) console.log('\nSudah beres (hapus dari KNOWN_DEBT):', c.resolved.join(', '));
  if (c.added.length) { console.log('\nPERBEDAAN BARU (dilarang):', c.added.join(', ')); process.exit(1); }
  console.log('\nTidak ada perbedaan baru dibanding daftar yang diketahui.');
}
