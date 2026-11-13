'use strict';
// Sticky RugCheck flag. RugCheck's answer for the SAME token can flip between calls (Huang: danger 01:36 / 01:46, clean 01:51, danger again later).
// Once a token is seen as rugged / danger / score >= max it stays blocked for N days even if a later report looks clean. Persistent file: <paperDir>/rug-flagged.json.
// Transient problems (API error, missing report) and authority flags are NOT made sticky. Same module for dry run and live (shared screening).
const fs = require('fs'), path = require('path');
const file = dir => path.join(dir, 'rug-flagged.json');
function read(dir) { try { const j = JSON.parse(fs.readFileSync(file(dir), 'utf8')); return j && typeof j.mints === 'object' ? j : { mints: {} }; } catch { return { mints: {} }; } }
function write(dir, j) { const f = file(dir), tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n'); fs.renameSync(tmp, f); }
const DAY = 86400000;
// returns the entry while it is still inside its window, else null
function get(dir, mint, days, now = Date.now()) {
  if (!mint || !(days > 0)) return null;
  const e = read(dir).mints[mint]; if (!e) return null;
  return now - Date.parse(e.flaggedAt) < days * DAY ? e : null;
}
function add(dir, { mint, symbol, pool, reason }, now = Date.now()) {
  if (!mint) return false; const j = read(dir), first = !j.mints[mint];
  j.mints[mint] = { symbol: symbol || null, pool: pool || null, reason: String(reason || '').slice(0, 200), flaggedAt: new Date(now).toISOString(), firstFlaggedAt: (j.mints[mint] && j.mints[mint].firstFlaggedAt) || new Date(now).toISOString() };
  write(dir, j); return first;
}
function remove(dir, mint) { const j = read(dir); if (!j.mints[mint]) return false; delete j.mints[mint]; write(dir, j); return true; }
function list(dir) { return Object.entries(read(dir).mints).map(([mint, v]) => ({ mint, ...v })); }
const STICKY_REASON = /^rugcheck (danger|rugged|score_normalised)/;
// One call used by the screener: sticky first (no API call), else fetch + evaluate, and remember a bad verdict.
async function check({ dir, mint, days, symbol, pool, fetch, evaluate, now = Date.now(), log = () => {} }) {
  const st = get(dir, mint, days, now);
  if (st) return { ok: false, sticky: true, why: `rugcheck sticky: ${st.reason} (ditandai ${st.flaggedAt.slice(0, 16).replace('T', ' ')} UTC, diblok ${days} hari)`, report: null, rc: null };
  const report = await fetch(mint), rc = evaluate(report);
  if (!rc.ok && days > 0 && STICKY_REASON.test(String(rc.why || ''))) {
    try { if (add(dir, { mint, symbol, pool, reason: rc.why }, now)) log(`RugCheck sticky add ${symbol || ''} ${mint}: ${rc.why}`); } catch (e) { log('RugCheck sticky add failed: ' + e.message); }
  }
  return { ok: rc.ok, sticky: false, why: rc.why, report, rc };
}
module.exports = { read, get, add, remove, list, check, file, STICKY_REASON };
