# Brother Eli Assistant

Your **Starknet helper** in Telegram. Buy alerts are live now (price, charts, GIFs); more tools are coming.

It watches Ekubo Core swaps (including AVNU and Fibrous routes) and posts cards in your token group: emoji ladder, USD spent, optional STRK spent, market cap, mini chart, custom GIFs, and whale GIFs.

## What it posts

```
🟢🟢🟢🟢🟢
SLAY Buy!  🐋

Spent: $1,180
STRK: 1,250
Got: 2,450,000 SLAY
Route: 1 buy across 3 pools
Price: $0.000482  (+8.2% 1h)
MC $482K · Liq $91K · Vol $44K
Wallet: 0x04ab…c91
```

Buttons: Starkscan TX · DexScreener chart · Ekubo · Buy on AVNU

## AVNU split routes

AVNU (and Fibrous) often split **one** user swap across several Ekubo pools in the same transaction — for example 40% ETH→TOKEN and 60% ETH→STRK→TOKEN. Those look like several `Swapped` events on-chain.

Brother Eli waits until the transaction is quiet, **nets every hop in that tx**, ignores intermediate tokens (STRK in the example nets near zero), and posts **one** buy for what the user actually spent and received.

## Setup

1. Node.js 20+
2. The Telegram bot is `@brotherelibuybot`. In [@BotFather](https://t.me/BotFather), turn **Group Privacy** off (see below) so `/start` works in groups.
3. Copy env and fill the token:

```bash
copy .env.example .env
```

```
TELEGRAM_BOT_TOKEN=123456:abc
STARKNET_RPC_URL=https://api.cartridge.gg/x/starknet/mainnet
STARKNET_WS_URL=
```

Production uses the Alchemy mainnet RPC from the portfolio project (Railway variable). Cartridge is only the public fallback.

4. Install and run:

```bash
npm install
npm run dev
```

5. Add `@brotherelibuybot` to your Telegram group as admin with **post messages** and **send media**. Then send `/start` in the group.

## Turn off Group Privacy (needed)

Telegram bots ignore group commands until this is off. You do it in BotFather, not in our code:

1. Open Telegram and search **@BotFather**
2. Tap it and press **Start** if needed
3. Send `/mybots`
4. Tap **Brother Eli Assistant** (or `@brotherelibuybot`)
5. Tap **Bot Settings**
6. Tap **Group Privacy**
7. Tap **Turn off**

You want it to say privacy is **disabled**. Then add the bot to the group.

## Admin settings (per token)

| Setting | Default | Notes |
| --- | --- | --- |
| Min USD | $100 | Swaps below this are ignored |
| Emoji + step | 🟢 / $50 | Ladder length = USD / step |
| GIF | none | Send a GIF in chat, or a URL |
| Whale GIF | none | Used on buys at or above the whale USD size |
| Chart | on | 5m candlesticks when no GIF is set |
| Price alert | off | Extra ping on ±N% moves |

Cap: **10 tokens per group**.

Close the panel with **Close**, **Cancel**, `/cancel`, or `/close`. That also drops any in-progress prompt (GIF, min USD, etc.) so later chat messages are not captured.

## How detection works

- Subscribe (WebSocket) or poll `starknet_getEvents` on Ekubo Core `0x00000005dd3d2f…5b4b`
- Decode `Swapped` deltas. Positive token delta = buy (user received the token).
- All hops in one transaction are netted before posting (AVNU/Fibrous split routes).
- Price / MC / liquidity / candles from GeckoTerminal. DexScreener is only a backup if Gecko has no data.

## Project layout

```
src/
  index.ts            boot
  bot/                grammy admin panel, cards, send queue
  indexer/            Ekubo WS + HTTP poll, decode, AVNU netting
  market/             DexScreener, Ekubo API, GeckoTerminal
  chart/              candlestick PNG
  store/              sqlite
```

SQLite file: `data/brother-eli.db`

## GitHub + Railway

Repo: [github.com/CudanSvat/brother-eli-assistant](https://github.com/CudanSvat/brother-eli-assistant)

The bot token lives in `.env` and is gitignored. Production on Railway uses:

- `TELEGRAM_BOT_TOKEN` (set in the Railway dashboard / CLI, never committed)
- `STARKNET_RPC_URL` (Alchemy mainnet from the portfolio project; set in Railway, never committed)
- `DATABASE_PATH=/data/brother-eli.db`
- `NODE_VERSION=20`

SQLite needs a persistent volume mounted at `/data` or buys/settings reset on every deploy. Start command is `npm start` (Node 20). `better-sqlite3` and the chart canvas package compile native code on install.
