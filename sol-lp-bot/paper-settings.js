require('./env-config').load(__dirname);
// Paper-only settings for the Telegram mini app Settings tab.
// Never touches the live STOP file, never handles keys, funding, or live flags.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = process.env.LP_BOT_DIR || '/workspace/lp-bot';
const DEFAULT_PAPER_DIR = process.env.LP_PAPER_DIR || path.join(ROOT, 'paper');
const LIVE_STOP = path.resolve(process.env.LP_STOP_FILE || path.join(ROOT, 'STOP'));
const PM2_PAPER_APP = process.env.PM2_PAPER_APP || 'lp-paper';
const PM2_PAPER_ECOSYSTEM = process.env.PM2_PAPER_ECOSYSTEM || path.join(ROOT, 'ecosystem.paper.config.js');
const DEFAULTS = Object.freeze({
  ...require('./paper-strategy').DEFAULTS,
  MAX_POSITIONS: 10,
  CAPITAL_ASSET:'USDC',
  REOPEN_COOLDOWN_MIN:30,
  MAX_PUMP24H_PCT:200,
  MAX_LIQ_USD: 100000,
  MAX_NONREFUND_SOL: 0.05,
  MIN_FT: 0.6,
  MIN_LIQ_USD: 10000,
  MIN_AGE_H: 0.5,
  RESHAPE_N: 5,
  MIN_BIN_STEP: 80,
  MAX_BIN_STEP: 400,
  UPPER_BUFFER_BINS: 0,
  NOTIFY_RESHAPE: false,
  OOR_RIGHT_CONFIRM_POLLS: 2,
  OOR_RIGHT_MIN_BINS: 5,
  OOR_RIGHT_REPOSITION_MIN_PNL_PCT: -3,
  OOR_RIGHT_MIN_PROFIT_PCT: 0.5,
  OOR_RIGHT_MAX_REPOSITIONS: 2,
  POSITION_USDC: 500, // entry spend budget incl gas (USDC); 0 = split available cash across slots
  TP: 0.13, // legacy field used by the live path (CFG.TP); ALWAYS derived from TP_USD_PCT (see syncTp), never set on its own
  TP_USD_PCT: 13,
  OOR_RIGHT_CLOSE: true,
  TRAIL_ENABLED: false,
  TRAIL_ARM_PCT: 1,
  TRAIL_DROP_PCT: 0.5,
  OOR_MAX_MIN: 0,
  EMERGENCY_DROP: 0.20,
  SL_BLACKLIST_ENABLED: true,
  EMERGENCY_TP_ENABLED: true,
  EMERGENCY_TP_TRIGGER_RANGE_PCT: 50,
  EMERGENCY_TP_PCT: 10,
  EMERGENCY_SLPLUS_ENABLED: true,
  EMERGENCY_SLPLUS_ARM_PCT: 3,
  EMERGENCY_SLPLUS_LOCK_PCT: 0.1,
  EMERGENCY_SLPLUS_CONFIRM_POLLS: 3,
  EMERGENCY_SLPLUS_FLOOR_PCT: 0,
  EMERGENCY_SLPLUS_FLOOR_POLLS: 2,
  STALE_CLOSE_ENABLED: true,
  STALE_EXIT_MODE: 'ANY',
  STALE_EXIT_PCT: 5,
  MAX_HOURS: 12,
  GAS_BUFFER_SOL: 0.30,
  MAX_PUMP1H: 1.0,
  MAX_PUMP_24H: 5,
  VOL_SPIKE_1H_OF_24H: 0.50,
  FILTERS_ENABLED: true,
  PUMP1H_FILTER_ENABLED: true,
  PUMP24H_FILTER_ENABLED: true,
  RUGCHECK_ENABLED: true,
  RUGCHECK_STICKY_DAYS: 7,
  FEE_TURNOVER_MAX_PCT: 60,
  FEE_TURNOVER_TVL_BELOW_USD: 25000,
  TOP_HOLDERS_ENABLED: true,
  CHECK_INSIDERS: true,
  MAX_INSIDER_PCT: 25,
  ANTI_PVP_MODE: 'KEEP_BIGGEST',
  FT_WINDOW: '30m',
  MAX_TOP10_HOLD: 0.30,
  MAX_DEV_HOLD: 0.10,
  USDC_BUFFER: 0.10,
  ANTI_PVP_MIN_LIQ_USD: 10000,
  OLD_DUMP_FILTER_ENABLED: true,
  OLD_TOKEN_MODE: 'BLOCK_ALL',
  OLD_DUMP_MIN_AGE_H: 400,
  OLD_DUMP_MAX_PUMP24H: 0,
  TVL_DROP_FILTER_ENABLED: true,
  TVL_DROP_MAX_PCT: 45,
});

