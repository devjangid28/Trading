# OrderFlow v2 — Build Progress

**Status: Phases 0–3 complete and verified against live data. Phases 4–11 not started.**

Last verified: 10 Oct 2026, 15:55 UTC from this machine.
Run: `npm install && npm run dev` → http://localhost:5173

---

## Phase status

| Phase | Name | Status | Verified how |
|---|---|---|---|
| **0** | Source probe | ✅ **Complete** | 40 probes run live → `DATA_SOURCES.md` |
| **1** | Live transport | ✅ **Complete** | Both WebSockets delivering; `/api/stream` SSE live |
| **2** | Derivatives | ✅ **Complete** | 53 perps, cross-venue verified live |
| **3** | Multi-timeframe | ✅ **Complete** | 15m/1h/4h fetched, HTF alignment live on rows |
| **4** | Conviction + trade plan | ⚠️ **Engine built, UI pending** | Scoring verified live; no A/B picks surfaced yet |
| **9** | Signal ledger | ❌ Not started | — |
| 5 | Regime, calendar, blackout | 🟡 Partial | Regime field exists and populates; calendar not built |
| 6 | News upgrades | 🟡 Partial | Tier-0 feeds + GDELT + clustering not added |
| 7 | Flows, unlocks, DEX | 🟡 Partial | Stablecoins + Coinbase premium done; ETF flows + unlocks blocked/manual |
| 8 | India layer | 🟡 Partial | CoinDCX INR premium live; tax calculator built, not wired to UI |
| 10 | UI | ❌ Not started | Existing tabs still render v1 shape |
| 11 | Alerts | ❌ Not started | — |

---

## Phase 0 — the probe changed the plan

`npm run probe` → **40 probes, 34 OK**.

### Binance futures is NOT blocked — the biggest open risk cleared

Every futures endpoint works from India, and critically:

```
OK  WS  wss://fstream.binance.com/market/stream   delivered markPriceUpdate in 1036ms
```

The `/market` route question is **answered yes**. An un-routed futures URL connects
successfully and silently delivers nothing, so the routed form is used. Hyperliquid (234
perps) and Bybit are wired as cross-venue comparison rather than as the primary, which is
where they add value.

### Two sources are genuinely unavailable — confirmed, not guessed

| Source | Result | Decision |
|---|---|---|
| DefiLlama `/emissions` | **HTTP 402** (billing wall, Pro tier) | Unlocks → user-editable `unlocks.json`. **Never invented** |
| Farside ETF flows | **HTTP 403**, all paths incl. all-data, custom Referer, text proxy | ETF flows → `Unavailable` with the 403 as the reason |
| SoSoValue | HTTP 403 | same |
| GDELT | HTTP 429 persistent despite 6s spacing | 5s queue still implemented; degrades to the 6 RSS feeds |

### Three failures were my own bad URLs

| Wrong | Right |
|---|---|
| `deribit.com/.../get_index_price?index_name=btc_dvol` | DVOL comes from `get_volatility_index_data` |
| `deribit.com/.../ticker?instrument_name=BTC-DVOL` | DVOL is an index, not an instrument |
| `bls.gov/schedule/news_release/2026_sched.htm` | `bls.gov/schedule/2026/home.htm` |

### CoinDCX shape discovered

`GET /exchange/ticker` returns a **bare JSON array**, not `{status, data}`. Every field is a
string. Markets are `BASEUSDT` with USDT as the INR quote. **The INR premium is computed from
this, not assumed from blog posts.**

---

## Phase 1 — live transport

`server/src/live/` — two sockets feeding one in-memory `MarketState`.

- **Spot:** `wss://data-stream.binance.vision/stream` — `@kline_5m` per symbol + `!miniTicker@arr`
- **Futures:** `wss://fstream.binance.com/market/stream` — `@markPrice@1s` + `!forceOrder@arr`

Implemented:

| Requirement | Status |
|---|---|
| Reconnect with exponential backoff **+ jitter** | ✅ |
| Proactive reconnect at 23h (before the 24h hard drop) | ✅ |
| **REST gap backfill on reconnect** | ✅ — `backfilledCandles` is tracked per connection |
| Ring buffer, 1000 × 5m | ✅ |
| Forming candle held separately from closed | ✅ |
| Setup recompute **only on candle close** | ✅ `ingestKline` returns `true` only when a candle closes |
| `!forceOrder@arr` is a **lower bound** | ✅ labelled `isSample: true` everywhere |
| SSE `/api/stream` | ✅ snapshot → deltas → heartbeat |
| Polling kept as fallback | ✅ |

Health at 69s uptime: `{"cache":{"entries":206,"live":175}}` — the WebSocket path is filling
the ring buffers.

---

