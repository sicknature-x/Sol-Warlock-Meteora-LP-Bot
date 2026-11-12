# Sol Warlock v1.7

Paper trading is what is running (or ready to run) now. Live trading is locked until Tuan funds the wallet and explicitly approves.

## Current locks

- `/workspace/lp-bot/STOP` is the **live** lock. It was **left in place**. Do not remove it for paper.
- Paper stop file: `/workspace/lp-bot/paper/STOP`
- The process will refuse live mode unless `DRY_RUN=0` **and** `LIVE_CONFIRMED=1`. `send()` also refuses without that pair of flags.

## Paper run (7 days, 500 USDC capital)

Started by pm2 (`ecosystem.paper.config.js`, app name `lp-paper`) via `paper-exec.sh`. Forces `PAPER=1 DRY_RUN=1`. Never loads the private key, never signs, never sends. `run-paper.sh` is a bash fallback and must not run at the same time.

Virtual wallet starts at **500 USDC only**. There is no separate SOL gas balance. At each open the bot Jupiter-quotes (quote only) USDC→SOL for the position size plus `GAS_BUFFER_SOL` (default **0.30 SOL**) to cover position+ATA rent, possible bin-array rent, and open/reshape/close/swap tx fees, with margin. A tiny `USDC_BUFFER` (default $0.10) stays unsold. On close, refundable rent and leftover buffer are included and **all remaining SOL is swapped back to USDC**. Real wallet is unused.

- Position: ~all available USDC after the gas extra and residual, 50% Spot + 50% Bid-Ask, one-sided left of active down to about −50%, one position at a time, AR off. Still capped at 5% of pool TVL (the cap applies to position size, not the gas extra).
- Filters (C2 plus anti-rug, all must pass): **30m** fee/TVL (Meteora datapi `fees[30m]/tvl*100`) ≥ **1%** (`FT_WINDOW`, `MIN_FT`), 1h pump ≤ 15%, 24h pump ≤ +50%, pool age ≥ **24h**, liquidity ≥ **$10k**, bin step 100–400, 1h volume not a spike from ~zero (1h ≤ 50% of 24h volume), RugCheck contract safety (mint + freeze authority revoked, no `danger` risks, normalised score < 50; API failure is a reject), top-10 holders (excluding LP/pool/program accounts) ≤ 30% of supply, creator/dev hold ≤ 10%. Position still capped at 5% of pool TVL (logs requested vs actual). Thresholds are env-configurable.
- Single live-like strategy: **N5** — reshape when the active bin has moved down 5 bins since last reshape or entry, compound SOL fees on reshape. Same-position M-shape (token-only Bid-Ask on the right, left quote never withdrawn). Baseline and N10 remain in `bot.js` commented, not deleted.
- Exits: TP +20%, **emergency stop if price drops more than 30% from entry**, or max hold 12h. `paper/STOP` or the 7-day window end closes whatever is still open. Emergency closes are stored with reason `emergency_stop`.
- Telegram (Tuan, [DRY RUN], casual Indonesian): open, reshape, close, emergency stop, error/restart, daily ~21:00 WIB, window end. Chat id in `paper/telegram.json`; token is not stored in the repo.
- Journals: `paper/history.csv` (pair, pool address, open/close WIB, close reason, `usdc_in`/`usdc_out`, `pnl_usd`/`pnl_pct`, SOL equivalent, `swap_cost_usd`, `gas_used_sol`, fees, reshape count, plus size/bin fields), `paper/positions_open.json` (single position or null), `paper/summary.json` (single-strategy stats, USDC-primary).

### Mini app (Status, Settings, Wallet, Live)

Telegram mini app on `127.0.0.1:8787` (pm2 app `lp-miniapp`), published through a Cloudflare quick tunnel (pm2 app `lp-tunnel`, `cloudflared` in `~/.local/bin`). The current HTTPS URL is written to `paper/tunnel-url.json` and, whenever it changes, pushed to Tuan's chat menu button (`setChatMenuButton` web_app, chat `YOUR_TELEGRAM_USER_ID`) and to `/start` (`setMyCommands`). `/start` replies with a web_app button only to Tuan. Static pages are public; `/api/*` still requires valid Tuan `initData` (403 without it).

