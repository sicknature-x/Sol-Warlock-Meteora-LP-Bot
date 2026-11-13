# Changes

## v1.8 (2026-11-13)

- **Filter baru (dry run dan live sama):** RugCheck lengket (`RUGCHECK_STICKY_DAYS`, default 7 hari: token yang pernah ditandai bahaya tetap diblok walau laporan berikutnya bersih), pengaman fee turnover (`FEE_TURNOVER_MAX_PCT` 60% untuk TVL di bawah `FEE_TURNOVER_TVL_BELOW_USD` 25000), dan `OOR_RIGHT_MIN_BINS` (reposition/limit OOR kanan baru jalan setelah harga naik N bin di atas range, default 5).
- **Reposition floor:** `OOR_RIGHT_REPOSITION_MIN_PNL_PCT` (default -3%): posisi yang net PnL-nya lebih dalam dari itu ditahan, tidak di-reposition. Take-profit, batas reposition, SL, dan stale tetap berlaku.
- **Anti PvP `KEEP_BIGGEST`:** yang terbesar likuiditasnya menang, bukan yang tertua.
- **Jupiter API key dan Helius RPC:** isi `JUPITER_API_KEY` dan `HELIUS_API_KEY` di `.env` (nama saja di `.env.example`). Kuota quote lebih longgar, refresh quote 30 detik, fallback otomatis ke endpoint tanpa key kalau key ditolak. Prioritas RPC: `SOLANA_RPC_URL` > Helius > RPC publik.
- **Menu Wallet:** tombol **Claim Token Account** (klaim rent SOL dari token account kosong; hanya akun saldo 0 milik wallet sendiri, USDC/wSOL dan token dari posisi yang masih terbuka dilewati, semua transaksi disimulasikan dulu, wajib konfirmasi dan ketik `CLAIM`, tidak pernah otomatis).
- **Menu Live:** pilihan modal **USDC / SOL** dipindah ke sini (satu setelan bersama dry run dan live); Settings tidak lagi memuatnya.
- **Screening:** tombol **Open sekarang** aktif untuk semua kandidat; filter biasa bisa di-override dengan konfirmasi (TVL, quote, RugCheck, mint, insider, holder tetap wajib).
- **Opsi SOL:** Tambah modal dan Edit modal dry run bisa diisi dalam SOL (dikonversi ke USDC pada harga SOL), dan PnL Calendar punya toggle USD / SOL.
- **UI:** tombol di Posisi open, Screening, dan modal dibuat lebih besar dan jelas; strip pilihan strategi dihapus (strategi hanya satu).
- **Tes:** tes lama diperbarui ke default sekarang, ditambah tes untuk semua fitur baru. Tiga tes UI/integrasi lama masih usang dan perlu ditulis ulang.

## v1.7 (2026-11-12)

- **Live = dry run, satu aturan:** screening, pengaman open, keputusan close, reshape + compound tiap N bin, reposition kanan, swap back (token langsung ke USDC), pool berkuote USDC, dan multi-posisi sampai `MAX_POSITIONS` kini memakai kode dan setting yang sama di dry run dan live. Pengecek paritas (`parity-check.js`) menolak Go Live selama masih ada perbedaan atau tes dana kecil yang belum dicatat (`record-live-verification.js`, dijalankan Tuan sendiri).
- **Entry quote-only:** `UPPER_BUFFER_BINS` default **0** (tanpa bin token di atas bin aktif), range -50% mengikuti bin step pool, Spot : Bid-Ask **50:50**, reshape tiap 5 bin. Berlaku untuk dry run dan live.
- **Anti PvP `KEEP_BIGGEST` = likuiditas terbesar menang** (bukan yang tertua), kini default; token kembar yang lebih kecil diabaikan. `SKIP_ALL` dan `OFF` tetap tersedia.
- **Menu Live disederhanakan:** satu tombol **Live ON** dengan satu konfirmasi; tanpa key atau saldo live menolak setelah konfirmasi dan dry run tetap jalan. Saat Live ON berhasil, dry run disimpan sebagai run bernomor dan run berikutnya mulai bersih. Istilah "STOP file" dihapus dari tampilan.
- **History:** modal USDC menampilkan **net USDC** sebagai angka utama (warna mengikuti angka itu); modal SOL tidak berubah.
- **Telegram:** emoji di pesan open, reposition, close (profit/rugi), dan emergency; pesan reshape diam secara default (`NOTIFY_RESHAPE`); prefix `[LIVE]` untuk proses live.
- **Fee swap dijelaskan terbuka:** swap on-chain lewat Jupiter (live) memuat fee platform 0,5% ke akun referral developer; tertulis di README. Dry run tidak terkena fee.
- **Tanpa alamat pribadi di kode:** alamat wallet tidak lagi tertulis di source, README, atau config; tombol LP Agent memakai alamat wallet bot yang tersimpan di mini app.

