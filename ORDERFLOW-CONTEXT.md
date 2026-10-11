# OrderFlow — Complete Context Window

> A full record of what was researched, what was built, why each decision was made, and how to run,
> test, extend or replace any part of it.
>
> Written: 10 October 2026 · Project root: `C:\Users\DK\Desktop\trading`
> Stack: React 18 + Vite 6 + TypeScript 5.7 + Tailwind 4 (frontend) · Express 4 + tsx (engine)

---

## Table of contents

1. [The original brief](#1-the-original-brief)
2. [Research phase — what OrderBlock actually does](#2-research-phase--what-orderblock-actually-does)
3. [Research phase — free data sources](#3-research-phase--free-data-sources)
4. [Research phase — news impact methodology](#4-research-phase--news-impact-methodology)
5. [What I built — architecture](#5-what-i-built--architecture)
6. [File-by-file manifest](#6-file-by-file-manifest)
7. [The engine, explained line by line](#7-the-engine-explained-line-by-line)
8. [The news engine, explained](#8-the-news-engine-explained)
9. [The frontend, explained](#9-the-frontend-explained)
10. [API reference](#10-api-reference)
11. [How to run and test](#11-how-to-run-and-test)
12. [Bugs found and fixed during the build](#12-bugs-found-and-fixed-during-the-build)
13. [Known limits and honest gaps](#13-known-limits-and-honest-gaps)
14. [Extension guide — where to change what](#14-extension-guide--where-to-change-what)
15. [Decision log](#15-decision-log)

---

## 1. The original brief

> *"Go to https://order-block.com/app, read it in depth, I want to clone this but for crypto and
> the Indian market, focus mostly on crypto. Search what that website does and everything I must
> do related to crypto and the Indian market. Search everywhere and make sure I can find each and
> everything about the crypto market — the news, its impact on crypto, and all the major stuff
> that can change the market. Make the same thing using React or Vite so I can test it."*

Four requirements decomposed:

| # | Requirement | How it was met |
|---|---|---|
| 1 | Clone OrderBlock | Reverse-engineered from 6 blog posts + changelog (the `/app` terminal is login-gated) |
| 2 | Crypto + Indian market, crypto-focused | Crypto terminal is primary; Indian F&O runs on the same engine |
| 3 | News and its impact on crypto | Full news impact scoring engine + move attribution |
| 4 | React/Vite, testable | `npm run dev` → one command, two processes |

---

## 2. Research phase — what OrderBlock actually does

### 2.1 The gate

`https://order-block.com/app` returns only a login screen (Google OAuth or WhatsApp OTP). The actual
terminal could not be seen. **The product was reconstructed from public writing instead:**

| Source | What it revealed |
|---|---|
| `/blog/what-is-an-order-block` | OB definition, FVG-vs-OB, supply/demand comparison, why by-hand is hopeless |
| `/blog/read-order-block-popup` | **The exact row anatomy** — RANK, RULE, OB, Z, S1, R1, R2, R:R, VWAP |
| `/blog/read-the-market-breadth-sectors` | Market picture, breadth counts, sector flow, the 4-point alignment check |
| `/blog/orderblock-daily-playbook` | The 5-step daily routine the UI is laid out around |
| `/blog/wait-for-the-zone-first-retest` | Zone ageing, discipline |
| `/blog/consistency-sizing-rr-journal` | Sizing, R:R, journal loop |
| `/updates` | Full changelog v1.0 → v2.9 — every feature that exists |
| `/` (landing) | Product pitch, pricing model, FAQ with operational detail |

### 2.2 The reconstructed product spec

**The funnel:** 200+ stocks → 40 contenders → 6 picks → 1 zone.

**Core concept — one-directional strength.** Not "biggest mover" but *cleanest* mover. Their own
words: *"A stock that ran up and came straight back down doesn't make the list, however big its
range."* Choppy stocks score zero *"so they don't clutter your board."*

**Order block rules, as published:**
- the last red candle before a strong rise (bullish) / last green before a strong fall (bearish)
- the move must **close** beyond a recent swing high or low — *"Without that break, it is just
  another red candle"*
- the move away must be forceful — they state it counts *"if it leaves a gap, or closes beyond the
  block by at least the size of an average candle"*
- no later 5-minute close may have passed through the zone
- only **closed** 5-minute candles are read, so a zone never repaints from a live candle

**The ladder** (from the popup anatomy post):
- `Z` — the zone level, the price the setup is built around
- `S1` — *"just beyond the far side of the block… If price settles below it, the demand that
  defended the block has gone and the setup no longer holds"* (bullish; `R1` on bearish)
- `R1`, `R2` — next resistance in the direction of the move, *"placed at liquidity whenever there
  is some in range"*
- `R:R` — room from Z to the second level vs risk from Z to invalidation
- `VWAP` — *"Bullish setups above VWAP and bearish setups below it have the average participant on
  their side"*
- `p99.8 · #1/130` — percentile across the **whole board**, with bearish read from the other end
- `RULE` — why a stock is or isn't a pick: sector cap, outside top 3, event risk

**Picks discipline:** top 3 per side, **no more than 2 from any one sector**, event-risk stocks
excluded entirely (*"gets no levels at all"*).

**Alignment check** (4 points, from the breadth post): stock rank, sector, breadth, VWAP.
4/4 = full attention, 3/4 = smaller size, 2/4 or fewer = pass.

**Operational detail worth cloning:** live 9:15–15:30 IST on trading days; rankings settle after
the first few minutes because the opening auction flips direction; holidays show the last
session's board; rank-change markers show places moved since the previous minute.

### 2.3 What I deliberately changed for crypto

| OrderBlock | OrderFlow | Why |
|---|---|---|
| 200+ NSE F&O stocks, 9:15–15:30 | ~56 crypto pairs, **24/7** | Crypto never closes; no session gating, no holiday handling |
| Range limited to 288 daily candles | 320 five-minute candles | 5m is the actionable TF, matching their own advice |
| "First 15 minutes range" as structure | Equal highs/lows liquidity pools | Crypto has no opening auction |
| OI-based liquidity score | Session VWAP + pivot pools | Binance spot OI is not free; futures is a separate host |
| No news layer | **News impact engine** | The brief asked for it; the original has none |
| No attribution | **Abnormal-return attribution** | "What moved this asset" is the missing half of any news panel |
| ₹7,999/year | Free, open, keyless | Not cloning the business model |

---

## 3. Research phase — free data sources

Full detail is in **`FREE-MARKET-DATA-APIS-REFERENCE.md`** (908 lines). It was compiled by a
subagent that **verified every endpoint live from a confirmed Indian IP** (Ahmedabad, Jio,
AS55836; Binance responded via CloudFront `BOM78-P9` Mumbai).

### 3.1 Verified working from India

| Source | Base URL | Key? | Limit |
|---|---|---|---|
| **Binance** | `data-api.binance.vision` (market-data mirror) | No | 6000 weight/min |
| **Bybit** | `api.bybit.com` | No | 600 req / 5s |
| **Coinbase Ex.** | `api.exchange.coinbase.com` | No | ~10 req/s |
| **Kraken** | `api.kraken.com` | No | counter-based |
| **CoinGecko** | `api.coingecko.com` | Optional demo key | ~30/min keyless, 100/min with key |
| **Yahoo Finance** | `query1.finance.yahoo.com` | No — **cookie+crumb required** | standard |
| **NSE (partial)** | `www.nseindia.com` | No — partial | — |
| **RSS ×6** | see §8.1 | No | none |

### 3.2 Blocked or dead — and what I did

| Finding | Consequence |
|---|---|
| **CryptoPanic killed its free tier** — discontinued 1 Apr 2026, now $50/week, and Cloudflare-403s Indian IPs | Killed a major planned source. Used RSS instead — same headlines, zero cost |
| **OKX is TCP-unreachable from India** (HTTP 000 on `www.okx.com` *and* `aws.okx.com`) | Never used. Not a headers problem — a network block |
| **NSE `/api/equity-stockIndices` → 404**, `/api/option-chain-indices` → 404** | The two most-wanted endpoints are exactly the two that fail. NSE's homepage (which mints the cookie) returns 403 to non-browsers, so the cookie-priming workaround is also blocked |
| **NSE option chain has no free source at all** | Deliberately **not attempted**. Documented as a gap rather than faked |
| **Yahoo's "symbol may be delisted" is an auth failure**, not a missing ticker | Implemented the 3-step cookie+crumb handshake |
| **Binance `limit > 1000` silently truncates** — no error | Clamped to 1000 and documented |

### 3.3 Working NSE endpoints

Only three, all keyless, all needing a browser UA + `Referer`:

- `/api/allIndices` → 139 indices, `chartTodayPath` SVG URLs (undocumented, untested)
- `/api/marketStatus` → per-segment Open/Pre Open/Close
- `/api/holiday-master?type=trading` → **the F&O bucket is keyed `FO`, not `FNO`.** `o.FNO` is
  `undefined` and throws. This is the single easiest mistake with that API.

### 3.4 Session timings — corrected

The research corrected a fact I would otherwise have got wrong: **equity derivatives now close at
15:40, not 15:30** (circular NSE/FAOP/74467, issued 29 May 2026, effective 3 Aug 2026). Equity
cash keeps a 15:30 normal close with a separate 15:40–16:00 closing auction.

```ts
equity:    09:15 – 15:30   (+ CAS 15:40–16:00)
fnf:       09:15 – 15:40   ← changed Aug 2026
currency:  09:00 – 17:00
commodity: 09:00 – 23:30   (23:55 under US DST)
```

IST is UTC+05:30 with **no DST**, so a fixed offset is correct — a real convenience for scheduling.

---

## 4. Research phase — news impact methodology

Full detail: **`CRYPTO_NEWS_CATALYSTS_REFERENCE.md`** (1,235 lines). This produced the most
valuable design decision in the project.

### 4.1 How the commercial vendors do it

| Vendor | Publicly documented mechanism | What was borrowed |
|---|---|---|
| **RavenPack** | Event Relevance (REL) 0–100 by *position of the event in the document*; Event Similarity Days (SIM). Their finding: **REL 90–100 significantly outperforms** low relevance, and novelty adds up to 50% information ratio — but aggressive novelty gating destroys volume | Position-based relevance (not just keyword presence); novelty as a multiplier with a **1.0 floor, never a gate** |
| **NewsWhip** | Social **Velocity** (a *rate*, not a total); publisher-relative normalisation over a trailing 30-day window; 4-word overlap for clustering | Per-class half-life decay; corroboration breadth |
| **Benzinga** | Vendor-supplied `importance_rank` 1–5 | Source tiering |
| **GDELT** | Free, no key, `TimelineVol` = breaking-news detector | Tone as a signal, not just classification |

**The gap none of them close:** *they all score news; none tell you what moved the asset.* That
became §8.4.

### 4.2 The measured macro relationships used

- **CPI is the dominant driver and it re-formed in 2026.** 1h R² on CPI surprise hit ~80% over a
  12-release window, versus ~0 in 2024–25. β = −3.2%/pp short-run, −5.5%/pp long-run.
- **NFP sensitivity decayed to near zero.** The Fed's attention moved from labour to inflation.
  *Weight CPI above NFP.*
- **FOMC:** mean absolute 1h return 0.66% → 1.25% for BTC; volume ×2.54. But cumulative abnormal
  *returns* are insignificant — direction is conditional on the surprise.
- **FOMC reactions REVERSE over the following 4 hours** for crypto, unlike equities. This became
  the reversal-risk flag.
- **The Fed Chair in 2026 is Kevin Warsh, not Powell.** Keyword rules tuned on Powell language
  mis-fire. Both names are in the lexicon.
- **Stablecoin supply growth is a 1–3 month leading indicator**; ETF flows are T+1 structural.
- **DefiLlama moved.** The documented `api.llama.fi/stablecoincharts/all` now **404s**. Stablecoin
  APIs are on `stablecoins.llama.fi`.
- India: there is **no Indian BTC ETF** and SEBI has not approved one. GIFT City closed to crypto
  from 31 Oct 2025. The only route is LRS → IBIT. RBI's written submission to Parliament
  (2 Jul 2026) recommends *"calibrated containment strategy leaning towards prohibition."*

### 4.3 The formula implemented

```
NIS = (severity + relevance + max(0, sentiment) + source tier + urgency)
      × novelty × corroboration × confidence × recency-decay × macro-multiplier
```

The single most important line is **`max(0, sentiment)`**:

> A strongly negative story still has **high impact**. If negative sentiment reduced the impact
> score, the panel would hide exactly the stories a trader most needs to see. Direction carries
> the sign, not magnitude.

---

## 5. What I built — architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  BROWSER  —  React 18 + Vite 6  (port 5173)                        │
│                                                                     │
│  App ── tabs ─┬─ Terminal: MarketPicture · BullBoard · BearBoard     │
│               │            SectorFlow · AssetPopup → CandleChart     │
│               ├─ News:    NewsImpactPanel · AttributionPanel         │
│               ├─ India:   IndiaPanel                                 │
│               ├─ Journal: Journal (localStorage + P&L heatmap)      │
│               └─ Learn:   method documentation                      │
│                                                                     │
│  usePolling() — 60s scan · 120s news/macro/attribution · 180s india │
│  pauses on document.visibilitychange                                 │
└────────────────────────────┬────────────────────────────────────────┘
                             │  /api  (Vite dev proxy → :8787)
┌────────────────────────────┴────────────────────────────────────────┐
│  ENGINE  —  Express 4 + tsx  (port 8787)                           │
│                                                                     │
│  routes/index.ts ──┬─ /api/scan            scanner.runScan()         │
│                    ├─ /api/asset/:id       orderblock.detect()      │
│                    ├─ /api/news            rss → score.buildFeed()  │
│                    ├─ /api/attribution     attribute()              │
│                    ├─ /api/macro           macro.macroState()        │
│                    ├─ /api/india           nse.indianMarket()        │
│                    └─ /api/health                                           │
│                                                                     │
│  lib/  http (retry/backoff/timeout) · cache (single-flight TTL)     │
│        time (IST, sessions, holiday parsing)                         │
│  data/ binance · yahoo · nse · rss · macro · universe                │
└─────────────────────────────────────────────────────────────────────┘
                             │
        ┌────────────────────┴────────────────────┐
        │  FREE UPSTREAMS (no keys, verified India)│
        │  Binance · Yahoo · NSE · CoinGecko       │
        │  alternative.me · DefiLlama · 6× RSS      │
        └─────────────────────────────────────────┘
```

**Why a backend at all** (rather than calling APIs from the browser):

1. **Yahoo requires authentication** — the cookie+crumb handshake must be server-side and the
   crumb must never reach the client.
2. **The scanner pulls 5m candles for ~56 pairs** (~180 requests). Doing that from a browser tab
   would be abusive and fragile.
3. The news engine needs cross-item novelty/corroboration — that is inherently whole-corpus work.
4. It mirrors the real product, which has a server-side engine.

### Size

| Layer | Files | Lines |
|---|---|---|
| Backend (`server/src`) | 17 | 2,266 |
| Frontend (`src`) | 15 | 2,219 |
| Shared types | 1 | 254 |
| Config / scripts | 4 | 78 |
| **Total TS/TSX** | **37** | **5,592** |

---

## 6. File-by-file manifest

### 6.1 Root

| File | Lines | Purpose |
|---|---|---|
| `package.json` | 34 | Scripts: `dev`, `dev:api`, `dev:web`, `build`, `typecheck`, `check:universe`, `start` |
| `tsconfig.json` | 19 | Strict, `noUnusedLocals`, `verbatimModuleSyntax`, bundler resolution |
| `vite.config.ts` | 20 | React + Tailwind plugins; proxies `/api` → `localhost:8787` |
| `index.html` | 25 | Pre-paint theme script reading `localStorage['of-theme']` to avoid a light-mode flash |
| `.env.example` | 7 | Documents that **every value is optional** |
| `.gitignore` | 6 | |
| `README.md` | 230 | User-facing docs |
| `FREE-MARKET-DATA-APIS-REFERENCE.md` | 908 | Data-source research (kept in repo) |
| `CRYPTO_NEWS_CATALYSTS_REFERENCE.md` | 1,235 | News/macro research (kept in repo) |

### 6.2 Backend — `server/src/`

| File | Lines | Responsibility |
|---|---|---|
| `index.ts` | 239 | Express app, 8 routes, static serving of `dist/`, `.env` loading |
| `lib/http.ts` | 64 | `fetchText` / `fetchJson` / `fetchJsonSafe` — timeout, retry with exponential backoff, 4xx (except 429) not retried |
| `lib/cache.ts` | 44 | Single-flight TTL cache. **Critical at scale**: concurrent callers for one key share one upstream request |
| `lib/time.ts` | 123 | IST conversion (fixed +05:30, no DST), `istDateKey` producing NSE's `DD-Mon-YYYY`, `parseIstDateKey`, session windows |
| `data/binance.ts` | 103 | Host failover `data-api.binance.vision` → `api.binance.com`; klines with TTL cache; 24h tickers; exchangeInfo |
| `data/yahoo.ts` | 151 | Cookie+crumb handshake (30-min crumb cache), parallel-array→candle conversion, 20-name F&O universe |
| `data/nse.ts` | 152 | allIndices / marketStatus / holidays, holiday detection, runs the OB engine over the F&O universe |
| `data/rss.ts` | 129 | 6 feeds, CDATA + full entity decoding, UTM stripping, RFC-822 dates, single-flight |
| `data/macro.ts` | 146 | Fear & Greed, stablecoin float, global market, India gauges |
| `data/universe.ts` | 99 | 56 assets with name/sector/beta-group/tags, 22 sectors |
| `engine/orderblock.ts` | 285 | **The core**: pivots, liquidity pools, VWAP, `detectOrderBlock`, `strengthScore`, `choppiness`, `percentileOf` |
| `engine/scanner.ts` | 300 | Full market scan, boards, picks, sector flow, market picture, breadth, rank-delta cache |
| `engine/attribution.ts` | 168 | Abnormal return, z-scores, significance gate, news weight distribution, `rollingBeta` |
| `engine/news/taxonomy.ts` | 133 | **65 event tags** with severity/direction/half-life/expiry + routine-commentary detector |
| `engine/news/lexicon.ts` | 106 | **180 weighted finance terms** (63 positive / 117 negative) + 26 negators |
| `engine/news/entities.ts` | 120 | 62 asset alias groups, macro entities, jurisdiction, headline-position relevance |
| `engine/news/score.ts` | 245 | Two-pass NIS scoring + novelty/corroboration |

### 6.3 Shared

| File | Lines | Purpose |
|---|---|---|
| `shared/types.ts` | 254 | Every wire type. Imported by **both** server and client, so a shape change breaks the build immediately |

### 6.4 Frontend — `src/`

| File | Lines | Responsibility |
|---|---|---|
| `main.tsx` | 11 | Mount |
| `App.tsx` | 315 | Shell, tabs, theme, polling, popup orchestration, Learn view |
| `index.css` | 90 | Tailwind 4 `@theme`, CSS vars for light/dark, panel/chip utilities, reduced-motion guards |
| `lib/api.ts` | 140 | Typed client, `usePolling` (pauses on hidden tabs), `useLazy` |
| `lib/format.ts` | 67 | Price/pct/USD formatting tuned per magnitude, severity palette, `niceTicks` |
| `components/CandleChart.tsx` | 452 | **Hand-written SVG chart**: candles, OB box + gradient zone, prior setups, level ladder, VWAP, crosshair, OHLC readout |
| `components/AssetPopup.tsx` | 269 | Chart + the 10-second read (ladder, proof, alignment check) |
| `components/Board.tsx` | 147 | Bullish/bearish table with rank deltas, picks, R:R, sparkline, rule chips |
| `components/MarketPicture.tsx` | 127 | Every pair as a dot at its move; picks ringed, event-risk amber, choppy hollow |
| `components/SectorFlow.tsx` | 88 | Diverging bars + per-member cells |
| `components/NewsImpactPanel.tsx` | 204 | NIS badges, direction, category/asset/jurisdiction chips, reversal-risk, category + severity filters |
| `components/AttributionPanel.tsx` | 127 | Per-asset abnormal return, band, coverage bar, headline shares |
| `components/MacroStrip.tsx` | 114 | BTC, F&G, market cap, dominance, stablecoin float, India VIX/Sensex |
| `components/IndiaPanel.tsx` | 144 | Session state, NSE indices, F&O board, holiday notice |
| `components/Journal.tsx` | 311 | Trade log, win rate, expectancy, profit factor, P&L heatmap |
| `components/Sparkline.tsx` | 38 | 60-point inline trend |
| `components/ui.tsx` | 133 | Panel, Chip, LiveBadge, StatTile, Empty, Spinner |

---

## 7. The engine, explained

### 7.1 Strength — why "one-directional"

`server/src/engine/orderblock.ts`

```ts
export function strengthScore(changePct: number, rangePct: number): number {
  if (rangePct <= 0) return 0;
  const efficiency = Math.abs(changePct) / rangePct;
  if (efficiency < 0.25) return 0;          // chop gate
  return Math.abs(changePct) * efficiency;
}
```

- `efficiency = |net move| / day range`. A coin that ran 9% and gave it all back has a large range
  and near-zero efficiency → **scores exactly 0** and is filtered off the board in `scanner.ts`.
- The `efficiency < 0.25` gate is a second, harder chop filter.

This is the single most important idea carried over from OrderBlock. It is why the board shows 20
names instead of a list of the day's biggest moves.

### 7.2 Order block detection

`detectOrderBlock(candles, { range, prefer })`

Reads **only closed candles** — the last row from Binance is the still-forming candle and is
excluded by `Number(k[6]) < Date.now()`.

For each candidate candle `i` (starting at index 12):

1. **Colour filter** — bullish needs `blk.c < blk.o` (a red candle). If `prefer` is set, skip
   blocks that cannot produce the requested side. *This was a bug fix: the board was showing a
   bearish zone for a bullish asset.*
2. **Structural break** — scan up to 6 candles forward. Prior swing highs are taken from pivots
   in the preceding 8 candles, falling back to the window high/low. Requires
   `c.c > lastHigh` (bullish) or `c.c < lastLow` (bearish). **A close, not a wick.**
3. **Forceful move** — either:
   - **FVG:** bullish `breakCandle.l > closed[breakIdx - 2].h`, bearish the mirror; or
   - **displacement** ≥ 1× the average true range over 20 candles.
4. **Not violated** — no later 5-minute close through the zone.
5. **Most recent valid block wins.**

Then it builds the ladder:

| Output | Derivation |
|---|---|
| `z` | midpoint of the block's OHLC extent |
| `invalidation` | `zoneLow × 0.9995` bullish / `zoneHigh × 1.0005` bearish |
| `targets` | Pivot highs above (bullish) / lows below, **prioritising equal highs/lows**, deduped, nearest 2 |
| `context` | Levels met on the way (non-pool pivots + day high/low), up to 3 |
| `rr` | `|target2 − Z| / |Z − invalidation|`, or **0 when there are no targets** — never an invented multiple |
| `ageMinutes` | how long the zone has existed |
| `previous` | up to 3 earlier opposite candles, left where they happened |

**Liquidity pools** use `tolerancePct = 0.12`: two or more pivots at the same price are an
*equal high* or *equal low* — where stop orders actually pile up. Those get priority as targets.

### 7.3 The scanner

`server/src/engine/scanner.ts` — `runScan()`

1. Fetch all Binance 24h tickers + exchangeInfo **in parallel**.
2. Filter the 56-asset universe to those that are on USDT spot **and** have >$1M 24h volume.
3. Fetch 5m klines in **batches of 8 concurrent** (`Promise.allSettled` so one bad symbol cannot
   kill the scan), computing strength, choppiness, VWAP, setup and sparkline per pair.
4. Split into bullish/bearish, drop `strength === 0`, sort, take top 20 each.
5. Assign picks: top 3 per side, max 2 per sector, event-risk excluded. **Every row records why.**
6. Aggregate sector flow and mark leader/laggard.
7. Build the market picture (all dots) and breadth bias (ratio > 0.62 bullish, < 0.38 bearish).
8. `applyRankDelta` diffs against the previous minute's ranks so rows can show ▲/▼ movement.

**Percentiles are inverted on the bearish side.** OrderBlock's spec says bearish reads from the
other end, so the strongest bearish asset reads near the top of its own list.

### 7.4 Choppiness

ADX-style: `100 / (1 + ln(ΣTR / ΣHL) / ln(14))`. 0 = clean trend, 100 = pure chop. Displayed in
the popup as context; not used to gate the board (the efficiency gate does that job).

---

## 8. The news engine, explained

### 8.1 Ingestion

`server/src/data/rss.ts` — 6 feeds, no key, verified 200 from India:

| Feed | Domain | Tier |
|---|---|---|
| CoinDesk | coindesk.com | 12 |
| Cointelegraph | cointelegraph.com | 10 |
| Decrypt | decrypt.co | 10 |
| Bitcoin Magazine | bitcoinmagazine.com | 10 |
| Bitcoin.com | news.bitcoin.com | 10 |
| CryptoSlate | cryptoslate.com | 8 |

Parsing handles the three real-world problems: `<description>` is **HTML not text**, `<link>` is
CDATA-wrapped with `utm_*` tracking params, and `pubDate` is RFC-822 with a numeric offset.
Numeric entities (`&#8217;`) are decoded — this was a real display bug caught in testing.

### 8.2 Taxonomy — 65 event tags

`engine/news/taxonomy.ts`. Each tag: category, severity (0–40), default direction, half-life,
hard expiry, trigger regex.

| Category | Tags | Examples |
|---|---|---|
| ETF | 8 | `ETF_APPROVAL` (28, +), `ETF_DENIAL` (35, −) — *"denial is worse than a delay"* |
| Security | 6 | `HACK_EXCHANGE_MAJOR` (40, −), `HACK_STATE_ACTOR` (38, −) |
| Stablecoin | 6 | `DEPEG_MAJOR` (38, −), `REDEMPTION_SUSPENDED` (34, −) |
| Regulation | 11 | `BANNED` (38, −), `INJUNCTION` (32, −), `IN_FIU_IND` (32, −) |
| Tech | 7 | `HALVING` (30, +) but urgency is capped — a pre-announced halving must not score high |
| Listing | 4 | `DELISTING_MAJOR_EXCHANGE` (24, −) |
| Whale | 4 | `WHALE_EXCHANGE_DEPOSIT` (26, −) with reversal risk 0.60 |
| Adoption | 5 | `PENSION_SOVEREIGN_ALLOCATION` (30, +) |
| Distress | 4 | `PROOF_OF_RESERVE_FAILURE` (36, −) |
| Derivatives | 4 | `FORCED_LIQUIDATION_CASCADE` (32, −) |
| Macro | 8 | `MACRO_FOMC` (36), `MACRO_CPI` (32) |

**Routine-commentary detector** — the calibration fix. Without it, *"Bitcoin Price Holds $82K"*
scored 97 (CRITICAL) purely because it named the asset early and came from a decent outlet.
Patterns catch holds/clings/consolidates, analysis/explainer/opinion/forecast language, and
indicator commentary. Matching items get severity capped at 4 and urgency forced to 1.

### 8.3 Sentiment — negation-aware

`engine/news/lexicon.ts` — 180 weighted terms. Two refinements that matter more than the raw list:

1. **Negation window** — a negator within 3 tokens before a polarity term flips its sign.
   *"Not approved"* must not read as bullish.
2. **Position decay** — headline terms count `1.0`, body terms `0.4`. Headline terms carry roughly
   ten times the information.

Normalised: `clamp(raw / max(3.0, 0.6 × hits), −3, +3)`.

### 8.4 The two-pass build

`engine/news/score.ts`

**Pass 1** — score each item in isolation: severity, relevance (headline position: `max(0, 100 −
6.25 × charsBeforeFirstAssetMention)` — the cheap RavenPack REL proxy), sentiment, source tier,
urgency.

**Pass 2** — `buildFeed()` computes the two things only visible across the whole corpus:

- **Novelty** — Jaccard word overlap > 0.45 (or > 0.2 with matching asset + category) against
  every *older* item. < 1 day → 1.5×, < 7d → 1.3×, < 30d → 1.15×, else 1.0×. **Floor is 1.0 —
  it multiplies, it never gates.**
- **Corroboration** — `1 + 0.1 × min(distinct credible sources − 1, 3)`, so 1.00–1.30.

Then rescore and bucket: ≥70 CRITICAL, ≥55 HIGH, ≥30 MEDIUM, ≥15 LOW, below that NOISE (suppressed).

### 8.5 Attribution

`engine/attribution.ts`

```
abnormal return = ln(P_close(t+h)/P_close(t)) × 100 − (rollingβ × BTC return)
moveZ           = abnormal / σ₂₀(abnormal)
volZ            = (ln vol − μ₂₀) / σ₂₀
significant     = (|moveZ| ≥ 2.5 AND volZ ≥ 2.0) OR |moveZ| ≥ 3.5
```

- `rollingBeta` is an OLS fit of the asset's log returns against BTC's.
- **Significance gate** — a 0.3% move would be nominally "explained" by any headline, so
  attribution only runs when the move is real. Insignificant items report `coverage: 0` and the
  UI says *"move below 2.5σ — not attributed"*.
- **Routine items are excluded from attribution** — commentary about price that already happened
  explains nothing. This was a bug: *"Bitcoin Price Holds $82K"* had a 69% attribution share.
- Weights: `NIS × e^(−ageMinutes/180) × assetMatch`, where assetMatch is 1.0 for a named asset,
  0.55 for macro, 0.3 otherwise.
- **Coverage bands** — ≥65% driven by news, 35–65% partially attributed, below that no clear
  driver. **A low number is information, not a failure.**
- **Reversal risk** — 0.7 for FOMC/CPI items (measured 4-hour reversal), 0.6 for bearish whale
  transfers (often dip-buying).

---

## 9. The frontend, explained

### 9.1 Layout

Three-tier, terminal-first:

```
┌───────────────────────────────────────────────────────────────┐
│ OrderFlow │ tabs │ Live badge │ ☀/☾                           │  sticky
├───────────────────────────────────────────────────────────────┤
│ BTC · F&G · mcap · dominance · stablecoins · India VIX       │  macro strip
├──────────────────────────────────────────────┬────────────────┤
│ MARKET PICTURE (every pair as a dot)         │                │
├───────────────────────┬──────────────────────┤  SECTOR FLOW   │
│ BULLISH BOARD         │ BEARISH BOARD        │                │
│ (20 rows, picks first)│ (20 rows)            │                │
└───────────────────────┴──────────────────────┴────────────────┘
```

The India tab runs **the same engine** over NSE F&O stocks, so the order block logic is not
crypto-specific — it is price-action logic.

### 9.2 The chart

`CandleChart.tsx` — **452 lines of hand-written SVG**, deliberately not a charting library.

A library would have fought the overlays: the OB box needs to start at the block's candle and run
to the right edge; the zone needs a gradient tied to the setup's side; the ladder needs labels that
sit *inside* the plot; prior setups need to stay where they happened while the current one moves.

Layout: 120 candles, price axis on the right (62px gutter), ~20px for the time axis.
Nice-round gridlines via `niceTicks`. Crosshair + OHLC readout on hover.

Colour comes from CSS variables, so light/dark is free and the chart follows the theme.

### 9.3 Polling discipline

`usePolling` pauses on `document.visibilitychange` — a backgrounded terminal does not keep
hammering Binance. Intervals: scan 60s, news/macro/attribution 120s, india 180s.

### 9.4 The journal

`localStorage`, no backend. Computes net P&L, win rate, expectancy and profit factor, plus a
GitHub-style P&L calendar heatmap padded to whole weeks. Tagging trades by setup is what makes
the journal useful a month later — *"which setups actually work for you"*.

---

## 10. API reference

| Method | Path | Returns | Upstream calls |
|---|---|---|---|
| GET | `/api/health` | ok, IST clock, cache stats, uptime | 0 |
| GET | `/api/scan` | `ScanResult` — both boards, sectors, market picture, breadth | ~56 klines + tickers + exchangeInfo |
| GET | `/api/asset/:id` | Candles + setup + choppiness. Accepts `BTC`, `BTCUSDT`, `RELIANCE` | 1 klines or 1 Yahoo chart |
| GET | `/api/news` | `NewsFeed` — scored items, severity buckets, category counts | 6 RSS |
| GET | `/api/attribution` | Attribution for every coin on the board | ~18 klines + BTC |
| GET | `/api/attribution/:id?horizon=60` | Single-asset attribution + fitted beta | 2 klines |
| GET | `/api/macro` | F&G, stablecoins, global market, India gauges | 3 external |
| GET | `/api/india` | Session, indices, holidays, F&O strength board | NSE ×3 + 20 Yahoo |
| GET | `/api/percentile/:id` | Row percentile lookup | 0 (in-memory) |

Non-API routes serve `dist/` in production, with an SPA fallback.

---

## 11. How to run and test

### 11.1 First run

```bash
cd C:\Users\DK\Desktop\trading
npm install
npm run dev
```

Open **http://localhost:5173**.

> **On first install on Windows:** npm may warn that esbuild's postinstall was not run. Vite needs
> it. Run `npm install-scripts approve esbuild` if you see that warning.

**First scan takes 30–60 seconds** — it pulls 5-minute candles for ~42 liquid pairs. The page
renders as soon as it lands, then refreshes every minute.

### 11.2 Production

```bash
npm run build     # typecheck + bundle to dist/
npm start         # single server on :8787 serving API + UI
```

### 11.3 Verifying it works

```bash
curl http://localhost:8787/api/health
curl http://localhost:8787/api/scan
```

Last verified run (10 Oct 2026, 20:40 IST):

```
OK  health          ist=20:40
OK  scan            scanned=42 bull=20 bear=2 choppy=8 bias=bullish sectors=20
                      setups drawn: 22/22   picks: 5
OK  news            items=72 crit=1 high=3
OK  macro           btc=83013 fng=64 mcap=2818B stables=311B vix=14.36
OK  india           state=Close idx=7 fno=19 nextHol=20-Oct-2026
OK  attribution     n=11
OK  asset/BTC       candles=320 setup=82778-82830.29 side=bullish
OK  asset/RELIANCE  candles=365 setup=yes side=bearish

RESULT: 8 ok, 0 failed
```

Response times after cache warm: scan **0.1s**, attribution **2.4s**, asset **0.2s**.

### 11.4 Tests

```bash
npm run typecheck          # strict tsc, no emit
npm run build              # typecheck + production bundle
npm run check:universe     # which tracked pairs are live on Binance spot, with volumes
```

`check:universe` exists because 9 initially-selected tickers turned out not to be on Binance spot
(Monero was delisted, several exchange tokens never listed). It is the tool for re-validating the
universe after any change to it.

---

## 12. Bugs found and fixed during the build

All found by actually running the code against live data, not by reading it.

| # | Bug | Symptom | Fix |
|---|---|---|---|
| 1 | `W(` lost its paren on 2 lines of `taxonomy.ts` | `TS1005 ',' expected` | Re-wrote the lines. **Found by hex-dumping the file after the error proved unexplainable** |
| 2 | Percentiles not inverted on the bearish side | A −10.59% coin showed `p69`; the strongest bearish name sank to the bottom | `side === 'bearish' ? 100 − raw : raw` |
| 3 | Counter-trend setups on the board | A +11.75% coin displayed a *bearish* OB with its invalidation above the zone | Added `prefer: Side` to `detectOrderBlock`; the board now shows only matching-side zones |
| 4 | Fake R:R when no liquidity in range | `rr = 2` was a `risk × 2` fallback, inventing a multiple | Return `0`; the UI shows `—` |
| 5 | Choppy assets cluttering the boards | Zero-strength coins occupied board slots | Filtered to `strength > 0`; choppy count surfaced in the market picture instead |
| 6 | **Routine headlines scoring CRITICAL** | *"Bitcoin Price Holds $82K"* scored **97**; only 1 CRITICAL remained after fixing | Added `ROUTINE_PATTERNS` + `isRoutine()`, capping severity at 4 and urgency at 1 |
| 7 | **Routine headlines credited as a driver** | *"BTC Holds $82K"* held a **69% attribution share** | Added `routine` to `NewsItem`; excluded from attribution candidates |
| 8 | **Coverage reading 100% on insignificant moves** | A 0.34% move showed "coverage 100%" next to "no clear driver" | Coverage zeroed unless significant; raw kept for display; UI explains why |
| 9 | Numeric HTML entities leaking | Headlines rendered `Saylor&#8217;s` | Full numeric + hex entity decoding in `decodeEntities` |
| 10 | Universe had 9 dead tickers | Only 31 of 54 pairs scanned — Monero delisted, several never listed | `check:universe` script → removed dead names, expanded to 56 live pairs |
| 11 | `useMemo` used for a ResizeObserver | Would never fire | `useEffect` |
| 12 | Chart never resized | Fixed 600px initial width | `ResizeObserver` |
| 13 | Duplicate object keys in the lexicon | Silently dropped terms; TS complaints | Rewrote `POSITIVE`/`NEGATIVE` cleanly (180 terms now) |
| 14 | Duplicate `EXCLUDE_FROM_BOARD` | Would not compile | Removed the stale copy |

---

## 13. Known limits and honest gaps

These are real and deliberately not hidden.

| Limit | Detail |
|---|---|
| **Hand-maintained universe** | ~56 pairs, not all ~2,400 Binance pairs. Scanning every micro-cap would be dominated by names too thin to trade. `check:universe` keeps it honest |
| **No free NSE option chain** | NSE blocks it to non-browsers and licenses it commercially. **Not attempted** rather than faked |
| **Yahoo dependency** | Needs the cookie+crumb handshake; can be slow or rate-limited. The crypto terminal is unaffected when it fails — it degrades to "No Indian equity data right now" |
| **Novelty window** | Computed within the current RSS feed window, not a 365-day store. Resets when a story scrolls out of the feeds |
| **Beta window** | ~8 hours of 5-minute returns, not the 90-day window in the research. Directionally right, not a published study |
| **News scoring is hand-tuned** | Defensible and calibrated against structure, but **not fitted against labelled outcomes**. The research says ~2,000 labelled events are needed to replace the hand-tuned multipliers |
| **Attribution scale is a heuristic** | `scale = 0.35` maps summed NIS points to a percent-of-move. Defensible, uncalibrated |
| **Spot only** | Binance futures (funding, OI, liquidations) are a separate host and not wired. Those would meaningfully improve the liquidity and liquidation layers |
| **No WebSocket** | Everything is polled. Fine at 60s granularity, wrong for sub-minute |
| **Single user, no auth** | No accounts, no persistence beyond the browser's localStorage |
| **3 exchanges supported, 1 wired** | Bybit/Coinbase/Kraken are in the data layer's design but only Binance reaches the scanner |

---

## 14. Extension guide — where to change what

| Goal | File | Change |
|---|---|---|
| Add a crypto pair | `server/src/data/universe.ts` | Add to `UNIVERSE` with base/name/sector/betaGroup/tags |
| Add a sector | `server/src/data/universe.ts` | Append to `SECTORS` |
| Add a news source | `server/src/data/rss.ts` | Append to `FEEDS` (include the `tier`) |
| Tune the news formula | `server/src/engine/news/score.ts` | The formula is one expression in `buildFeed` |
| Add an event tag | `server/src/engine/news/taxonomy.ts` | Append to `EVENT_TAGS` with severity/dir/halfLife/expiry |
| Add sentiment words | `server/src/engine/news/lexicon.ts` | `POSITIVE` / `NEGATIVE` |
| Change OB strictness | `server/src/engine/orderblock.ts` | `detectOrderBlock` — the FVG and 1× displacement thresholds, the `violated` check |
| Change the chop gate | `server/src/engine/orderblock.ts` | `efficiency < 0.25` |
| Change board size / picks | `server/src/engine/scanner.ts` | `BOARD_SIZE`, `PICKS_PER_SIDE`, `MAX_PER_SECTOR` |
| Change event-risk threshold | `server/src/engine/scanner.ts` | `EVENT_RISK_PCT = 14` |
| Change poll intervals | `src/App.tsx` | The four `usePolling` interval arguments |
| Change the significance gate | `server/src/engine/attribution.ts` | `moveZ >= 2.5`, `volZ >= 2.0`, `moveZ >= 3.5` |
| Add an exchange | new `server/src/data/<name>.ts` | Implement the same shape as `binance.ts`, then swap it into `scanner.ts` |
| Change the board layout | `src/App.tsx` | The grid in the `terminal` tab |

### Ideas deliberately left on the table

1. **Binance futures** — funding rate, OI and liquidation cascades would sharpen both the
   liquidity and liquidation layers. `/fapi/v1/*`, no key for public data.
2. **Real correlation fitting** — the research gives a BTC/DXY/10y-real-yield regression for
   abnormal returns. Currently only BTC beta is used; adding DXY and DFII10 would sharpen it a lot.
3. **Outcome feedback loop** — persist every attribution and its realised return, then report
   per-category hit rate and Brier score. This is what turns the hand-tuned weights into fitted
   ones.
4. **WebSocket** — `wss://data-stream.binance.vision` for live marks.
5. **Alerting** — push on NIS ≥ 70 or a CRITICAL tag.

---

## 15. Decision log

Decisions worth remembering, with the reasoning.

| # | Decision | Reasoning |
|---|---|---|
| 1 | Backend engine, not browser-direct | Yahoo needs server-side auth; the scanner needs 56 symbols; news novelty is corpus-level work |
| 2 | `data-api.binance.vision` as primary host | Binance's designated market-data mirror, no account endpoints, verified working from India |
| 3 | RSS instead of CryptoPanic | Free tier discontinued Apr 2026; $50/week minimum; Cloudflare-403s Indian IPs |
| 4 | No live NSE option chain | No free source exists. Documented, not faked |
| 5 | `max(0, sentiment)` in the impact formula | A hack must score **high impact**. Negative sentiment must not bury it |
| 6 | Novelty floor of 1.0 | RavenPack's own finding — gating on novelty destroys information ratio |
| 7 | Routine-commentary demotion | Without it, price recaps outranked actual catalysts. Calibration > elegance |
| 8 | Attribution requires a 2.5σ gate | Otherwise any headline "explains" any small move |
| 9 | Routine items excluded from attribution | Commentary about past price explains nothing |
| 10 | 5-minute candles only | Matches OrderBlock's own advice and the original's reason for reading only closed candles |
| 11 | Hand-written SVG chart | Library overlays would fight the OB box, zone gradient and ladder labels |
| 12 | Strength efficiency gate at 0.25 | Second, harder chop filter on top of the zero-score rule |
| 13 | Choppy assets hidden, not greyed | OrderBlock's stated rationale: *"so they don't clutter your board"* |
| 14 | Same engine for Indian F&O | Proves the logic is price-action, not crypto-specific |
| 15 | localStorage journal, no backend | Appropriate for a single-user research tool; adds no auth surface |
| 16 | Explicit `KR·R=R·K` disclaimer + README section | Trading tools carry real risk; must not read as advice |
| 17 | Research docs kept in the repo | They justify the data choices and let anyone re-verify them |
| 18 | One-off repair instead of a runtime fallback | Keeps the engine single-sourced so behaviour stays predictable |

---

## Appendix A — Complete constant reference

```ts
// scanner.ts
BOARD_SIZE        = 20      // rows per side
PICKS_PER_SIDE    = 3
MAX_PER_SECTOR    = 2
EVENT_RISK_PCT    = 14      // |move| >= 14% => event risk, no levels published
MIN_RANGE_PCT     = 0.6     // below this there is no tradable structure
SCAN_TTL_MS       = 60_000
CONCURRENCY       = 8

// orderblock.ts
efficiency gate   = 0.25
pivot wing        = 2
liquidity tolerance = 0.12 %
ATR lookback      = 20
max context levels = 3
max targets        = 2
max previous setups = 3

// score.ts
SEVERITY:  CRITICAL >= 70 | HIGH >= 55 | MEDIUM >= 30 | LOW >= 15 | else NOISE
NOVELTY:   <1d 1.50 | <7d 1.30 | <30d 1.15 | else 1.00   (floor 1.0)
CORROB:    1 + 0.1 x min(sources-1, 3)                     => 1.00-1.30
CONF:      1 + 0.2 x |sentiment|/15                         => 1.00-1.20
MACRO:     FOMC 1.5 | CPI 1.4 | PCE/Speech 1.2 | NFP 1.1 | else 1.0
half-life: breaking 45m | structural 2880m | default 1440m
expiry:    7 days hard cap

// attribution.ts
significant = (|moveZ| >= 2.5 AND volZ >= 2.0) OR |moveZ| >= 3.5
coverage bands: >= 0.65 driven | 0.35-0.65 partial | else none
recency e-folding = 180 min
reversal risk: FOMC/CPI 0.7 | PCE/Speech 0.4 | bearish whale 0.6 | else 0.3

// time.ts
IST_OFFSET_MIN = 330        // +05:30, no DST
sessions: equity 09:15-15:30 | fnf 09:15-15:40 | currency 09:00-17:00 | commodity 09:00-23:30

// caches
binance klines     20s   | exchangeInfo 1h
news RSS            5m   | nse allIndices 5m | nse marketStatus 2m | nse holidays 24h
yahoo crumb        30m   | yahoo charts 60s | macro state 60s
```

## Appendix B — Data source cheat sheet

```
Crypto OHLCV/tickers  https://data-api.binance.vision/api/v3/{klines,ticker/24hr,exchangeInfo}
Indian equities       https://query1.finance.yahoo.com/v8/finance/chart/{SYM}.NS   (+cookie/crumb)
NSE indices           https://www.nseindia.com/api/allIndices
NSE session           https://www.nseindia.com/api/marketStatus
NSE holidays          https://www.nseindia.com/api/holiday-master?type=trading   -> .FO
Market cap/global     https://api.coingecko.com/api/v3/global
Fear & Greed          https://api.alternative.me/fng/?limit=8
Stablecoin float      https://stablecoins.llama.fi/stablecoincharts/all          (NOT api.llama.fi)
News                  6 RSS feeds, see §8.1
```

## Appendix C — Glossary

| Term | Meaning here |
|---|---|
| **Order block** | The last opposite-coloured candle before a move that closed beyond structure |
| **FVG** | Fair-value gap — a 3-candle imbalance. Treated here as *proof* the move was real, not as a level |
| **Structure break** | A close beyond the prior swing high or low |
| **Displacement** | How far the break candle travelled, in multiples of average candle range |
| **Zone (Z)** | The midpoint of the order block — the price the setup is built around |
| **Invalidation** | S1 (bullish) / R1 (bearish) — where the idea is proven wrong |
| **Liquidity pool** | Two or more pivots at the same price; where stop orders pile up |
| **Liquidity sweep** | Price taking those stops, then reversing |
| **Choppiness** | ADX-style 0–100. High = no clean direction |
| **Efficiency** | `|net move| / day range`. Low = went up and came back down |
| **Breadth** | How many pairs lean each way today |
| **Alignment** | The 4-point check: rank, sector, breadth, VWAP |
| **NIS** | News Impact Score, 0–100 |
| **Abnormal return** | Raw move minus what BTC's move implies at that asset's beta |
| **Coverage** | Share of the abnormal move the headlines account for |

---

**End of context document.**