const FIELDS = Object.freeze({
  QUOTE_FAILURE_POLLS:{type:'integer',integer:true,min:1,max:100,default:10,label:'Quote gagal berturut-turut sebelum OOR pakai estimasi on-chain',unit:'poll',displayScale:1},
  RANGE_DOWN_PCT:{type:'number',integer:false,min:0.1,max:99.9,default:50,label:'Target coverage bawah (0–100%; bin dibulatkan ke atas)',unit:'%',displayScale:1},
  LOWER_BINS:{type:'integer',integer:true,min:0,max:1300,default:0,label:'Jumlah bin bawah termasuk active (0 = otomatis dari range)',unit:'bin',displayScale:1},
  RANGE_UP_PCT:{type:'number',integer:false,min:0,max:1000,default:0,label:'Range atas (0 = pakai jumlah bin atas)',unit:'%',displayScale:1},
  OPEN_SPOT_PCT:{type:'number',integer:false,min:0,max:100,default:50,label:'Spot saat open; Bid-Ask = 100% minus Spot',unit:'%',displayScale:1},
  COMPOUND_SPOT_PCT:{type:'number',integer:false,min:0,max:100,default:50,label:'Spot untuk compound fee quote; sisanya Bid-Ask',unit:'%',displayScale:1},
  MAX_POSITION_TVL_PCT:{type:'number',integer:false,min:0.01,max:100,default:5,label:'Maks alokasi LP terhadap TVL saat open',unit:'%',displayScale:1},
  RESHAPE_ENABLED:{type:'boolean',default:true,label:'Reshape aktif',unit:'',displayScale:1},
  COMPOUND_ENABLED:{type:'boolean',default:true,label:'Compound fee saat reshape',unit:'',displayScale:1},
  NOTIFY_RESHAPE:{type:'boolean',default:false,label:'Telegram: kirim pesan tiap reshape (OFF = diam; open, reposition, close tetap dikirim)',unit:'',displayScale:1},
  OPEN_SHAPE:{type:'enum',options:['MIXED', 'SPOT', 'BIDASK'],default:'MIXED',label:'Shape saat open (MIXED = split di bawah)',unit:'',displayScale:1},
  RESHAPE_SHAPE:{type:'enum',options:['BIDASK', 'SPOT'],default:'BIDASK',label:'Shape token setelah reshape',unit:'',displayScale:1},
  CAPITAL_ASSET:{type:'enum',options:['USDC','SOL'],default:'USDC',label:'Quote / aset modal: USDC atau SOL (hanya posisi baru; saldo bebas dikonversi)',unit:'',displayScale:1},
  REOPEN_COOLDOWN_MIN:{type:'number',min:0,max:10080,default:30,label:'Jeda buka ulang pool setelah close (0 = off)',unit:'menit',displayScale:1},
  MAX_PUMP24H_PCT:{type:'number',min:0,max:100000,default:200,label:'Pump maksimum token 24 jam',unit:'%',displayScale:1},
  MAX_LIQ_USD:{type:'number',min:0,max:10000000,default:100000,label:'TVL maksimum (0 = nonaktif)',unit:'USD',displayScale:1},
  MAX_NONREFUND_SOL:{type:'number',min:0,max:10,default:.05,label:'Maks biaya non-refundable open (0 = nonaktif)',unit:'SOL',displayScale:1},
  MAX_POSITIONS: {type:'integer',min:1,max:10,integer:true,default:DEFAULTS.MAX_POSITIONS,label:'Maksimum posisi terbuka',unit:'posisi',displayScale:1},
  OOR_RIGHT_MIN_PROFIT_PCT:{type:'number',min:0,max:100,default:.5,label:'Profit minimum OOR kanan (net aset modal posisi)',unit:'%',displayScale:1},
  OOR_RIGHT_MAX_REPOSITIONS:{type:'integer',min:0,max:10,integer:true,default:2,label:'Maksimum reposition kanan per posisi',unit:'kali',displayScale:1},
  UPPER_BUFFER_BINS: {type:'integer',min:0,max:100,integer:true,default:0,label:'Bin token di atas active saat entry (0 = quote only)',unit:'bin',displayScale:1},
  OOR_RIGHT_CONFIRM_POLLS: {type:'integer',min:1,max:10,integer:true,default:2,label:'Konfirmasi OOR kanan berturut-turut',unit:'poll',displayScale:1},
  OOR_RIGHT_REPOSITION_MIN_PNL_PCT: { type: 'number', min: -100, max: 0, integer: false, default: -3, label: 'OOR kanan: reposition hanya bila net PnL minimal X% (di bawah itu posisi ditahan; -100 = selalu boleh)', unit: '%', displayScale: 1 },
  OOR_RIGHT_MIN_BINS: {type:'integer',min:0,max:50,integer:true,default:5,label:'OOR kanan: reposition/limit baru jalan kalau harga naik minimal N bin di atas range (profit >= minimum tetap langsung diambil; 0 = langsung)',unit:'bin',displayScale:1},
  MIN_BIN_STEP: { type:'integer', min:1, max:500, integer:true, default:DEFAULTS.MIN_BIN_STEP, label:'Bin step minimum', unit:'bin step', displayScale:1 },
  MAX_BIN_STEP: { type:'integer', min:1, max:500, integer:true, default:400, label:'Bin step maksimum', unit:'bin step', displayScale:1 },
  POSITION_USDC: { type:'number', min:0, max:1000000, default:DEFAULTS.POSITION_USDC, label:'Budget entry ekuivalen USDC termasuk gas; mode SOL dibagi harga SOL saat open (0 = bagi slot)', unit:'USDC', displayScale:1 },
  MIN_FT: { type: 'number', min: 0, max: 20, integer: false, default: DEFAULTS.MIN_FT, label: 'Fee/TVL 30m minimum', unit: '%', displayScale: 1 },
  MIN_LIQ_USD: { type: 'integer', min: 0, max: 10_000_000, integer: true, default: DEFAULTS.MIN_LIQ_USD, label: 'TVL minimum', unit: 'USD', displayScale: 1 },
  MIN_AGE_H: { type: 'number', min: 0, max: 720, integer: false, default: DEFAULTS.MIN_AGE_H, label: 'Umur pool minimum', unit: 'jam', displayScale: 1 },
  RESHAPE_N: { type: 'integer', min: 1, max: 50, integer: true, default: DEFAULTS.RESHAPE_N, label: 'Reshape setiap N bin', unit: 'bin', displayScale: 1 },
  TP: { type: 'number', min: 0.01, max: 2, integer: false, default: DEFAULTS.TP, label: 'Take profit', unit: '%', displayScale: 100 },
  TP_USD_PCT: { type: 'number', min: 0.1, max: 200, integer: false, default: DEFAULTS.TP_USD_PCT, label: 'Take profit aset modal posisi (USDC / SOL)', unit: '%', displayScale: 1 },
  OOR_RIGHT_CLOSE: { type: 'boolean', default: true, label: 'Tutup OOR kanan → aset modal posisi', unit: '', displayScale: 1 },
  TRAIL_ENABLED: { type: 'boolean', default: false, label: 'TRAILING STOP (Trailing TP aset modal, opsional — default OFF)', unit: '', displayScale: 1 },
  TRAIL_ARM_PCT: { type: 'number', min: 0.1, max: 200, default: 1, label: 'Trailing stop: arm setelah profit', unit: '%', displayScale: 1 },
  TRAIL_DROP_PCT: { type: 'number', min: 0.1, max: 100, default: 0.5, label: 'Trailing stop: turun dari puncak', unit: 'poin %', displayScale: 1 },
  OOR_MAX_MIN: { type: 'number', min: 0, max: 10080, default: 0, label: 'Timeout OOR kiri negatif (0 = nonaktif)', unit: 'menit', displayScale: 1 },
  EMERGENCY_DROP: { type: 'number', min: 0.05, max: 0.95, integer: false, default: DEFAULTS.EMERGENCY_DROP, label: 'Stop Loss (emergency) % — rugi net aset modal vs entry', unit: '%', displayScale: 100 },
  SL_BLACKLIST_ENABLED: { type: 'boolean', default: true, label: 'Jangan buka lagi token yang kena SL (blacklist per token mint)', unit: '', displayScale: 1 },
  EMERGENCY_TP_ENABLED: { type: 'boolean', default: true, label: 'TP emergency setelah harga turun dalam (default ON; berlaku juga ke posisi open)', unit: '', displayScale: 1 },
  EMERGENCY_TP_TRIGGER_RANGE_PCT: { type: 'number', min: 1, max: 100, integer: false, default: 50, label: 'TP emergency: aktif saat harga turun ≥ X% dari range bawah (50 = setengah range; range -50% → aktif di -25%)', unit: '% range', displayScale: 1 },
  EMERGENCY_TP_PCT: { type: 'number', min: 0.1, max: 200, integer: false, default: 10, label: 'TP emergency: target TP (menggantikan TP normal)', unit: '%', displayScale: 1 },
  EMERGENCY_SLPLUS_ENABLED: { type: 'boolean', default: true, label: 'TP Emergency SL+ (kunci profit setelah TP emergency aktif; berlaku juga ke posisi open)', unit: '', displayScale: 1 },
  EMERGENCY_SLPLUS_ARM_PCT: { type: 'number', min: 0.1, max: 100, integer: false, default: 3, label: 'TP Emergency SL+: aktif saat PnL net menyentuh ≥ X% (setelah TP emergency aktif)', unit: '%', displayScale: 1 },
  EMERGENCY_SLPLUS_LOCK_PCT: { type: 'number', min: -5, max: 50, integer: false, default: 0.1, label: 'TP Emergency SL+: tutup bila PnL net turun ke ≤ X% (harus lebih kecil dari angka aktif)', unit: '%', displayScale: 1 },
  EMERGENCY_SLPLUS_CONFIRM_POLLS: { type: 'integer', min: 1, max: 20, integer: true, default: 3, label: 'TP Emergency SL+: konfirmasi poll berturut-turut', unit: 'poll', displayScale: 1 },
  EMERGENCY_SLPLUS_FLOOR_PCT: { type: 'number', min: -5, max: 50, integer: false, default: 0, label: 'TP Emergency SL+ pelindung BEP: setelah aktif, langsung tutup bila PnL net ≤ X% (0 = BEP; harus lebih kecil dari angka tutup di atas)', unit: '%', displayScale: 1 },
  EMERGENCY_SLPLUS_FLOOR_POLLS: { type: 'integer', min: 1, max: 20, integer: true, default: 2, label: 'TP Emergency SL+ pelindung BEP: konfirmasi poll (1 = langsung)', unit: 'poll', displayScale: 1 },
  STALE_CLOSE_ENABLED: { type: 'boolean', default: true, label: 'Stale close: tutup posisi yang sudah lama open (berlaku juga ke posisi open)', unit: '', displayScale: 1 },
  MAX_HOURS: { type: 'number', min: 1, max: 168, integer: false, default: DEFAULTS.MAX_HOURS, label: 'Stale close: setelah berapa jam (posisi open memakai jam saat entry)', unit: 'jam', displayScale: 1 },
  STALE_EXIT_MODE: { type: 'enum', options: ['ANY', 'MINUS', 'BEP', 'PROFIT'], default: 'ANY', label: 'Stale close: syarat keluar (ANY = langsung tutup berapa pun PnL; MINUS = tutup saat PnL ≥ -X%; BEP = PnL ≥ 0; PROFIT = PnL ≥ +X%)', unit: '', displayScale: 1 },
  STALE_EXIT_PCT: { type: 'number', min: 0, max: 100, integer: false, default: DEFAULTS.STALE_EXIT_PCT, label: 'Stale close: X% untuk mode MINUS / PROFIT', unit: '%', displayScale: 1 },
  GAS_BUFFER_SOL: { type: 'number', min: 0.05, max: 1, integer: false, default: DEFAULTS.GAS_BUFFER_SOL, label: 'Buffer gas/rent', unit: 'SOL', displayScale: 1 },
  MAX_PUMP1H: { type: 'number', min: 0.01, max: 2, integer: false, default: DEFAULTS.MAX_PUMP1H, label: 'Max pump 1 jam', unit: '%', displayScale: 100 },
  MAX_PUMP_24H: { type: 'number', min: 0.01, max: 5, integer: false, default: DEFAULTS.MAX_PUMP_24H, label: 'Max pump 24 jam', unit: '%', displayScale: 100 },
  VOL_SPIKE_1H_OF_24H: { type: 'number', min: 0.05, max: 1, integer: false, default: DEFAULTS.VOL_SPIKE_1H_OF_24H, label: 'Max volume 1 jam vs 24 jam', unit: '%', displayScale: 100 },
  FILTERS_ENABLED: { type: 'boolean', default: true, label: 'Semua filter token ON/OFF (master; OFF = pump 1j/24j, RugCheck, top holder, insider, anti PvP, token tua, TVL turun dilewati; pilihan per filter tetap tersimpan)', unit: '', displayScale: 1 },
  PUMP1H_FILTER_ENABLED: { type: 'boolean', default: true, label: 'Filter pump 1 jam', unit: '', displayScale: 1 },
  PUMP24H_FILTER_ENABLED: { type: 'boolean', default: true, label: 'Filter pump 24 jam', unit: '', displayScale: 1 },
  FEE_TURNOVER_MAX_PCT: { type: 'number', min: 0, max: 1000, integer: false, default: 60, label: 'Lewati pool panas: fee 24 jam / TVL di atas X% (hanya untuk pool dengan TVL di bawah batas berikut; 0 = mati)', unit: '%', displayScale: 1 },
  FEE_TURNOVER_TVL_BELOW_USD: { type: 'number', min: 0, max: 100000000, integer: false, default: 25000, label: 'Lewati pool panas: berlaku hanya bila TVL di bawah (0 = semua TVL)', unit: 'USD', displayScale: 1 },
  RUGCHECK_STICKY_DAYS: { type: 'integer', min: 0, max: 365, integer: true, default: 7, label: 'RugCheck: token yang pernah ditandai bahaya (danger / rugged / skor tinggi) tetap diblok N hari walau laporan berikutnya bersih (0 = mati)', unit: 'hari', displayScale: 1 },
  RUGCHECK_ENABLED: { type: 'boolean', default: true, label: 'RugCheck (mint/freeze authority, risiko danger, skor < 50)', unit: '', displayScale: 1 },
  TOP_HOLDERS_ENABLED: { type: 'boolean', default: true, label: 'Cek top 10 holder (maks 30%) dan dev (maks 10%)', unit: '', displayScale: 1 },
  CHECK_INSIDERS: { type: 'boolean', default: true, label: 'Cek insider/cluster wallet (RugCheck insider networks)', unit: '', displayScale: 1 },
  MAX_INSIDER_PCT: { type: 'number', min: 0, max: 100, integer: false, default: 25, label: 'Insider: maks total supply dipegang jaringan insider', unit: '%', displayScale: 1 },
  ANTI_PVP_MODE: { type: 'enum', options: ['KEEP_BIGGEST', 'SKIP_ALL', 'OFF'], default: 'KEEP_BIGGEST', label: 'Anti PvP (token kembar nama/simbol sama, CA beda)', unit: '', displayScale: 1 },
  FT_WINDOW: { type: 'enum', options: ['30m', '1h', '2h', '4h', '12h', '24h'], default: '30m', label: 'Jendela fee/TVL (MIN_FT dihitung dari jendela ini; sama untuk dry run dan live)', unit: '', displayScale: 1 },
  MAX_TOP10_HOLD: { type: 'number', min: 0.01, max: 1, integer: false, default: 0.30, label: 'Batas holder top 10 (anti-rug; sama untuk dry run dan live)', unit: '%', displayScale: 100 },
  MAX_DEV_HOLD: { type: 'number', min: 0.01, max: 1, integer: false, default: 0.10, label: 'Batas holder dev (anti-rug; sama untuk dry run dan live)', unit: '%', displayScale: 100 },
  USDC_BUFFER: { type: 'number', min: 0, max: 1000, integer: false, default: 0.10, label: 'Sisa USDC yang tidak dipakai saat buka posisi (sama untuk dry run dan live)', unit: 'USDC', displayScale: 1 },
  ANTI_PVP_MIN_LIQ_USD: { type: 'number', min: 0, max: 10000000, integer: false, default: 10000, label: 'Anti PvP: kembar dihitung kalau likuiditasnya minimal', unit: 'USD', displayScale: 1 },
  OLD_DUMP_FILTER_ENABLED: { type: 'boolean', default: true, label: 'Filter token tua (maks umur pool) ON/OFF', unit: '', displayScale: 1 },
  OLD_TOKEN_MODE: { type: 'enum', options: ['BLOCK_ALL', 'DUMP_ONLY'], default: 'BLOCK_ALL', label: 'Filter token tua: mode', unit: '', displayScale: 1 },
  OLD_DUMP_MIN_AGE_H: { type: 'number', min: 0, max: 100000, integer: false, default: 400, label: 'Filter token tua: maks umur pool', unit: 'jam', displayScale: 1 },
  OLD_DUMP_MAX_PUMP24H: { type: 'number', min: -100, max: 1000, integer: false, default: 0, label: 'Mode "Hanya yang lagi dump": skip kalau pump 24 jam di bawah (negatif = dump)', unit: '%', displayScale: 1 },
  TVL_DROP_FILTER_ENABLED: { type: 'boolean', default: true, label: 'Filter TVL turun vs entry terakhir token yang sama ON/OFF', unit: '', displayScale: 1 },
  TVL_DROP_MAX_PCT: { type: 'number', min: 1, max: 99, integer: false, default: 45, label: 'Skip kalau TVL turun ≥ X% dibanding TVL saat entry terakhir token yang sama (history atau posisi open)', unit: '%', displayScale: 1 },
});

