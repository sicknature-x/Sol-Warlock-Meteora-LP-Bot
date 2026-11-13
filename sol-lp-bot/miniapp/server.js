require('../env-config').load(require('path').join(__dirname,'..'));
// Paper + (Tuan-triggered) live control Telegram mini app. Binds localhost by default.
// POST writes require valid Tuan initData + single-use CSRF. Key material is never logged or returned.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const settings = require('../paper-settings');
const funding=require('../paper-funding');
const paperRuns=require('../paper-runs');
const commands=require('../paper-commands');
const screenRefresh=require('../paper-screen-refresh');
const walletStore = require('../wallet-store');
const liveControl = require('../live-control');
const tokenRent = require('../token-rent');
// Tuan rule: live must equal dry run. Go Live (arm/start) is refused while the parity check finds any difference (fails closed if the check itself errors).
// ---- token account rent (read-only scan + guarded claim). Never automatic; the claim only runs from an authenticated POST with an explicit phrase.
// Mints the live bot still holds positions in (any side): their token accounts are never closed, even when momentarily empty.
function liveProtectedMints(opts) {
  if (opts.protectedMintsFn) return new Set(opts.protectedMintsFn());
  const set = new Set();
  const live = (opts.liveStatusFn || liveControl.pm2LiveStatus)();
  let st = null;
  try { st = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'state.json'), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error('state live tidak terbaca, claim ditunda'); }
  if (st) for (const p of require('../live-positions').list(st)) { if (p && p.mintX) set.add(p.mintX); if (p && p.mintY) set.add(p.mintY); }
  if (!st && live.running) throw new Error('state live tidak ditemukan saat live ON, claim ditunda');
  return set;
}
async function rentScan(opts, secretsDir) {
  const meta = walletStore.readEnvelopeMeta(secretsDir);
  if (!meta.hasKey || !meta.publicAddress) return { ok: false, status: 400, error: 'key not stored' };
  if (opts.rentScanFn) return { ok: true, ...(await opts.rentScanFn(meta.publicAddress)) };
  const web3 = require('@solana/web3.js');
  const conn = new web3.Connection(opts.rpc || require('../rpc-config').url(), 'confirmed');
  return { ok: true, ...(await tokenRent.scan({ conn, owner: meta.publicAddress, PublicKey: web3.PublicKey, protectedMints: liveProtectedMints(opts) })) };
}
async function rentClaim(opts, secretsDir) {
  if (opts.rentClaimFn) return opts.rentClaimFn();
  const web3 = require('@solana/web3.js'), spl = require('@solana/spl-token');
  const keypair = walletStore.loadKeypair(secretsDir);
  const conn = new web3.Connection(opts.rpc || require('../rpc-config').url(), 'confirmed');
  const prep = async tx => { tx.feePayer = keypair.publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash; return tx; };
  return tokenRent.claim({
    conn, keypair, web3, spl, protectedMints: liveProtectedMints(opts),
    simulate: async tx => { await prep(tx); const r = await conn.simulateTransaction(tx); return { err: r.value && r.value.err }; },
    send: async tx => { const bh = await conn.getLatestBlockhash('confirmed'); tx.feePayer = keypair.publicKey; tx.recentBlockhash = bh.blockhash; tx.sign(keypair);
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
      const c = await conn.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, 'confirmed');
      if (c.value && c.value.err) throw new Error('tx error ' + JSON.stringify(c.value.err)); return sig; },
  });
}

function liveParityDifferences() { try { return require('../parity-check').analyse().debt; } catch (e) { return ['parity-check error: ' + e.message]; } }
const telegram = require('../telegram-notify');
const ROOT = process.env.LP_BOT_DIR || '/workspace/lp-bot';

const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_HOST = process.env.MINIAPP_HOST || '127.0.0.1';
const DEFAULT_PORT = +(process.env.MINIAPP_PORT || 8787);

function send(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(sanitizeResponse(obj));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

function sanitizeResponse(obj) {
  const drop = /private[_-]?key|secretKey|secret_key|SOLANA_BOT_PRIVATE_KEY|masterKey|initData|TELEGRAM_BOT_TOKEN/i;
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, val] of Object.entries(v)) {
        if (drop.test(k)) continue;
        o[k] = walk(val);
      }
      return o;
    }
    return v;
  };
  return walk(obj);
}