## v1.6 (2026-11-12)

- **TP Emergency SL+** (kunci profit setelah TP Emergency aktif; default ON, berlaku juga ke posisi open): setelah TP Emergency v1 aktif dan PnL net menyentuh **+3%** (`EMERGENCY_SLPLUS_ARM_PCT`), posisi ditutup bila PnL net turun ke **+0.1%** (`EMERGENCY_SLPLUS_LOCK_PCT`) selama **3 poll** berturut-turut (`EMERGENCY_SLPLUS_CONFIRM_POLLS`).
- **Pelindung BEP** (bagian dari SL+): setelah aktif, PnL net ≤ **0% (BEP)** (`EMERGENCY_SLPLUS_FLOOR_PCT`) di poll pertama (`EMERGENCY_SLPLUS_FLOOR_POLLS`=2) langsung close, supaya jatuh cepat setelah peak tidak sampai SL -20%.
- Alasan close `emergency_slplus` (bukan Stop Loss, tidak masuk SL blacklist). Tampil di History (badge **TP Emergency SL+**), CSV (`exit_reason`), kalender PnL, dan kartu posisi aktif (status ON/OFF, menunggu profit, SL+ aktif x/3, pelindung BEP). Dihitung dari nilai estimasi seperti SL (tidak menunggu quote terverifikasi).
- Posisi yang sudah open ikut: bila peak PnL tercatat setelah TP Emergency aktif dan >= +3%, SL+ langsung aktif. Peak sebelum TP Emergency aktif tidak dihitung.
- **Koreksi riwayat HUNG-SOL #2** (disetujui, `hung-sol-20261112-emergency-slplus-recalc-v1`): ditutup 10:29:08 WIB oleh SL+ di -0.2239 USDC (sebelumnya SL -108.83 USDC pada 11:36:17). Kas virtual +108.607 USDC; baris asli tersimpan di `correction.original`. HUNG tetap di SL blacklist.
- Setelan baru di tab Setelan (konfirmasi strategi diperlukan). Tes: `test-emergency-slplus.js` (38 cek). Hanya jalur paper; jalur live belum memakai logika exit ini.
- **Default & tombol Reset = setelan aktif sekarang:** TP normal **13%** (sebelumnya 20%; di data riwayat peak tertinggi 12.7%, TP emergency tetap 10%, TP normal harus tetap di atas TP emergency), Anti PvP **KEEP_BIGGEST** (likuiditas terbesar menang, bukan yang tertua; sebelumnya SKIP_ALL), TP Emergency SL+ ON (aktif +3%, tutup <= +0.1% x3 poll, lantai BEP 0% x2 poll). TP normal baru hanya berlaku ke posisi baru.
- **TP live = TP paper:** field lama `TP` (dipakai jalur live) sekarang selalu diturunkan dari `TP_USD_PCT` (13% -> 0.13), di `currentValues` dan setiap penyimpanan setelan, termasuk Reset. Sebelumnya live masih memakai 20%.
- **Aturan: live dan dry run satu setelan, jangan dibedakan (tahap 1 selesai).** Kunci yang dulu hanya dari env kini masuk setelan bersama (tab Setelan + Reset berlaku untuk paper dan live): `FT_WINDOW`, `MAX_TOP10_HOLD`, `MAX_DEV_HOLD`, `USDC_BUFFER`; `RESHAPE`, `RESERVE_SOL`, `POSITION_USD` mengikuti `RESHAPE_ENABLED`, `GAS_BUFFER_SOL`, `POSITION_USDC`. **Ukuran posisi live sekarang dibatasi `POSITION_USDC` seperti dry run** (sebelumnya live menyetor seluruh saldo USDC yang tersedia). `parity-check.js` + `test-parity-live-paper.js` menggagalkan tes bila ada perbedaan baru. **Gerbang keras:** bot menolak start live dan miniapp menolak Go Live (arm/start) selama `node parity-check.js` masih menemukan perbedaan. **Tahap 2a selesai: keputusan exit live = kode dry run** (`live-exit.js`: PnL net USDC dari `paper-usdc.exitQuote`, aturan dari `paper-exit-policy.decide`): SL -20% berbasis PnL net, TP 13%, TP Emergency, SL+ dan lantai BEP, OOR kanan, stale, trailing. Aturan lama live (SL berbasis harga token, TP tetap 20%, max age tetap 12 jam) dihapus. **Tahap 2b-2 selesai (kode):** entry quote-only (`UPPER_BUFFER_BINS=0`, range -50% mengikuti bin step, Spot:Bid-Ask 50:50) di dry run dan live (`live-geometry.js`, `live-open-exec.js`); swap back live = dry run (token->USDC langsung, tumpukan SOL posisi->USDC, `live-close-exec.js`); reshape tiap N bin + compound di live (`live-reshape-exec.js`); reposition kanan di live (`live-reposition-exec.js`); pool berkuote USDC di live; multi-posisi sampai `MAX_POSITIONS` (`live-positions.js`). Semua perbedaan logika live vs dry run = 0. Go Live tetap terkunci oleh 6 gate `unverified:*` yang hanya bisa dibuka lewat `record-live-verification.js` setelah tes dana kecil yang diawasi Tuan. **Tahap 2b-1 selesai:** screening live memakai filter yang sama dengan dry run (SL blacklist, cooldown, penolakan sewa non-refundable `MAX_NONREFUND_SOL`, data TVL-drop dari riwayat live sendiri, urutan kandidat `screenSource.priority`); `liveOpen` menjalankan pengaman open yang sama dengan `paperOpenSingle` (SL blacklist, cooldown, `MAX_LIQ_USD`, `MAX_NONREFUND_SOL`) sebelum mengirim apa pun; `liveClose` mencatat SL blacklist seperti `paperClose`. **Masih berbeda (butuh kode eksekusi transaksi + uji dana kecil di bawah pengawasan Tuan):** pool berkuote USDC di screening/open live, geometri entry (`strategy.geometry`), reposition kanan, reshape/compound, multi-posisi, dan rute swap-back (live: token->SOL->USDC dengan sisa SOL; dry run: token->USDC langsung, seluruh SOL ke USDC).
- Label versi: v1.6 (header home, README, package.json, teks Telegram).

