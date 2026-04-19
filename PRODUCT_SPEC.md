# Booba — Lifecycle Wrapper for Pacifica

## Overview

Booba is a Chrome extension + companion web app that wraps every trade on Pacifica (a Solana-based perp DEX) with intelligence across four phases: **Discover → Enter → Manage → Review**. It is an enhancer, not a destination — it augments Pacifica's existing UX rather than replacing it.

The product has two layers:
- **Universal layer:** Trading journal, behavioral analytics, strategy degradation detection, order management tools. Useful to every Pacifica trader.
- **Unified margin layer:** Liquidation stress tester, utilization monitor, debt inception warning, carry trade calculator, auction sniper. For users on Pacifica's portfolio margin system.

A persistent AI agent (Booba) ties everything together — a character with memory that learns the trader's patterns, surfaces insights, and reacts to account state in real time.

**Hackathon context:** Pacifica hackathon, $15k prize pool, four tracks (Trading Bots, Analytics, Social, DeFi Composability). Deadline: April 16. The team has requested a "booba" project. They have an existing AI Intelligence terminal and MCP server — do not duplicate either.

---

## Architecture

### Decision Gate: Skin vs. Extension
Before committing to architecture, check whether Pacifica has open-sourced their frontend or offers a skinning/theming system. They have expressed interest in "skins." If available, a native fork/skin is dramatically stronger than an extension. If not, proceed with extension architecture below.

### Chrome Extension (Primary)
- **Content script:** Injects overlay components onto Pacifica's trading pages (stress tester panel, utilization monitor widget, debt inception warning modal, Booba floating avatar)
- **Extension popup:** Booba's home. Contains: avatar with reactive state, account vitals (margin ratio, utilization, daily borrow cost), contextual alerts/speech bubble, chat input for natural language interaction, navigation links to web app pages
- **Background script:** Handles Pacifica API polling, alert logic, notification dispatch (Telegram integration for mobile alerts)

### Companion Web App
Separate hosted pages for views that need full-screen space:
- Journal dashboard
- Trades table
- Analytics deep-dive
- Auction feed
- Caller/source leaderboard

Opened from extension popup links. Share the same backend and authentication.

### Backend
- **Database:** Trade history, thesis entries, strategy definitions, Booba's observation store, user preferences
- **API layer:** Ingests from Pacifica API, computes analytics, serves to extension and web app
- **Periodic jobs:** Regime computation, behavioral analysis, Booba memory compression, novel pattern detection via Claude API

### Authentication
Wallet-based (Solana wallet connect). No separate account creation.

### Builder Code
Attached only to trades the extension actively manages (candle-close stop triggers, auction sniper entries, carry trade entries routed through the app). Never silently injected into native Pacifica trades. Transparent onboarding screen explains this to the user.

---

## Four-Phase Lifecycle

### Phase 1: Discover
Surfaces opportunities before the user decides to trade.

**Auction sniper feed:**
- Live/recent liquidation auctions on Pacifica
- Per auction: asset, size, current best bid, true discount vs. VWAP (not just mark price), cascade risk indicator (isolated vs. chain — derived from OI drop + CVD + multiple auctions firing simultaneously)
- Historical auction analytics: what discounts have past auctions cleared at, by asset, by market condition
- Post-acquisition decision tree (see Phase 2)

**Carry trade scanner:**
- Markets ranked by net yield: funding rate received - borrow interest at current utilization - entry/exit fees - slippage
- Uses actual account state (collateral composition, LTV) for leverage-adjusted yield
- Break-even holding period
- Stressed yield at higher utilization levels

**Funding harvester:**
- Markets where user would receive funding as the underweight side
- Cross-sectional funding rate ranking

### Phase 2: Enter
Triggers immediately after order execution on Pacifica. Extension detects the trade and presents a popup.

