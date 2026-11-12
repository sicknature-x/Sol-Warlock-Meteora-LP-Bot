'use strict';
const fs = require('fs');
const path = require('path');
const quotePnl=require('../paper-quote-pnl');
// Read only a bounded log tail. Never return raw logs, URLs, stack traces, or startup env.
function readTail(file, bytes = 65536) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - bytes);
    const b = Buffer.alloc(Math.min(size, bytes));
    fs.readSync(fd, b, 0, b.length, start);
    const text = b.toString('utf8');
    return start ? text.slice(text.indexOf('\n') + 1) : text;
  } catch { return ''; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function reasonId(s) {
  return String(s).replace(/quote not SOL/g, 'quote bukan SOL')
    .replace(/fee\/tvl/g, 'fee/TVL').replace(/tvl</g, 'TVL di bawah ')
    .replace(/age</g, 'umur di bawah ').replace(/pump/gi, 'lonjakan harga')
    .replace(/vol1h low/g, 'volume 1 jam rendah').replace(/vol spike/gi, 'lonjakan volume')
    .replace(/blacklisted/g, 'masuk blacklist').replace(/bin_step outside/g, 'bin step di luar')
    .replace(/no SOL liquidity/g, 'likuiditas SOL kosong').replace(/rugcheck/gi, 'RugCheck')
    .replace(/pass basic filters/g, 'lolos filter awal');
}
function events(paperDir) {
  const out = [];
  for (const line of readTail(path.join(paperDir, 'bot.log')).split('\n')) {
    const m = line.match(/^\[([\d-]+ [\d:]+ WIB)\](?: \[PAPER\])?\s*(.*)$/);
    if (!m) continue;
    const msg = m[2]; let text = '', kind = 'info', x;
    if(msg.includes('reason=oor_right_reposition_leg'))continue;
    if(msg.startsWith('REPOSITION KANAN #')){text='Reposition kanan '+msg.slice('REPOSITION KANAN '.length);kind='reshape';}
    else if(msg.startsWith('capital deposit applied:')){text='Tambah modal dry run · '+msg.slice('capital deposit applied:'.length);kind='info';}
    else if(msg.startsWith('manual open ')||msg.startsWith('manual close ')||msg.startsWith('manual switch ')){text='Aksi manual paper · '+msg;kind='info';}
    else if (msg.startsWith('screen source fallback:')) {
      text = 'Sumber screening fallback · ' + msg.slice('screen source fallback: '.length); kind = 'error';
    } else if ((x = msg.match(/^scan: (\d+) pools fetched, (\d+) pass basic filters; rejects=(.*)$/))) {
      let rejects = '';
      try { rejects = Object.entries(JSON.parse(x[3])).map(([k,v]) => `${reasonId(k)}: ${v}`).join(' · '); } catch {}
      text = `Scan ${x[1]} pool · ${x[2]} lolos awal${rejects ? ' — ' + rejects : ''}`; kind = 'scan';
    } else if ((x = msg.match(/^scan final: (\d+) pass all filters/))) {
      text = `${x[1]} pool lolos semua filter keamanan`; kind = 'scan';
    } else if (msg.startsWith('near-threshold ')) {
      text = 'Kandidat mendekati batas: ' + msg.slice(msg.indexOf('): ') + 3); kind = 'candidate';
    } else if ((x = msg.match(/^skip ([^:]{1,200}): (.*)$/))) {
      // Drop links and reject any unexpected key-related log. Messages remain display-only.
      text = `Lewati ${x[1]} — ${reasonId(x[2])}`; kind = 'skip';
    } else if (/no candidate passes all filters/.test(msg)) {
      text = 'Menunggu peluang · belum ada kandidat yang lolos semua filter'; kind = 'idle';
    } else if ((x = msg.match(/PAPER OPEN \[[^\]]+\] ([^:]+): spent ([\d.]+) USDC/))) {
      text = `Buka posisi paper ${x[1]} · budget ${x[2]} USDC (token + quote + buffer gas)`; kind = 'open';
    } else if (/CLOSE /.test(msg)) {
      x = msg.match(/CLOSE (.*?) reason=(.*?) pnlUsd=([\d.-]+)/);
      if (x) { text = `Tutup ${x[1]} · ${reasonId(x[2])} · PnL $${x[3]}`; kind = 'close'; }
    } else if (/jupiter quote/i.test(msg) && !/failed/.test(msg)) {
      x = msg.match(/quote[^:]*:\s*(.*?)(?:, (?:haircut|swapCost)|$)/i);
      text = 'Simulasi swap Jupiter · ' + (x ? x[1] : 'quote diperbarui'); kind = 'swap';
    } else if (/compound-on-reshape:/.test(msg)) {
      x = msg.match(/([\d.]+) (?:SOL|quote) fees added/);
      text = `Compound fee ${x ? x[1] + ' quote' : ''} ke bin kiri · tanpa menarik likuiditas kiri`; kind = 'reshape';
    } else if (/RESHAPE #/.test(msg)) {
      x = msg.match(/RESHAPE #(\d+) (.*?): right=([^ ]+)/);
      text = x ? `Reshape #${x[1]} ${x[2]} · range kanan ${x[3]} · bentuk M · fee dikompon` : 'Reshape posisi ke bentuk M'; kind = 'reshape';
    } else if (/reshape (?:skipped|aborted)/i.test(msg)) {
      text = 'Reshape ditunda · batas range atau buffer gas belum memenuhi'; kind = 'skip';
    } else if (/monitor \[/.test(msg) && /pnlUsdc=/.test(msg)) {
      x=msg.match(/monitor \[.*?\] (.*?):.*pnlUsdc=([\d.-]+).*pnlUsdcPct=([\d.-]+)%/);
      if(x){text=`Pantau ${x[1]} · close → USDC PnL $${x[2]} (${x[3]}%)`;kind='monitor';}
    } else if (/monitor \[/.test(msg)) {
      x = msg.match(/monitor \[.*?\] (.*?): value=([\d.]+) SOL pnl=([\d.-]+)%/);
      if (x) { text = `Pantau ${x[1]} · ${x[2]} SOL · PnL ${x[3]}%`; kind = 'monitor'; }
    } else if (/error|failed|fatal/i.test(msg) && !/telegram/.test(msg)) {
      text = 'Gangguan data / siklus · bot akan mencoba lagi'; kind = 'error';
    } else if (/paper window ended/.test(msg)) {
      text = 'Window paper selesai · tidak membuka posisi baru'; kind = 'close';
    }
    const display=msg.match(/\bpnlQuote=([\d.-]+) quoteSymbol=(SOL|USDC) pnlQuoteUsd=([\d.-]+)/);
    if(display&&['open','close','monitor','reshape'].includes(kind)){
      const label=quotePnl.format({pnlQuote:+display[1],quoteSymbol:display[2],pnlQuoteUsd:+display[3]});
      if(kind==='monitor'){const name=msg.match(/monitor \[.*?\] (.*?):/);text=`Pantau ${name?.[1]||'posisi'} · PnL ${label}`;}
      else if(kind==='close'){const name=msg.match(/CLOSE (.*?) reason=/);text=`Tutup ${name?.[1]||'posisi'} · PnL ${label}`;}
      else if(kind==='open')text+=` · PnL ${label}`;
      else text=`Reposition kanan · PnL ${label}`;
    }
    if (!text || /private.?key|secret|token=|Bearer|TELEGRAM_BOT_TOKEN/i.test(text)) continue;
    text = text.replace(/https?:\/\/\S+/g, '[tautan]').slice(0, 1400);
    out.push({ atWib: m[1], kind, text });
  }
  return out.slice(-50).reverse();
}
module.exports = { readTail, events, reasonId };
