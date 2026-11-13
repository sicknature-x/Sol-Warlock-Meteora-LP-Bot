// Live start/stop + balance checks for the mini app. Paths and side effects are injectable
// so tests never touch the real /workspace/lp-bot/STOP file or start the real live process.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const walletStore = require('./wallet-store');
const paperSettings = require('./paper-settings');

const ROOT = process.env.LP_BOT_DIR || '/workspace/lp-bot';
const REAL_STOP = path.resolve(process.env.LP_STOP_FILE || path.join(ROOT, 'STOP'));
const DEFAULT_NO_NEW = path.resolve(process.env.LP_NO_NEW_FILE || path.join(ROOT, 'NO_NEW'));
const PM2_LIVE_APP = process.env.PM2_LIVE_APP || 'lp-live';
const PM2_PAPER_APP = process.env.PM2_PAPER_APP || 'lp-paper';
const PM2_LIVE_ECOSYSTEM = process.env.PM2_LIVE_ECOSYSTEM || path.join(ROOT, 'ecosystem.live.config.js');
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const ARM_TTL_MS = 60 * 1000;
const LIVE_INITDATA_MAX_AGE_SEC = 5 * 60;
const MIN_LIVE_SOL = 0.05; // fee reserve so the wallet can still pay txs
const MIN_LIVE_USDC = 10;
const LIVE_SOL_RESERVE = 0.05;

function wib(d = new Date()) {
  return new Date(d).toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' }) + ' WIB';
}

function cleanPm2Env() {
  return {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME || '/home/USER',
    USER: process.env.USER || '',
    LOGNAME: process.env.LOGNAME || process.env.USER || '',
    PM2_HOME: process.env.PM2_HOME || path.join(process.env.HOME || '/home/USER', '.pm2'),
    LANG: process.env.LANG || 'C.UTF-8',
  };
}