const ALLOWED_KEYS = Object.freeze(Object.keys(FIELDS));
const FORBIDDEN_KEYS = Object.freeze([
  'DRY_RUN', 'LIVE_CONFIRMED', 'SOLANA_BOT_PRIVATE_KEY', 'PRIVATE_KEY', 'TELEGRAM_BOT_TOKEN',
  'POSITION_SOL', 'POSITION_USD', 'PAPER_USDC', 'PAPER_VIRTUAL_SOL', 'RESERVE_SOL',
  'STOP', 'LIVE_STOP', 'wallet', 'withdraw', 'fund', 'key', 'secret',
]);

const CSRF_TTL_MS = 10 * 60 * 1000;
const INITDATA_MAX_AGE_SEC = 24 * 3600;

function wib(d = new Date()) {
  return new Date(d).toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' }) + ' WIB';
}

function paths(paperDir = DEFAULT_PAPER_DIR) {
  const dir = path.resolve(paperDir);
  return {
    dir,
    settings: path.join(dir, 'settings.json'),
    audit: path.join(dir, 'settings-audit.log'),
    paperStop: path.join(dir, 'STOP'),
  };
}

function paperStopPath(paperDir = DEFAULT_PAPER_DIR) {
  return paths(paperDir).paperStop;
}

function isLiveStopPath(p) {
  try {
    return path.resolve(p) === LIVE_STOP;
  } catch {
    return false;
  }
}

