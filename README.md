# 🧙 Sol Warlock v1.7: Bot LP Solana (Meteora DLMM)

Bot LP otomatis untuk Meteora DLMM. Default-nya mode PAPER (simulasi, tanpa uang asli), dikontrol lewat Telegram Mini App. Tidak pakai AI/LLM.

## Fitur
- Screening pool (fee/TVL, bin step, umur pool, filter pump)
- SL -20%, TP +20%, TP Emergency +10% (default ON)
- SL Blacklist: token yang kena SL nggak dibuka lagi
- Close Stale: atur jam, mode keluar (langsung, minus X%, BEP, profit X%)
- Shape Spot:Bid-Ask bebas, trailing opsional (default OFF)
- Mini App: Status, Settings, Wallet, PnL Calendar, Live

## 0. Yang perlu disiapkan
- VPS Linux Ubuntu 22.04/24.04, minimal RAM 1 GB. Bisa sewa di [SumoPod](https://sumopod.com/) (bayar pakai QRIS), Tencent Cloud, DigitalOcean, Vultr, Contabo, dll. Catat IP, username, dan password/SSH key-nya.
- Aplikasi Termius (atau terminal SSH lain). Di Termius: New Host, isi IP, username, password, lalu Connect.
- Akun Telegram.

## 1. Bikin bot Telegram
1. Chat **@BotFather**, kirim `/newbot`.
2. Kasih nama, lalu username yang diakhiri `bot` (contoh: `LPkuBot`).
3. Simpan **token** dari BotFather (bentuknya `123456:ABC...`). Ini rahasia.
4. Chat **@userinfobot**, kirim `/start`, catat angka **Id** kamu.
5. Buka bot barumu dan tekan **Start**.

## 2. Install Node.js + PM2 di VPS
Login ke VPS, lalu jalankan:

    sudo apt update && sudo apt install -y curl unzip wget git
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt install -y nodejs
    sudo npm install -g pm2
    node -v

Pastikan `node -v` menunjukkan v22 atau lebih.

## 3. Download dari GitHub

    cd ~
    git clone https://github.com/sicknature-x/Sol-Warlock-Meteora-LP-Bot.git
    cd Sol-Warlock-Meteora-LP-Bot/sol-lp-bot
    npm ci --omit=dev

## 4. Isi file .env

    cp .env.example .env
    chmod 600 .env
    nano .env

Nilai yang diawali `isi_` dianggap kosong dan bot pakai default. Cukup ganti ini:

| Baris | Isi dengan | Wajib? |
|---|---|---|
| `TELEGRAM_BOT_TOKEN=` | token dari BotFather | Wajib |
| `TELEGRAM_ALLOWED_ID=` | Id Telegram kamu | Wajib |
| `TELEGRAM_CHAT_ID=` | Id yang sama | Wajib |
| `ALLOWED_TG_IDS=` | Id yang sama | Wajib |
| `TELEGRAM_BOT_USERNAME=` | username bot, tanpa @ | Disarankan |
| `MINIAPP_URL=` | URL https mini app (langkah 6) | Untuk mini app |
| `SOLANA_RPC_URL=` | URL RPC, misalnya dari helius.dev (gratis) | Disarankan |
| `HELIUS_API_KEY=` | API key Helius | Opsional |
| `JUPITER_API_KEY=` | API key Jupiter | Opsional |
| `PRIVATE_KEY=` | biarkan placeholder selama paper | Hanya live |
| `WALLET_PUBLIC_KEY=` | alamat wallet (bukan private key) | Hanya live |

Baris strategi dan filter biarkan saja, nanti bisa diubah dari menu Settings di mini app. Simpan di nano: `Ctrl+O`, Enter, lalu `Ctrl+X`.

## 5. Jalankan bot

    pm2 start ecosystem.public.config.cjs
    pm2 save
    pm2 startup
    pm2 status
    pm2 logs --lines 30

Setelah `pm2 startup`, jalankan perintah yang ditampilkan supaya bot nyala lagi setelah VPS reboot. Semua proses di `pm2 status` harus "online".

## 6. Mini app (dashboard di Telegram)
Mini app jalan di `127.0.0.1:8797`, dan Telegram butuh alamat https. Pakai Cloudflare tunnel gratis:

    curl -L -o cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
    chmod +x cloudflared && sudo mv cloudflared /usr/local/bin/
    pm2 start "cloudflared tunnel --url http://127.0.0.1:8797" --name miniapp-tunnel
    pm2 logs miniapp-tunnel --lines 20

1. Cari URL `https://xxxx.trycloudflare.com` di log, salin ke `MINIAPP_URL=` di `.env`, lalu `pm2 restart all`.
2. Di @BotFather: `/mybots`, pilih bot, Bot Settings, Menu Button, tempel URL yang sama.
3. Buka bot di Telegram dan tekan tombol menu.

URL trycloudflare berubah kalau tunnel di-restart, jadi ulangi langkah 1 dan 2 kalau itu terjadi.

## 7. Paper vs Live
- Default: dry run / paper (aman, tanpa uang asli).
- Pindah ke live lewat tab **Live** di mini app (konfirmasi dua kali). Live butuh wallet yang sudah diisi dan file `STOP` sudah dihapus.
- Live bisa rugi uang asli. Pakai wallet khusus dengan saldo kecil dulu.

## 8. Perintah berguna

    pm2 status
    pm2 logs --lines 50
    pm2 restart all
    pm2 stop all

## Update dari versi lama (v1.0–v1.4)

    cd ~/Sol-Warlock-Meteora-LP-Bot && git pull
    rsync -a --exclude '.env' --exclude 'paper/' --exclude 'node_modules/' ~/Sol-Warlock-Meteora-LP-Bot/sol-lp-bot/ ~/sol-lp-bot/
    cd ~/sol-lp-bot && npm ci --omit=dev
    pm2 restart all && pm2 status

Kalau belum punya folder clone-nya, jalankan dulu bagian langkah 3 (`git clone`). File `.env` dan data paper kamu tetap aman. Kalau kamu sudah live dan sempat menghapus `STOP`, update ini memunculkannya lagi sehingga bot berhenti dulu (aman). Hapus lagi `STOP` kalau mau lanjut live.

## Keamanan
- Jangan pernah share atau upload isi `.env`, token, atau private key.
- Bot hanya merespon Id Telegram yang diisi di `.env`.

## Disclaimer
Bukan saran finansial. LP di token baru berisiko tinggi, gunakan dengan risiko sendiri.

💡 Bisa backtest sendiri pakai Grok Bot.
