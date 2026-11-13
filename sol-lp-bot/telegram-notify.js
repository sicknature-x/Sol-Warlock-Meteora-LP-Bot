require('./env-config').load(__dirname);
// Telegram notifier for the paper bot. Fail-safe: never throws to the caller.
// The bot token is read from TELEGRAM_BOT_TOKEN or a chmod 600 file outside the repo.
// Never log, echo, or write the token.
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const quotePnl=require('./paper-quote-pnl');

const ROOT = process.env.LP_BOT_DIR || '/workspace/lp-bot';
const SECRET_FILE = process.env.TELEGRAM_TOKEN_FILE || '/home/box/.secrets/lp-bot-telegram.token';
const CFG_FILE = process.env.TELEGRAM_CFG_FILE || path.join(ROOT, 'paper', 'telegram.json');
const TUNNEL_FILE = process.env.TUNNEL_URL_FILE || path.join(ROOT, 'paper', 'tunnel-url.json');
const OFFSET_FILE = process.env.TG_OFFSET_FILE || path.join(ROOT, 'paper', 'tg-offset.json');
const MIN_GAP_MS = 2000;
const HTTP_TIMEOUT_MS = 15000;
const MAX_QUEUE = 25;
const ERROR_COOLDOWN_MS = 5 * 60 * 1000;
const IS_LIVE = process.env.DRY_RUN === '0' && process.env.PAPER !== '1';
const PREFIX = IS_LIVE ? '[LIVE]' : '[DRY RUN]';
// Recipient authorization comes from .env; there is no built-in recipient.
const TUAN_TG_ID = Number(process.env.TELEGRAM_ALLOWED_ID || process.env.TELEGRAM_CHAT_ID || 0);
const { botWalletAddress } = require('./bot-wallet-address');

let queue = Promise.resolve();
let queueLen = 0;
let lastSentAt = 0;
let lastErrorAt = 0;
let lastErrorKey = '';

function redact(s) {
  if (s == null) return '';
  let t = require('./env-config').redact(s);
  try {
    const tok = loadToken();
    if (tok) t = t.split(tok).join('[redacted]');
  } catch { /* ignore */ }
  t = t.replace(/https?:\/\/api\.telegram\.org\/bot[^\s]+/gi, 'telegram-api');
  return t.slice(0, 400);
}

function tokenFromText(v) {
  const raw = String(v || '').trim();
  if (!raw) return '';
  const m = raw.match(/^\s*TELEGRAM_BOT_TOKEN\s*=\s*(.*)$/m);
  if (m) {
    let t = m[1].trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1);
    return t.trim();
  }
  const lines = raw.split(/\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.includes('='));
  return lines[0] || '';
}

function loadToken() {
  try {
    const env = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
    if (env) return env;
  } catch { /* ignore */ }
  try {
    if (fs.existsSync(SECRET_FILE)) {
      const t = tokenFromText(fs.readFileSync(SECRET_FILE, 'utf8'));
      if (t) return t;
    }
  } catch { /* ignore */ }
  return '';
}

function loadCfg() {
  try {
    return {...JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')),...(process.env.TELEGRAM_CHAT_ID?{chatId:Number(process.env.TELEGRAM_CHAT_ID)}:{})};
  } catch {
    return {};
  }
}

function saveCfgPatch(patch) {
  try {
    const cur = loadCfg();
    const next = { ...cur, ...patch, updatedWib: wib() };
    delete next.token;
    delete next.botToken;
    delete next.TELEGRAM_BOT_TOKEN;
    const tmp = CFG_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, CFG_FILE);
    return true;
  } catch {
    return false;
  }
}

function wib(d = new Date()) {
  return new Date(d).toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' }) + ' WIB';
}

function wibDate(d = new Date()) {
  return new Date(d).toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' }).slice(0, 10);
}

function wibHourMinute(d = new Date()) {
  const s = new Date(d).toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' });
  const time = s.split(' ')[1] || '00:00:00';
  const [hh, mm] = time.split(':').map(Number);
  return { date: s.slice(0, 10), hh, mm };
}

function allowedTgIds() {
  const ids = new Set(TUAN_TG_ID?[TUAN_TG_ID]:[]);
  const extra = String(process.env.ALLOWED_TG_IDS || '').split(/[\s,]+/).filter(Boolean);
  for (const x of extra) {
    if (/^-?\d+$/.test(x)) ids.add(Number(x));
  }
  if(TUAN_TG_ID)ids.add(TUAN_TG_ID);
  return ids;
}

function isAllowedTgId(id) {
  if (id == null || id === '') return false;
  const n = Number(id);
  return Number.isFinite(n) && allowedTgIds().has(n);
}

// Only Tuan's chat. A stored chat id is used only if it is on the allowlist.
function chatId() {
  const configured = loadCfg().chatId;
  if (isAllowedTgId(configured)) return Number(configured);
  return TUAN_TG_ID;
}

function lpAgentAddress() {
  // explicit override (LPAGENT_ADDRESS_OVERRIDE; the old LPAGENT_ADDRESS is ignored) wins; otherwise the bot's own stored wallet; never a hard-coded personal address
  return String(process.env.LPAGENT_ADDRESS_OVERRIDE || '').trim() || botWalletAddress() || '';
}

function lpAgentLink(address) {
  const addr = address || lpAgentAddress();
  return addr ? `https://app.lpagent.io/portfolio?address=${encodeURIComponent(addr)}&chain=SOL` : 'https://app.lpagent.io/portfolio';   // no wallet stored yet: generic page
}

function dryRunLpAgentNote() {
  return IS_LIVE ? '' : '(posisi dry run tidak tampil di LP Agent)';
}

// Plain URL buttons only (open public pages). Never web_app / mini-app buttons.
function poolKeyboard(pool) {
  const row = [];
  if (pool) row.push({ text: 'Meteora', url: meteoraLink(pool) });
  row.push({ text: 'LP Agent', url: lpAgentLink() });
  return { inline_keyboard: [row] };
}