## Phase 2 — derivatives

**53 perps live.** Per coin:

- Funding normalised to 8h via `fundingInfo` (intervals differ per symbol — a 4h coin
  otherwise looks twice as extreme as it is)
- Funding label: `NEUTRAL / CROWDED_LONG / CROWDED_SHORT / EXTREME_LONG / EXTREME_SHORT / SQUEEZE_FUEL`,
  with the **"OI rising" flag** separating genuine crowding from longs unwinding
- OI change at 5m/1h/4h/24h in % and USD
- **Price × OI quadrant** — new-longs / short-cover / new-shorts / long-liquidation / flat
- Basis (mark vs index), null when the index looks unreliable
- Long/short account ratio vs top-trader position ratio + divergence
- **CVD and taker ratio from kline index 9** — free, no extra request
- CVD divergence flag (new price high without confirmation)
- Liquidations 5m/1h/24h long vs short + 3σ cascade flag
- Cross-venue: Binance vs Hyperliquid vs Bybit funding/OI with divergence flag

**Live BTC cross-venue read:**

```
binance      fund8h= 0.00000457  oiUsd=7,67,90,90,462
hyperliquid  fund8h= 0.000076456 oiUsd=3,15,67,98,373
bybit        fund8h=-0.00000583  oiUsd=4,64,73,43,642
fundingSpread=0.000082286  divergence=False
```

Options (Deribit BTC+ETH): DVOL, put/call OI ratio, max pain, expiries — implemented, not yet
exposed on a route.

---

## Phase 3 — multi-timeframe

15m/1h/4h klines fetched in parallel with 5m; HTF context computed per setup:

- **Overlay alignment** — 5m zone inside a same-side 1h/4h zone
- **Trend alignment** — pivot structure on 1h and 4h
- **Conflict** — fresh opposite higher-timeframe zone → penalty
- Score adjustment `−10 … +8` wired into conviction

Also built: **retest state machine** (`fresh` / `approaching` / `in-zone` / `retested-held` /
`violated`) — this is where "wait for the first retest" is actually encoded — plus ATR
percentile, realised vol, Bollinger squeeze, and a 24-hour volume profile.

Live row read:

```
LUMIA  retest=in-zone        htf=True
STRK   retest=in-zone        htf=False
WLD    retest=retested-held  htf=False
ADA    retest=in-zone        htf=True
```

---

## Phase 4 — conviction (engine built, UI pending)

`server/src/engine/conviction.ts` — pure function, no I/O.

**Weights, all `[TUNED]` not fitted:** structure 25 · order flow 20 · momentum 15 ·
positioning 15 · news 10 · macro regime 10 · tradability 5.

**Vetoes:** macro blackout · already-moved-14% · hack/depeg/delisting within 6h · unlock
≥2% within 48h · depth/spread below minimum · funding crowded our way **while OI falls**.

**8-point checklist** (OrderBlock ships 4): zone fresh · HTF aligned · VWAP side · sector flow ·
breadth · order flow · positioning · no event veto.

**Live output — and this is the interesting part:**

```
LUMIA  +38.37%  score=49.4  NO TRADE  cl=6/8  NOT_PICKED_VETO
STRK   +19.38%  score=40.5  NO TRADE  cl=6/8  NOT_PICKED_VETO
WLD    +13.73%  score=31.3  Pass      cl=5/8  NOT_PICKED_LOW_GRADE
ZK      +9.86%  score=33.7  Pass      cl=6/8  NOT_PICKED_LOW_GRADE
ADA     +7.38%  score=50.9  C         cl=7/8  NOT_PICKED_LOW_GRADE
picks: 0
```

**Zero A/B picks, and that is the system working correctly.** The two strongest movers had
already run 38% and 19% today, so the event-risk veto fired and the system refused to chase
them. A tool that ranked them first would be telling you to buy the top of a vertical move.

Trade plans carry real numbers with real R:R:

```
LUMIA  entry=0.11075  stop=0.109292  risk/u=0.001458
       R1@0.125 (9.77R)
       costs: fee=10bps slip=5bps total=15bps   netR=8.66
```

And `noRoom`/`rr=0` when there is no liquidity target — no invented multiples.

Also built: Indian tax calculator (30% flat, 1% TDS >₹10k, **no loss offset**, flagged `[?]`
everywhere with editable rates), leverage sanity check, cost model.

---

## Bugs found and fixed in v2

Every one found by running against live data.

