#!/usr/bin/env node
'use strict';
// TUAN runs this after a supervised SMALL live test of one feature. It is the only thing that clears the matching "unverified:<feature>" gate in parity-check.js
// (Go Live stays blocked while any gate is open). Claude must never run it on Tuan's behalf.
//   node record-live-verification.js entry-geometry "tes $20 pool X-SOL: posisi in-range, 2 deposit selesai, tx <sig> <sig>"
const fs = require('fs'), path = require('path');
const { REQUIRED_VERIFICATIONS } = require('./parity-check');
const [feature, ...rest] = process.argv.slice(2), note = rest.join(' ').trim();
if (!REQUIRED_VERIFICATIONS.includes(feature) || note.length < 20) {
  console.error('usage: node record-live-verification.js <feature> "<what was tested, with tx signatures (min 20 chars)>"\nfeatures: ' + REQUIRED_VERIFICATIONS.join(', '));
  process.exit(2);
}
const file = path.join(__dirname, 'live-verification.json');
let d = { features: {} }; try { d = JSON.parse(fs.readFileSync(file, 'utf8')); d.features = d.features || {}; } catch (e) { /* new file */ }
d.features[feature] = { verifiedBy: process.env.SUDO_USER || process.env.USER || 'unknown', at: new Date().toISOString(), note };
fs.writeFileSync(file + '.tmp', JSON.stringify(d, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(file + '.tmp', file);
console.log('recorded', feature, '-> remaining unverified:', REQUIRED_VERIFICATIONS.filter(f => !(d.features[f] && d.features[f].verifiedBy)).join(', ') || '(none)');