function sanitizeReplyMarkup(markup, { allowWebApp } = {}) {
  if (!markup || typeof markup !== 'object') return undefined;
  const rows = markup.inline_keyboard;
  if (!Array.isArray(rows)) return undefined;
  const clean = rows.map((row) => (Array.isArray(row) ? row : []).map((btn) => {
    if (!btn || typeof btn !== 'object' || !btn.text) return null;
    const text = String(btn.text).slice(0, 32);
    if (btn.url) return { text, url: String(btn.url) };
    // web_app is allowed only for /start and the chat menu, never on trade notifications.
    if (allowWebApp && btn.web_app && btn.web_app.url) {
      const u = String(btn.web_app.url).trim();
      if (!/^https:\/\//i.test(u)) return null;
      return { text, web_app: { url: u } };
    }
    return null;
  }).filter(Boolean)).filter((row) => row.length);
  return clean.length ? { inline_keyboard: clean } : undefined;
}

function readTunnelUrl() {
  if(/^https:\/\//.test(process.env.MINIAPP_URL||''))return process.env.MINIAPP_URL.replace(/\/$/,'');
  try {
    const j = JSON.parse(fs.readFileSync(TUNNEL_FILE, 'utf8'));
    const u = String((j && (j.url || j.https)) || '').trim().replace(/\/$/, '');
    if (/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i.test(u)) return u;
  } catch { /* ignore */ }
  return '';
}

function writeTunnelUrl(url) {
  const clean = String(url || '').trim().replace(/\/$/, '');
  const dir = path.dirname(TUNNEL_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = TUNNEL_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ url: clean, updatedWib: wib() }, null, 2) + '\n');
  fs.renameSync(tmp, TUNNEL_FILE);
  return clean;
}

function startKeyboard(url) {
  return { inline_keyboard: [[{ text: 'Buka mini app', web_app: { url } }]] };
}

