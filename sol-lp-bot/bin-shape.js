// Per-position BIN SHAPE chart: SOL (Y) vs token (X) per bin, active marker, range edges.
// Renders a PNG (no native deps) for Telegram and a compact model for the mini app Status tab.
'use strict';

const zlib = require('zlib');

function toBinList(pos = {}) {
  const raw = pos.bins || pos.binMap || {};
  const minBinId = num(pos.minBinId);
  const maxBinId = num(pos.maxBinId);
  const activeBin = firstNum(pos.activeBin, pos.lastActiveBin, pos.entryActiveBin, pos.lastReshapeActiveBin);
  const map = new Map();
  if (Array.isArray(raw)) {
    for (const b of raw) {
      const id = num(b.id != null ? b.id : b.binId);
      if (id == null) continue;
      map.set(id, { id, sol: +b.sol || +b.y || 0, token: +b.token || +b.x || 0 });
    }
  } else if (raw && typeof raw === 'object') {
    for (const [k, b] of Object.entries(raw)) {
      const id = num(b && (b.binId != null ? b.binId : k));
      if (id == null) continue;
      map.set(id, { id, sol: +((b && (b.y != null ? b.y : b.sol)) || 0), token: +((b && (b.x != null ? b.x : b.token)) || 0) });
    }
  }
  let lo = minBinId, hi = maxBinId;
  if (lo == null || hi == null) {
    const ids = [...map.keys()].sort((a, b) => a - b);
    if (ids.length) {
      if (lo == null) lo = ids[0];
      if (hi == null) hi = ids[ids.length - 1];
    }
  }
  if (activeBin != null) {
    if (lo == null || activeBin < lo) lo = activeBin;
    if (hi == null || activeBin > hi) hi = activeBin;
  }
  if (lo == null) lo = 0;
  if (hi == null) hi = lo;
  if (hi < lo) { const t = lo; lo = hi; hi = t; }
  const bins = [];
  for (let id = lo; id <= hi; id++) {
    const b = map.get(id) || { id, sol: 0, token: 0 };
    bins.push({ id, sol: b.sol || 0, token: b.token || 0 });
  }
  const shape = String(pos.shape || '');
  return {
    name: pos.name || pos.pair || '',
    pool: pos.pool || '',
    shape,
    isM: /M|m-double|reshape/i.test(shape),
    minBinId: lo,
    maxBinId: hi,
    activeBin: activeBin,
    bins,
    nBins: bins.length,
  };
}

function num(v) {
  if (v == null || v === '') return null;
  const n = +v;
  return Number.isFinite(n) ? n : null;
}
function firstNum(...xs) {
  for (const x of xs) {
    const n = num(x);
    if (n != null) return n;
  }
  return null;
}

function chartModel(pos) {
  const m = toBinList(pos);
  return {
    name: m.name,
    quoteSymbol: pos?.quoteSymbol || 'SOL',
    shape: m.shape,
    isM: m.isM,
    minBinId: m.minBinId,
    maxBinId: m.maxBinId,
    activeBin: m.activeBin,
    bins: m.bins,
  };
}