function sendFile(res, file, contentType, { head } = {}) {
  const data = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self' https://web.telegram.org https://telegram.org",
  });
  if (head) return res.end();
  res.end(data);
}

function readJson(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > maxBytes) {
        reject(Object.assign(new Error('body too large'), { code: 'TOO_LARGE' }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); }
      catch { reject(Object.assign(new Error('invalid json'), { code: 'BAD_JSON' })); }
    });
    req.on('error', reject);
  });
}

function initDataFrom(req, body) {
  return (body && (body.initData || body.init_data))
    || req.headers['x-telegram-init-data']
    || '';
}

function publicStatus(paperDir) {
  const out = { paper: true, dryRun: true };
  const files = ['status.json', 'summary.json', 'positions_open.json', 'config.json', 'screening.json'];
  for (const name of files) {
    try {
      const p = path.join(paperDir, name);
      if (fs.existsSync(p)) out[name.replace('.json', '')] = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { /* ignore broken journal */ }
  }
  out.screenRefresh=screenRefresh.status(paperDir,settings.currentValues(paperDir),out.screening);
  out.capital=funding.snapshot(paperDir);
  out.runs=paperRuns.snapshot(paperDir);
  out.commands=commands.snapshot(paperDir);
  out.activity = require('./activity').events(paperDir);
  out.lpAgentUrl = telegram.lpAgentLink();
  out.paused = settings.isPaused(paperDir);
  out.window = {
    startedWib: (out.config && out.config.startedWib) || (out.status && out.status.meta && out.status.meta.startedWib) || null,
    endsWib: (out.config && out.config.endsWib) || (out.status && out.status.meta && out.status.meta.endsWib) || null,
  };
  return sanitizeResponse(out);
}

function loadBotTokenQuiet() {
  try {
    const env = (process.env.MINIAPP_TEST === '1' && process.env.MINIAPP_TEST_TOKEN) ? process.env.MINIAPP_TEST_TOKEN : '';
    if (env) return env;
  } catch { /* ignore */ }
  try {
    const t = telegram.loadToken();
    if (t) return t;
  } catch { /* ignore */ }
  return '';
}

function createApp(opts = {}) {
  const paperDir = opts.paperDir || process.env.LP_PAPER_DIR || path.join(ROOT, 'paper');
  const token = opts.token || '';
  const secretsDir = opts.secretsDir || walletStore.DEFAULT_SECRETS_DIR;
  const stopPath = opts.stopPath || liveControl.REAL_STOP;
  const noNewPath = opts.noNewPath || liveControl.DEFAULT_NO_NEW;
  const csrf = settings.createCsrfStore();
  const arm = liveControl.createArmStore({ ttlMs: opts.armTtlMs || liveControl.ARM_TTL_MS });
  const rateLimitMs = opts.rateLimitMs != null ? opts.rateLimitMs : 750;
  const lastPostAt = { t: 0 };
  const failMax = opts.failMax != null ? opts.failMax : 8;
  const failWindowMs = opts.failWindowMs != null ? opts.failWindowMs : 10 * 60 * 1000;
  const lockMs = opts.lockMs != null ? opts.lockMs : 15 * 60 * 1000;
  const fail = { n: 0, windowStart: 0, lockedUntil: 0 };

  function locked() {
    return Date.now() < fail.lockedUntil;
  }
  function noteFail() {
    const now = Date.now();
    if (now - fail.windowStart > failWindowMs) { fail.n = 0; fail.windowStart = now; }
    fail.n += 1;
    if (fail.n >= failMax) fail.lockedUntil = now + lockMs;
  }
  function noteOk() {
    fail.n = 0;
  }

  function botToken() {
    if (token) return token;
    if (opts.loadToken) return opts.loadToken() || '';
    return loadBotTokenQuiet();
  }

  function authInit(req, body, { write, maxAgeSec } = {}) {
    if (locked()) return { ok: false, status: 403, error: 'unauthorized', reason: 'locked out' };
    const v = settings.validateInitData(initDataFrom(req, body), botToken(), { maxAgeSec });
    if (!v.ok) {
      noteFail();
      return { ok: false, status: 403, error: 'unauthorized', reason: v.reason };
    }
    if (write) {
      const nonce = (body && body.csrf) || req.headers['x-csrf-token'];
      const c = csrf.consume(nonce, v.userId);
      if (!c.ok) {
        noteFail();
        return { ok: false, status: 403, error: 'unauthorized', reason: c.reason };
      }
      const now = Date.now();
      if (rateLimitMs > 0 && now - lastPostAt.t < rateLimitMs) {
        return { ok: false, status: 429, error: 'rate limited' };
      }
      lastPostAt.t = now;
    }
    noteOk();
    return { ok: true, userId: v.userId };
  }

  async function notify(kind, payload) {
    if (opts.notifyFn) return opts.notifyFn({ kind, ...payload });
    try {
      const telegram = require('../telegram-notify');
      if (kind === 'update' || kind === 'reset' || kind === 'pause' || kind === 'resume') {
        if (typeof telegram.notifySettingsChange === 'function') return telegram.notifySettingsChange({ kind, ...payload });
      }
      if ((kind === 'key-saved' || kind === 'key-deleted') && typeof telegram.notifyWalletChange === 'function') {
        return telegram.notifyWalletChange({ kind, ...payload });
      }
      if ((kind === 'live-arm' || kind === 'live-start' || kind === 'live-stop' || kind === 'live-no-new') && typeof telegram.notifyLiveChange === 'function') {
        return telegram.notifyLiveChange({ kind, ...payload });
      }
    } catch { /* fail-safe */ }
    return { ok: false, skipped: 'notify unavailable' };
  }

  function audit(line) {
    try { settings.audit(paperDir, line); } catch { /* ignore */ }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/health') {
      return send(res, 200, { ok: true, paper: true });
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && (pathname === '/' || pathname === '/index.html')) {
      return sendFile(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8', { head: req.method === 'HEAD' });
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/app.js') {
      return sendFile(res, path.join(PUBLIC_DIR, 'app.js'), 'application/javascript; charset=utf-8', { head: req.method === 'HEAD' });
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/app.css') {
      return sendFile(res, path.join(PUBLIC_DIR, 'app.css'), 'text/css; charset=utf-8', { head: req.method === 'HEAD' });
    }

    const freshSec = liveControl.LIVE_INITDATA_MAX_AGE_SEC;

    if (req.method === 'GET' && pathname === '/api/pnl-calendar') {
      const gate = authInit(req, { initData: url.searchParams.get('initData') || req.headers['x-telegram-init-data'] });
      if (!gate.ok) return send(res, gate.status, { ok: false, error: gate.error, reason: gate.reason, locked: locked() });
      const cal = require('../paper-pnl-calendar');
      const envFile = require('../env-config').read(path.join(__dirname, '..'));
      return send(res, 200, { ok: true, ...cal.build(paperDir), mode: cal.mode({ ...process.env, ...envFile }, liveControl.isStopPresent(stopPath)) });
    }
    if (req.method === 'GET' && (pathname === '/api/settings' || pathname === '/api/status' || pathname === '/api/wallet' || pathname === '/api/live' || pathname === '/api/wallet/rent')) {
      const gate = authInit(req, { initData: url.searchParams.get('initData') || req.headers['x-telegram-init-data'] });
      if (!gate.ok) return send(res, gate.status, { ok: false, error: gate.error, reason: gate.reason, locked: locked() });
      const nonce = csrf.issue(gate.userId);
      if (pathname === '/api/wallet/rent') {
        try {
          const r = await rentScan(opts, secretsDir);
          if (!r.ok) return send(res, r.status || 400, { ok: false, error: r.error, csrf: nonce });
          return send(res, 200, { ...r, csrf: nonce, accounts: undefined, sample: (r.accounts || []).slice(0, 5).map(a => ({ mint: a.mint, sol: a.lamports / 1e9 })) });
        } catch (e) { return send(res, 502, { ok: false, error: 'scan gagal: ' + String(e.message || e).slice(0, 120), csrf: nonce }); }
      }
      if (pathname === '/api/wallet') {
        const meta = walletStore.readEnvelopeMeta(secretsDir);
        return send(res, 200, { ok: true, csrf: nonce, hasKey: meta.hasKey, publicAddress: meta.publicAddress, updatedWib: meta.updatedWib });
      }
      if (pathname === '/api/live') {
        const snap = await liveControl.liveSnapshot({
          secretsDir, stopPath, noNewPath,
          getBalances: opts.getBalances,
          liveStatusFn: opts.liveStatusFn,
          rpc: opts.rpc,
        });
        return send(res, 200, { ok: true, csrf: nonce, ...snap });
      }
      const values = settings.currentValues(paperDir);
      return send(res, 200, {
        ok: true,
        paper: true,
        csrf: nonce,
        csrfTtlSec: Math.round(settings.CSRF_TTL_MS / 1000),
        values,
        defaults: settings.cloneDefaults(),
        fields: settings.displayValues(values),
        capitalEnabled:liveControl.isStopPresent(stopPath),
        paused: settings.isPaused(paperDir),
        slBlacklist: require('../paper-sl-blacklist').list(paperDir),
        status: pathname === '/api/settings' && url.searchParams.get('status') === '0' ? undefined : publicStatus(paperDir),
      });
    }

    if (req.method !== 'POST') {
      return send(res, 404, { ok: false, error: 'not found' });
    }

    let body;
    try { body = await readJson(req); }
    catch (e) {
      if (e.code === 'TOO_LARGE') return send(res, 413, { ok: false, error: 'body too large' });
      return send(res, 400, { ok: false, error: 'invalid json' });
    }

    const writeRoutes = new Set([
      '/api/settings', '/api/settings/reset', '/api/pause', '/api/resume', '/api/sl-blacklist/remove',
      '/api/paper/capital/deposit', '/api/paper/capital/new-run', '/api/paper/open', '/api/paper/close', '/api/paper/scan',
      '/api/wallet', '/api/wallet/delete', '/api/wallet/rent/claim',
      '/api/live/arm', '/api/live/start', '/api/live/stop',
    ]);
    if (!writeRoutes.has(pathname)) return send(res, 404, { ok: false, error: 'not found' });

    const isSensitive = pathname.startsWith('/api/wallet') || pathname.startsWith('/api/live');
    const gate = authInit(req, body, { write: true, maxAgeSec: isSensitive ? freshSec : undefined });
    if (!gate.ok) return send(res, gate.status, { ok: false, error: gate.error, reason: gate.reason, locked: locked() });
    const meta = { updatedBy: gate.userId };

    try {
      if(pathname.startsWith('/api/paper/')){
        const live=(opts.liveStatusFn||liveControl.pm2LiveStatus)();
        if(!liveControl.isStopPresent(stopPath)||live.running||live.status==='unknown')return send(res,409,{ok:false,error:'Hanya dry run; aksi dikunci saat live/unknown'});
        if(pathname==='/api/paper/scan'){
          const result=screenRefresh.request(paperDir,{manual:true,userId:gate.userId,reason:'manual scan request'});
          if(!result.ok)return send(res,429,{ok:false,error:`Scan dibatasi 1/30 detik; tunggu ${result.retryAfterSec} detik`,retryAfterSec:result.retryAfterSec,csrf:csrf.issue(gate.userId)});
          audit(`uid=${gate.userId} action=paper-scan-request id=${result.id}`);
          return send(res,202,{ok:true,status:'queued',id:result.id,csrf:csrf.issue(gate.userId)});
        }
        if(body.confirmed!==true)return send(res,400,{ok:false,error:'Konfirmasi diperlukan'});
        if(pathname==='/api/paper/capital/deposit'){
          let amount;try{amount=funding.amountValue(body.amount);}catch(e){return send(res,400,{ok:false,error:e.message});}
          const result=funding.queueDeposit(paperDir,amount,{updatedBy:gate.userId,requestId:body.requestId});
          audit(`uid=${gate.userId} action=paper-capital-deposit-queued id=${result.id} amount=${result.amount} USDC duplicate=${!!result.duplicate}`);
          return send(res,202,{...result,csrf:csrf.issue(gate.userId)});
        }
        if(pathname==='/api/paper/capital/new-run'){
          let amount;try{amount=paperRuns.amountValue(body.amount);}catch(e){return send(res,400,{ok:false,error:e.message});}
          let st=null;try{st=JSON.parse(fs.readFileSync(path.join(paperDir,'state.json'),'utf8'));}catch{return send(res,409,{ok:false,error:'Paper books unavailable'});}
          let result;try{result=paperRuns.queueNewRun(paperDir,amount,{updatedBy:gate.userId,expectedOldModal:body.expectedOldModal,requestId:body.requestId,state:st});}catch(e){return send(res,409,{ok:false,error:e.message});}
          audit(`uid=${gate.userId} action=paper-new-run-queued id=${result.id} amount=${result.amount} USDC oldModal=${body.expectedOldModal}`);
          return send(res,202,{...result,csrf:csrf.issue(gate.userId)});
        }
        if(body.confirmedTwice!==true)return send(res,400,{ok:false,error:'Konfirmasi kedua diperlukan'});
        if(settings.isPaused(paperDir))return send(res,409,{ok:false,error:'Paper dipause; resume dahulu'});
        let type=pathname.endsWith('/open')?'open':'close';
        const snap=funding.snapshot(paperDir);
        if(!snap.available)return send(res,409,{ok:false,error:'Paper books unavailable'});
        if(type==='open'){
          if((snap.positions||[]).some(p=>p.pool===body.pool))return send(res,409,{ok:false,error:'Pool sudah dibuka'});
          if(body.replaceCurrent===true){
            if(!(snap.positions||[]).some(p=>p.pool===body.expectedPool&&p.openedAt===body.expectedOpenedAt))return send(res,409,{ok:false,error:'Posisi pilihan berubah; refresh dan konfirmasi ulang'});
            type='switch';
          }else if(snap.openCount>=settings.currentValues(paperDir).MAX_POSITIONS)return send(res,409,{ok:false,error:'Slot penuh; pilih posisi yang diganti'});
          let scan;try{scan=JSON.parse(fs.readFileSync(path.join(paperDir,'screening.json')));}catch{}
          const row=[...(scan?.display||[]),...(scan?.candidates||[])].find(p=>p.address===body.pool);
          if(!row)return send(res,409,{ok:false,error:'Pool tidak ada pada daftar screening; scan ulang dahulu'});
          if(row.status!=='passed'&&(!body.overrideFailedFilters||body.overrideConfirmed!==true))return send(res,400,{ok:false,error:'Filter gagal perlu peringatan dan konfirmasi tambahan',reasons:row.reasons});
          if(body.overrideFailedFilters&&body.overrideConfirmed!==true)return send(res,400,{ok:false,error:'Konfirmasi override diperlukan'});
        }
        const result=commands.queue(paperDir,{type,pool:body.pool,openedAt:body.openedAt,expectedPool:body.expectedPool,expectedOpenedAt:body.expectedOpenedAt,overrideFailedFilters:!!body.overrideFailedFilters,confirmedReasons:body.confirmedReasons||[],requestId:body.requestId,updatedBy:gate.userId});
        audit(`uid=${gate.userId} action=paper-manual-${type}-queued id=${result.id} pool=${body.pool}`);
        return send(res,202,{...result,csrf:csrf.issue(gate.userId)});
      }
      if (pathname === '/api/settings') {
        const oldPolicy=screenRefresh.signature(settings.currentValues(paperDir));
        const patch=body.settings||body.values||{},current=settings.currentValues(paperDir);
        if(patch.CAPITAL_ASSET&&patch.CAPITAL_ASSET!==current.CAPITAL_ASSET&&body.capitalAssetConfirmed!==true)return send(res,400,{ok:false,error:'Konfirmasi perubahan aset modal diperlukan'});
        const normalized=settings.fromDisplayPatch(patch);if([...require('../paper-strategy').KEYS,'EMERGENCY_TP_ENABLED','EMERGENCY_TP_TRIGGER_RANGE_PCT','EMERGENCY_TP_PCT','EMERGENCY_SLPLUS_ENABLED','EMERGENCY_SLPLUS_ARM_PCT','EMERGENCY_SLPLUS_LOCK_PCT','EMERGENCY_SLPLUS_CONFIRM_POLLS','EMERGENCY_SLPLUS_FLOOR_PCT','EMERGENCY_SLPLUS_FLOOR_POLLS'].some(k=>normalized[k]!==undefined&&String(normalized[k])!==String(current[k]))&&body.strategyConfirmed!==true)return send(res,400,{ok:false,error:'Konfirmasi perubahan strategy diperlukan; hanya posisi baru'});
        const result = settings.applySettings(paperDir, patch, meta);
        if (!result.ok) return send(res, 400, { ok: false, error: result.error, rejected: result.rejected });
        if(oldPolicy!==screenRefresh.signature(result.values)){screenRefresh.request(paperDir,{userId:gate.userId,reason:'screening settings changed'});result.rescanRequested=true;}
        notify('update', result).catch(() => {});
        return send(res, 200, { ...result, csrf: csrf.issue(gate.userId), paused: settings.isPaused(paperDir) });
      }
      if (pathname === '/api/sl-blacklist/remove') {
        const L=require('../paper-sl-blacklist');
        if(body.confirmed!==true)return send(res,400,{ok:false,error:'Konfirmasi diperlukan',csrf:csrf.issue(gate.userId)});
        if(typeof body.mint!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(body.mint))return send(res,400,{ok:false,error:'Mint tidak valid',csrf:csrf.issue(gate.userId)});
        const item=L.list(paperDir).find(x=>x.mint===body.mint);
        if(!item||!L.remove(paperDir,body.mint))return send(res,404,{ok:false,error:'Token tidak ada di SL blacklist',csrf:csrf.issue(gate.userId)});
        audit(`uid=${gate.userId} action=sl-blacklist-remove mint=${body.mint} symbol=${item.symbol||''}`);
        return send(res,200,{ok:true,removed:body.mint,slBlacklist:L.list(paperDir),csrf:csrf.issue(gate.userId)});
      }
      if (pathname === '/api/settings/reset') {
        const oldPolicy=screenRefresh.signature(settings.currentValues(paperDir));
        if(settings.currentValues(paperDir).CAPITAL_ASSET!=='USDC'&&body.capitalAssetConfirmed!==true)return send(res,400,{ok:false,error:'Konfirmasi konversi saldo ke USDC diperlukan'});
        const result = settings.resetSettings(paperDir, meta);
        if(oldPolicy!==screenRefresh.signature(result.values)){screenRefresh.request(paperDir,{userId:gate.userId,reason:'screening settings reset'});result.rescanRequested=true;}
        notify('reset', result).catch(() => {});
        return send(res, 200, { ...result, csrf: csrf.issue(gate.userId), paused: settings.isPaused(paperDir) });
      }
      if (pathname === '/api/pause') {
        const result = settings.pauseDryRun(paperDir, meta);
        notify('pause', result).catch(() => {});
        return send(res, 200, { ...result, csrf: csrf.issue(gate.userId) });
      }
      if (pathname === '/api/resume') {
        const result = settings.resumeDryRun(paperDir, meta, {
          restartFn: opts.restartFn || ((opts.skipPm2) ? (() => ({ ok: true, skipped: 'test' })) : settings.defaultRestartFn),
        });
        notify('resume', result).catch(() => {});
        return send(res, 200, { ...result, csrf: csrf.issue(gate.userId) });
      }

      if (pathname === '/api/wallet') {
        const secret = body && (body.secret || body.key || body.privateKey);
        if (!secret || typeof secret !== 'string') return send(res, 400, { ok: false, error: 'key required' });
        let saved;
        try { saved = walletStore.saveKey(secret, secretsDir); }
        catch (e) { return send(res, 400, { ok: false, error: e.expose ? e.message : 'invalid key' }); }
        // Drop secret from memory as soon as we can
        if (body) { body.secret = undefined; body.key = undefined; body.privateKey = undefined; }
        audit(`uid=${gate.userId} action=wallet-key-saved address=${saved.publicAddress}`);
        notify('key-saved', { publicAddress: saved.publicAddress, updatedWib: saved.updatedWib }).catch(() => {});
        return send(res, 200, { ok: true, hasKey: true, publicAddress: saved.publicAddress, updatedWib: saved.updatedWib, csrf: csrf.issue(gate.userId) });
      }
      if (pathname === '/api/wallet/rent/claim') {
        if (String(body && body.confirm || '') !== 'CLAIM') return send(res, 400, { ok: false, error: 'type CLAIM to confirm' });
        if (!walletStore.readEnvelopeMeta(secretsDir).hasKey) return send(res, 400, { ok: false, error: 'key not stored' });
        audit(`uid=${gate.userId} action=wallet-rent-claim-start`);
        let r; try { r = await rentClaim(opts, secretsDir); } catch (e) { r = { ok: false, error: String(e.message || e).slice(0, 160), closed: 0 }; }
        audit(`uid=${gate.userId} action=wallet-rent-claim-done ok=${!!r.ok} closed=${r.closed || 0} sol=${r.reclaimedSol || 0}${r.error ? ' error=' + String(r.error).slice(0, 80) : ''}`);
        return send(res, r.ok ? 200 : 502, { ...r, csrf: csrf.issue(gate.userId) });
      }
      if (pathname === '/api/wallet/delete') {
        walletStore.deleteKey(secretsDir);
        audit(`uid=${gate.userId} action=wallet-key-deleted`);
        notify('key-deleted', {}).catch(() => {});
        return send(res, 200, { ok: true, hasKey: false, publicAddress: null, csrf: csrf.issue(gate.userId) });
      }

      if (pathname === '/api/live/arm') {
        { const par = (opts.parityFn || liveParityDifferences)(); if (par.length) return send(res, 400, { ok: false, error: 'live belum sama dengan dry run; Go Live ditolak', differences: par }); }
        const snap = await liveControl.liveSnapshot({
          secretsDir, stopPath, noNewPath,
          getBalances: opts.getBalances,
          liveStatusFn: opts.liveStatusFn,
          rpc: opts.rpc,
        });
        if (!snap.hasKey) return send(res, 400, { ok: false, error: 'key not stored' });
        if (!snap.balanceCheck || !snap.balanceCheck.ok) {
          return send(res, 400, { ok: false, error: 'balance check failed', reasons: snap.balanceCheck && snap.balanceCheck.reasons, sol: snap.sol, usdc: snap.usdc });
        }
        const armId = arm.issue(gate.userId, { address: snap.publicAddress });
        audit(`uid=${gate.userId} action=live-arm address=${snap.publicAddress} sol=${snap.sol} usdc=${snap.usdc}`);
        notify('live-arm', { publicAddress: snap.publicAddress, sol: snap.sol, usdc: snap.usdc }).catch(() => {});
        return send(res, 200, { ok: true, armed: true, armId, expiresInSec: Math.round((opts.armTtlMs || liveControl.ARM_TTL_MS) / 1000), publicAddress: snap.publicAddress, sol: snap.sol, usdc: snap.usdc, csrf: csrf.issue(gate.userId) });
      }

      if (pathname === '/api/live/start') {
        { const par = (opts.parityFn || liveParityDifferences)(); if (par.length) return send(res, 400, { ok: false, error: 'live belum sama dengan dry run; Go Live ditolak', differences: par }); }
        const phrase = body && String(body.confirm || body.phrase || '');
        if (phrase !== 'LIVE') return send(res, 400, { ok: false, error: 'type LIVE to confirm' });
        const used = arm.consume(body && body.armId, gate.userId);
        if (!used.ok) return send(res, 400, { ok: false, error: used.reason });
        // Second balance check right before start
        const snap = await liveControl.liveSnapshot({
          secretsDir, stopPath, noNewPath,
          getBalances: opts.getBalances,
          liveStatusFn: opts.liveStatusFn,
          rpc: opts.rpc,
        });
        if (!snap.hasKey) return send(res, 400, { ok: false, error: 'key not stored' });
        if (!snap.balanceCheck || !snap.balanceCheck.ok) {
          return send(res, 400, { ok: false, error: 'balance check failed', reasons: snap.balanceCheck && snap.balanceCheck.reasons });
        }
        liveControl.clearNoNew(noNewPath);
        liveControl.removeStop(stopPath);
        let started = { ok: true };
        const startFn = opts.startLiveFn || (opts.skipPm2 ? (() => ({ ok: true, skipped: 'test' })) : liveControl.startLivePm2);
        try { started = startFn(); } catch (e) { started = { ok: false, error: 'start failed' }; }
        let dryRunResumed = false;
        if (!started.ok) {   // live did not start: keep live locked; the dry run was never touched
          try { liveControl.writeStop(stopPath); } catch { /* ignore */ }
          dryRunResumed = true;
        } else {
          // Live is ON: the dry run stops. The paper bot closes its virtual positions, saves the run by number (run-N) and prepares run N+1, then idles.
          try { settings.pauseDryRun(paperDir, meta); } catch { /* ignore */ }
          try { fs.writeFileSync(path.join(paperDir, 'ARCHIVE_ON_LIVE'), JSON.stringify({ at: new Date().toISOString(), by: gate.userId }) + '\n', { mode: 0o600 }); } catch { /* ignore */ }
        }
        audit(`uid=${gate.userId} action=live-start address=${snap.publicAddress} started=${!!started.ok} (STOP removed by Tuan confirm; no key in env)`);
        notify('live-start', { publicAddress: snap.publicAddress, started: !!started.ok, startError: started.error || null }).catch(() => {});
        return send(res, 200, { ok: true, live: true, started: !!started.ok, dryRunResumed, startError: started.error || null, publicAddress: snap.publicAddress, stopPresent: liveControl.isStopPresent(stopPath), csrf: csrf.issue(gate.userId) });
      }

      if (pathname === '/api/live/stop') {
        const mode = (body && body.mode) === 'noNew' ? 'noNew' : 'closeAll';
        if (mode === 'noNew') {
          liveControl.writeNoNew(noNewPath);
          audit(`uid=${gate.userId} action=live-no-new (STOP not written; existing positions stay open)`);
          notify('live-no-new', {}).catch(() => {});
          return send(res, 200, { ok: true, mode, noNew: true, stopPresent: liveControl.isStopPresent(stopPath), csrf: csrf.issue(gate.userId) });
        }
        liveControl.writeStop(stopPath);
        const stopFn = opts.stopLiveFn || (opts.skipPm2 ? (() => ({ ok: true, skipped: 'test' })) : liveControl.stopLivePm2);
        let stopped = { ok: true };
        try { stopped = stopFn(); } catch { stopped = { ok: false }; }
        audit(`uid=${gate.userId} action=live-stop-close-all stopApp=${!!stopped.ok}`);
        notify('live-stop', { mode, stopped: !!stopped.ok }).catch(() => {});
        return send(res, 200, { ok: true, mode, stopPresent: true, stopped: !!stopped.ok, csrf: csrf.issue(gate.userId) });
      }
    } catch (e) {
      if (e && (e.code === 'LIVE_STOP_FORBIDDEN' || e.code === 'TEST_STOP_GUARD')) {
        return send(res, 403, { ok: false, error: 'live STOP is forbidden in this context' });
      }
      return send(res, 500, { ok: false, error: 'write failed' });
    }
  }

  return handle;
}

function startServer(opts = {}) {
  const handle = createApp(opts);
  const host = opts.host || DEFAULT_HOST;
  const port = opts.port != null ? opts.port : DEFAULT_PORT;
  const server = http.createServer((req, res) => {
    Promise.resolve(handle(req, res)).catch(() => {
      try { send(res, 500, { ok: false, error: 'server error' }); } catch { /* ignore */ }
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(port, host, () => {
      const addr = server.address();
      if (opts.pollTelegram === true) {
        try { require('../telegram-notify').startPolling(); } catch { /* poller is optional */ }
      }
      resolve({ server, host: addr.address, port: addr.port });
    });
    server.on('error', reject);
  });
}

if (require.main === module) {
  startServer({ pollTelegram: true }).then(({ host, port }) => {
    console.log(`[${settings.wib()}] [PAPER] mini app listening on http://${host}:${port} (localhost default; live controls require Tuan confirm)`);
  }).catch((e) => {
    console.error('miniapp failed to start: ' + (e && e.message));
    process.exit(1);
  });
}

module.exports = { startServer, createApp, publicStatus };