## v1.4 (2026-11-11)

- **PnL Calendar** (Wallet → PnL Calendar): kalender bulanan PnL realized per hari (hijau profit / merah rugi + jumlah trade), navigasi bulan, total bulanan. Reset harian 07:00 WIB = 00:00 UTC. Badge mode **DRY RUN** / **LIVE**. Endpoint `/api/pnl-calendar`, data dari history yang sama dengan halaman History.
- **Sub menu Live** (Wallet → Live): Dry run Pause/Resume, Tambah modal (dry run), dan kontrol Go Live (konfirmasi ganda tetap). Dihapus dari Settings dan tab atas.
- **TP Emergency default ON** (`EMERGENCY_TP_ENABLED=true`, +10%, aktif setelah harga turun 50% range bawah).
- **Default & tombol Reset = setting dev**: MAX_POSITIONS 10, POSITION_USDC 500, MIN_FT 0.6, MIN_BIN_STEP 80, MIN_AGE_H 0.5, MAX_PUMP1H 150%, MAX_PUMP_24H 500%.
- **Info filter Pump 1j/24j** di Settings: bot skip token yang sudah naik > MAX_PUMP1H (150%) dalam 1 jam atau > MAX_PUMP24H_PCT (200%) dalam 24 jam (anti beli di pucuk). Key lama `MAX_PUMP_24H` tidak dipakai filter.
- **Fix install baru**: `REAL_WALLET` dibaca dari `WALLET_PUBLIC_KEY` (kosong/invalid → alamat dummy), tidak crash "Invalid public key input".