// --- tiny 5x7 font (A-Z 0-9 and a few symbols), bits top-to-bottom then left-to-right ---
const GLYPHS = (() => {
  const g = {};
  const set = (ch, rows) => { g[ch] = rows; };
  // 5 columns of 7 bits, encoded as 5 hex-ish numbers 0-127
  const pack = (lines) => {
    // lines: 7 strings of 5 chars '.' or 'X'
    const cols = [0, 0, 0, 0, 0];
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 5; c++) if (lines[r][c] === 'X') cols[c] |= (1 << r);
    }
    return cols;
  };
  const D = {
    ' ': ['.....','.....','.....','.....','.....','.....','.....'],
    '0': ['.XXX.','X...X','X..XX','X.X.X','XX..X','X...X','.XXX.'],
    '1': ['..X..','.XX..','..X..','..X..','..X..','..X..','.XXX.'],
    '2': ['.XXX.','X...X','....X','...X.','..X..','.X...','XXXXX'],
    '3': ['.XXX.','X...X','....X','..XX.','....X','X...X','.XXX.'],
    '4': ['...X.','..XX.','..XX.','X..X.','XXXXX','...X.','...X.'],
    '5': ['XXXXX','X....','XXXX.','....X','....X','X...X','.XXX.'],
    '6': ['.XXX.','X....','X....','XXXX.','X...X','X...X','.XXX.'],
    '7': ['XXXXX','....X','...X.','..X..','..X..','..X..','..X..'],
    '8': ['.XXX.','X...X','X...X','.XXX.','X...X','X...X','.XXX.'],
    '9': ['.XXX.','X...X','X...X','.XXXX','....X','....X','.XXX.'],
    'A': ['.XXX.','X...X','X...X','XXXXX','X...X','X...X','X...X'],
    'B': ['XXXX.','X...X','X...X','XXXX.','X...X','X...X','XXXX.'],
    'C': ['.XXX.','X...X','X....','X....','X....','X...X','.XXX.'],
    'D': ['XXXX.','X...X','X...X','X...X','X...X','X...X','XXXX.'],
    'E': ['XXXXX','X....','X....','XXXX.','X....','X....','XXXXX'],
    'F': ['XXXXX','X....','X....','XXXX.','X....','X....','X....'],
    'G': ['.XXX.','X...X','X....','X.XXX','X...X','X...X','.XXXX'],
    'H': ['X...X','X...X','X...X','XXXXX','X...X','X...X','X...X'],
    'I': ['.XXX.','..X..','..X..','..X..','..X..','..X..','.XXX.'],
    'J': ['..XXX','...X.','...X.','...X.','...X.','X..X.','.XX..'],
    'K': ['X...X','X..X.','X.X..','XX...','X.X..','X..X.','X...X'],
    'L': ['X....','X....','X....','X....','X....','X....','XXXXX'],
    'M': ['X...X','XX.XX','X.X.X','X.X.X','X...X','X...X','X...X'],
    'N': ['X...X','XX..X','X.X.X','X..XX','X...X','X...X','X...X'],
    'O': ['.XXX.','X...X','X...X','X...X','X...X','X...X','.XXX.'],
    'P': ['XXXX.','X...X','X...X','XXXX.','X....','X....','X....'],
    'Q': ['.XXX.','X...X','X...X','X...X','X.X.X','X..X.','.XX.X'],
    'R': ['XXXX.','X...X','X...X','XXXX.','X.X..','X..X.','X...X'],
    'S': ['.XXXX','X....','X....','.XXX.','....X','....X','XXXX.'],
    'T': ['XXXXX','..X..','..X..','..X..','..X..','..X..','..X..'],
    'U': ['X...X','X...X','X...X','X...X','X...X','X...X','.XXX.'],
    'V': ['X...X','X...X','X...X','X...X','X...X','.X.X.','..X..'],
    'W': ['X...X','X...X','X...X','X.X.X','X.X.X','XX.XX','X...X'],
    'X': ['X...X','X...X','.X.X.','..X..','.X.X.','X...X','X...X'],
    'Y': ['X...X','X...X','.X.X.','..X..','..X..','..X..','..X..'],
    'Z': ['XXXXX','....X','...X.','..X..','.X...','X....','XXXXX'],
    '-': ['.....','.....','.....','XXXXX','.....','.....','.....'],
    '+': ['.....','..X..','..X..','XXXXX','..X..','..X..','.....'],
    ':': ['.....','..X..','..X..','.....','..X..','..X..','.....'],
    '.': ['.....','.....','.....','.....','.....','.....','..X..'],
    '/': ['....X','...X.','...X.','..X..','.X...','X....','X....'],
    '%': ['XX..X','XX.X.','...X.','..X..','.X...','X.XX.','X..XX'],
    '[': ['.XXX.','.X...','.X...','.X...','.X...','.X...','.XXX.'],
    ']': ['.XXX.','...X.','...X.','...X.','...X.','...X.','.XXX.'],
    '(': ['..XX.','.X...','X....','X....','X....','.X...','..XX.'],
    ')': ['.XX..','...X.','....X','....X','....X','...X.','.XX..'],
    ' ': ['.....','.....','.....','.....','.....','.....','.....'],
  };
  for (const [ch, lines] of Object.entries(D)) set(ch, pack(lines));
  return g;
})();