Tabs: Status (read-only; when a position is open, a per-position **BIN SHAPE** chart of SOL vs token per bin, with the active bin, range edges, and an M badge after reshape), Settings (paper filters / reshape N / TP / emergency / hold / gas buffer / pump caps, pause/resume dry run via `paper/STOP`), Wallet (paste key write-only into an encrypted store; only the public address is shown), Live (balances, two-step Go Live by typing LIVE within 60s, Stop Live). Writes need Tuan's Telegram `initData` (live/key writes must be <5 minutes fresh) plus a CSRF nonce, with rate limits and lockout. Settings land in `paper/settings.json`. The key is never logged or put in pm2 env. This bot does not go live by itself — only Tuan's confirm in the app removes `/workspace/lp-bot/STOP` and starts `lp-live`.

Open/reshape Telegram notices send a PNG of the bin shape (`sendPhoto`) with the same caption plus Meteora / LP Agent URL buttons, and fall back to text if the photo cannot be sent.

### Check status


```bash
cat /workspace/lp-bot/paper/summary.json
tail -n 80 /workspace/lp-bot/paper/bot.log
cat /workspace/lp-bot/paper/positions_open.json
# optional:
column -s, -t /workspace/lp-bot/paper/history.csv | sed -n '1,20p'
```

### Stop paper (does not start live, does not touch the live STOP file)

```bash
touch /workspace/lp-bot/paper/STOP
# and/or
pm2 stop lp-paper
```

`paper/STOP` makes the bot close any open **virtual** position and exit; the wrapper then stops the pm2 app so it does not autorestart. `pm2 stop lp-paper` stops the process immediately (use `paper/STOP` first if a position is open and you want a clean close).

### Journal files

- `/workspace/lp-bot/paper/positions_open.json`
- `/workspace/lp-bot/paper/history.csv`
- `/workspace/lp-bot/paper/summary.json`
- `/workspace/lp-bot/paper/reshapes.jsonl`
- `/workspace/lp-bot/paper/state.json` (virtual book; live `state.json` is not overwritten)
- `/workspace/lp-bot/paper/ESTIMATES.md` — what is real vs estimated

## Go live (requires funding + Tuan's explicit approval)

Do **not** run these until Tuan says yes and the bot wallet (its public address is shown in the mini app, Wallet menu) is funded.

Funding needed (SOL price moves; add a little buffer):

| Target | Position | Reserve | Rent/fees (typical) | **Suggested fund** |
|---|---|---|---|---|
| Classic 2 SOL | 2.00 | 0.15 | ~0.06 refundable position+ATA, plus 0–N × 0.0714 non-refundable bin arrays | **~2.40 SOL** |
| Paper-sized 5 SOL | 5.00 | 0.15 | same rent shape | **~5.40 SOL** |
| $500 at entry | $500 / SOL-USD (e.g. ~5.83 SOL at $85.8) | 0.15 | same | **~6.20 SOL** |

Exact rent is quoted at entry (`quoteCreatePosition`). Bin-array rent is not returned when the position closes.

```bash
# 2 SOL, classic C2, reshape off (historical default)
cd /workspace/lp-bot && \
  DRY_RUN=0 LIVE_CONFIRMED=1 POSITION_SOL=2 RESERVE_SOL=0.15 RESHAPE=0 \
  nohup ./run.sh >/dev/null 2>&1 &

# $500 per open (converted at entry), 5% TVL cap, $10k min liquidity
cd /workspace/lp-bot && \
  DRY_RUN=0 LIVE_CONFIRMED=1 POSITION_USD=500 RESERVE_SOL=0.15 \
  MIN_LIQ_USD=10000 MAX_POS_TVL_FRAC=0.05 \
  nohup ./run.sh >/dev/null 2>&1 &
```

`./run.sh` will still refuse if `STOP` is present. Removing `STOP` is part of an approved go-live only.

To enable the same-position M-reshape live, add `RESHAPE=1`.