## v1.3 (2026-11-11)

- **Stop Loss -20%** (`EMERGENCY_DROP=0.20`, net vs modal entry) dan **SL blacklist** (`SL_BLACKLIST_ENABLED=true`): token (mint) yang ditutup karena stop loss tidak dibuka lagi di pool/fee tier mana pun. Daftar tampil di Settings, dan bisa dihapus dengan konfirmasi + audit log.
- **Emergency TP** (default ON): posisi yang harganya turun ≥ `EMERGENCY_TP_TRIGGER_RANGE_PCT`% dari range bawah saat open memakai target TP `EMERGENCY_TP_PCT` (default 10%) menggantikan TP normal.
- **Close stale settings**: `STALE_CLOSE_ENABLED`, `MAX_HOURS`, `STALE_EXIT_MODE` (ANY / MINUS / BEP / PROFIT), `STALE_EXIT_PCT`. Default ANY = perilaku lama (tutup langsung setelah MAX_HOURS). Dikelompokkan dalam blok "Close stale".
- **History**: badge alasan close (SL, TP, TP EMERGENCY, OOR, TRAIL, MANUAL, **STALE**), durasi open di setiap baris (⏱), detail stale. Close yang terjadi setelah cutoff arsip lama selalu tampil di history.
- **Shape Spot:Bid-Ask**: input dua kotak `[ ] : [ ]` (angka bulat 0–100, jumlah 100, kotak lain terisi otomatis) untuk open dan compound.
- **Label Stop Loss** dan peringatan checklist saat menyalakan trailing stop. Label trailing ditebalkan.
- **UI**: tema kartu gelap yang seragam untuk semua halaman mini app.
- Teks HawkFi dihapus. Sumber screening ditampilkan sebagai Meteora datapi 30m.
- **Test isolation**: settings yang disimpan ke folder paper selain default (misalnya tes) tidak lagi menulis `.env` di folder bot utama.

## 2026-11-11 (afternoon, Asia/Jakarta) — v1.2: Emergency TP, Stop Loss label, trailing warning

- **Emergency TP (new, default OFF):** `EMERGENCY_TP_ENABLED=false`, `EMERGENCY_TP_TRIGGER_RANGE_PCT=50`, `EMERGENCY_TP_PCT=10`. When the active price falls from the leg's entry by at least (lower range at open × trigger %), e.g. range -50% → -25%, range -70% → -35%, the position is flagged `deepDrawdown` persistently (state keeps `openRangeDownPct`, `maxPriceDropPct`, `deepDrawdownAt/Bin/DropPct/TriggerPct`). While enabled, its TP target becomes `EMERGENCY_TP_PCT` (same net capital-asset basis and quote/fallback rules as normal TP). Close reason `emergency_tp …`. Applies live to open positions; Stop Loss -30% still has priority. Shown in Settings > Strategy with confirm + audit log.
- **Stop Loss label:** existing `EMERGENCY_DROP` now labelled "Stop Loss (emergency) %" and placed after TP.
- **Trailing stop:** TRAIL_* labels bold ("TRAILING STOP"); turning trailing ON requires a checkbox confirmation dialog. Default stays OFF.
- Tests: `test-emergency-tp.js` (13 offline checks). Version label bumped to v1.2 (README, package.json, mini app header, Telegram /start text).
- **Stop Loss -30% → -20%** (Tuan request t204): active setting and code defaults now `EMERGENCY_DROP=0.20`. Open positions keep the SL frozen in their entry snapshot (30%); new positions use 20%.
- **History recalc** (approved): all closed positions replayed from bot.log monitor polls under SL -20% / EMERGENCY_TP +10% / TP +20%, first event wins. Only HOLD-SOL changed (correction `hold-sol-20261111-emergency-tp-recalc-v2`: -180.04 → +49.99 USDC, EMERGENCY_TP at 12:52:08 WIB). GTA6-SOL (20:34 WIB 10 Nov) left unchanged: only 1 monitor poll in bot.log.
- Paper only. STOP left in place.