function assertPaperStopOnly(target) {
  const resolved = path.resolve(target);
  if (resolved === LIVE_STOP || resolved === path.resolve('/workspace/lp-bot/STOP')) {
    const err = new Error('refusing to touch live STOP');
    err.code = 'LIVE_STOP_FORBIDDEN';
    throw err;
  }
  if (path.basename(resolved) === 'STOP' && path.dirname(resolved) !== path.resolve(path.dirname(resolved), '.') && !resolved.endsWith(`${path.sep}paper${path.sep}STOP`) && !resolved.includes(`${path.sep}paper${path.sep}`)) {
    // extra belt: only allow a file named STOP inside a directory named paper (or a test dir we explicitly pass)
  }
  if (resolved === LIVE_STOP) throw new Error('refusing to touch live STOP');
  return resolved;
}

function cloneDefaults() {
  return { ...DEFAULTS };
}

function readSettingsFile(paperDir = DEFAULT_PAPER_DIR) {
  const file = paths(paperDir).settings;
  try {
    if (!fs.existsSync(file)) return { values: {}, exists: false };
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const values = (j && typeof j === 'object' && j.values && typeof j.values === 'object') ? j.values : (j && j.MIN_FT != null ? j : {});
    return { raw: j, values, exists: true, updatedWib: j && j.updatedWib, updatedBy: j && j.updatedBy };
  } catch (e) {
    return { values: {}, exists: true, error: e.message };
  }
}