function crc32(buf) {
  return zlib.crc32(buf) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[(width * 4 + 1) * y] = 0;
    rgba.copy(raw, (width * 4 + 1) * y + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function px(rgba, w, h, x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const i = (y * w + x) * 4;
  if (a >= 255) { rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255; return; }
  const ai = a / 255, inv = 1 - ai;
  rgba[i] = Math.round(r * ai + rgba[i] * inv);
  rgba[i + 1] = Math.round(g * ai + rgba[i + 1] * inv);
  rgba[i + 2] = Math.round(b * ai + rgba[i + 2] * inv);
  rgba[i + 3] = 255;
}

function fillRect(rgba, w, h, x, y, rw, rh, r, g, b, a) {
  const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(w, Math.ceil(x + rw)), y1 = Math.min(h, Math.ceil(y + rh));
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) px(rgba, w, h, xx, yy, r, g, b, a);
}

function vline(rgba, w, h, x, y0, y1, r, g, b, a = 255) {
  const xx = Math.round(x);
  const ya = Math.max(0, Math.min(y0, y1)), yb = Math.min(h - 1, Math.max(y0, y1));
  for (let y = ya; y <= yb; y++) px(rgba, w, h, xx, y, r, g, b, a);
}

function hline(rgba, w, h, y, x0, x1, r, g, b, a = 255) {
  const yy = Math.round(y);
  const xa = Math.max(0, Math.min(x0, x1)), xb = Math.min(w - 1, Math.max(x0, x1));
  for (let x = xa; x <= xb; x++) px(rgba, w, h, x, yy, r, g, b, a);
}

function drawText(rgba, w, h, text, x, y, color, scale = 1) {
  const s = String(text).toUpperCase();
  let cx = Math.round(x);
  const cy = Math.round(y);
  const [cr, cg, cb] = color;
  for (const ch of s) {
    const cols = GLYPHS[ch] || GLYPHS[' '];
    for (let c = 0; c < 5; c++) {
      const bits = cols[c] || 0;
      for (let r = 0; r < 7; r++) {
        if (bits & (1 << r)) {
          fillRect(rgba, w, h, cx + c * scale, cy + r * scale, scale, scale, cr, cg, cb, 255);
        }
      }
    }
    cx += 6 * scale;
  }
  return cx;
}

const COL = {
  bg: [15, 20, 26],
  panel: [22, 30, 40],
  grid: [40, 52, 66],
  text: [220, 228, 236],
  muted: [139, 154, 171],
  sol: [56, 189, 248],
  token: [251, 191, 36],
  active: [244, 63, 94],
  range: [165, 180, 196],
  m: [167, 139, 250],
};

function renderPng(pos, opts = {}) {
  const model = chartModel(pos);
  const W = opts.width || 800;
  const H = opts.height || 440;
  const rgba = Buffer.alloc(W * H * 4, 0);
  fillRect(rgba, W, H, 0, 0, W, H, ...COL.bg, 255);

  const title = `[DRY RUN] BIN SHAPE${model.name ? '  ' + String(model.name).slice(0, 24) : ''}`;
  drawText(rgba, W, H, title, 16, 14, COL.text, 2);
  const sub = [
    model.isM ? 'SHAPE M (LEFT QUOTE, RIGHT TOKEN BID-ASK)' : (model.shape ? 'SHAPE ' + model.shape : 'SHAPE INITIAL'),
    `RANGE ${model.minBinId}..${model.maxBinId}`,
    model.activeBin != null ? `ACTIVE ${model.activeBin}` : '',
  ].filter(Boolean).join('   ');
  drawText(rgba, W, H, sub, 16, 36, COL.muted, 1);

  // legend
  fillRect(rgba, W, H, 16, 54, 10, 10, ...COL.sol, 255);
  drawText(rgba, W, H, model.quoteSymbol, 30, 55, COL.sol, 1);
  fillRect(rgba, W, H, 70, 54, 10, 10, ...COL.token, 255);
  drawText(rgba, W, H, 'TOKEN (QUOTE EQ)', 84, 55, COL.token, 1);
  fillRect(rgba, W, H, 220, 54, 10, 10, ...COL.active, 255);
  drawText(rgba, W, H, 'ACTIVE BIN', 234, 55, COL.active, 1);
  fillRect(rgba, W, H, 350, 54, 10, 10, ...COL.range, 255);
  drawText(rgba, W, H, 'RANGE EDGE', 364, 55, COL.range, 1);

  const padL = 48, padR = 16, padT = 80, padB = 36;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  fillRect(rgba, W, H, padL, padT, plotW, plotH, ...COL.panel, 255);
  for (let i = 0; i <= 4; i++) {
    const y = padT + (plotH * i) / 4;
    hline(rgba, W, H, y, padL, padL + plotW, ...COL.grid, 160);
  }

  const price=+(pos.lastPrice||pos.entryPrice)||0;
  const bins = model.bins.map(b=>({...b,token:b.token*price}));
  const n = Math.max(1, bins.length);
  const slot = plotW / n;
  const maxV = Math.max(1e-12, ...bins.map((b) => Math.max(b.sol, b.token)));
  const barW = Math.max(1, Math.floor(slot * 0.4));

  for (let i = 0; i < n; i++) {
    const b = bins[i];
    const cx = padL + (i + 0.5) * slot;
    const solH = (b.sol / maxV) * (plotH - 2);
    const tokH = (b.token / maxV) * (plotH - 2);
    fillRect(rgba, W, H, cx - barW - 0.5, padT + plotH - solH, barW, solH, ...COL.sol, 230);
    fillRect(rgba, W, H, cx + 0.5, padT + plotH - tokH, barW, tokH, ...COL.token, 230);
  }

  const xFor = (binId) => padL + ((binId - model.minBinId) + 0.5) * slot;
  // range edges
  const xMin = xFor(model.minBinId);
  const xMax = xFor(model.maxBinId);
  vline(rgba, W, H, xMin, padT, padT + plotH, ...COL.range, 220);
  vline(rgba, W, H, xMax, padT, padT + plotH, ...COL.range, 220);
  drawText(rgba, W, H, String(model.minBinId), xMin - 10, padT + plotH + 8, COL.range, 1);
  drawText(rgba, W, H, String(model.maxBinId), Math.min(W - 60, xMax - 10), padT + plotH + 8, COL.range, 1);

  if (model.activeBin != null && model.activeBin >= model.minBinId && model.activeBin <= model.maxBinId) {
    const xa = xFor(model.activeBin);
    vline(rgba, W, H, xa, padT - 2, padT + plotH, ...COL.active, 255);
    vline(rgba, W, H, xa - 1, padT - 2, padT + plotH, ...COL.active, 120);
    drawText(rgba, W, H, 'ACTIVE', Math.max(padL, xa - 18), padT - 12, COL.active, 1);
  }

  if (model.isM && model.activeBin != null) {
    drawText(rgba, W, H, 'QUOTE', padL + 4, padT + 6, COL.sol, 1);
    drawText(rgba, W, H, 'TOKEN BID-ASK', Math.min(W - 110, xFor(Math.min(model.maxBinId, model.activeBin + 1))), padT + 6, COL.token, 1);
  }

  hline(rgba, W, H, padT + plotH, padL, padL + plotW, ...COL.muted, 255);
  return encodePng(W, H, rgba);
}

function isPng(buf) {
  return Buffer.isBuffer(buf) && buf.length > 16 && buf[0] === 137 && buf[1] === 80 && buf[2] === 78 && buf[3] === 71;
}

module.exports = { toBinList, chartModel, renderPng, isPng };
