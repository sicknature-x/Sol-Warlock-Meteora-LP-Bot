// PAPER dry-run "Edit modal": archive the current run and start a fresh run with a new modal.
// No wallet, key, RPC, transaction, or live controls. Requests are queued by the mini app and applied
// by the paper bot (which owns state.json). SL blacklist and settings are never touched.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const multi = require('./paper-multi'), entryPolicy = require('./paper-entry-policy'), calendar = require('./paper-pnl-calendar');
const wib = (d = new Date()) => new Date(d).toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' }) + ' WIB';
const stamp = (d = new Date()) => wib(d).replace(/[-: ]/g, '').replace('WIB', '').replace(/^(\d{8})(\d{4})(\d{2})$/, '$1-$2$3');
const pnlOf = (h) => (h.pnlUsd != null ? +h.pnlUsd : +h.netPnlUsd || 0);
const MAX_MODAL = 1_000_000;
const COPY_FILES = ['state.json', 'summary.json', 'status.json', 'positions_open.json', 'history.csv', 'history_N5.csv', 'history-archived-over500.csv',
  'reshapes.jsonl', 'repositions.jsonl', 'settings.json', 'sl-blacklist.json', 'config.json', 'history-archive-policy.json'];

function dirs(paperDir) { const root = path.join(paperDir, 'runs'); return { root, pending: path.join(root, 'pending'), done: path.join(root, 'done'), index: path.join(root, 'index.json') }; }
function amountValue(value) {
  if (!['string', 'number'].includes(typeof value) || String(value).trim() === '') throw Error('Modal minimal $1');
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) throw Error('Modal minimal $1');
  if (n > MAX_MODAL || Math.abs(n * 1e6 - Math.round(n * 1e6)) > 1e-5) throw Error('Modal maksimum 1.000.000 USDC, maksimum 6 desimal');
  return Math.round(n * 1e6) / 1e6;
}
function writeJsonAtomic(file, obj) { const tmp = file + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmp, file); }
function readIndex(paperDir) { try { const j = JSON.parse(fs.readFileSync(dirs(paperDir).index, 'utf8')); return Array.isArray(j.runs) ? j : { runs: [] }; } catch { return { runs: [] }; } }
function pendingFiles(paperDir) { const p = dirs(paperDir).pending; return fs.existsSync(p) ? fs.readdirSync(p).filter((x) => /^[a-zA-Z0-9_-]{8,80}\.json$/.test(x)).sort() : []; }
function currentRun(state, paperDir) {
  const b = state?.books?.N5 || Object.values(state?.books || {})[0];
  const idx = readIndex(paperDir);
  const number = state?.dryRun?.number || (idx.runs.length ? Math.max(...idx.runs.map((r) => r.number)) + 1 : 1);
  return { number, startedAt: state?.dryRun?.startedAt || state?.meta?.startedAt || null, modal: b?.virtual?.totalDepositedUsdc ?? b?.virtual?.usdcStart ?? 0 };
}
function summarize(state, paperDir) {
  const policy = entryPolicy.readArchivePolicy(paperDir);
  const books = Object.values(state.books || {}), all = books.flatMap((b) => b.history || []);
  const vis = entryPolicy.visible(all, policy), b = books[0] || {}, v = b.virtual || {};
  const totalPnlUsd = all.reduce((a, h) => a + pnlOf(h), 0), visiblePnlUsd = vis.reduce((a, h) => a + pnlOf(h), 0);
  const free = (+v.usdc || 0) + ((+v.sol || 0) + (+v.capitalSol || 0)) * (+v.lastCapitalSolUsd || 0);
  return { modal: v.totalDepositedUsdc ?? v.usdcStart ?? 0, trades: all.length, visibleTrades: vis.length, archivedTrades: all.length - vis.length,
    totalPnlUsd: +totalPnlUsd.toFixed(6), visiblePnlUsd: +visiblePnlUsd.toFixed(6), equityUsd: +free.toFixed(6), cashUsdc: +(+v.usdc || 0).toFixed(6),
    deposits: (state.capitalDeposits || []).length, calendar: calendar.fromHistory(all, policy), calendarAll: calendar.fromHistory(all, null) };
}
function queueNewRun(paperDir, amount, { updatedBy, expectedOldModal, requestId = crypto.randomUUID(), state } = {}) {
  amount = amountValue(amount);
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(requestId)) throw Error('Invalid request ID');
  if (state) {
    const open = Object.values(state.books || {}).reduce((n, b) => n + multi.positions(b).length, 0);
    if (open) throw Error('Tutup semua posisi dulu (' + open + ' posisi masih open)');
    const cur = currentRun(state, paperDir);
    if (expectedOldModal != null && Math.abs(+expectedOldModal - cur.modal) > 1e-6) throw Error('Modal sudah berubah; muat ulang halaman');
  }
  const d = dirs(paperDir); fs.mkdirSync(d.pending, { recursive: true, mode: 0o700 }); fs.mkdirSync(d.done, { recursive: true, mode: 0o700 });
  if (pendingFiles(paperDir).length) throw Error('Masih ada permintaan Edit modal yang antre; tunggu bot memproses');
  const request = { id: requestId, type: 'new-run', amount, updatedBy, expectedOldModal: expectedOldModal ?? null, createdAt: new Date().toISOString(), createdWib: wib(), paper: true };
  const tmp = path.join(d.pending, '.' + requestId + '.' + crypto.randomUUID() + '.tmp'), dest = path.join(d.pending, requestId + '.json');
  fs.writeFileSync(tmp, JSON.stringify(request), { flag: 'wx', mode: 0o600 });
  try { fs.linkSync(tmp, dest); } finally { fs.unlinkSync(tmp); }
  return { ok: true, id: requestId, amount, status: 'queued' };
}
function finish(d, name, r, result) { fs.mkdirSync(d.done, { recursive: true, mode: 0o700 }); writeJsonAtomic(path.join(d.done, name), { ...r, result, doneAt: new Date().toISOString(), doneWib: wib() }); fs.unlinkSync(path.join(d.pending, name)); }
// Called by the paper bot. save(state) must persist state.json atomically.
function applyPending(state, paperDir, { save, audit = () => {}, log = () => {}, allowedId = Number(process.env.TELEGRAM_ALLOWED_ID || 0), now = () => new Date() } = {}) {
  const d = dirs(paperDir); let count = 0;
  for (const name of pendingFiles(paperDir)) {
    const r = JSON.parse(fs.readFileSync(path.join(d.pending, name), 'utf8'));
    if (r.id + '.json' !== name || r.paper !== true || r.type !== 'new-run' || r.updatedBy !== allowedId) { finish(d, name, r, { ok: false, error: 'Invalid paper run request' }); continue; }
    let amount; try { amount = amountValue(r.amount); } catch (e) { finish(d, name, r, { ok: false, error: e.message }); continue; }
    const books = Object.values(state.books || {});
    const open = books.reduce((n, b) => n + multi.positions(b).length, 0);
    const reject = (error) => { finish(d, name, r, { ok: false, error }); const l = `uid=${r.updatedBy} action=paper-new-run-rejected id=${r.id} reason=${error}`; audit(l); log(l); };
    if (!books.length || books.some((b) => !b.virtual)) { reject('Paper books unavailable'); continue; }
    if (open) { reject('Tutup semua posisi dulu (' + open + ' posisi masih open)'); continue; }
    if (books.some((b) => (b.virtual.capitalAsset || 'USDC') !== 'USDC')) { reject('Ganti aset modal ke USDC dulu'); continue; }
    const cur = currentRun(state, paperDir);
    if (r.expectedOldModal != null && Math.abs(+r.expectedOldModal - cur.modal) > 1e-6) { reject('Modal sudah berubah; muat ulang halaman'); continue; }
    save(state); // flush current run to disk before archiving
    const t = now(), runDir = path.join(d.root, `run-${cur.number}-${stamp(t)}`);
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    for (const f of COPY_FILES) { const src = path.join(paperDir, f); if (fs.existsSync(src)) fs.copyFileSync(src, path.join(runDir, f)); }
    const sum = summarize(state, paperDir);
    writeJsonAtomic(path.join(runDir, 'pnl-calendar.json'), { visible: sum.calendar, includingArchived: sum.calendarAll, tz: 'UTC (reset 00:00 UTC = 07:00 WIB)' });
    const entry = { number: cur.number, dir: path.basename(runDir), modal: sum.modal, startedAt: cur.startedAt, startedWib: cur.startedAt ? wib(cur.startedAt) : null,
      endedAt: t.toISOString(), endedWib: wib(t), trades: sum.trades, visibleTrades: sum.visibleTrades, archivedTrades: sum.archivedTrades,
      totalPnlUsd: sum.totalPnlUsd, visiblePnlUsd: sum.visiblePnlUsd, equityUsd: sum.equityUsd, endedBy: r.updatedBy, requestId: r.id, nextModal: amount };
    writeJsonAtomic(path.join(runDir, 'index.json'), entry);
    const idx = readIndex(paperDir); idx.runs = [...idx.runs.filter((x) => x.number !== entry.number), entry].sort((a, b) => a.number - b.number); writeJsonAtomic(d.index, idx);
    const before = JSON.stringify({ books: state.books, capitalDeposits: state.capitalDeposits, accountingCorrections: state.accountingCorrections, dryRun: state.dryRun });
    for (const b of books) {
      const v = b.virtual;
      b.history = []; b.reshapes = []; b.rightRepositionEvents = []; b.capitalConversions = []; b.position = null; b.positions = [];
      b.virtual = { usdcStart: amount, usdc: amount, sol: 0, totalDepositedUsdc: amount, capitalAsset: 'USDC', capitalSol: 0, ...(v.lastCapitalSolUsd ? { lastCapitalSolUsd: v.lastCapitalSolUsd } : {}) };
    }
    state.capitalDeposits = [{ id: r.id, type: 'run-start', amount, updatedBy: r.updatedBy, createdAt: r.createdAt, appliedAt: t.toISOString(), appliedWib: wib(t), paper: true }];
    state.accountingCorrections = [];
    state.dryRun = { number: cur.number + 1, startedAt: t.toISOString(), startedWib: wib(t), modal: amount, previousRun: cur.number, previousDir: path.basename(runDir) };
    try { save(state); } catch (e) { const old = JSON.parse(before); Object.assign(state, old); throw e; }
    finish(d, name, r, { ok: true, archived: path.basename(runDir), newRun: cur.number + 1, modal: amount });
    const l = `uid=${r.updatedBy} action=paper-new-run id=${r.id} archived=run#${cur.number} (${path.basename(runDir)}) oldModal=${sum.modal} trades=${sum.trades} pnl=${sum.totalPnlUsd} equity=${sum.equityUsd} -> run#${cur.number + 1} modal=${amount} USDC (SL blacklist + settings kept)`;
    audit(l); log(l); count++;
  }
  return count;
}
function snapshot(paperDir) {
  let s = null; try { s = JSON.parse(fs.readFileSync(path.join(paperDir, 'state.json'), 'utf8')); } catch {}
  const d = dirs(paperDir), last = fs.existsSync(d.done) ? fs.readdirSync(d.done).filter((x) => x.endsWith('.json')).map((x) => { try { return JSON.parse(fs.readFileSync(path.join(d.done, x), 'utf8')); } catch { return null; } }).filter(Boolean).sort((a, b) => String(a.doneAt).localeCompare(String(b.doneAt))).at(-1) : null;
  return { current: s ? currentRun(s, paperDir) : null, runs: readIndex(paperDir).runs, pending: pendingFiles(paperDir).length, last: last ? { result: last.result, doneWib: last.doneWib, amount: last.amount } : null };
}