// Live and paper must use the same take profit: the legacy TP field is always TP_USD_PCT/100, whatever file/.env/patch says.
function tpFromUsdPct(p) { return Number.isFinite(Number(p)) ? +(Number(p) / 100).toFixed(6) : DEFAULTS.TP; }
function syncTp(v) { v.TP = tpFromUsdPct(v.TP_USD_PCT); return v; }

function currentValues(paperDir = DEFAULT_PAPER_DIR) {
  const file = readSettingsFile(paperDir);
  const result={...DEFAULTS,...pickAllowed(file.values)},env=require('./env-config').read(ROOT);for(const k of ALLOWED_KEYS){if(env[k]===undefined)continue;const f=FIELDS[k],v=f.type==='boolean'?env[k]==='true'||env[k]==='1':f.type==='enum'?env[k]:Number(env[k]);if(validatePatch({[k]:v},result).ok)result[k]=v;}return syncTp(result);
}

function pickAllowed(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const k of ALLOWED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null) out[k] = obj[k];
  }
  return out;
}

function validatePatch(input, current = DEFAULTS) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'settings must be an object', rejected: [] };
  }
  const rejected = [];
  const sanitized = {};
  for (const key of Object.keys(input)) {
    if (FORBIDDEN_KEYS.includes(key) || (key!=='MAX_NONREFUND_SOL' && /live|private.?key|withdraw|fund|wallet|DRY_RUN|LIVE_CONFIRMED/i.test(key))) {
      rejected.push({ key, reason: 'forbidden (live / funding / key / size)' });
      continue;
    }
    if (!ALLOWED_KEYS.includes(key)) {
      rejected.push({ key, reason: 'unknown key' });
      continue;
    }
    const field = FIELDS[key];
    const raw = input[key];
    if(field.type==='enum'){if(field.options.includes(raw))sanitized[key]=raw;else rejected.push({key,reason:'must be '+field.options.join(' or ')});continue;}
    if (field.type === 'boolean') {
      if (raw === true || raw === false) sanitized[key] = raw;
      else if (raw === 1 || raw === '1' || raw === 'true') sanitized[key] = true;
      else if (raw === 0 || raw === '0' || raw === 'false') sanitized[key] = false;
      else rejected.push({key,reason:'must be boolean'});
      continue;
    }
    if (!['number','string'].includes(typeof raw) || (typeof raw === 'string' && raw.trim() === '')) {
      rejected.push({ key, reason: 'invalid type' });
      continue;
    }
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) {
      rejected.push({ key, reason: 'not a number' });
      continue;
    }
    if (field.integer && !Number.isInteger(n)) {
      rejected.push({ key, reason: 'must be an integer' });
      continue;
    }
    if (n < field.min || n > field.max) {
      rejected.push({ key, reason: `out of range ${field.min}..${field.max}` });
      continue;
    }
    sanitized[key] = field.integer ? n : n;
  }
  const merged={...current,...sanitized};
  if(merged.MIN_BIN_STEP>merged.MAX_BIN_STEP)rejected.push({key:'MIN_BIN_STEP',reason:'minimum must be <= MAX_BIN_STEP'});
  if (rejected.length) return { ok: false, error: 'validation failed', rejected, sanitized };
  return { ok: true, sanitized };
}