| Bug | Symptom | Fix |
|---|---|---|
| REST klines didn't map index 9 | `cvdSlope=0` on every coin | Mapped `takerBuyBase` in `fetchKlines` — CVD is free and was being thrown away |
| CVD in raw base units | `cvdSlope=-88117` on a $0.10 token, meaningless | Normalised to % of window volume so it is comparable across coins |
| Basis annualised | `basis=-941%` on illiquid perps | Stopped annualising; raw % with a null guard when the index is stale |
| CoinDCX shape | Assumed `{status,data}` wrapper | It is a bare array of strings — parsed accordingly |
| Funding not normalised | 4h-interval coins looked 2× as crowded | `normaliseFunding` via `fundingInfo` |
| `basisAnnualised` returned `number` while the guard could return null | Type lie | Type changed to `number \| null` |
| PowerShell rewrites mangled a regex and a template literal | `setHandlers\(h: Handler\)` | Replaced with the Edit tool. **Lesson: stop using PowerShell `-replace` on source files** |

---

## What is NOT built yet

Honest list. Nothing below is stubbed or faked — it simply does not exist.

1. **The UI is still v1.** Tabs `Terminal / News / India / Journal / How it works`. No
   `Derivatives`, `Top 24`, `Flows & Macro`, `Calendar`, `Ledger`, `Alerts`. The new backend
   fields (grade, score, quadrant, CVD, checklist) are computed and served but **not rendered**.
   This is the single biggest gap between the engine and what you can see.
2. **No A/B picks surface in normal conditions.** Grading works, but A requires score ≥75 AND
   ≥7/8 checklist. On a quiet market that is correct; it also means the pick panel is often
   empty. Worth watching over a few sessions before judging the thresholds.
3. **Ledger (Phase 9) not started** — no SQLite, no signal freezing, no outcomes. **The weights
   remain hand-tuned guesses** until this exists. This is the most important missing piece.
4. **No tests.** `vitest` is not installed; there is no `npm run verify`. The acceptance
   criteria in §14 of the spec are unmet.
5. **Regime is a placeholder.** `regime: 'range'`, `sizeAdvice: 'reduced'` are returned but not
   computed from BTC structure, DVOL, breadth, funding or ETF flow.
6. **Calendar/blackout do not fire.** `blackedOut` is always false.
7. **Unlocks/ETF flows** show `Unavailable` with the reason; the user-editable JSON files are not
   created yet.
8. **SSE has no client.** `useLiveStream()` does not exist — the frontend still polls.

---

## Recommended next order

Deliberately **not** the order in the spec's §15, for one reason: building the Derivatives tab
and the ledger next means every day the app runs produces real outcome data, which is the only
thing that makes the weights defensible.

1. **Ledger + SQLite** — `node:sqlite` is built in (verified, no native compile needed). Start
   recording immediately.
2. **UI: Derivatives tab + Terminal columns** (grade, score, flow, position, news dot) — this
   makes Phases 2–4 visible and is the biggest perceived gap.
3. **`useLiveStream()`** — connect the SSE that is already running.
4. **Regime + calendar + blackout** — makes `blackedOut` real.
5. **Tests** — the pure functions in `derivatives.ts`, `conviction.ts`, `timeframes.ts` and
   `tradePlan.ts` are already I/O-free and ready for vitest.
6. Everything else per spec order.

---

## Commands

```bash
npm run dev            # both processes, http://localhost:5173
npm run probe          # re-run the source probe -> server/data/probe-results.json
npm run check:universe # which tracked pairs are live on Binance spot
npm run typecheck      # strict tsc
npm run build          # typecheck + production bundle
```

---

# Update: tests, ledger, derivatives UI

## Tests first (92 passing)

`vitest` + `npm run verify` (typecheck + tests). Fixtures captured from live
responses via `npm run fixtures` -> `server/test/fixtures/`.

| File | Tests | Covers |
|---|---|---|
| `derivatives.test.ts` | 42 | funding 8h normalisation across 1h/4h/8h/12h, CVD USD-notional scaling, basis stale-index rejection, OI x price quadrant, L/S divergence, OI changes |
| `conviction.test.ts` | 30 | every veto individually (macro blackout, event risk, security 6h window, unlock, depth/spread, funding-unwinding), grade thresholds, 8-point checklist |
| `ledger.test.ts` | 20 | stop-first ambiguity, nearest-target crediting, MFE/MAE in R, expiry, pre-signal candle rejection |

### Three real bugs the tests caught

1. **`fundingLabel` mislabelled nearly every coin.** `f <= FUNDING_CROWDED_8H`
   should have been `f <= -FUNDING_CROWDED_8H`. Any funding below +0.03% was
   labelled `CROWDED_SHORT`, which made `fundingCrowdedAgainst` fire on almost
   every bearish setup. Visible in earlier live output as DOT at +0.0001%
   funding showing `CROWDED_SHORT`.
2. **Target crediting ignored whether price actually traded at the level.** A
   candle opening above TP1 and running to TP2 credited TP1. Now the test is
   "is the target inside this candle's range", so gaps credit correctly.