**Post-execution popup contains:**
- **Stop type selector:** Candle-close, trailing stop, partial TP ladder, fixed stop. Sets up conditional follow-up orders via API.
- **Thesis input:** One-line text field (or voice → Claude parses to structured fields). Optional — the trade is journaled regardless.
- **Strategy tag:** Dropdown of user's saved strategies, or "new strategy"
- **Source tag:** Manual, Caller name, Allora, auction acquisition
- **Invalidation price:** Simple price level (automatable tracking). For structural invalidation (e.g., trendline), captured in thesis text and evaluated by Claude retrospectively.
- **Target price(s):** Optional
- **Conviction:** Optional 1-3 scale

**Debt inception warning** (if trade triggers auto-borrowing):
- Amount to be borrowed
- Current cost at current utilization
- Stressed cost at higher utilization
- New margin ratio after trade
- Approve / cancel

**Post-auction-acquisition decision tree** (if trade came from auction sniper):
- Market sell immediately → projected profit after fees
- Deposit as collateral → new margin ratio, new borrowing capacity
- Enter carry trade → projected net yield using discounted entry
- Hold as spot → break-even price

**Position sizing suggestion** (optional/advanced):
- Fractional Kelly based on user's historical win rate for this strategy in current regime
- Allora confidence interval as input if available

### Phase 3: Manage
Ongoing monitoring while positions are open.

**Injected into Pacifica UI (extension overlay):**
- Margin health gauge (green/yellow/red, animates with price changes)
- Utilization rate with personal cost and trend sparkline
- Booba avatar with reactive state tied to worst-of vitals

**Stress tester (slide-out panel):**
- Lists all current positions and collateral
- Sliders to adjust hypothetical price moves per asset
- Live-updating margin ratio, liquidation distance
- One-click "everything drops 25%" scenario
- Booba reacts as you drag sliders

**Active monitoring (background):**
- Utilization rate approaching cliff (75%+ warning, 80%+ alert)
- Carry trade yield turning negative after borrow costs
- Candle-close stop conditions being evaluated
- Trailing stop updates
- Tilt detection: N losses in X minutes → soft friction warning
- Oversize detection: position larger than historical average

**Booba contextual alerts (speech bubble):**
- "Utilization up 8% in the last hour"
- "Your carry on SOL-PERP is net negative after borrow costs at current utilization"
- "You've taken 3 trades in 40 minutes — last time this happened you lost $380"
- One alert at a time, auto-dismiss, newest wins

### Phase 4: Review
Post-trade analysis and long-term pattern recognition.

**Auto-captured per trade (zero user input):**
- Asset, direction, size, entry price, exit price, timestamps
- P&L (realized)
- Fees paid
- Funding received / paid during hold
- Hold time
- MFE (max favorable excursion) and MAE (max adverse excursion)
- Regime at entry (see Regime Detection section)
- Margin ratio at entry
- Utilization rate at entry
- Builder code (if routed through external builder)
- Subaccount

**User-input captured (from Phase 2 popup):**
- Thesis text
- Strategy tag
- Source / caller tag
- Trade type (directional, carry, delta-neutral, market making, liquidation acquisition)
- Invalidation price
- Target price(s)
- Stop type used
- Conviction level

**Scaling in/out model:**
- Each partial fill is a separate journal entry
- Linked by parent group ID
- Thesis and strategy live on the group, not individual fills
- Group shows aggregate stats; individual fills show per-entry stats
- Enables analysis: "first entries profitable 70% of the time, scale-ins only 40%"

---

## Analytics

All metrics are established, standard trading analytics. No custom inventions. The differentiator is automatic computation, regime-conditional slicing, and Pacifica-native dimensions.

### Core Performance
- Equity curve (cumulative P&L over time, toggleable overlays by strategy/regime/source)
- Win rate, average winner vs. average loser
- Profit factor (gross wins / gross losses)
- Expectancy (average $ per trade)
- R-multiple distribution
- Sharpe ratio, Sortino ratio, Calmar ratio — per strategy, per regime