## 2026-11-10 (evening, Asia/Jakarta) — MIN_FT 2% → 1%

Tuan lowered the paper 30m fee/TVL threshold from 2% to **1%**. Default and `paper/settings.json` are both `MIN_FT=1`. TVL floor stays $10k; other anti-rug filters and the 5%-of-TVL cap are unchanged. The change is in `settings-audit.log` and a `[DRY RUN]` Telegram settings note was sent. Applies on the next paper scan. Live was not started. `/workspace/lp-bot/STOP` was left in place.


## 2026-11-10 (evening, Asia/Jakarta) — MIN_LIQ_USD 25000 → 10000

Tuan lowered the paper TVL floor from $25k to **$10k**. Default and `paper/settings.json` are both `MIN_LIQ_USD=10000`. Other anti-rug filters and the 5%-of-TVL position cap are unchanged. The change is in `settings-audit.log` and a `[DRY RUN]` Telegram settings note was sent. Applies on the next paper scan (`applyPaperSettings`). Live was not started. `/workspace/lp-bot/STOP` was left in place.


## 2026-11-10 (evening, Asia/Jakarta) — Mini app public tunnel, BIN SHAPE chart, sendPhoto

Cloudflared (2026.10.7) is installed at `~/.local/bin/cloudflared`. pm2 app `lp-tunnel` runs a quick tunnel to `127.0.0.1:8787`. A watcher writes `paper/tunnel-url.json` and, on every URL change, calls `setChatMenuButton` (web_app) for chat YOUR_TELEGRAM_USER_ID and `setMyCommands` `/start`. `/start` replies with a web_app button only to Tuan. The Status tab shows a per-position BIN SHAPE chart (SOL vs token per bin, active marker, range edges, M badge after reshape) only when a position is open. Open/reshape notifications send that chart as a PNG via `sendPhoto` (caption + Meteora / LP Agent buttons) and fall back to text. Local synthetic PNG tests were run; no fake trade notification was sent to Tuan. Token and keys stay out of pm2 dump and logs. `/workspace/lp-bot/STOP` was left in place. Live was not started.


## 2026-11-10 — Mini app Wallet + Live tabs (Tuan-triggered only)

Tuan now has a **Wallet** tab and a **Live** tab in the mini app, in addition to Status and Settings.

Wallet: hidden password field to paste a base58 or JSON-array private key. Write-only — the secret is never returned, displayed, logged, put in Telegram, or written to pm2 env/dump. The server validates the format and shows only the derived public address. The key is stored AES-256-GCM at rest, using a random master key under `/home/box/.secrets` (dir 700, files 600), outside the repo. Hapus key / Ganti key are provided. Live mode loads the key from this store into memory only (`SOLANA_BOT_PRIVATE_KEY` remains a fallback).

Live: shows address, SOL/USDC (RPC read), and a two-step Go Live (button, then type `LIVE` within 60s). Requirements: key stored, balance check (min 0.05 SOL fee reserve + 10 USDC), fresh initData (<5 min) for user YOUR_TELEGRAM_USER_ID, CSRF. Going live removes `/workspace/lp-bot/STOP` and starts pm2 `lp-live` with `DRY_RUN=0 LIVE_CONFIRMED=1`, same N5 strategy + settings.json + USDC flow (real Jupiter swaps; a 0.05 SOL fee reserve is kept on close). Paper is paused. Stop Live can write STOP and stop the app (close positions) or set `NO_NEW` (no new opens). Every key/live action is audited (no secrets) and sent as a Telegram note.