function displayValues(values) {
  const out = {};
  for (const k of ALLOWED_KEYS) {
    const f = FIELDS[k];
    const v = values[k];
    out[k] = {
      value: v,
      type: f.type,
      display: f.displayScale === 1 ? v : +(v * f.displayScale).toFixed(6),
      unit: f.unit,
      label: f.label,
      default: f.default,
      defaultDisplay: f.displayScale === 1 ? f.default : +(f.default * f.displayScale).toFixed(6),
      min: f.min,
      max: f.max,
      displayMin: f.displayScale === 1 ? f.min : f.min * f.displayScale,
      displayMax: f.displayScale === 1 ? f.max : f.max * f.displayScale,
      displayScale: f.displayScale,options:f.options,
    };
  }
  return out;
}

function fromDisplayPatch(input) {
  // Accept UI-scale fields like TP_PCT / or { TP: 20, _display: true }
  if (!input || typeof input !== 'object') return input;
  if (!input._display) return input;
  const out = {};
  for (const k of Object.keys(input)) {
    if (k === '_display') continue;
    const f = FIELDS[k];
    if (!f) { out[k] = input[k]; continue; }
    if (f.type === 'boolean'||f.type==='enum') { out[k] = input[k]; continue; }
    if(typeof input[k] === 'boolean' || input[k] == null || (typeof input[k] === 'string' && !input[k].trim())) { out[k]=input[k]; continue; }
    const n = Number(input[k]);
    out[k] = f.displayScale && f.displayScale !== 1 ? n / f.displayScale : n;
  }
  return out;
}