### Exit Analysis
- MFE/MAE per trade and aggregate per strategy
- Exit efficiency (actual exit vs. optimal exit based on price action)
- "Money left on the table" quantification
- Stop analysis: too tight (stopped out before thesis played out), too wide (excess MAE on winners)

### Time Analysis
- P&L by hour of day, day of week, month
- Hold time: winners vs. losers (disposition effect detection)
- Session analysis (Asian / European / US hours)
- Streak analysis

### Behavioral Detection (hardcoded)
- Disposition effect: hold time ratio winners vs. losers
- Revenge trading: performance on trades entered within N minutes of a loss
- Size escalation after losses: average position size after loss vs. after win
- Overtrading: trade count per session correlated with session P&L
- Tilt: consecutive losses followed by larger-than-average position
- Rule adherence: did user follow stated invalidation price, stop level, target

### Statistical (leveraging math/stats background)
- Return autocorrelation (are wins/losses clustered or independent?)
- Distribution analysis: histogram with normality overlay, skew, kurtosis
- Monte Carlo simulation: probability of X% drawdown over next N trades, probability of ruin at current sizing
- Kelly criterion sizing from actual data: per strategy, per regime
- Covariance of concurrent positions: correlation-adjusted portfolio exposure

### Strategy Analysis
- Side-by-side strategy comparison table
- Each strategy's stats sliced by regime (THE key differentiator)
- Strategy degradation: rolling win rate / expectancy vs. historical baseline, flagged at 2 standard deviations
- Thesis accuracy: directional outcome independent of P&L

### Pacifica-Native Dimensions
- Funding P&L attribution: how much of profit is directional vs. funding
- Carry trade metrics: actual yield vs. projected, hold time vs. optimal, borrow cost impact
- Utilization cost impact per trade lifetime
- Auction acquisition outcomes: discount captured, path chosen, result
- Caller/source leaderboard with per-caller equity curve and regime-conditional stats
- Subaccount breakdown
- Builder code filtering (e.g., isolate Treadfi market-making P&L)

### Libraries
- `quantstats` — Sharpe, Sortino, drawdown, equity curves, most standard metrics
- `scipy.stats` — autocorrelation, normality tests, skew, kurtosis
- `pandas-ta` or `ta-lib` — ADX, ATR for regime detection
- `numpy` — Monte Carlo simulation, Kelly computation
- `hmmlearn` — Hidden Markov Model regime detection (post-hackathon upgrade)

---

## Regime Detection

### Hackathon Implementation
- ADX + ATR on BTC daily candles as market proxy
- ADX > 25 = trending, ADX < 20 = ranging, 20-25 = transitional
- ATR relative to its 20-period moving average: above = high volatility, below = low volatility
- Four regimes: trending/low-vol, trending/high-vol, ranging/low-vol, ranging/high-vol
- Every trade tagged with regime at entry time
- Acknowledged limitation: BTC proxy breaks for alts that diverge. Defensible for hackathon, improve later.

### Post-Hackathon Upgrades
- Per-asset regime computation
- Funding rate momentum as third input
- Hidden Markov Model for statistically-derived regimes
- Multiple timeframe regime (daily for swing, hourly for intraday, auto-selected by hold time)

---

## Booba — AI Agent

### Character
- Visual avatar with 5 states: calm (margin > 150%), alert (120-150%), nervous (100-120%), panicking (< 100%), money mode (profitable carry / fat auction discount)
- Special states: pouting/sad when user hides her ("fine, I'll watch your margin ratio from over here..."), excited when brought back
- Speech bubble for one-line contextual observations, auto-dismiss after 10 seconds
- Lives in extension popup permanently, floats on Pacifica page as dismissible overlay

### Chat Interface
Scoped assistant, not general chatbot. Can:
- Explain user's own data ("why is my margin ratio dropping?")
- Run calculations ("what's my net yield on SOL carry right now?")
- Parse natural language orders ("set candle-close stop on SOL at 140") into structured actions requiring confirmation
- Explain features ("how does the stress tester work?")

