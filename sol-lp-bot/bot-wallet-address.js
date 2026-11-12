'use strict';
// PUBLIC address of the bot's own wallet (the one stored via the mini app), read from the key envelope metadata. No decryption, no hard-coded address anywhere.
// Used for: LP Agent buttons (Telegram + mini app) and the paper "real wallet" balance display. No key stored -> null (callers must cope).
const path = require('path');
function botWalletAddress(secretsDir = process.env.LP_SECRETS_DIR || path.join(__dirname, 'secrets')) {
  try { const m = require('./wallet-store').readEnvelopeMeta(secretsDir); return m && m.publicAddress ? String(m.publicAddress) : null; } catch { return null; }
}
module.exports = { botWalletAddress };