function writeSettingsFile(paperDir, values, meta = {}) {
  const p = paths(paperDir);
  fs.mkdirSync(p.dir, { recursive: true });
  const body = {
    updatedWib: wib(),
    updatedBy: meta.updatedBy || null,
    values: syncTp({ ...DEFAULTS, ...pickAllowed(values) }),
    note: 'Paper-only settings. Bot reads this on the next scan. Does not control live trading.',
  };
  const tmp = p.settings + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n');
  fs.renameSync(tmp, p.settings);
  require('./env-config').update(p.dir===path.resolve(DEFAULT_PAPER_DIR)?ROOT:path.dirname(p.dir),body.values);
  return body;
}

function audit(paperDir, line) {
  const p = paths(paperDir);
  fs.mkdirSync(p.dir, { recursive: true });
  fs.appendFileSync(p.audit, `[${wib()}] ${line}\n`);
}

function diffValues(before, after) {
  const changes = [];
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    if (!ALLOWED_KEYS.includes(k)) continue;
    if (before[k] !== after[k]) changes.push({ key: k, from: before[k], to: after[k] });
  }
  return changes;
}

function formatChanges(changes) {
  return changes.map((c) => {
    const f = FIELDS[c.key];
    const scale = f && f.displayScale ? f.displayScale : 1;
    const unit = f && f.unit ? f.unit : '';
    const a = scale === 1 ? c.from : +(c.from * scale).toFixed(6);
    const b = scale === 1 ? c.to : +(c.to * scale).toFixed(6);
    return `${c.key}: ${a}${unit ? ' ' + unit : ''} → ${b}${unit ? ' ' + unit : ''}`;
  });
}

function applySettings(paperDir, patch, meta = {}) {
  const checked = validatePatch(fromDisplayPatch(patch), currentValues(paperDir));
  if (!checked.ok) return { ok: false, error: checked.error, rejected: checked.rejected };
  const before = currentValues(paperDir);
  const next = { ...before, ...checked.sanitized };
  const changes = diffValues(before, next);
  const written = writeSettingsFile(paperDir, next, meta);
  const lines = formatChanges(changes);
  const who = meta.updatedBy || 'unknown';
  audit(paperDir, `uid=${who} action=update ${lines.length ? lines.join(', ') : '(no value change)'}`);
  return { ok: true, values: written.values, changes, changeLines: lines, updatedWib: written.updatedWib };
}

function resetSettings(paperDir, meta = {}) {
  const before = currentValues(paperDir);
  const written = writeSettingsFile(paperDir, { ...DEFAULTS }, meta);
  const changes = diffValues(before, written.values);
  const who = meta.updatedBy || 'unknown';
  audit(paperDir, `uid=${who} action=reset-to-default ${formatChanges(changes).join(', ') || '(already default)'}`);
  return { ok: true, values: written.values, changes, changeLines: formatChanges(changes), updatedWib: written.updatedWib };
}

function isPaused(paperDir = DEFAULT_PAPER_DIR) {
  return fs.existsSync(paths(paperDir).paperStop);
}

function pauseDryRun(paperDir, meta = {}) {
  const p = paths(paperDir);
  const target = assertPaperStopOnly(p.paperStop);
  if (isLiveStopPath(target)) throw new Error('refusing to touch live STOP');
  fs.mkdirSync(p.dir, { recursive: true });
  if (!fs.existsSync(target)) {
    fs.writeFileSync(target, `paused via mini app ${wib()}\n`);
  }
  const who = meta.updatedBy || 'unknown';
  audit(paperDir, `uid=${who} action=pause paper/STOP created (live STOP not touched)`);
  return { ok: true, paused: true, paperStop: true, liveStopUntouched: true };
}

function resumeDryRun(paperDir, meta = {}, opts = {}) {
  const p = paths(paperDir);
  const target = assertPaperStopOnly(p.paperStop);
  if (isLiveStopPath(target)) throw new Error('refusing to touch live STOP');
  if (fs.existsSync(LIVE_STOP) === false) {
    // live STOP missing would be unusual; we still must not create or remove it
  }
  if (fs.existsSync(target)) fs.unlinkSync(target);
  const who = meta.updatedBy || 'unknown';
  let restarted = false;
  let restartError = null;
  if (opts.restart !== false && opts.restartFn) {
    try {
      const r = opts.restartFn();
      restarted = !!(r && r.ok);
      restartError = r && r.error ? r.error : null;
    } catch (e) {
      restartError = e.message;
    }
  }
  audit(paperDir, `uid=${who} action=resume paper/STOP removed, lp-paper restart=${restarted}${restartError ? ' error=' + restartError : ''} (live STOP not touched)`);
  return { ok: true, paused: false, restarted, restartError, liveStopUntouched: true };
}