Implementation: Claude API call with system prompt containing current account state summary + Booba's observation history + tool schema matching app functions.

### Memory Architecture

**Layer 1 — Raw data:**
All trades, metrics, price data in database. Never sent to Claude directly.

**Layer 2 — Computed summaries:**
End-of-day and end-of-week automated analytics runs produce structured summaries. ~500 tokens each. Example: "This week: 14 trades, 57% win rate, Sharpe 1.2, trending regime Mon-Wed, ranging Thu-Fri. Disposition effect score worsened. Average hold time on losers increased 40%."

**Layer 3 — Booba's observations:**
After Layer 2 summaries are computed, Claude receives: previous observations + new summary → produces updated observations. Stored as text.

**Compression policy:**
Every 4 weeks, Claude consolidates all observations. Retention rules:
- Observations confirmed more than once → always retained
- Single-occurrence observations older than 4 weeks → compressed or dropped
- Risk behavior warnings → never deleted
- Target: observation store stays under ~2000 tokens

**Novel pattern detection:**
Periodic targeted data slices sent to Claude. Rotating queries like:
- "All trades where thesis was directionally correct but P&L was negative — what do they have in common?"
- "Compare first trades of each session vs. fourth-or-later trades"
- "All SOL trades in ranging regimes — any patterns?"

These produce insights that could never be hardcoded. This is the most compelling use of AI in the architecture — lead with it in the pitch.

### Context Window Per Claude Call
- System prompt (~500 tokens)
- Booba's compressed observations (~1000-2000 tokens)
- Current day/week summary (~500 tokens)
- User's current question or analysis prompt
- Total: well under 8k tokens per call

---

## UI Structure

### Extension Popup
- Booba avatar (120x120) at top
- Vitals bar: margin ratio, utilization rate, daily borrow cost
- Current alert / speech bubble from Booba
- Chat input field
- Nav links: Journal, Analytics, Auctions, Settings

### Pacifica Page Overlays (injected by extension)
- Booba floating avatar (bottom right, dismissible)
- Margin health gauge (small, persistent)
- Stress tester (slide-out panel from right edge)
- Debt inception warning (modal, triggered by order detection)
- Post-execution popup (modal, triggered by trade detection)

### Web App — Dashboard (home page)
- Top bar: total P&L toggleable (all time / this week / today), win rate, expectancy, streak
- Equity curve with regime-overlay toggles (filter by strategy, source, regime)
- 2-3 insight cards from Booba (behavioral detections + novel observations)
- Quick stats per active strategy

### Web App — Trades Table
- Filterable, sortable list
- Columns: asset, direction, P&L, fees, funding, hold time, regime tag (colored dot), strategy, source
- Expandable rows: thesis, invalidation, targets, MFE/MAE, mini chart with entry/exit marked, post-mortem
- Filter by any dimension: strategy, regime, source, trade type, subaccount, date range

### Web App — Analytics
- Strategy comparison table (side by side, sliced by regime)
- Behavioral metrics panel
- Distribution histogram
- Time-of-day heatmap
- MFE/MAE scatter plot
- Monte Carlo drawdown probability chart
- Kelly sizing recommendations per strategy per regime

### Web App — Calendar
- Daily P&L heatmap (green/red squares)
- Tap day to see trades
- Secondary navigation view, not home page

### Web App — Caller Leaderboard (Social Track)
- Ranked by P&L, win rate, regime-conditional stats
- Per-caller mini equity curve
- "Which alpha callers actually have edge, proven by your own trade history"
- Potentially viral within CT — genuinely novel feature

### Visual Identity
- Dark theme (deep navy/dark purple, not cold gray)
- Booba's personality adds warmth to data-heavy UI
- Insight cards styled as messages from Booba, not sterile alert boxes
- Minimal, scannable — not Bloomberg terminal density

