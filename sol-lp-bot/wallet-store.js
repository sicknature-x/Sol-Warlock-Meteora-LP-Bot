require('./env-config').load(__dirname);
// Encrypted bot-wallet key store. Write-only secret: never log or return the private key.
// AES-256-GCM; master key and encrypted file live under /home/box/.secrets (chmod 600, dir 700).
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58').default || require('bs58');

const DEFAULT_SECRETS_DIR = process.env.LP_SECRETS_DIR || '/home/box/.secrets';
const MASTER_NAME = 'lp-bot-wallet.master';
const ENVELOPE_NAME = 'lp-bot-wallet.enc';
const ALG = 'aes-256-gcm';

function wib(d = new Date()) {
  return new Date(d).toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' }) + ' WIB';
}

function paths(secretsDir = DEFAULT_SECRETS_DIR) {
  const dir = path.resolve(secretsDir);
  return {
    dir,
    master: path.join(dir, MASTER_NAME),
    envelope: path.join(dir, ENVELOPE_NAME),
  };
}

function ensureSecretsDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* ignore */ }
}

function safeErr(msg) {
  const e = new Error(msg);
  e.expose = true;
  return e;
}

function parseSecretKey(raw) {
  if (typeof raw !== 'string' && !Buffer.isBuffer(raw) && !(raw instanceof Uint8Array)) {
    throw safeErr('invalid key format');
  }
  const text = typeof raw === 'string' ? raw.trim() : null;
  if (text === '') throw safeErr('empty key');
  let bytes;
  try {
    if (text && text.startsWith('[')) {
      const arr = JSON.parse(text);
      if (!Array.isArray(arr) || !(arr.length === 64 || arr.length === 32)) throw new Error('bad json length');
      if (!arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error('bad json bytes');
      bytes = Uint8Array.from(arr);
    } else if (text) {
      bytes = bs58.decode(text);
    } else {
      bytes = Uint8Array.from(raw);
    }
  } catch {
    throw safeErr('invalid key format');
  }
  if (bytes.length !== 32 && bytes.length !== 64) throw safeErr('invalid key length');
  try {
    return bytes.length === 32 ? Keypair.fromSeed(bytes) : Keypair.fromSecretKey(bytes);
  } catch {
    throw safeErr('invalid key');
  }
}

function publicAddressFromSecret(raw) {
  return parseSecretKey(raw).publicKey.toBase58();
}

function loadOrCreateMaster(secretsDir = DEFAULT_SECRETS_DIR) {
  const p = paths(secretsDir);
  ensureSecretsDir(p.dir);
  if (!fs.existsSync(p.master)) {
    const key = crypto.randomBytes(32);
    fs.writeFileSync(p.master, key, { mode: 0o600 });
    try { fs.chmodSync(p.master, 0o600); } catch { /* ignore */ }
  }
  const buf = fs.readFileSync(p.master);
  if (buf.length !== 32) throw safeErr('master key unreadable');
  try { fs.chmodSync(p.master, 0o600); } catch { /* ignore */ }
  return buf;
}

function envKey(){const v=process.env.PRIVATE_KEY||process.env.SOLANA_BOT_PRIVATE_KEY||'';return require('./env-config').unset(v)?'':v;}
function hasKey(secretsDir = DEFAULT_SECRETS_DIR) {
  if(envKey())return true;
  try {
    return fs.existsSync(paths(secretsDir).envelope) && fs.statSync(paths(secretsDir).envelope).size > 0;
  } catch {
    return false;
  }
}

function readEnvelopeMeta(secretsDir = DEFAULT_SECRETS_DIR) {
  if(envKey()&&!fs.existsSync(paths(secretsDir).envelope))return {hasKey:true,publicAddress:process.env.WALLET_PUBLIC_KEY||null,updatedWib:null,source:'env'};
  if (!hasKey(secretsDir)) return { hasKey: false, publicAddress: null, updatedWib: null };
  try {
    const j = JSON.parse(fs.readFileSync(paths(secretsDir).envelope, 'utf8'));
    return {
      hasKey: true,
      publicAddress: j && j.publicAddress ? String(j.publicAddress) : null,
      updatedWib: (j && j.updatedWib) || null,
    };
  } catch {
    return { hasKey: true, publicAddress: null, updatedWib: null };
  }
}

function saveKey(raw, secretsDir = DEFAULT_SECRETS_DIR) {
  const kp = parseSecretKey(raw);
  const secret = Buffer.from(kp.secretKey); // 64 bytes
  const master = loadOrCreateMaster(secretsDir);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALG, master, iv);
  const ct = Buffer.concat([cipher.update(secret), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Zero secret buffer when done
  secret.fill(0);
  const envelope = {
    v: 1,
    alg: ALG,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
    publicAddress: kp.publicKey.toBase58(),
    updatedWib: wib(),
  };
  const p = paths(secretsDir);
  ensureSecretsDir(p.dir);
  const tmp = p.envelope + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(envelope) + '\n', { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* ignore */ }
  fs.renameSync(tmp, p.envelope);
  try { fs.chmodSync(p.envelope, 0o600); } catch { /* ignore */ }
  return { ok: true, publicAddress: envelope.publicAddress, updatedWib: envelope.updatedWib };
}

function loadKeypair(secretsDir = DEFAULT_SECRETS_DIR) {
  const p = paths(secretsDir);
  if (!fs.existsSync(p.envelope)){if(envKey())return parseSecretKey(envKey());throw safeErr('no key stored');}
  const j = JSON.parse(fs.readFileSync(p.envelope, 'utf8'));
  if (!j || j.alg !== ALG || !j.iv || !j.tag || !j.ct) throw safeErr('wallet envelope invalid');
  const master = loadOrCreateMaster(secretsDir);
  const decipher = crypto.createDecipheriv(ALG, master, Buffer.from(j.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(j.tag, 'base64'));
  const secret = Buffer.concat([decipher.update(Buffer.from(j.ct, 'base64')), decipher.final()]);
  let kp;
  try {
    kp = Keypair.fromSecretKey(Uint8Array.from(secret));
  } finally {
    secret.fill(0);
  }
  if (j.publicAddress && kp.publicKey.toBase58() !== j.publicAddress) throw safeErr('wallet envelope address mismatch');
  return kp;
}

function deleteKey(secretsDir = DEFAULT_SECRETS_DIR) {
  const p = paths(secretsDir);
  if (fs.existsSync(p.envelope)) {
    try { fs.writeFileSync(p.envelope, Buffer.alloc(0)); } catch { /* ignore */ }
    fs.unlinkSync(p.envelope);
  }
  if (fs.existsSync(p.envelope + '.tmp')) {
    try { fs.unlinkSync(p.envelope + '.tmp'); } catch { /* ignore */ }
  }
  return { ok: true, hasKey: false };
}

function looksLikeSecretPayload(text, secretRaw) {
  if (!text || !secretRaw) return false;
  const hay = String(text);
  const variants = [];
  const raw = String(secretRaw).trim();
  if (raw) variants.push(raw);
  try {
    const kp = parseSecretKey(raw);
    variants.push(Buffer.from(kp.secretKey).toString('base64'));
    variants.push(bs58.encode(kp.secretKey));
    variants.push('[' + Array.from(kp.secretKey).join(','));
    variants.push('[' + Array.from(kp.secretKey).join(', '));
  } catch { /* ignore */ }
  return variants.some((v) => v && v.length >= 8 && hay.includes(v));
}

module.exports = {
  DEFAULT_SECRETS_DIR,
  MASTER_NAME,
  ENVELOPE_NAME,
  wib,
  paths,
  parseSecretKey,
  publicAddressFromSecret,
  hasKey,
  readEnvelopeMeta,
  saveKey,
  loadKeypair,
  deleteKey,
  looksLikeSecretPayload,
};
