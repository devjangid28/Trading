# OrderFlow

A live **order block, liquidity and news-impact terminal** for crypto and the Indian market.

It is a from-scratch rebuild of the OrderBlock concept (Indian F&O screener) re-targeted at
crypto, with three things the original does not have: a **news impact engine**, **macro /
on-chain context**, and **move attribution** that tells you what actually moved an asset.

Everything runs on **free, no-key public data**. There is nothing to sign up for.

---

## Quick start

```bash
npm install
npm run dev
```

Then open **http://localhost:5173**.

That runs two processes:

| Process | Port | What it does |
|---|---|---|
| `vite` | 5173 | React frontend, proxies `/api` to the engine |
| `tsx watch server/src/index.ts` | 8787 | The scan engine and all data fetching |

First scan takes ~30–60 s because it pulls 5-minute candles for every tracked pair. The page
renders as soon as it lands and then refreshes every minute.

For a production build:

```bash
npm run build     # typechecks, then builds to dist/
npm start         # single server on :8787 serving both API and UI
```

Optional (not needed): copy `.env.example` to `.env` and add a free CoinGecko demo key to raise
the rate limit from ~30/min to 100/min.

---

## What it does

### 1. One-directional strength board

Every tracked pair is scored on **one-directional strength**, not on raw size of move:

```
strength = |net move %| × efficiency      where  efficiency = |net move %| / day range %
```

A coin that ran 9% and gave it all back has a huge range and near-zero efficiency, so it scores
**zero and never reaches the board**. That is the whole point — it removes the "big but finished"
movers that clutter an intraday screener.

Percentiles are read across the whole board, and the **bearish side is inverted**, so the strongest
bearish name reads near the top of its own list exactly like the strongest bullish one.

### 2. Order block detection

Runs on **closed 5-minute candles only**, so a zone never repaints from a candle still forming.

A valid order block requires all of:

- the last **opposite-coloured** candle before a structural break
- that break must be a **close** beyond the prior swing high (bullish) or low (bearish)
- the move away must be **forceful** — either it left a **fair-value gap**, or it travelled at
  least one average candle range
- **no later 5-minute close** may have gone through the zone

### 3. The level ladder