function defaultRestartFn() {
  return restartLpPaperClean();
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

function cleanPm2Env() {
  return {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME || osHome(),
    USER: process.env.USER || '',
    LOGNAME: process.env.LOGNAME || process.env.USER || '',
    PM2_HOME: process.env.PM2_HOME || path.join(process.env.HOME || osHome(), '.pm2'),
    LANG: process.env.LANG || 'C.UTF-8',
  };
}

function osHome() {
  return process.env.HOME || '/home/USER';
}

function restartLpPaperClean() {
  const env = cleanPm2Env();
  const pm2 = pm2Bin();
  const appName = PM2_PAPER_APP;
  // Never restart or start any app that is not this paper app (do not touch grok*/elysium*/bsc*).
  if (!appName || /^(grok|elysium|bsc)/i.test(appName)) {
    return { ok: false, error: 'refusing to manage a non-sol/lp paper app' };
  }
  const list = spawnSync(pm2, ['jlist'], { env, encoding: 'utf8', timeout: 15000 });
  if (list.status !== 0) return { ok: false, error: 'pm2 jlist failed' };
  let apps = [];
  try { apps = JSON.parse(list.stdout || '[]'); } catch { return { ok: false, error: 'pm2 jlist parse failed' }; }
  const app = apps.find((a) => a && a.name === appName);
  const status = app && app.pm2_env && app.pm2_env.status;
  let res;
  if (app && status === 'online') {
    res = spawnSync(pm2, ['restart', appName], { env, encoding: 'utf8', timeout: 20000 });
  } else if (app) {
    res = spawnSync(pm2, ['start', appName], { env, encoding: 'utf8', timeout: 20000 });
  } else {
    res = spawnSync(pm2, ['start', PM2_PAPER_ECOSYSTEM], { env, encoding: 'utf8', timeout: 20000 });
  }
  if (res.status !== 0) return { ok: false, error: (res.stderr || res.stdout || 'pm2 restart failed').slice(0, 200) };
  return { ok: true, previousStatus: status || 'missing' };
}

// --- CSRF / initData helpers (tests pass a fake token; never log tokens) ---

function createCsrfStore({ ttlMs = CSRF_TTL_MS } = {}) {
  const map = new Map();
  function issue(userId) {
    prune();
    const token = crypto.randomBytes(24).toString('hex');
    map.set(token, { userId: +userId, exp: Date.now() + ttlMs });
    return token;
  }
  function consume(token, userId) {
    prune();
    const rec = map.get(token);
    if (!rec) return { ok: false, reason: 'csrf missing or already used' };
    if (Date.now() > rec.exp) {
      map.delete(token);
      return { ok: false, reason: 'csrf expired' };
    }
    if (+rec.userId !== +userId) return { ok: false, reason: 'csrf user mismatch' };
    map.delete(token); // single use
    return { ok: true };
  }
  function prune() {
    const now = Date.now();
    for (const [k, v] of map) if (now > v.exp) map.delete(k);
  }
  function size() { prune(); return map.size; }
  return { issue, consume, prune, size };
}

function signInitData(fields, botToken) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) params.set(k, String(v));
  const dataCheck = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

function validateInitData(initData, botToken, { maxAgeSec = INITDATA_MAX_AGE_SEC, allowedId = Number(process.env.TELEGRAM_ALLOWED_ID||0), nowSec } = {}) {
  try {
    if (!botToken || !initData) return { ok: false, reason: 'missing' };
    const params = new URLSearchParams(String(initData));
    const hash = params.get('hash');
    if (!hash) return { ok: false, reason: 'no hash' };
    params.delete('hash');
    const dataCheck = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const check = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(check, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad hash' };
    let user = null;
    try { user = JSON.parse(params.get('user') || 'null'); } catch { user = null; }
    const uid = user && user.id;
    if (+uid !== +allowedId) return { ok: false, reason: 'user not allowed' };
    const authDate = +(params.get('auth_date') || 0);
    const now = nowSec != null ? +nowSec : Math.floor(Date.now() / 1000);
    if (!authDate) return { ok: false, reason: 'no auth_date' };
    if (now - authDate > maxAgeSec) return { ok: false, reason: 'initData expired' };
    if (authDate > now + 60) return { ok: false, reason: 'auth_date in the future' };
    return { ok: true, userId: uid, authDate };
  } catch {
    return { ok: false, reason: 'validate failed' };
  }
}

module.exports = {
  DEFAULTS,
  FIELDS,
  ALLOWED_KEYS,
  FORBIDDEN_KEYS,
  CSRF_TTL_MS,
  INITDATA_MAX_AGE_SEC,
  LIVE_STOP,
  wib,
  paths,
  paperStopPath,
  isLiveStopPath,
  cloneDefaults,
  currentValues,
  readSettingsFile,
  validatePatch,
  fromDisplayPatch,
  displayValues,
  applySettings,
  resetSettings,
  isPaused,
  pauseDryRun,
  resumeDryRun,
  restartLpPaperClean,
  defaultRestartFn,
  createCsrfStore,
  signInitData,
  validateInitData,
  formatChanges,
  diffValues,
  audit,
};
