'use strict';
// Optional Jupiter API key (JUPITER_API_KEY in .env). WITH a key, quotes and swaps go to api.jup.ag with header x-api-key (own rate limit).
// WITHOUT a key they use the shared keyless lite-api.jup.ag (observed: ~85 HTTP 429 per hour). A rejected key (401/403) falls back to lite-api once and says so.
// Same module for dry run and live. The key value is never logged (env-config.redact also masks every *API_KEY variable).
const LITE = 'https://lite-api.jup.ag', PRO = 'https://api.jup.ag';
let rejected = false;
function key() { if (rejected) return ''; const k = String(process.env.JUPITER_API_KEY || '').trim(); return (!k || /^isi_/i.test(k)) ? '' : k; }
function rewrite(url) { return key() ? String(url).replace(LITE, PRO) : url; }   // only lite-api URLs are rewritten
function withKey(opt = {}) { const k = key(); return k ? { ...opt, headers: { ...(opt.headers || {}), 'x-api-key': k } } : opt; }
function reject(log = () => {}) { if (!rejected) { rejected = true; try { log('Jupiter API key ditolak (401/403) oleh api.jup.ag: kembali ke lite-api tanpa key. Periksa JUPITER_API_KEY di .env.'); } catch { /* ignore */ } } }
function wrap(getJSON, log = () => {}) {
  return async (url, opt = {}, tries) => {
    if (!key()) return getJSON(url, opt, tries);
    try { return await getJSON(rewrite(url), withKey(opt), tries); }
    catch (e) { if (/^(401|403)\b/.test(String(e && e.message))) { reject(log); return getJSON(url, opt, tries); } throw e; }
  };
}
function describe() { return key() ? 'API key aktif (api.jup.ag, header x-api-key)' : 'tanpa API key (lite-api.jup.ag, batas bersama; sering 429)'; }
function _reset() { rejected = false; }   // tests only
module.exports = { key, rewrite, withKey, reject, wrap, describe, _reset, LITE, PRO };