| Label | Meaning |
|---|---|
| `OB` | The order block candle's low–high |
| `Z` | Zone level — the midpoint, and the price the whole setup is built around |
| `S1` / `R1` | Where the idea is **wrong**: below for bullish, above for bearish |
| `R1`, `R2` | Liquidity ahead — swing highs price has not returned to, biased to **equal highs/lows** where stop orders pile up |
| amber dotted | Levels price already met on the way (swing points, day's high/low) |
| yellow dashed | Session **VWAP** |

`R:R` compares the room from `Z` to the second liquidity level against the risk from `Z` to
invalidation. If there is no liquidity in range, it reports `—` rather than inventing a number.

### 4. Picks, not tips

Three picks per side, with **no more than two from any one sector**, so a single sector's news
cannot fill the whole shortlist. A coin with an unusually large one-day move is flagged
**event risk** and gets no levels at all. Every row tells you *why* it was or was not picked.

### 5. News impact scoring

Headlines from six RSS feeds are scored on a 0–100 **News Impact Score**:

```
NIS = (severity + relevance + max(0, sentiment) + source tier + urgency)
      × novelty × corroboration × confidence × recency-decay × macro-multiplier
```

Some deliberate choices:

- **Only the positive part of sentiment feeds the score.** A strongly negative story still has
  *high impact* — that is exactly the story you most need to see. Direction carries the sign.
- **Negation is handled.** "Not approved" flips the polarity of "approved".
- **Headline terms count ~10× body terms**, and relevance is measured by *how early* the asset is
  named in the headline (a cheap RavenPack-style position proxy).
- **Routine commentary is demoted.** "BTC holds $82K" describes price that already happened and
  must not outrank an actual catalyst.
- **Recency decay has a per-class half-life** — 45 min for a hack, 4 h for a macro print.
- **Novelty multiplies but never gates.** RavenPack's own finding is that aggressive novelty
  filters destroy information ratio, so the floor is 1.0.

### 6. Attribution — what moved what

```
abnormal return = raw move − (rolling β × BTC move)
```

Attribution only runs when the move clears a **2.5σ gate** with confirming volume. Headlines are
weighted by `NIS × recency × asset-relevance` and distributed across the move. Coverage bands:

| Coverage | Band |
|---|---|
| ≥ 65% | Driven by news |
| 35–65% | Partially attributed |
| < 35% | No clear driver — flow, order flow or liquidations |

A low number is not a failure. It is information.

Scheduled macro items also carry a **reversal-risk flag**, because FOMC reactions historically
reverse over the following four hours even as equities do not.

### 7. Indian market

The **same engine** runs over liquid NSE F&O stocks. NSE indices, live session state and the
official holiday calendar come from NSE's keyless endpoints.

### 8. The Engine Lab

A dedicated tab where the engine is **tested, trained and supervised**: observe → decide →
execute in paper or Binance **testnet** → review every outcome → retrain in controlled batches →
promote only if a challenger beats the champion out-of-sample.

It reports what the evidence supports, not what would look good. A confidence tier below the
sample floor quotes **no hit rate** and says how many trades it has and what the floor is; the
calibration panel shows the Brier score **against the constant base rate**; and the promotion block
lists, in words, everything that is still missing — including the operator's manual approval, which
is always required because **the engine cannot promote itself**.

**Real-money execution is not built.** The modes are SHADOW, PAPER and TESTNET. There is no live
adapter, no key handling and no configuration that turns one on.

TradingView is used for **viewing only**. Its paper-trading account is a manual UI simulator with
no public order-placement API, so the Lab exposes an outbound alert-style JSON message to paste
into a TradingView alert or a chart note. Nothing is sent anywhere by this app.

### 9. Crypto chart terminal

The **Charts** tab is a live Binance spot chart workspace, separate from the scanner and the
heatmap:

- **Feed:** Binance REST klines and ticker plus a combined kline/trade/bookTicker WebSocket. The
  chart talks to Binance directly, so it is independent of the server's `MOCK` mode and the global
  `MOCK` badge does not describe the chart feed.
- **Timeframes:** `1m | 5m | 15m | 30m | 1h | 4h | 1D`; 1,500 bars retained, closed candles only.
- **Views:** Candles, Heikin Ashi, Line and Area; linear, logarithmic and percentage scales.
- **Indicators:** EMA, SMA, RSI, MACD, Bollinger Bands, Volume and VWAP. Main-pane overlays and
  separate RSI/MACD/Volume panes.
- **Drawings:** trend line, horizontal ray, horizontal line, rectangle, Fibonacci retracement,
  long position, short position and text note, plus a clear-all action.
- **Context:** London and New York session bands, visible-range volume/delta/CVD/POC, crosshair
  OHLC readout, live price flash, bid/ask/spread, feed latency and REST timestamp.
- **Persistence:** chart settings survive reload under `of-charts-settings-v1`; the selected
  symbol survives under `of-terminal-symbol`.

If Binance is geo-blocked, the chart shows a feed error while the rest of the app can keep using
the server's configured source. The data layer exposes a `MarketDataSource` interface so another
venue can be substituted in `src/lib/binance.ts`.

---

## API

| Endpoint | Returns |
|---|---|
| `GET /api/scan` | Both boards, sector flow, market picture, breadth |
| `GET /api/stream` | SSE: `snapshot`, `tick`, `scan` (accepts `?cid=` and `?symbols=`) |
| `POST /api/stream/visible` | Narrows one client's tick subscription to the symbols it renders |
| `GET /api/search?q=` | Tracked universe search with live price, change and age attached |
| `GET /api/asset/:id` | Candles + setup for `BTC`, `BTCUSDT` or `RELIANCE` |
| `GET /api/news` | Scored news feed with severity buckets |
| `GET /api/attribution` | Attribution for every coin currently on the board |
| `GET /api/attribution/:id?horizon=60` | Single-asset attribution |
| `GET /api/macro` | Fear & Greed, stablecoin float, dominance, India gauges |
| `GET /api/india` | NSE indices, session state, holidays, F&O strength board |
| `GET /api/health` | Liveness, IST clock, cache stats |
| `GET /api/lab/overview` | The whole Engine Lab page: status, decisions, account, reviews, learning, calibration |
| `GET /api/lab/status` | Mode, model version, drift monitor, kill switch, daily-loss halt |
| `GET /api/lab/decisions` | What the engine is considering right now, with P(win) and its interval |
| `GET /api/lab/account` | Equity curve, open positions, fills with modelled costs labelled |
| `GET /api/lab/reviews` | Every resolved trade with its failure classification and the reason |
| `GET /api/lab/learning` | Model versions, walk-forward folds, promotions, rejections, rollbacks |
| `GET /api/lab/calibration` | Reliability, confidence tiers with Wilson intervals, Brier, log loss |
| `GET /api/lab/alert-message` | The optional outbound TradingView-style JSON to paste |
| `POST /api/lab/controls` | Start/stop, kill switch, shadow-only, mode, rollback, retrain |


---

## Data sources — all free, none keyed

| Data | Source |
|---|---|
| Crypto OHLCV + tickers | Binance public REST (`data-api.binance.vision`) |
| Crypto chart OHLCV + live feed | Binance public REST (`api.binance.com`) and WebSocket (`stream.binance.com:9443`) |
| Indian equities | Yahoo Finance chart API |
| Indian indices, session, holidays | NSE `allIndices`, `marketStatus`, `holiday-master` |
| Market cap, dominance | CoinGecko |
| Fear & Greed | alternative.me |
| Stablecoin float | DefiLlama |
| News | CoinDesk, Cointelegraph, Decrypt, Bitcoin Magazine, Bitcoin.com, CryptoSlate |

**No broker login, no API key, no paid plan.** The one thing with no free source is a live NSE
option chain — NSE licenses that commercially and blocks it to non-browser clients. It is
deliberately not attempted here rather than faked.

---

## Known limits

- **The universe is hand-maintained** (~56 pairs with real liquidity) rather than all ~2,400
  Binance pairs. Scanning every micro-cap would be dominated by names too thin to trade.
- **Binance / Bybit / Coinbase / Kraken** are supported at the data layer; only Binance is wired
  into the scanner. OKX is unreachable from Indian IPs and is not used.
- **Novelty is computed within the current feed window**, not against a 365-day history, so it
  resets when a story scrolls out of the RSS feeds.
- **Attribution betas are fitted on ~8 hours of 5-minute returns**, not a 90-day window. Enough
  to be directionally right, not enough to be a published study.
- News scoring is hand-tuned. It is defensible, but it is not calibrated against labelled
  outcomes yet.
- **The chart feed is direct from Binance and may be geo-blocked.** It bypasses the server's
  `MOCK` fixture path, so in MOCK mode the chart can still be live. Swap `MarketDataSource` in
  `src/lib/binance.ts` if the venue is unreachable.
- **The chart is not a Tradfye pixel/animation clone.** The reference terminal is behind a
  private-beta access code; the layout and behaviour follow the written specification.
- **The chart bundle is large.** klinecharts plus the chart workspace push the production JS chunk
  to `719.88 kB` (`211.41 kB` gzip), above Vite's 500 kB warning. No code-splitting yet.

---

## Running it always-on (the signal ledger needs uptime)

The ledger only records while the app is running. A server that is stopped records nothing, so the
supervised launcher is the supported way to run it between CPI, FOMC and PCE prints.

```bash
npm run start:forever
```

That runs `server/scripts/supervisor.ts`, which restarts the server on exit with crash-loop
backoff (a run that dies in under 60s doubles the wait, capped at 5 minutes), rotates
`data/logs/orderflow.log` at 5MB keeping 5 files, and takes a single-instance lock at
`data/orderflow.lock`.

**A second launch refuses to start** and names the process holding the lock:

```
REFUSING TO START — another OrderFlow instance is already running.
another OrderFlow instance is already running: PID 9700 on 127.0.0.1:8787 (orderflow-api),
started 2026-10-11T14:51:46.990Z, up 2m23s. Two servers would double the Binance request
weight, which is how the original 418 happened.
```

### Start on login (Windows, Task Scheduler)

Run PowerShell as your normal user. Task Scheduler is the Windows-native answer to "start on
login unattended"; pm2 was rejected because its Windows daemon/`startup` flow is the fragile part
and it would be a machine-wide install the repo does not carry.

```powershell
$repo = 'C:\Users\DK\Desktop\trading'
$action = New-ScheduledTaskAction `
  -Execute 'cmd.exe' `
  -Argument "/c cd /d `"$repo`" && npm run start:forever >> `"$repo\data\logs\task.log`" 2>&1" `
  -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::MaxValue)
Register-ScheduledTask -TaskName 'OrderFlow' -Action $action -Trigger $trigger -Settings $settings `
  -Description 'OrderFlow always-on signal ledger' -RunLevel Limited
Start-ScheduledTask -TaskName 'OrderFlow'
```

To remove it: `Unregister-ScheduledTask -TaskName 'OrderFlow' -Confirm:$false`.

On Linux/macOS use the same wrapper under systemd or `pm2 startup`; nothing in the supervisor is
Windows-specific.

### After downtime

Sleep, crash and event-loop stalls are detected and recorded as gaps in the `gaps` table, then
backfilled. `GET /api/health` reports what that cost:

- `supervision.gaps7d` — gap count and total minutes over 7 days
- `supervision.downtimeMinutes7d` — recorded process-level downtime
- `supervision.restarts24h` — launches in the trailing 24 hours
- `supervision.coverage` — **read this before quoting any win rate.** It states the real sample
  coverage: signals that already existed and hit a level during the hole are recovered by
  backfill, but signals that would have been *created* during the hole (A/B picks, grade-C
  shadows, vetoed coins) have no row to recover and are permanently absent.

---

## Risk disclosure

OrderFlow is a market analytics and education project. Nothing it displays is investment advice
or a recommendation to buy or sell any asset. Trading crypto derivatives and Indian F&O carries a
substantial risk of loss. Past performance means nothing.
