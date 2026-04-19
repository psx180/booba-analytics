# Pending commits

Six tasks from this session, mapped to files and suggested commit messages.
Recommendation: **do not group** — every remaining change maps cleanly to one
task, so commits stay independent and revertable. Task 4's two scripts can
optionally be merged into one commit if you prefer fewer commits.

---

## Task 1 — Booba avatar broken-image fix

**What it does:** The floating avatar on Pacifica pages showed as a broken
image despite assets being on disk. Two root causes:

- Manifest V3 requires `web_accessible_resources` for any extension file
  referenced by `<img src>` from a content script; the manifest was missing
  it, so Chrome blocked even the valid `booba-calm.png`.
- The `MOODS` object in `booba-float.js` mapped every non-calm mood to
  filenames that didn't exist (`booba-alert.png`, `booba-nervous.png`, etc.)
  when the actual files on disk are `alert.png`, `nervous.png`,
  `money-mode.png`, `pout.png`, `excited.png`.

Added `web_accessible_resources: [{resources: ["assets/*"], matches:
["https://app.pacifica.fi/*", …]}]` to the manifest, and rewrote `MOODS`
to point at the real filenames.

**Files:**
- `extension/manifest.json`
- `extension/content/booba-float.js`

**Commit message:**
```
Fix Booba avatar: declare web_accessible_resources and correct MOODS filenames
```

---

## Task 3 — Pacifica WebSocket compact-format compatibility

**What it does:** Trade popups weren't firing because Pacifica's WebSocket
had switched to a compact array-wrapped format with single-letter keys
(`h=history_id`, `s=symbol`, `ts=open_long|close_short|…`, etc.) while
`session.ts` still assumed the old verbose object shape. Every dispatched
fill had `undefined` for all fields and `handleAccountTrade` returned early.
Also: the REST `/v1/positions` endpoint switched `side` from `long|short`
to `bid|ask` (book semantics), making `fetchInitialPositions` throw on
Zod validation.

Fixes:

- Added `normalizeAccountTrade()` and `normalizeAccountPosition()` in
  `session.ts` that map short keys → verbose shape and accept both formats.
  Dispatcher handles array payloads; `replaceOpenPositions()` treats
  `account_positions` as full-state snapshots per Pacifica's spec.
- Added `PositionSideSchema` in `types/account.ts` using `z.preprocess` to
  map `bid → long`, `ask → short` transparently, so downstream code keeps
  working in directional terms.

**Files:**
- `src/services/pacifica/live/session.ts`
- `src/services/pacifica/types/account.ts`

**Commit message:**
```
Support Pacifica's compact WS format and bid/ask REST position side
```

---

## Task 4 — Signal webhook mock script + strategies seed

**What it does:** Two new scripts for demo prep.

- `fire-mock-signal.ts` — posts realistic randomized signals (BTC/ETH/SOL,
  long/short, proportional TP/SL) to `/api/signals/webhook` using the same
  contract TradingView itself would use. Flags: `--count`, `--every=6s`,
  `--url`, `--secret`, `--format=json|text`, `--once`.
- `seed-strategies.ts` — creates four strategies (Breakout Continuation,
  Mean Reversion Scalp, Momentum Reversal, News Pump Fade) with full
  schema metadata (directionBias, preferredRegime, typicalTimeframe,
  typicalRrTarget, description, entrySignalTags, checklist) and tags ~12
  matching closed positions each. Errors out cleanly on the
  `Strategy.name` global-unique constraint.

**Files:**
- `src/scripts/fire-mock-signal.ts` *(new)*
- `src/scripts/seed-strategies.ts` *(new)*

**Commit message — split (recommended):**
```
Add fire-mock-signal script for posting demo TradingView alerts to /api/signals/webhook
```
```
Add seed-strategies script with four demo strategies and position tagging
```

**Commit message — merged (alternative):**
```
Add fire-mock-signal and seed-strategies demo scripts
```

---

## Task 5 — Reset-wallet script + NetworkSelector re-enable + intro blur fix

**What it does:** Three unrelated items bundled into one conversation turn
but kept as separate commits because they touch unrelated surfaces.

### 5a. Reset wallet

`reset-wallet.ts` wipes every wallet-scoped table for a given wallet. It
reuses `cleanDemoData()` from `seed-trades.ts` for the FK-safe core wipe
(Alert → FundingHistory → Trade → OrderGroup → Position → Journal →
Signal → Playbook → BoobaObservation → AnalysisSnapshot), then extends
with `Strategy` and `LinkedStrategy` rows which that function doesn't
touch. Does not clear global caches (`CandleCache`, `RegimeSnapshot`).

**Files:**
- `src/scripts/reset-wallet.ts` *(new)*

**Commit message:**
```
Add reset-wallet script to wipe wallet-scoped data including strategies
```

### 5b. NetworkSelector re-enable

`NavBar.tsx` — re-enabled the mainnet/testnet `<NetworkSelector />` in
the nav bar (was commented out with "testnet not exposed in UI"), and
restored a small testnet banner below the nav so the `isTestnet` variable
at line 32 becomes used again rather than dead code.

**Files:**
- `src/app/NavBar.tsx`

**Commit message:**
```
Re-enable mainnet/testnet NetworkSelector and testnet banner in NavBar
```

### 5c. Intro overlay blur

The intro popup text was blurred because the page uses `html { zoom: 0.9 }`
and this overlay had no counter-zoom. Added `zoom: 1.1111111` on the text
wrapper `<div>`, matching the existing `.booba-tour-popover` pattern in
`globals.css`. Partial fix — does not fully resolve zoom-composition
rounding, but visibly better.

**Files:**
- `src/app/components/onboarding/IntroOverlay.tsx`

**Commit message:**
```
Counter-zoom IntroOverlay text to fix blur under html zoom: 0.9
```

---

## Task 6 — Hybrid signal seed with live-priced open rows

**What it does:** Refactored `seed-signals.ts` so clicking "Check Outcomes"
during a demo actually does visible work. The ~47 pre-resolved historical
signals (driving the caller leaderboard personas: AlphaTrader ~65%,
DegenKing ~53%, SolanaWhale ~38%, ChartMaster ~58%) were kept as hardcoded
fixtures. The 8 `status: 'open'` rows were extracted into `OPEN_TEMPLATES`
with proportional `stopPct` and `tpPcts` instead of literal prices. At
seed time, the script pulls recent 1h candles via `getCandleCache()` for
BTC/ETH/SOL, picks the close nearest each template's `createdDaysAgo`,
adds a small ±0.3% entry jitter, and computes stop/target from the
proportional ratios. Falls back to hardcoded prices if network is
unavailable. The per-caller summary print was updated to count
open-templates separately from resolved fixtures so the totals match
what's in the DB.

**Files:**
- `src/scripts/seed-signals.ts`

**Commit message:**
```
Price open-signal seed rows against live candles so "Check Outcomes" resolves them
```