3. **`-0` leaked from MAE.** `Object.is(-0, 0)` is false and JSON keeps the sign.
   Normalised.

Also: the CVD fix you asked for. It was `% of volume` (still base units). It is
now **USD notional** from Binance kline index 10 (taker-buy QUOTE volume)
against index 7 (total quote volume). Live sample:

```
MAGICUSDT  cvd = -196,057 USD
RLCKUSDT   cvd =  -11,309 USD
KAIAUSDT   cvd =  +63,907 USD
```

## Ledger

`server/src/ledger/` — SQLite via `node:sqlite` (built in, no native compile).
Files at `data/orderflow.db`.

- **`resolve.ts`** — pure resolver, split out of `store.ts` specifically so it
  can be tested without dragging `node:sqlite` into the module graph.
- **`store.ts`** — schema, freeze, stats.
- **`worker.ts`** — freezes from each scan, resolves every 5 minutes.

### Shadow signals, as you asked

Recording only A/B would give almost nothing. Recorded:

| Kind | What |
|---|---|
| real | grade A or B |
| shadow | grade C |
| shadow | **every vetoed coin**, with the veto reason stored |

First live run recorded 22 signals, all shadow. The vetoed ones carry their reasons:

```
STRK   NO TRADE  veto = already moved 31.1% today - event risk
LUMIA  NO TRADE  veto = already moved 36.0% today - event risk
WLD    NO TRADE  veto = already moved 11.7% today - event risk
ADA    C         veto = (none)
```

### Replay proof (`npm run verify:ledger`)

Replaying **real 5m candles** through the resolver for LUMIA:

```
outcome   : STOP
R multiple: -1
MFE       : 3.279R
MAE       : -3.676R
```

The coin the veto blocked went **3.28R in favour before stopping out**. One
sample proves nothing — that is exactly why shadow recording exists. But the
mechanism now captures the evidence needed to judge the 14% threshold.

### Stats suppression

With 0 resolved signals:

```
winRate=  avgR=  expectancy=  profitFactor=
message: Only 0 resolved signals. Stats are suppressed below 30 samples -
         a win rate from a handful of trades is noise, not evidence.
```

Nothing is invented to fill the gap.

### Calibration

Six score buckets, all null until each has 30 samples. `isPredictive` stays
null until two buckets populate. When it resolves false, the message goes red:

> RED: higher conviction scores are NOT winning more than lower ones. The score
> is not predictive yet. Do not size off it.

**No weights were touched.** `CONVICTION.WEIGHTS` are unchanged and still
labelled `[TUNED]`.

## Derivatives UI

New `Derivatives` tab: 53 perps, sortable on every column, with the extremes
highlighted, plus a live liquidation tape and a long/short split bar.

Terminal board gained five columns — **Grade**, **Score**, **Flow** (CVD arrow),
**Pos** (quadrant chip), **News** dot — and the popup gained a **Signal** block
with the 8-point checklist and per-component bars.

```
STRK  +31.08%  NO TRADE  54.9  6/8  UP  new-longs     0.0081%
LUMIA +35.99%  NO TRADE  58.5  7/8  DN  new-longs     0.0100%
ADA    +7.04%  B         62.3  7/8  UP  flat          0.0100%
RLC   +13.67%  C         50.6  4/8  DN  short-cover  -0.5934%
```

ADA reached grade B. The vetoed coins still show their scores and checklist,
just greyed by the veto — visible evidence rather than hidden.

## Coinbase premium confirmed

You were right that it works. Fixture captured:

```
coinbase 82,962.02  binance 83,050.92  premium = -0.107%
```

Coinbase trading at a small discount to Binance. Live on the macro strip as
`coinbasePremiumPct`. Note it compares USDT to USD assuming parity; a real
USDT/USD rate would refine it.

## Integration bug fixed

Derivatives were computed but never fed into the scan context, so the Flow and
Pos columns rendered empty and two of seven conviction components silently
scored zero. The board looked fine and was quietly wrong. Now `getScan` builds
its own context via `enrichContext()`.

## Still not built

- Ledger tab UI (the API is ready: `GET /api/ledger`)
- `useLiveStream()` — SSE runs, frontend still polls
- Top 24, Flows & Macro, Calendar, Alerts tabs
- Calendar and blackout mode (`blackedOut` still always false)
- `fit-weights` script (correctly — needs 200+ resolved signals)

## Commands

```bash
npm run verify         # typecheck + 92 tests
npm run fixtures       # re-capture live fixtures
npm run verify:ledger  # replay real candles through the resolver
npm run probe          # re-run the source probe
npm run dev            # http://localhost:5173
```