// Live ON: the dry run is saved by number exactly like "Edit modal" (run-N-<stamp> folder + index) and the NEXT dry run (N+1) is prepared with the same modal,
// so after Live OFF a resumed dry run starts clean as run N+1 and run N stays intact. Called by the paper bot (it owns state.json) once it is paused and flat.
function archiveForLive(state, paperDir, { save, audit = () => {}, log = () => {}, now = () => new Date(), endedBy = 'live-on', nextModal } = {}) {
  const d = dirs(paperDir), books = Object.values(state.books || {});
  if (!books.length || books.some((b) => !b.virtual)) return { ok: false, error: 'Paper books unavailable' };
  const open = books.reduce((n, b) => n + multi.positions(b).length, 0);
  if (open) return { ok: false, error: 'posisi dry run masih open (' + open + ')' };
  const cur = currentRun(state, paperDir), amount = +nextModal > 0 ? +nextModal : (cur.modal > 0 ? cur.modal : 1000);
  save(state);   // flush the current run to disk before archiving
  const t = now(), runDir = path.join(d.root, `run-${cur.number}-${stamp(t)}`);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  for (const f of COPY_FILES) { const src = path.join(paperDir, f); if (fs.existsSync(src)) fs.copyFileSync(src, path.join(runDir, f)); }
  const sum = summarize(state, paperDir);
  writeJsonAtomic(path.join(runDir, 'pnl-calendar.json'), { visible: sum.calendar, includingArchived: sum.calendarAll, tz: 'UTC (reset 00:00 UTC = 07:00 WIB)' });
  const entry = { number: cur.number, dir: path.basename(runDir), modal: sum.modal, startedAt: cur.startedAt, startedWib: cur.startedAt ? wib(cur.startedAt) : null,
    endedAt: t.toISOString(), endedWib: wib(t), trades: sum.trades, visibleTrades: sum.visibleTrades, archivedTrades: sum.archivedTrades,
    totalPnlUsd: sum.totalPnlUsd, visiblePnlUsd: sum.visiblePnlUsd, equityUsd: sum.equityUsd, endedBy, endedReason: 'live-on', nextModal: amount };
  writeJsonAtomic(path.join(runDir, 'index.json'), entry);
  const idx = readIndex(paperDir); idx.runs = [...idx.runs.filter((x) => x.number !== entry.number), entry].sort((a, b) => a.number - b.number); writeJsonAtomic(d.index, idx);
  const before = JSON.stringify({ books: state.books, capitalDeposits: state.capitalDeposits, accountingCorrections: state.accountingCorrections, dryRun: state.dryRun });
  for (const b of books) {
    const v = b.virtual;
    b.history = []; b.reshapes = []; b.rightRepositionEvents = []; b.capitalConversions = []; b.position = null; b.positions = [];
    b.virtual = { usdcStart: amount, usdc: amount, sol: 0, totalDepositedUsdc: amount, capitalAsset: 'USDC', capitalSol: 0, ...(v.lastCapitalSolUsd ? { lastCapitalSolUsd: v.lastCapitalSolUsd } : {}) };
  }
  state.capitalDeposits = [{ id: 'live-on-' + stamp(t), type: 'run-start', amount, updatedBy: endedBy, createdAt: t.toISOString(), appliedAt: t.toISOString(), appliedWib: wib(t), paper: true }];
  state.accountingCorrections = [];
  state.dryRun = { number: cur.number + 1, startedAt: t.toISOString(), startedWib: wib(t), modal: amount, previousRun: cur.number, previousDir: path.basename(runDir) };
  try { save(state); } catch (e) { Object.assign(state, JSON.parse(before)); throw e; }
  const l = `action=paper-run-archived-for-live archived=run#${cur.number} (${path.basename(runDir)}) trades=${sum.trades} pnl=${sum.totalPnlUsd} equity=${sum.equityUsd} -> next run#${cur.number + 1} modal=${amount}`;
  audit(l); log(l);
  return { ok: true, archived: path.basename(runDir), run: cur.number, newRun: cur.number + 1, modal: amount };
}
module.exports = { archiveForLive, amountValue, queueNewRun, applyPending, snapshot, readIndex, currentRun, summarize, dirs, MAX_MODAL };