// For a future mini app only. Not used: we do not attach WebApp buttons.
function validateInitData(initData, token) {
  try {
    const tok = token || loadToken();
    if (!tok || !initData) return { ok: false, reason: 'missing' };
    const params = new URLSearchParams(String(initData));
    const hash = params.get('hash');
    if (!hash) return { ok: false, reason: 'no hash' };
    params.delete('hash');
    const dataCheck = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(tok).digest();
    const check = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(check, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad hash' };
    let user = null;
    try { user = JSON.parse(params.get('user') || 'null'); } catch { user = null; }
    const uid = user && user.id;
    if (!isAllowedTgId(uid)) return { ok: false, reason: 'user not allowed' };
    return { ok: true, userId: uid };
  } catch {
    return { ok: false, reason: 'validate failed' };
  }
}

function isAllowedUpdate(update) {
  try {
    const cq = update && update.callback_query;
    const msg = (update && (update.message || update.edited_message))
      || (cq && cq.message);
    const from = (cq && cq.from) || (msg && msg.from) || (update && update.from);
    const chat = (msg && msg.chat) || (update && update.chat);
    return isAllowedTgId(from && from.id) || isAllowedTgId(chat && chat.id);
  } catch {
    return false;
  }
}

function fmtNum(n, d = 2) {
  if (n == null || !Number.isFinite(+n)) return 'n/a';
  return (+n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
}

function fmtSol(n, d = 4) {
  if (n == null || !Number.isFinite(+n)) return 'n/a';
  const v = +n;
  const sign = v > 0 ? '+' : '';
  return sign + v.toFixed(d) + ' SOL';
}

function fmtPct(n) {
  if (n == null || !Number.isFinite(+n)) return 'n/a';
  const v = +n;
  const sign = v > 0 ? '+' : '';
  return sign + v.toFixed(2) + '%';
}

function fmtUsd(n) {
  if (n == null || !Number.isFinite(+n)) return 'n/a';
  return '$' + Math.round(+n).toLocaleString('en-US');
}

function meteoraLink(pool) {
  return pool ? `https://app.meteora.ag/dlmm/${pool}` : '';
}

function postSendMessage(text, opts = {}) {
  if (typeof messageTransport === 'function') {
    return Promise.resolve(messageTransport(text, opts));
  }
  return new Promise((resolve) => {
    const token = loadToken();
    const id = opts.chat_id != null ? opts.chat_id : chatId();
    if (!token) return resolve({ ok: false, skipped: 'token not set' });
    if (id == null) return resolve({ ok: false, skipped: 'chat id missing' });
    if (!isAllowedTgId(id)) return resolve({ ok: false, skipped: 'chat id not allowlisted' });
    const payload = {
      chat_id: id,
      text: String(text).slice(0, 3900),
      disable_web_page_preview: true,
    };
    const markup = sanitizeReplyMarkup(opts.reply_markup, { allowWebApp: !!opts.allowWebApp });
    if (markup) payload.reply_markup = markup;
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: HTTP_TIMEOUT_MS,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; if (buf.length > 8000) buf = buf.slice(0, 8000); });
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          if (j && j.ok) return resolve({ ok: true, messageId: j.result && j.result.message_id });
          return resolve({ ok: false, error: redact((j && j.description) || 'telegram not ok') });
        } catch (e) {
          return resolve({ ok: false, error: 'bad telegram response' });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: redact(e.message || 'request error') }));
    req.on('timeout', () => { try { req.destroy(); } catch { /* ignore */ } resolve({ ok: false, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

function send(text, opts = {}) {
  if (queueLen >= MAX_QUEUE) {
    return Promise.resolve({ ok: false, skipped: 'notify queue full' });
  }
  queueLen += 1;
  const job = queue.then(async () => {
    const wait = lastSentAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const res = await postSendMessage(text, opts);
    lastSentAt = Date.now();
    return res;
  }).catch((e) => ({ ok: false, error: redact(e && e.message) }))
    .finally(() => { queueLen = Math.max(0, queueLen - 1); });
  queue = job.then(() => undefined, () => undefined);
  return job;
}

function fire(text, opts = {}) {
  return send(text, opts).catch(() => ({ ok: false, error: 'notify failed' }));
}

function postApi(method, payload) {
  return new Promise((resolve) => {
    const token = loadToken();
    if (!token) return resolve({ ok: false, skipped: 'token not set' });
    const body = JSON.stringify(payload || {});
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: HTTP_TIMEOUT_MS,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; if (buf.length > 8000) buf = buf.slice(0, 8000); });
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          if (j && j.ok) return resolve({ ok: true, result: j.result });
          return resolve({ ok: false, error: redact((j && j.description) || 'telegram not ok') });
        } catch {
          return resolve({ ok: false, error: 'bad telegram response' });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: redact(e.message || 'request error') }));
    req.on('timeout', () => { try { req.destroy(); } catch { /* ignore */ } resolve({ ok: false, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

let photoTransport = null;
let messageTransport = null;
function setPhotoTransport(fn) { photoTransport = fn; }
function setMessageTransport(fn) { messageTransport = fn; }

function postSendPhoto(caption, png, opts = {}) {
  if (typeof photoTransport === 'function') {
    return Promise.resolve(photoTransport(caption, png, opts));
  }
  return new Promise((resolve) => {
    const token = loadToken();
    const id = opts.chat_id != null ? opts.chat_id : chatId();
    if (!token) return resolve({ ok: false, skipped: 'token not set' });
    if (id == null) return resolve({ ok: false, skipped: 'chat id missing' });
    if (!isAllowedTgId(id)) return resolve({ ok: false, skipped: 'chat id not allowlisted' });
    if (!Buffer.isBuffer(png) || png.length < 32) return resolve({ ok: false, error: 'no photo' });
    let FormData;
    try { FormData = require('form-data'); } catch (e) { return resolve({ ok: false, error: 'form-data missing' }); }
    const form = new FormData();
    form.append('chat_id', String(id));
    form.append('caption', String(caption || '').slice(0, 1024));
    form.append('photo', png, { filename: 'bin-shape.png', contentType: 'image/png' });
    const markup = sanitizeReplyMarkup(opts.reply_markup);
    if (markup) form.append('reply_markup', JSON.stringify(markup));
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendPhoto`,
      method: 'POST',
      headers: form.getHeaders(),
      timeout: Math.max(HTTP_TIMEOUT_MS, 20000),
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; if (buf.length > 8000) buf = buf.slice(0, 8000); });
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          if (j && j.ok) return resolve({ ok: true, messageId: j.result && j.result.message_id, photo: true });
          return resolve({ ok: false, error: redact((j && j.description) || 'telegram not ok') });
        } catch {
          return resolve({ ok: false, error: 'bad telegram response' });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: redact(e.message || 'request error') }));
    req.on('timeout', () => { try { req.destroy(); } catch { /* ignore */ } resolve({ ok: false, error: 'timeout' }); });
    form.pipe(req);
  });
}

function sendPhoto(caption, png, opts = {}) {
  if (queueLen >= MAX_QUEUE) return Promise.resolve({ ok: false, skipped: 'notify queue full' });
  queueLen += 1;
  const job = queue.then(async () => {
    const wait = lastSentAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const res = await postSendPhoto(caption, png, opts);
    lastSentAt = Date.now();
    return res;
  }).catch((e) => ({ ok: false, error: redact(e && e.message) }))
    .finally(() => { queueLen = Math.max(0, queueLen - 1); });
  queue = job.then(() => undefined, () => undefined);
  return job;
}

function renderBinShapePng(posLike) {
  if (!posLike) return null;
  const src = posLike.binShape || posLike;
  if (!src.bins && !src.binMap) return null;
  const binShape = require('./bin-shape');
  return binShape.renderPng(src);
}

function fireWithChart(text, posLike, opts = {}) {
  return (async () => {
    try {
      const png = renderBinShapePng(posLike);
      if (png) {
        const cap = String(text || '').length > 1000 ? String(text).slice(0, 990) + '\n…' : text;
        const photo = await sendPhoto(cap, png, opts);
        if (photo && photo.ok) return photo;
      }
    } catch { /* fall back to text */ }
    return fire(text, opts);
  })().catch(() => ({ ok: false, error: 'notify failed' }));
}

function setChatMenuButton(url, chatId = TUAN_TG_ID) {
  if (!url || !isAllowedTgId(chatId)) return Promise.resolve({ ok: false, skipped: 'url or chat missing' });
  return postApi('setChatMenuButton', {
    chat_id: chatId,
    menu_button: { type: 'web_app', text: 'Mini app', web_app: { url } },
  });
}

function setMyCommands() {
  return postApi('setMyCommands', {
    commands: [{ command: 'start', description: 'Buka mini app Sol Warlock v1.8' }],
  });
}

async function publishMiniAppUrl(url) {
  const clean = String(url || '').trim().replace(/\/$/, '');
  if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i.test(clean)) {
    return { ok: false, error: 'invalid tunnel url' };
  }
  const prev = readTunnelUrl();
  writeTunnelUrl(clean);
  if (prev === clean) return { ok: true, changed: false, url: clean };
  const menu = await setChatMenuButton(clean, TUAN_TG_ID);
  const cmds = await setMyCommands();
  return { ok: !!(menu.ok || cmds.ok), changed: true, url: clean, menuOk: !!menu.ok, commandsOk: !!cmds.ok, menuError: menu.error, commandsError: cmds.error };
}

function replyStart(fromId, chatId) {
  if (!isAllowedTgId(fromId) || !isAllowedTgId(chatId)) {
    return Promise.resolve({ ok: false, skipped: 'not allowlisted' });
  }
  const url = readTunnelUrl();
  if (!url) {
    return send('Tuan, mini app belum punya URL publik. Coba /start lagi sebentar.', { chat_id: chatId });
  }
  return send('Tuan, buka mini app Sol Warlock v1.8 di sini (Status, Settings, Wallet, Live).', {
    chat_id: chatId,
    reply_markup: startKeyboard(url),
    allowWebApp: true,
  });
}

function handleUpdate(update) {
  try {
    if (!isAllowedUpdate(update)) return Promise.resolve({ ok: false, skipped: 'ignored' });
    const msg = update && (update.message || update.edited_message);
    const text = msg && msg.text;
    const fromId = msg && msg.from && msg.from.id;
    const chatId = msg && msg.chat && msg.chat.id;
    if (text && /^\/start(?:@\S+)?(?:\s|$)/.test(String(text))) {
      return replyStart(fromId, chatId);
    }
    return Promise.resolve({ ok: false, skipped: 'not start' });
  } catch {
    return Promise.resolve({ ok: false, skipped: 'handle failed' });
  }
}

function readOffset() {
  try { return +(JSON.parse(fs.readFileSync(OFFSET_FILE, 'utf8')).offset) || 0; } catch { return 0; }
}
function writeOffset(offset) {
  try {
    fs.writeFileSync(OFFSET_FILE, JSON.stringify({ offset, updatedWib: wib() }) + '\n');
  } catch { /* ignore */ }
}

function getUpdates(offset) {
  return new Promise((resolve) => {
    const token = loadToken();
    if (!token) return resolve({ ok: false, skipped: 'token not set' });
    const q = `timeout=25&offset=${offset || 0}&allowed_updates=${encodeURIComponent(JSON.stringify(['message']))}`;
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/getUpdates?${q}`,
      method: 'GET',
      timeout: 35000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; if (buf.length > 200000) buf = buf.slice(0, 200000); });
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          if (j && j.ok) return resolve({ ok: true, result: j.result || [] });
          return resolve({ ok: false, error: redact((j && j.description) || 'getUpdates not ok') });
        } catch {
          return resolve({ ok: false, error: 'bad telegram response' });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: redact(e.message || 'request error') }));
    req.on('timeout', () => { try { req.destroy(); } catch { /* ignore */ } resolve({ ok: false, error: 'timeout' }); });
    req.end();
  });
}

let polling = false;
async function pollOnce() {
  const offset = readOffset();
  const res = await getUpdates(offset);
  if (!res.ok || !Array.isArray(res.result)) return res;
  let last = offset;
  for (const upd of res.result) {
    if (upd && upd.update_id >= last) last = upd.update_id + 1;
    try { await handleUpdate(upd); } catch { /* ignore one update */ }
  }
  if (last !== offset) writeOffset(last);
  return { ok: true, n: res.result.length };
}

function startPolling() {
  if (polling) return { ok: true, already: true };
  polling = true;
  const loop = async () => {
    while (polling) {
      try { await pollOnce(); } catch { await new Promise((r) => setTimeout(r, 2000)); }
    }
  };
  loop().catch(() => {});
  return { ok: true };
}

function stopPolling() { polling = false; }

function openReasonLines(c){
 const s=c?.snapshot||{},v=(n,d=2)=>n!=null&&Number.isFinite(+n)?fmtNum(+n,d):'tidak diketahui';
 return [`Aset modal saat entry: ${s.capitalAsset||'USDC'}${s.capitalInSol!=null?' · modal '+v(s.capitalInSol,6)+' SOL':''}`,`Sumber buka: ${c?.source||'tidak diketahui'}`,`Alasan buka: ${c?.reason||'tidak diketahui'}`,
 `Screen entry: fee/TVL 30m ${v(s.ft30mPct)}% · TVL ${s.tvlUsd==null?'tidak diketahui':fmtUsd(s.tvlUsd)} · umur ${v(s.ageH,1)} jam · bin step ${v(s.binStep,0)}`,
 `MC: ${s.marketCapUsd==null?'tidak diketahui':fmtUsd(s.marketCapUsd)} · quote ${s.quote||'tidak diketahui'} · strategi ${s.strategy||'tidak diketahui'}`,
 `Non-refundable entry: ${s.entryCostEstimate?.known?v(s.entryCostEstimate.nonrefTotalSol,6)+' SOL; '+s.entryCostEstimate.newBinArrays+' bin array baru':'tidak diketahui'}`,
 `Filter: ${s.passedAllFilters===true?'lolos semua':s.passedAllFilters===false?'⚠ tidak lolos: '+(s.failedFilters||[]).join('; '):'tidak diketahui / bukan full screening'}`];
}

function notifyOpen({ name, pool, sizeSol, quoteSymbol = 'SOL', depositQuote, usdcIn, gasBufferSol, leftoverSol, minBinId, maxBinId, rangePct, entryPrice, ft30m, tvl } = {}) {
  const sizeLine = quoteSymbol === 'USDC' ? `💰 Size: ${fmtUsd(usdcIn)} (posisi ${fmtUsd(depositQuote)} USDC + buffer gas ${fmtNum(gasBufferSol,4)} SOL, sisa ${fmtNum(leftoverSol,4)} SOL)` : usdcIn != null
    ? `💰 Size: ${fmtUsd(usdcIn)} (posisi ${fmtNum(sizeSol, 4)} SOL + buffer gas ${fmtNum(gasBufferSol, 4)} SOL, sisa ${fmtNum(leftoverSol, 4)} SOL)`
    : `💰 Size: ${fmtNum(sizeSol, 4)} SOL`;
  const lines = [
    `🟢 ${PREFIX} Tuan, posisi kebuka.`,
    '',
    `🪙 Pair: ${name || 'n/a'}`,
    `📍 Pool: ${pool || 'n/a'}`,
    arguments[0]?.openContext?.snapshot?.capitalAsset==='SOL'?`💰 Modal: ${fmtNum(arguments[0].openContext.snapshot.capitalInSol,6)} SOL (nilai saat entry ${fmtUsd(usdcIn)}); gas dari SOL`:sizeLine,
    ...openReasonLines(arguments[0]?.openContext),
    `🎯 Basis entry: ${fmtNum(arguments[0]?.entryQuoteAmount??depositQuote??sizeSol,6)} ${quoteSymbol}`,
    `📊 PnL LP net quote: ${quotePnl.format(arguments[0])}`,
    quotePnl.solChange(arguments[0]),
    `📐 Range: bin ${minBinId}..${maxBinId}${rangePct != null ? ` (${fmtNum(rangePct, 1)}%)` : ''}`,
    `💵 Harga entry: ${entryPrice != null && Number.isFinite(+entryPrice) ? Number(entryPrice).toExponential(4) + ' ' + quoteSymbol : 'n/a'}`,
    `📈 Fee/TVL 30m: ${ft30m != null && Number.isFinite(+ft30m) ? fmtNum(ft30m, 2) + '%' : 'n/a'}`,
    `🏦 TVL: ${fmtUsd(tvl)}`,
    '',
    dryRunLpAgentNote(),
  ];
  const arguments_ = arguments[0] || {};
  return fireWithChart(lines.join('\n'), arguments_, { reply_markup: poolKeyboard(pool) });
}

function notifyReshape({ name, pool, n, activeBin, rightMin, rightMax, amountX, tokenX, feeXAdded, feeYAdded, reshapes, quoteSymbol = 'SOL' } = {}) {
  const lines = [
    `🔄 ${PREFIX} Tuan, reshape #${reshapes || n || '?'} (turun 5 bin).`,
    '',
    `Pair: ${name || 'n/a'}`,
    `Pool: ${pool || 'n/a'}`,
    `Active bin: ${activeBin != null ? activeBin : 'n/a'}`,
    `Range kanan: ${rightMin != null ? rightMin : 'n/a'}..${rightMax != null ? rightMax : 'n/a'}`,
    `Token di-add (X): ${amountX != null && Number.isFinite(+amountX) ? Number(amountX).toExponential(4) : 'n/a'}`,
    `  (withdrawn ${tokenX != null && Number.isFinite(+tokenX) ? Number(tokenX).toExponential(4) : 'n/a'} + fee X ${feeXAdded != null && Number.isFinite(+feeXAdded) ? Number(feeXAdded).toExponential(4) : 'n/a'})`,
    `Fee ${quoteSymbol} di-compound: ${fmtNum(feeYAdded, 6)} ${quoteSymbol}`,
    '',
    dryRunLpAgentNote(),
  ];
  return fireWithChart(lines.join('\n'), arguments[0] || {}, { reply_markup: poolKeyboard(pool) });
}

function notifyReposition(e={}){
 const lines=[`🔁 ${PREFIX} Tuan, reposition kanan #${e.number}.`,`🪙 Pair: ${e.name}`,`🧾 Alasan: ${e.reason}`,...openReasonLines(e.openContext),`PnL LP net quote: ${quotePnl.format(e)}`,quotePnl.solChange(e),e.capitalAsset==='SOL'?`PnL net SOL (aturan risiko): ${fmtNum(e.pnlCapital,6)} SOL (${fmtNum(e.pnlPct,3)}%); USD ${fmtUsd(e.pnlUsd)}`:`PnL net USDC (aturan risiko): ${fmtUsd(e.pnlUsd)} (${fmtNum(e.pnlPct,3)}%)`,`Range baru: ${e.minBinId}..${e.maxBinId}; active ${e.activeBin}`,`Swap, gas, rent dihitung; PnL lama diteruskan, batas hold tidak direset.`,dryRunLpAgentNote()];
 return fireWithChart(lines.join('\n'),e,{reply_markup:poolKeyboard(e.pool)});
}

function closeBody(rec, title) {
  const reason=rec?.closeReasonText||require('./paper-history').closeReason(rec||{});
  return [
    title,
    '',
    `🪙 Pair: ${(rec && rec.name) || 'n/a'}`,
    rec && rec.pool ? `📍 Pool: ${rec.pool}` : '',
    `🧾 Alasan: ${reason}`,
    `⏱ Hold: ${rec && rec.holdHours != null ? fmtNum(rec.holdHours, 2) + ' jam' : 'n/a'}`,
    `📊 PnL LP net quote: ${quotePnl.format(rec)}`,
    quotePnl.solChange(rec),
    rec?.capitalAsset==='SOL'?`💵 PnL modal SOL (aturan risiko): ${fmtNum(rec.pnlCapital,6)} SOL (${fmtPct(rec.pnlCapitalPct)}); nilai USD ${fmtUsd(rec.pnlUsd)}`:rec && rec.pnlUsd != null ? `💵 PnL net USDC (aturan risiko): ${fmtUsd(rec.pnlUsd)} (${fmtPct(rec.pnlPct??rec.netPnlPct)})` : '',
    rec?.capitalAsset==='SOL'?`💱 SOL: ${fmtNum(rec.initialCapitalInSol||rec.capitalInSol,6)} → ${fmtNum(rec.solOut,6)}`:rec && rec.usdcIn != null ? `💱 USDC: ${fmtUsd(rec.usdcIn)} → ${fmtUsd(rec.usdcOut)}` : '',
    rec && rec.swapCostUsd != null ? `💸 Biaya swap: ${fmtUsd(rec.swapCostUsd)}` : '',
    rec && rec.gasUsedSol != null ? `⛽ Gas/rent terpakai: ${fmtNum(rec.gasUsedSol, 6)} SOL` : '',
    rec && rec.feesEarnedUsd != null ? `🌾 Fee: ${fmtUsd(rec.feesEarnedUsd)} (${fmtNum(rec.feesEarnedQuote,6)} ${rec.quoteSymbol||'SOL'})` : `🌾 Fee: ${fmtNum(rec && rec.feesEarnedSol,6)} SOL`,
    rec && rec.reshapes != null ? `🔄 Reshape: ${rec.reshapes}` : '',
  ].filter(Boolean).join('\n');
}

function notifyClose(rec = {}) {
  const win = Number(rec && (rec.pnlUsd != null ? rec.pnlUsd : rec.pnlCapital)) >= 0;
  const text = closeBody(rec, `${win ? '✅' : '🔻'} ${PREFIX} Tuan, posisi ditutup${win ? ' (profit)' : ' (rugi)'}.`) + '\n\n' + dryRunLpAgentNote();
  return fire(text, { reply_markup: poolKeyboard(rec && rec.pool) });
}

function notifyEmergency(rec = {}) {
  const text = closeBody(rec, `🛑 ${PREFIX} Tuan, EMERGENCY STOP. Rugi net ${rec.capitalAsset||'USDC'} posisi mencapai batas.`) + '\n\n' + dryRunLpAgentNote();
  return fire(text, { reply_markup: poolKeyboard(rec && rec.pool) });
}

function notifyError(err, kind = 'error') {
  const key = kind + ':' + redact(err && (err.message || err)).slice(0, 80);
  const now = Date.now();
  if (key === lastErrorKey && now - lastErrorAt < ERROR_COOLDOWN_MS) {
    return Promise.resolve({ ok: false, skipped: 'error notify cooldown' });
  }
  lastErrorKey = key;
  lastErrorAt = now;
  const brief = redact(err && (err.stack || err.message || err)).split('\n').slice(0, 3).join(' / ');
  const text = [
    `${PREFIX} Tuan, bot ${kind}.`,
    '',
    brief || '(tidak ada detail)',
    kind === 'cycle error' ? 'Masih jalan, retry ~15 detik. Live tidak dijalankan.' : 'Cek log paper/bot.log. Live tidak dijalankan.',
  ].join('\n');
  return fire(text);
}

function notifyStartup(status = {}) {
  const pos = status.position;
  const scan = status.lastScan;
  const rej = scan && scan.rejects ? Object.entries(scan.rejects).map(([k, v]) => `${k} ${v}`).join(', ') : '';
  const lines = [
    `${PREFIX} Bot LP Sol Warlock v1.8 terhubung`,
    '',
    'Status dry run:',
    `Window: ${status.startedWib || 'n/a'} → ${status.endsWib || 'n/a'}`,
    'Strategy: N5 (reshape tiap 5 bin, compound fee SOL)',
    `Filter: ${status.ftWindow || '30m'} fee/TVL ≥ ${status.minFt != null ? status.minFt : 2}%, TVL ≥ $${status.minLiqUsd != null ? Number(status.minLiqUsd).toLocaleString('en-US') : '25,000'}, umur ≥ ${status.minAgeH != null ? status.minAgeH : 24} jam`,
    `Modal: ${status.capitalAsset==='SOL'?fmtNum(status.freeCapitalSol,6)+' SOL':status.virtualUsdc != null ? fmtUsd(status.virtualUsdc) : (status.virtualCashSol != null ? fmtNum(status.virtualCashSol, 4) + ' SOL' : 'n/a')}${status.leftoverSol ? ` + ${fmtNum(status.leftoverSol, 4)} SOL sisa buffer` : ''}`,
    `Posisi ${status.openCount||0}/${status.maxPositions||5}: ${(status.positions||[]).map(p=>p.name||p.pool).join(', ')||'tidak ada'}`,
    scan ? `Scan terakhir: ${scan.atWib || ''} — ${scan.fetched || 0} pool, ${scan.n || 0} lolos${rej ? ` (tolak: ${rej})` : ''}` : '',
    'Live tidak dijalankan.',
  ].filter((l, i, a) => l !== '' || i === 1);
  return fire(lines.join('\n'));
}

function notifyRestart(status = {}) {
  return notifyStartup(status);
}

function dailyDue(now = new Date()) {
  const { date, hh } = wibHourMinute(now);
  if (hh < 21) return false;
  const last = loadCfg().lastDailySummaryDate;
  return last !== date;
}

function notifyDailySummary(status = {}) {
  const { date } = wibHourMinute();
  if (!dailyDue()) return Promise.resolve({ ok: false, skipped: 'daily already sent or not due' });
  const lines = [
    `${PREFIX} Tuan, ringkasan harian (${date} ~21:00 WIB).`,
    '',
    `Trades hari ini: ${status.tradesToday != null ? status.tradesToday : 0}`,
    `PnL realisasi hari ini (USDC): ${status.pnlTodayUsd != null ? fmtUsd(status.pnlTodayUsd) : fmtSol(status.pnlToday, 4)}`,
    `PnL equity kumulatif (USDC): ${status.pnlTotalUsd != null ? fmtUsd(status.pnlTotalUsd) : fmtSol(status.pnlTotal, 4)}`,
    `Modal: ${status.capitalAsset==='SOL'?fmtNum(status.freeCapitalSol,6)+' SOL':status.virtualUsdc != null ? fmtUsd(status.virtualUsdc) : (status.virtualCashSol != null ? fmtNum(status.virtualCashSol, 4) + ' SOL' : 'n/a')}${status.leftoverSol ? ` + ${fmtNum(status.leftoverSol, 4)} SOL sisa buffer` : ''}`,
    `PnL posisi open (quote → USD): ${fmtUsd(status.quotePnlTotals?.usd)}`,
    ...Object.entries(status.quotePnlTotals?.quotes||{}).map(([q,n])=>`${q}-pool: ${fmtNum(n,q==='SOL'?4:2)} ${q}`),
    ...(status.positions||[]).map(p=>`${p.name} [modal ${p.capitalAsset||'USDC'}]: ${quotePnl.format(p)}${quotePnl.solChange(p)?' · '+quotePnl.solChange(p):''}`),
    'Aturan exit mengikuti aset modal masing-masing posisi saat entry (USDC/SOL).',
    `Aset modal aktif: ${status.capitalAsset||'USDC'} · equity ${fmtNum(status.equitySol,6)} SOL · deposit basis ${fmtNum(status.totalDepositedSol,6)} SOL`,
    `Equity: ${fmtUsd(status.equityUsd)} · modal disetor: ${fmtUsd(status.totalDepositedUsdc)}`,
    `Posisi ${status.openCount||0}/${status.maxPositions||5}: ${(status.positions||[]).map(p=>p.name||p.pool).join(', ')||'tidak ada'}`,
    `Window sampai: ${status.endsWib || 'n/a'}`,
  ];
  return fire(lines.join('\n')).then((res) => {
    if (res && res.ok) saveCfgPatch({ lastDailySummaryDate: date });
    return res;
  });
}

function notifyWindowEnd(status = {}) {
  const lines = [
    `${PREFIX} Tuan, window dry run sudah berakhir (${status.endsWib || wib()}).`,
    '',
    `Trades: ${status.trades != null ? status.trades : 0}`,
    `PnL: ${status.pnlTotalUsd != null ? fmtUsd(status.pnlTotalUsd) : fmtSol(status.pnlTotal, 4)}`,
    `Modal: ${status.capitalAsset==='SOL'?fmtNum(status.freeCapitalSol,6)+' SOL':status.virtualUsdc != null ? fmtUsd(status.virtualUsdc) : (status.virtualCashSol != null ? fmtNum(status.virtualCashSol, 4) + ' SOL' : 'n/a')}${status.leftoverSol ? ` + ${fmtNum(status.leftoverSol, 4)} SOL sisa buffer` : ''}`,
    'Bot berhenti. Live tidak dijalankan.',
  ];
  return fire(lines.join('\n'));
}

function maybeDailySummary(status) {
  try {
    if (dailyDue()) return notifyDailySummary(status);
  } catch { /* ignore */ }
  return Promise.resolve({ ok: false, skipped: 'not due' });
}

function installProcessHandlers() {
  const once = (kind) => (err) => {
    try { notifyError(err, kind); } catch { /* ignore */ }
  };
  process.on('uncaughtException', once('crash (uncaught)'));
  process.on('unhandledRejection', once('crash (unhandled rejection)'));
}

function statusFromState(state, extra = {}) {
  const book = state && state.books && (state.books.N5 || Object.values(state.books)[0]);
  const positions=book?.positions||(book?.position?[book.position]:[]);
  const capitalPx=extra.solUsd||positions[0]?.lastSolUsd||positions[0]?.solUsdEntry||book?.virtual?.lastCapitalSolUsd||book?.virtual?.solDepositBasisPrice||0;
  const equityUsd=(book?.virtual?.usdc||0)+(book?.virtual?.capitalSol||0)*capitalPx+positions.reduce((n,p)=>{
    const px=p.lastSolUsd||p.solUsdEntry||0,unit=p.quoteSymbol==='USDC'?1:px;
    const xy=Object.values(p.bins||{}).reduce((r,b)=>({x:r.x+(b.x||0),y:r.y+(b.y||0)}),{x:0,y:0});
    const mark=((xy.x+(p.feeX||0))*(p.lastPrice||p.entryPrice)+(xy.y+(p.feeY||0)))*unit+((p.reserveSol||0)+(p.rentRefundableSol||0))*px;
    return n+(p.lastLive?.exitUsdc??p.lastExitUsdc??mark);
  },0);
  const deposits=book?.virtual?.totalDepositedUsdc??book?.virtual?.usdcStart??0;
  const displays=positions.map(p=>p.lastLive?.pnlQuote!=null?p.lastLive:quotePnl.fromPosition(p));
  const hist = (book && book.history) || [];
  const today = wibDate();
  const todays = hist.filter((h) => String(h.exitWib || '').startsWith(today));
  const sum = (rows) => rows.reduce((s, h) => s + (+h.netPnlSol || 0), 0);
  return {
    startedWib: state && state.meta && state.meta.startedWib,
    endsWib: state && state.meta && state.meta.endsWib,
    ftWindow: state && state.meta && state.meta.ftWindow,
    minFt: state && state.meta && state.meta.minFt,
    minLiqUsd: state && state.meta && state.meta.minLiqUsd,
    minAgeH: state && state.meta && state.meta.minAgeH,
    capitalAsset:book?.virtual?.capitalAsset||'USDC',freeCapitalSol:book?.virtual?.capitalSol||0,equitySol:capitalPx?equityUsd/capitalPx:null,totalDepositedSol:book?.virtual?.totalDepositedSol,pnlTotalSol:capitalPx&&book?.virtual?.totalDepositedSol!=null?equityUsd/capitalPx-book.virtual.totalDepositedSol:null,
    virtualUsdc: book && book.virtual && book.virtual.usdc,
    leftoverSol: positions.reduce((n,p)=>n+(p.reserveSol||0),+(book?.virtual?.sol||0)),
    positions:positions.map((p,i)=>({capitalAsset:p.capitalAsset||'USDC',name:p.name,pool:p.pool,entryWib:p.entryWib,...displays[i]})),
    quotePnlTotals:quotePnl.totals(displays),quotePnlToday:quotePnl.totals(todays),
    openCount:positions.length,maxPositions:state?.meta?.maxPositions||5,equityUsd,totalDepositedUsdc:deposits,
    virtualCashSol: book && book.virtual && (book.virtual.usdc != null ? book.virtual.usdc : book.virtual.cash),
    position: positions[0]&&{name:positions[0].name,pool:positions[0].pool,entryWib:positions[0].entryWib},
    lastScan: state && state.lastScan && {
      atWib: state.lastScan.atWib,
      fetched: state.lastScan.fetched,
      n: (state.lastScan.candidates || []).length,
      rejects: state.lastScan.rejects,
    },
    trades: hist.length,
    tradesToday: todays.length,
    pnlToday: sum(todays),
    pnlTotal: sum(hist),
    pnlTodayUsd: todays.reduce((s, h) => s + (+(h.pnlUsd != null ? h.pnlUsd : h.netPnlUsd) || 0), 0),
    pnlTotalUsd: equityUsd-deposits,
    realizedPnlTotalUsd: hist.reduce((s, h) => s + (+(h.pnlUsd != null ? h.pnlUsd : h.netPnlUsd) || 0), 0),
    ...extra,
  };
}

function notifyCapitalChange({ usdcStart, gasBufferSol, gasNeeded, gasRaw, solUsd, startedWib, endsWib, switchedWib } = {}) {
  const lines = [
    `${PREFIX} Modal diubah: ${usdcStart != null ? usdcStart : 500} USDC (swap SOL dilebihkan untuk gas/rent)`,
    '',
    'Tuan, buku virtual sekarang 500 USDC saja — tidak ada saldo SOL gas terpisah.',
    `Window tetap: ${startedWib || 'n/a'} → ${endsWib || 'n/a'}`,
    switchedWib ? `Reset modal: ${switchedWib}` : '',
    '',
    `Di setiap open, USDC ditukar ke SOL untuk size posisi plus buffer gas ${fmtNum(gasBufferSol, 4)} SOL (default).`,
    `Hitungan mentah ~${fmtNum(gasRaw, 4)} SOL (rent posisi+ATA, hingga 2 bin array, anggaran tx open/reshape/close); plus margin 15% = ~${fmtNum(gasNeeded, 4)} SOL. Floor 0.30 SOL biar ada cadangan.`,
    'Saat close, rent yang refundable dan sisa buffer di-swap semua balik ke USDC.',
    solUsd ? `SOL/USD saat ganti modal: $${fmtNum(solUsd, 2)}.` : '',
    'PnL LP ditampilkan dalam quote token; aturan exit tetap USDC. Live tidak dijalankan.',
  ].filter(Boolean);
  return fire(lines.join('\n'));
}

function notifySettingsChange({ kind, changeLines, paused, restarted, restartError } = {}) {
  const title = kind === 'pause' ? `${PREFIX} Tuan, dry run di-pause.`
    : kind === 'resume' ? `${PREFIX} Tuan, dry run dilanjutkan.`
    : kind === 'reset' ? `${PREFIX} Tuan, settings paper di-reset ke default.`
    : `${PREFIX} Tuan, settings paper diubah.`;
  const lines = [title, ''];
  if (kind === 'pause') {
    lines.push('paper/STOP dibuat. Posisi virtual akan ditutup kalau masih kebuka, lalu bot berhenti.');
    lines.push('Live STOP tidak disentuh. Live tidak dijalankan.');
  } else if (kind === 'resume') {
    lines.push('paper/STOP dihapus. lp-paper di-restart (env bersih, tanpa key).');
    if (restarted === false) lines.push('Restart lp-paper belum terkonfirmasi' + (restartError ? ` (${restartError})` : '') + '.');
    lines.push('Live STOP tetap di tempat. Live tidak dijalankan.');
  } else if (changeLines && changeLines.length) {
    lines.push(...changeLines);
    lines.push('', 'Berlaku di scan berikutnya. Live tidak dijalankan.');
  } else {
    lines.push('Tidak ada nilai yang berubah. Live tidak dijalankan.');
  }
  return fire(lines.filter(Boolean).join('\n'));
}

function notifyWalletChange({ kind, publicAddress } = {}) {
  const lines = kind === 'key-deleted'
    ? [`${PREFIX} Tuan, key wallet dihapus dari penyimpanan terenkripsi.`, '', 'Live tidak bisa start tanpa key. Live tidak dijalankan otomatis.']
    : [
      `${PREFIX} Tuan, key wallet disimpan (terenkripsi di server).`,
      '',
      publicAddress ? `Address: ${publicAddress}` : 'Address: (tidak terbaca)',
      'Private key tidak ditampilkan, tidak dicatat di log Telegram, dan tidak masuk pm2 env.',
    ];
  return fire(lines.join('\n'));
}

function notifyLiveChange({ kind, publicAddress, sol, usdc, started, startError, mode, stopped } = {}) {
  let lines;
  if (kind === 'live-arm') {
    lines = [
      `${PREFIX} Tuan, Go Live di-siapkan (belum jalan).`,
      '',
      publicAddress ? `Wallet: ${publicAddress}` : '',
      (sol != null || usdc != null) ? `Saldo cek lolos: ${sol != null ? Number(sol).toFixed(4) + ' SOL' : ''} ${usdc != null ? Number(usdc).toFixed(2) + ' USDC' : ''}`.trim() : '',
      'Ketik LIVE di mini app dalam 60 detik untuk konfirmasi. Kalau tidak, batal.',
    ];
  } else if (kind === 'live-start') {
    lines = [
      `${PREFIX} Tuan, perintah GO LIVE diterima.`,
      '',
      publicAddress ? `Wallet: ${publicAddress}` : '',
      started ? 'Proses live di-start (DRY_RUN=0 LIVE_CONFIRMED=1, key dari store terenkripsi ke memori saja).' : ('Start proses: ' + (startError || 'belum terkonfirmasi') + '.'),
      'paper bot di-pause. STOP live sudah dilepas atas konfirmasi Tuan.',
    ];
  } else if (kind === 'live-no-new') {
    lines = [`${PREFIX} Tuan, live tidak akan buka posisi baru.`, '', 'Posisi yang sudah kebuka dibiarkan sampai TP / emergency / 12 jam. STOP file tidak ditulis.'];
  } else {
    lines = [`${PREFIX} Tuan, live dihentikan.`, '', 'STOP file ditulis. Proses live di-stop.' + (stopped === false ? ' (stop proses belum terkonfirmasi)' : '')];
  }
  return fire(lines.filter(Boolean).join('\n'));
}

function notifyLinkTest({ name, pool } = {}) {
  const pair = name || 'STANK-SOL';
  const ca = pool || '91iHWaWXneUyoNDJhSno7ezxQg1VW5P6PdarNGyFfPCz';
  const lines = [
    `${PREFIX} Tuan, ini contoh notifikasi (bukan posisi kebuka — tes tautan).`,
    '',
    `Pair: ${pair}`,
    `Pool: ${ca}`,
    '',
    dryRunLpAgentNote(),
    'Tombol Meteora: halaman pool DLMM.',
    'Tombol LP Agent: portfolio wallet bot (chain SOL).',
  ];
  return fire(lines.join('\n'), { reply_markup: poolKeyboard(ca) });
}

// CLI: node telegram-notify.js --crash 1 | --test-links   (no token printed)
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--test-links') {
    notifyLinkTest().then((res) => {
      const ok = !!(res && res.ok);
      process.stderr.write(ok ? 'telegram link test delivered\n' : `telegram link test not sent${res && res.skipped ? ' (' + res.skipped + ')' : (res && res.error ? ' (' + res.error + ')' : '')}\n`);
      process.exit(ok ? 0 : 1);
    }).catch(() => process.exit(1));
  } else if (args[0] === '--capital') {
    notifyCapitalChange({
      usdcStart: 500,
      gasBufferSol: +(process.env.GAS_BUFFER_SOL || 0.30),
      gasNeeded: +(process.env.GAS_BUFFER_NEEDED || 0.235),
      gasRaw: +(process.env.GAS_BUFFER_RAW || 0.204),
      solUsd: process.env.SOL_USD ? +process.env.SOL_USD : null,
      startedWib: process.env.STARTED_WIB || '',
      endsWib: process.env.ENDS_WIB || '',
      switchedWib: process.env.SWITCHED_WIB || '',
    }).then((res) => {
      const ok = !!(res && res.ok);
      process.stderr.write(ok ? 'telegram capital notify delivered\n' : `telegram capital notify not sent${res && res.skipped ? ' (' + res.skipped + ')' : (res && res.error ? ' (' + res.error + ')' : '')}\n`);
      process.exit(ok ? 0 : 1);
    }).catch(() => process.exit(1));
  } else {
    const kind = args[0] === '--crash' ? 'crash (process exit)' : 'notice';
    const detail = args.slice(args[0] === '--crash' ? 1 : 0).join(' ') || 'unknown';
    notifyError(detail, kind).then((res) => {
      const ok = !!(res && res.ok);
      process.stderr.write(ok ? 'telegram crash notify sent\n' : 'telegram crash notify not sent\n');
      process.exit(0);
    }).catch(() => process.exit(0));
  }
}

module.exports = {
  send,
  notifyOpen,
  notifyReshape,
  notifyReposition,
  notifyClose,
  notifyEmergency,
  notifyCapitalChange,
  notifySettingsChange,
  notifyWalletChange,
  notifyLiveChange,
  notifyLinkTest,
  sendPhoto,
  setPhotoTransport,
  setMessageTransport,
  renderBinShapePng,
  setChatMenuButton,
  setMyCommands,
  publishMiniAppUrl,
  readTunnelUrl,
  writeTunnelUrl,
  handleUpdate,
  replyStart,
  startPolling,
  stopPolling,
  startKeyboard,
  TUNNEL_FILE,
  isAllowedTgId,
  isAllowedUpdate,
  validateInitData,
  meteoraLink,
  lpAgentLink,
  TUAN_TG_ID,
  notifyError,
  notifyStartup,
  notifyRestart,
  notifyDailySummary,
  notifyWindowEnd,
  maybeDailySummary,
  dailyDue,
  installProcessHandlers,
  statusFromState,
  loadToken: () => !!loadToken(), // boolean only for callers that want a presence check
  hasChatId: () => chatId() != null,
  wib,
  loadToken,
  SECRET_FILE,
  CFG_FILE,
};
