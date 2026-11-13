'use strict';
// One RPC URL for dry run, live and the mini app's live-balance check.
// Priority: a CUSTOM SOLANA_RPC_URL (anything other than the public default) > HELIUS_API_KEY (-> mainnet.helius-rpc.com) > the public Solana endpoint.
// The key is only ever inside the URL object handed to @solana/web3.js; logs show host only (describe()) and env-config.redact masks the key value (name matches *API_KEY).
const PUBLIC = 'https://api.mainnet-beta.solana.com';
const clean = v => { const s = String(v || '').trim(); return (!s || /^isi_/i.test(s)) ? '' : s; };
function url() {
  const custom = clean(process.env.SOLANA_RPC_URL);
  if (custom && custom.replace(/\/+$/, '') !== PUBLIC) return custom;
  const hk = clean(process.env.HELIUS_API_KEY);
  if (hk) return 'https://mainnet.helius-rpc.com/?api-key=' + encodeURIComponent(hk);
  return custom || PUBLIC;
}
function describe() {
  const u = url(); let host = ''; try { host = new URL(u).host; } catch { host = '?'; }
  return host + (/helius/i.test(host) ? ' (Helius, key aktif)' : (u === PUBLIC ? ' (RPC publik: batas ketat)' : ' (RPC kustom)'));
}
module.exports = { url, describe, PUBLIC };