---

## Onboarding Flow

Critical for demo. Three steps:
1. **Connect wallet** — Solana wallet connect
2. **Auto-import** — pull all available historical trades from Pacifica API, compute initial stats and regime tags
3. **Meet Booba** — avatar introduces herself, shows first insight from imported data, brief tour of key features

If no trade history exists, Booba explains what she'll do once trades start happening. Demo should use an account with existing history.

---

## Build Priority (Hackathon)

1. **Journal auto-ingestion + regime tagging + equity curve + one behavioral insight (disposition effect)** — this is the backbone, everything else depends on it
2. **Unified margin suite** — stress tester + utilization monitor + debt inception warning + carry calculator. Note: unified margin may be testnet-only. Build robust but have fallback if endpoints are unstable during demo.
3. **Booba avatar** — reactive states tied to account health, speech bubble alerts. High demo memorability for low build cost.
4. **Auction sniper** — with true discount calculation and post-acquisition decision tree. Strongest Pacifica-native differentiator. Demo risk: depends on auctions existing. Mitigate with historical replay.
5. **Post-execution popup** — thesis entry, stop type, strategy/source tagging. Connects enter phase to review phase.
6. **Order management** — candle-close stops, trailing stops. If time permits.
7. **Booba chat + memory** — if time permits. Can fake with pre-populated observations for demo.
8. **Caller leaderboard** — if time permits. Strong social track entry.

### Scoping Warning
This is ambitious for 10 days even with AI coding assistance. A polished journal + one unified margin feature + Booba with reactive states is a stronger submission than a half-built version of everything. Be ruthless about scope as you build.

---

## MCP Exposure (Post-Hackathon or Stretch Goal)

Expose journal data as an MCP server so other Pacifica ecosystem tools can query:
- User's behavioral stats
- Regime-conditional performance
- Trade history with tags
- Strategy performance rankings

Low build cost, strong ecosystem composability signal for judges.

---

## Technical Notes

- **Pacifica API:** Primary data source for trades, positions, margin state, funding rates, auction data. Verify endpoint availability and rate limits early.
- **Claude API:** Powers Booba chat, thesis parsing, novel pattern detection, post-mortem generation, memory compression. Use claude-sonnet-4-20250514 for cost efficiency on frequent calls.
- **TradingView:** Cannot read user drawings/indicators from embedded TV chart. Workaround for structural thesis evaluation: screenshot → Claude vision API for retrospective analysis. Not a hackathon priority.
- **Solana/on-chain:** Wallet connect for auth. Builder code attached at transaction level.
- **Frontend:** React + Tailwind. Use v0 for rapid UI scaffolding, Claude Code for logic and backend.
- **Extension:** Manifest V3. Content script for page injection, popup for Booba home, background script for API polling and alerts.

---

## Pitch Structure (5 minutes)

1. **Problem** (30s): Traders on Pacifica have no persistent intelligence layer. Trades happen and disappear. No memory, no behavioral feedback, no unified margin visibility.
2. **Solution** (30s): Booba wraps every trade with intelligence across four phases — discover, enter, manage, review. Enhances Pacifica, doesn't replace it.
3. **Demo — Journal** (90s): Show auto-imported trades, regime tags, equity curve filtered by regime. Show one behavioral insight. "You hold losers 3x longer than winners, but only in ranging markets."
4. **Demo — Unified Margin** (60s): Stress tester with sliders, Booba reacting. Utilization monitor with cost projection. Debt inception warning before a trade.
5. **Demo — Auction Sniper** (45s): Show a real/historical auction, true discount, post-acquisition carry trade yield projection.
6. **Demo — Booba Memory** (30s): Show an observation from Booba that references something from a week ago. "Last time utilization spiked like this, you paid $47 extra."
7. **Monetization + Roadmap** (15s): Builder code on managed trades. MCP exposure. Per-asset regime detection. Caller leaderboard going viral on CT.