function pm2Bin() {
  const cands = [
    process.env.PM2_BIN,
    '/usr/bin/pm2',
    '/usr/local/bin/pm2',
    path.join(process.env.HOME || '', '.local/bin/pm2'),
    '/home/box/.local/bin/pm2',
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  return 'pm2';
}

function assertOwnPm2App(name, kind) {
  if (!name || /^(grok|elysium|bsc)/i.test(name)) {
    throw new Error('refusing to manage a foreign pm2 app (' + kind + ')');
  }
  return name;
}

function pm2LiveStatus() {
  const res = spawnSync(pm2Bin(), ['jlist'], { env: cleanPm2Env(), encoding: 'utf8', timeout: 15000 });
  if (res.status !== 0) return { running: false, status: 'unknown' };
  let apps = [];
  try { apps = JSON.parse(res.stdout || '[]'); } catch { return { running: false, status: 'unknown' }; }
  const app = apps.find((a) => a && a.name === PM2_LIVE_APP);
  const status = app && app.pm2_env && app.pm2_env.status;
  return { running: status === 'online', status: status || 'missing', pid: app && app.pid };
}

function startLivePm2() {
  const env = cleanPm2Env();
  const pm2 = pm2Bin();
  const list = spawnSync(pm2, ['jlist'], { env, encoding: 'utf8', timeout: 15000 });
  let apps = [];
  try { apps = JSON.parse(list.stdout || '[]'); } catch { apps = []; }
  const liveName = assertOwnPm2App(PM2_LIVE_APP, 'live');
  const app = apps.find((a) => a && a.name === liveName);
  let res;
  if (app && app.pm2_env && app.pm2_env.status === 'online') {
    return { ok: true, already: true };
  }
  if (app) res = spawnSync(pm2, ['start', liveName], { env, encoding: 'utf8', timeout: 20000 });
  else res = spawnSync(pm2, ['start', PM2_LIVE_ECOSYSTEM], { env, encoding: 'utf8', timeout: 20000 });
  if (res.status !== 0) return { ok: false, error: 'pm2 start ' + liveName + ' failed' };
  return { ok: true };
}

function stopLivePm2() {
  const env = cleanPm2Env();
  const res = spawnSync(pm2Bin(), ['stop', assertOwnPm2App(PM2_LIVE_APP, 'live')], { env, encoding: 'utf8', timeout: 20000 });
  // missing app is ok
  return { ok: true, status: res.status };
}

function stopPaperPm2() {
  const env = cleanPm2Env();
  spawnSync(pm2Bin(), ['stop', assertOwnPm2App(PM2_PAPER_APP, 'paper')], { env, encoding: 'utf8', timeout: 20000 });
  return { ok: true };
}

function createArmStore({ ttlMs = ARM_TTL_MS } = {}) {
  const map = new Map();
  function issue(userId, meta = {}) {
    const id = crypto.randomBytes(16).toString('hex');
    map.set(id, { userId: +userId, exp: Date.now() + ttlMs, ...meta });
    return id;
  }
  function consume(id, userId) {
    const rec = map.get(id);
    if (!rec) return { ok: false, reason: 'arm token missing or already used' };
    if (Date.now() > rec.exp) {
      map.delete(id);
      return { ok: false, reason: 'arm token expired (type LIVE within 60s)' };
    }
    if (+rec.userId !== +userId) return { ok: false, reason: 'arm token user mismatch' };
    map.delete(id);
    return { ok: true, meta: rec };
  }
  return { issue, consume };
}

async function defaultGetBalances(address, rpc) {
  const conn = new Connection(rpc || require('./rpc-config').url(), 'confirmed');
  const pk = new PublicKey(address);
  const solLamports = await conn.getBalance(pk);
  const sol = solLamports / LAMPORTS_PER_SOL;
  let usdc = 0;
  try {
    const accs = await conn.getParsedTokenAccountsByOwner(pk, { mint: new PublicKey(USDC) });
    const raw = accs.value.reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
    usdc = Number(raw) / 1e6;
  } catch { usdc = 0; }
  return { sol, usdc };
}

function evaluateBalances({ sol, usdc, minSol = MIN_LIVE_SOL, minUsdc = MIN_LIVE_USDC } = {}) {
  const reasons = [];
  if (!(sol >= minSol)) reasons.push(`SOL ${sol ?? 0} < minimum ${minSol} (cadangan fee)`);
  if (!(usdc >= minUsdc)) reasons.push(`USDC ${usdc ?? 0} < minimum ${minUsdc} (modal posisi)`);
  return {
    ok: reasons.length === 0,
    sol: +sol || 0,
    usdc: +usdc || 0,
    minSol,
    minUsdc,
    reasons,
  };
}

function isStopPresent(stopPath = REAL_STOP) {
  return fs.existsSync(path.resolve(stopPath));
}

function isNoNew(noNewPath = DEFAULT_NO_NEW) {
  return fs.existsSync(path.resolve(noNewPath));
}

function writeStop(stopPath) {
  const resolved = path.resolve(stopPath);
  fs.writeFileSync(resolved, `stop live via mini app ${wib()}\n`);
  return resolved;
}

function removeStop(stopPath) {
  const resolved = path.resolve(stopPath);
  if (process.env.MINIAPP_TEST === '1' && resolved === REAL_STOP) {
    const err = new Error('test mode refuses to touch the real live STOP');
    err.code = 'TEST_STOP_GUARD';
    throw err;
  }
  if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
  return resolved;
}

function writeNoNew(noNewPath) {
  fs.writeFileSync(path.resolve(noNewPath), `no new opens via mini app ${wib()}\n`);
}

function clearNoNew(noNewPath) {
  const p = path.resolve(noNewPath);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

async function liveSnapshot(opts = {}) {
  const secretsDir = opts.secretsDir || walletStore.DEFAULT_SECRETS_DIR;
  const stopPath = opts.stopPath || REAL_STOP;
  const noNewPath = opts.noNewPath || DEFAULT_NO_NEW;
  const meta = walletStore.readEnvelopeMeta(secretsDir);
  const statusFn = opts.liveStatusFn || pm2LiveStatus;
  const live = statusFn();
  let balances = { sol: null, usdc: null };
  let check = { ok: false, reasons: ['no key stored'] };
  if (meta.hasKey && meta.publicAddress) {
    try {
      const getBal = opts.getBalances || defaultGetBalances;
      balances = await getBal(meta.publicAddress, opts.rpc);
      check = evaluateBalances({ sol: balances.sol, usdc: balances.usdc, minSol: opts.minSol, minUsdc: opts.minUsdc });
    } catch (e) {
      check = { ok: false, reasons: ['balance read failed'] };
    }
  }
  return {
    hasKey: !!meta.hasKey,
    publicAddress: meta.publicAddress,
    keyUpdatedWib: meta.updatedWib,
    stopPresent: isStopPresent(stopPath),
    noNew: isNoNew(noNewPath),
    liveRunning: !!live.running,
    liveStatus: live.status || null,
    sol: balances.sol,
    usdc: balances.usdc,
    balanceCheck: check,
    minSol: check.minSol || MIN_LIVE_SOL,
    minUsdc: check.minUsdc || MIN_LIVE_USDC,
    liveSolReserve: LIVE_SOL_RESERVE,
  };
}

module.exports = {
  REAL_STOP,
  DEFAULT_NO_NEW,
  USDC,
  ARM_TTL_MS,
  LIVE_INITDATA_MAX_AGE_SEC,
  MIN_LIVE_SOL,
  MIN_LIVE_USDC,
  LIVE_SOL_RESERVE,
  wib,
  cleanPm2Env,
  pm2LiveStatus,
  startLivePm2,
  stopLivePm2,
  stopPaperPm2,
  createArmStore,
  defaultGetBalances,
  evaluateBalances,
  isStopPresent,
  isNoNew,
  writeStop,
  removeStop,
  writeNoNew,
  clearNoNew,
  liveSnapshot,
};