This agent did **not** go live, did **not** store a real key, and did **not** remove STOP. Only Tuan can trigger Go Live from the app.

POSTs stay rate-limited with CSRF and lock out after repeated bad auth. Tests cover unauthorized key/live writes and assert the secret never appears in responses, audit logs, or notify payloads (throwaway keypairs, deleted afterwards).


## 2026-11-10 — Mini app Settings tab (paper only)

Telegram mini app (`/workspace/lp-bot/miniapp`, pm2 `lp-miniapp`, localhost `127.0.0.1:8787`) now has a **Settings** tab in addition to a read-only Status tab. This is the only write path: it overrides the earlier "no write endpoints" rule solely for these paper settings: `MIN_FT`, `MIN_LIQ_USD`, `MIN_AGE_H`, reshape N, TP, emergency stop, close-after hours, `GAS_BUFFER_SOL`, and max pump / volume-spike filters, plus Pause/Resume of the dry run (`paper/STOP` only; `lp-paper` is restarted on resume with a clean env).

POST endpoints require valid Telegram `initData` HMAC for user `YOUR_TELEGRAM_USER_ID` plus a fresh single-use CSRF nonce (~10 minutes). Server-side type and min/max checks reject unknown or live-related keys (no `DRY_RUN` / `LIVE_CONFIRMED` toggle, no live STOP removal, no key, no wallet/funding/withdraw, no position size above the 500 USDC capital). Values are stored in `paper/settings.json`; `bot.js` reloads them on the next scan. Every change is appended with a WIB timestamp to `paper/settings-audit.log` and sent as a `[DRY RUN]` Telegram note. The UI shows current values vs defaults and has reset-to-default. Tests in `test-paper-settings.js` cover invalid and unauthorized writes. Live STOP is never touched.


## 2026-11-10 — Paper capital is 500 USDC only (no separate SOL gas wallet)

Paper virtual book starts at 500 USDC. There is no separate $10 SOL gas balance. At each open the bot Jupiter-quotes (quote only, no sign/send) USDC→SOL for the position size plus a configurable `GAS_BUFFER_SOL` extra (default **0.30 SOL**). The default is a floor above the computed need: position+ATA rent (~0.0594 SOL, refunded on close), up to two bin-array rents (~0.1429 SOL, typically not refunded), and a generous open/reshape/close/swap tx budget, then ×1.15 margin (~0.235 SOL needed). 0.30 SOL leaves headroom; if a pool quotes more arrays the buffer rises above the floor. 5% TVL cap still applies to position size, not the gas extra. A tiny USDC residual (`USDC_BUFFER`, default $0.10) stays unsold.

On close: token→SOL as before, refundable rent is returned, leftover gas buffer is included, and **all remaining SOL is swapped back to USDC**. PnL is USDC-primary (`usdc_in`, `usdc_out`, `pnl_usd`, `pnl_pct`) with SOL equivalent and `swap_cost_usd` / `gas_used_sol` listed separately. The 7-day paper window is unchanged (ends 2026-11-17 11:33:32 WIB). History was empty so the book was reset to 500 USDC. Paper only; live STOP left in place.

(2026-11-10)

Backup of the previous bot lives in `/workspace/lp-bot/backup-20261110/`. Live `state.json` history (Bitcoin-SOL) was not deleted.

## Fixes and hardening

