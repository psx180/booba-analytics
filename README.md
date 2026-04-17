# Booba Analytics — AI-Powered Trade Journaling and Analytics for Pacifica

Booba Analytics connects to Pacifica (Solana perp DEX) and automatically journals every trade. It applies quantitative methods from statistical research and institutional finance — walk-forward validation, CUSUM behavioral detection, Monte Carlo simulation, MFE/MAE exit analysis — to show traders exactly where they're losing money, how much, and what to change. Every finding is tested for statistical significance before being shown.

## Architecture

```
┌──────────────────────────────┐        ┌──────────────────────────────────┐
│  Chrome Extension (MV3)      │        │  Next.js Web App                 │
│  ─ popup (Booba avatar/chat) │        │  ─ Dashboard / Trades            │
│  ─ content scripts (overlay) │ <────> │  ─ Analytics / Signals           │
│  ─ background polling        │        │  ─ Playbooks / Replay            │
└──────────────┬───────────────┘        └──────────────────┬───────────────┘
               │                                           │
               └────────────► Pacifica REST + WS ◄─────────┘
                                       │
                              ┌────────┴────────┐
                              │ Prisma + SQLite │
                              │ Claude API      │
                              └─────────────────┘
```

## Tech Stack

Next.js 15 · React 19 · Prisma · SQLite · Tailwind · Recharts · lightweight-charts · Claude API · Privy · Chrome MV3

## Setup

1. **Prerequisites:** Node.js 20+ and npm.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy environment template and fill in values:
   ```bash
   cp .env.example .env.local
   ```
4. Generate the Prisma client and apply the schema:
   ```bash
   npx prisma generate && npx prisma db push
   ```
5. Build and start the web app:
   ```bash
   npm run build && npm run start
   ```
6. Open <http://localhost:3000>.
7. **Chrome extension:** open `chrome://extensions`, enable Developer Mode, click "Load unpacked", and select the `extension/` directory.

## Scripts

| Script              | Purpose                                              |
| ------------------- | ---------------------------------------------------- |
| `npm run dev`       | Start Next.js in development mode with HMR.          |
| `npm run build`     | Produce a production build.                          |
| `npm run start`     | Serve the production build.                          |
| `npm run import`    | Ingest historical trades from Pacifica into the DB.  |
| `npm run seed:demo` | Populate the database with demo trades for previews. |

## Environment Variables

See [`.env.example`](./.env.example) for the canonical list. Summary:

| Variable                     | Description                                                          |
| ---------------------------- | -------------------------------------------------------------------- |
| `DATABASE_URL`               | Prisma connection string (defaults to local SQLite).                 |
| `NEXT_PUBLIC_PRIVY_APP_ID`   | Privy app ID for wallet auth (browser).                              |
| `PRIVY_APP_SECRET`           | Privy server secret for verifying session tokens.                    |
| `NEXT_PUBLIC_DEV_WALLET`     | Optional dev bypass wallet address.                                  |
| `PF_API_KEY`                 | Pacifica mainnet API key.                                            |
| `PACIFICA_TESTNET_API_KEY`   | Pacifica testnet API key.                                            |
| `PACIFICA_CARRY_API_URL`     | Base URL for Pacifica carry trade endpoints.                         |
| `ANTHROPIC_API_KEY`          | Claude API key powering the AI copilot and analytics.                |
| `BOT_API_KEY`                | Shared secret for webhook/bot endpoints.                             |
| `DEFAULT_WALLET_ADDRESS`     | Wallet attached to background jobs and webhook ingest.               |
| `TRADINGVIEW_WEBHOOK_SECRET` | HMAC secret for inbound TradingView webhooks.                        |
| `TELEGRAM_NOTIFY_URL`        | Telegram webhook URL for outbound mobile alerts (blank to disable).  |

## Analytics Methodology

Booba runs **walk-forward edge validation** — the same out-of-sample testing institutional researchers use to avoid curve-fitting — over each strategy's history before claiming a real edge. **MFE/MAE exit analysis** measures how much was left on the table per trade in dollars, so stop and target placement issues surface as quantified opportunity cost rather than abstract ratios. **CUSUM tilt detection**, borrowed from industrial quality control, flags behavioral drift (revenge trading, size escalation) the moment cumulative deviation crosses a control bound. **Monte Carlo simulation** projects drawdown and ruin probabilities at current sizing. Every one of the **26 behavioral detectors** runs hypothesis tests with **false-discovery-rate control** so insights shown to the trader are statistically real, not artefacts of multiple comparisons.

## Project Status

- [x] Auto-ingestion of Pacifica trade history
- [x] Regime detection (ADX/ATR, per-trade regime tagging)
- [x] Behavioral analytics (26 detectors, FDR-controlled)
- [x] AI copilot (Booba) with persistent memory
- [x] Trade replay with progressive fill markers
- [x] Signal tracking and source attribution
- [x] Chrome extension (popup, overlay, background)
- [x] MCP servers (trade data, analytics, grouping)

## Team

Built by Nick.