- Hard live guard: refuses to start or `send()` unless `DRY_RUN=0` **and** `LIVE_CONFIRMED=1`. Paper mode forces `DRY_RUN=1` and never loads the private key.
- `run.sh` has the same guard and will not start live if `STOP` exists. Default is still `DRY_RUN=1`.
- HTTP and RPC calls retry with backoff; GeckoTerminal pump has a DexScreener fallback. Meteora `dlmm-api.meteora.ag` is 404; the bot uses `https://dlmm.datapi.meteora.ag/pools` (list + per-pool), which works.
- `status.json` refreshes the **on-chain** wallet balance (read-only) and, when paper is running, points at the paper journal. Live trade history is not overwritten.
- Insufficient-balance guard uses the **virtual** wallet in paper (real wallet is 0 SOL). Live still refuses to open if on-chain SOL < position + reserve + rent + buffer, and logs the numbers.
- Net PnL on paper close splits: fees earned, IL (mark inventory vs deposit), swap-back cost (Jupiter **quote only**), network fees (estimated), refundable rent (returned, not profit), non-refundable bin-array rent (cost).
- Position size can be `POSITION_SOL` or `POSITION_USD` (converted at entry). Capped at `MAX_POS_TVL_FRAC` (default 5% of pool TVL); both requested and actual sizes are logged.
- Min liquidity filter is `MIN_LIQ_USD` (default $10,000, was $3,000).
- Mint/freeze authority check stays on. Top-10 holder filter is optional (`CHECK_TOP_HOLDERS=1`), default off; uses `getTokenLargestAccounts` when enabled.

## Paper book

- `PAPER=1` writes a 7-day virtual book under `/workspace/lp-bot/paper/`.
- One position at a time, same C2 entry/exit rules, 5-minute poll, supervisor restarts on crash, auto-stop at the end of the window (or `paper/STOP`).
- Live `/workspace/lp-bot/STOP` is ignored in paper mode and was **not** removed.

## Same-position M-reshape (paper, and live if `RESHAPE=1`)

- Never opens a second position.
- Withdraws only token-side bins (`binId > active`). Left quote liquidity is never withdrawn.
- Re-adds those tokens as Bid-Ask on the right of active (SDK Bid-Ask is heavier at the far edge).
- If the target right edge is outside the position, uses `increasePositionLength(position, ResizeSide.Upper, length, funder)` (chunked, max 91 bins per call, position max 1400). If there is no room, the range is clamped and logged.
- Claimed SOL fees are compounded as an add to the left (Spot+Bid-Ask on bins below active), with no removal. May extend Lower if there is no left side left.
- Build-only SDK validation: open tx1 is constructed and not signed; reshape parameters and `quoteExtendPosition` are verified; `removeLiquidity` / `addLiquidityByStrategy` cannot be fully built until a real on-chain position exists (logged as such).


## 2026-11-10 (later) — shadow variants

- Reshape trigger is now: price/active bin dropped **N bins** since last reshape or entry (replaces 5% token value + 600s cooldown).
- Paper runs five shadow books in one process on a shared entry stream: baseline (no reshape, no compound), N=5/10/15/20 (M-reshape + compound-on-reshape, same-position rules).
- Exits evaluated per variant. Journals split per variant plus a comparison table in `summary.json`.
- Paper window end time kept at 17 Nov 2026 11:33:32 WIB.


## 2026-11-10 (afternoon, Asia/Jakarta) — anti-rug filters on the paper run

Backup: `/workspace/lp-bot/backup-20261110/bot.js.before-antirug`. Paper window, history, and `/workspace/lp-bot/STOP` were left in place. Live was not started.

- Default floors tightened: pool age ≥ 24h (was 6h), TVL ≥ $50k (was $10k).
- New entry rejects: 24h pump > +50%; 1h volume > 50% of 24h volume (or 24h volume missing while 1h is positive); RugCheck report with mint/freeze authority still set, `danger` risks, rugged flag, or normalised score ≥ 50. RugCheck HTTP/parse failure rejects the pool (fail-closed) and is logged.
- Holder concentration always on: top 10 holders excluding LP/pool/known program accounts must be ≤ 30% of supply; creator/dev ≤ 10%. Prefers RugCheck `topHolders`; RPC `getTokenLargestAccounts` is the fallback, also fail-closed if unknown.
- Emergency stop on every variant, including baseline: close when price is down more than 30% from entry. History reason is `emergency_stop`.
- All of the thresholds above are configurable constants / env vars. Existing C2 fee/TVL, 1h pump, bin-step, mint RPC, and 5% TVL cap checks stay in place.


## 2026-11-10 (afternoon, Asia/Jakarta) — paper min TVL $25k

Tuan approved lowering the paper-bot TVL floor from $50k to **$25,000**. All other anti-rug filters and the −30% emergency stop are unchanged. `/workspace/lp-bot/STOP` was left in place; live was not started. Paper window and history were preserved.


## 2026-11-10 (afternoon, Asia/Jakarta) — paper min 1h fee/TVL 1.5%

Tuan approved lowering the paper-bot 1h fee/TVL floor from 2% to **1.5%**. TVL stays $25k; the other anti-rug filters and the −30% emergency stop are unchanged. `/workspace/lp-bot/STOP` was left in place; live was not started. Paper window and history were preserved.


## 2026-11-10 (evening, Asia/Jakarta) — Meteora 30m fee/TVL ≥ 2%

Tuan chose the screenshot definition: **30-minute fees / current TVL** from Meteora datapi (`fee_tvl_ratio['30m']` = `fees['30m']/tvl*100`), threshold **≥ 2%**. The previous 1h fee/TVL entry filter is replaced. Configurable via `FT_WINDOW` (default `30m`) and `MIN_FT` (default `2`). TVL stays $25k; age 24h, 1h/24h pump, volume spike, RugCheck, holders, −30% emergency stop, and the 5% TVL cap are unchanged. Screening metric is replicated from Meteora datapi. Execution stays Meteora-only, paper only.

Backup: `/workspace/lp-bot/backup-20261110/bot.js.before-fee30m`. Paper window, history, and `/workspace/lp-bot/STOP` were left in place. Live was not started.


## 2026-11-10 (evening, Asia/Jakarta) — final paper strategy N5 + pm2

Tuan approved the final paper strategy: **30m fee/TVL ≥ 2%**, reshape every **5 bins (N5)** with compound, TVL ≥ $25k, age ≥ 24h, 1h/24h pump, volume spike, RugCheck, holders, −30% emergency stop, 5% TVL cap, 5 SOL/position, TP +20%, 12h close. Paper behaves like a single live book: `VARIANTS` is N5 only; baseline and N10 remain commented in `bot.js`, not deleted.

The process is supervised by **pm2** (`lp-paper`, `ecosystem.paper.config.js` + `paper-exec.sh`). The wrapper reinstalls dependencies with `npm ci` (fallback `npm install`) if `node_modules` is missing, and stops the pm2 app when `paper/STOP` or `paper/ENDED` is present so autorestart does not loop. No private key is in the pm2 env or config.

Backup: `/workspace/lp-bot/backup-20261110/bot.js.before-n5-only`. Paper window, empty history files, and `/workspace/lp-bot/STOP` were left in place. Live was not started.


## 2026-11-10 (evening, Asia/Jakarta) — Telegram dry-run notifier

Paper bot notifies Tuan on Telegram (casual Indonesian, tagged [DRY RUN]) for open, reshape, close, emergency stop, errors/restarts, daily summary ~21:00 WIB, and window end. Fail-safe and rate-limited; a notify failure never crashes the bot. Chat id is stored in `paper/telegram.json`. The bot token is read at runtime from a chmod 600 file outside the repo (or from the process env if present), is never written into the pm2 ecosystem file, dump, logs, or repo, and is unset in the pm2 wrapper env. Live was not started. `/workspace/lp-bot/STOP` was left in place.


## 2026-11-10 (evening, Asia/Jakarta) — Telegram Meteora + LP Agent buttons, Tuan-only

Open/reshape/close (and emergency) Telegram notices include inline URL buttons: **Meteora** (`https://app.meteora.ag/dlmm/<pool>`) and **LP Agent** (`https://app.lpagent.io/portfolio?address=<WALLET>&chain=SOL`, `LPAGENT_ADDRESS` defaulting to the bot wallet). Paper messages note that dry-run positions do not appear on LP Agent. Buttons are plain URLs, not Telegram Web Apps. Notifications go only to allowlisted chat `YOUR_TELEGRAM_USER_ID`; other user IDs are ignored if any update/mini-app path is used. Token still not stored in the repo or pm2 dump. Live was not started.
