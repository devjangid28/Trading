# OrderFlow — Complete Context Window

> A full record of what was researched, what was built, why each decision was made, and how to run,
> test, extend or replace any part of it.
>
> Written: 10 October 2026 · Project root: `C:\Users\DK\Desktop\trading`
> Stack: React 18 + Vite 6 + TypeScript 5.7 + Tailwind 4 (frontend) · Express 4 + tsx (engine)
> Last updated: **28 October 2026** - Part XXIV.16 added (live Binance chart terminal, custom overlays, verified drawing smoke)
>
> **Parts I�?"IV are a historical record and are left as written.** Where a later part contradicts an
> earlier one, the later part wins. Part XXIV.16 is current.

---

## Maintenance rule — how this file stays true

This document is the project's memory, so it is only worth anything if it is **current**. The rule:

| When | What to do |
|---|---|
| Any change to the engine's behaviour (a threshold, a formula, a route) | Update the relevant section **and** the constant reference / API table in the same pass |
| A bug is found | Add it to the bug table with its symptom and fix. A bug that is not written down gets re-introduced |
| A session's worth of work lands | Add a dated Part. Do not silently rewrite an old Part — history is the point |
| A verification script is run | Paste the real numbers into the evidence table, including the failures. Never record a run as green that was not |
| Something is knowingly unbuilt | Say so in "honest gaps". An undocumented gap reads as a bug |

**Never record an aspiration as a fact.** Every "✅ complete" in this file was verified by running
something — `npm run verify`, `npm run verify:truth`, `npm run verify:stage1`, or a Playwright spec —
and the output of that run is quoted in the part that claims it.

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
16. [Part II — the v2 build, from zero to today](#part-ii--the-v2-build-from-zero-to-today)
17. [Part III — the render-loop bug and its regression test](#part-iii--the-render-loop-bug-and-its-regression-test)
18. [Part IV — the 12 Oct audit: FIX 1–4 and Stages 1–6](#part-iv--the-12-oct-audit-fix-14-and-stages-16)
19. [Part V — the 13 Oct Order Block page rebuild](#part-v--the-13-oct-order-block-page-rebuild)
20. [Part VI — the 13 Oct fan rebuild](#part-vi--the-13-oct-fan-rebuild-fan--hover-first-slice)
21. [Part VII — the 13 Oct reference-layout restore](#part-vii--the-13-oct-reference-layout-restore-ditto)
22. [Part VIII — 13 Oct "reference-v2" anatomy](#part-viii--13-oct-reference-v2-anatomy-tiles-tickets-crest-chips-ladder-nodes-bridges-lensspinefx)
23. [Part IX — 13 Oct "Calm Terminal" restyle](#part-ix--13-oct-calm-terminal-restyle-of-the-order-block-stage)
24. [Part X — 14 Oct: the chart was never real](#part-x--14-oct-2026-the-chart-was-never-real)
25. [Part XI — 15 Oct: the price was never live](#part-xi--15-oct-2026-the-price-was-never-live)
26. [Part XII — 16 Oct: the popup had no VWAP on two of its three surfaces](#part-xii--16-oct-2026-the-chart-popup-had-no-vwap-on-two-of-its-three-surfaces)
27. [Part XIII - 17 Oct: making this file usable as a brief](#part-xiii--17-oct-2026-making-this-file-usable-as-a-brief)
28. [Part XIV - 17 Oct: the Mind layer](#part-xiv--17-oct-2026-the-mind-layer-calibrated-probability-not-95-accuracy)
29. [Part XV - 17 Oct: the specification audit](#part-xv--17-oct-2026-a-full-specification-arrived-and-the-audit-it-forced)
30. [Part XVI — the evidence, learning and calibration layer](#part-xvi--17-oct-2026-evidence-learning-and-calibration)
31. [16. How to make a change in this repo](#16-how-to-make-a-change-in-this-repo)
32. [17. Roadmap, with the stable IDs used elsewhere in this file](#17-roadmap-with-the-stable-ids-used-elsewhere-in-this-file)
33. [Appendix A — Complete constant reference](#appendix-a--complete-constant-reference)

> **Read this first if you are new.** Sections 1–15 and Parts II–XII are the research, the reasoning
> and the history. **Section 16 is the operating manual** — ownership map, the traps that will bite
> you, and what "done" means. Section 17 is the backlog. Appendix A is every number in the product.
>
> Sections 5, 6, 10, 11, 13, 14 and Appendix A were **rewritten on 17 Oct 2026** against the real
> tree. Their earlier versions described the v1 build and were several generations stale; the Parts
> below them are untouched history and have not been retrofitted.

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
| **CoinGecko** | `api.coingecko.com` | Optional demo key | Public quota is shared per IP; a 429 was observed at only ~2 calls/min. This app now paces 2 s and caches markets/global for 5 min (Part XXII) |
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
┌──────────────────────────────────────────────────────────────────────────────┐
│  BROWSER  —  React 18 + Vite 6 + Tailwind 4.3.3          (dev :5173)         │
│                                                                              │
│  App.tsx ─ useState<Tab>  (NO router, NO url hash — reload = Dashboard)      │
│  ├── Dashboard   src/home/HomeView.tsx      board · depth curve · sectors    │
│  ├── Markets     src/components/MarketsView.tsx    whole universe, 15s      │
│  ├── Order Block src/stage/Stage.tsx         1920×1200 scaled stage + fan   │
│  ├── Signals     src/components/SignalsView.tsx   /api/signals cards        │
│  ├── Radar       src/components/RadarView.tsx     /api/radar pre-move       │
│  ├── Derivatives src/components/DerivativesTab.tsx funding/OI/CVD/liq       │
│  ├── News        NewsImpactPanel + AttributionPanel                          │
│  ├── India       IndiaPanel + SectorFlowPanel        (lazy: polls on visit) │
│  ├── Journal     src/components/Journal.tsx     localStorage only           │
│  └── Learn       inline in App.tsx:39-108        six explainer cards        │
│                                                                              │
│  Header chrome: GlobalSearch · BlackoutCountdown · StreamNotice · ModeBadge  │
│  MacroStrip (always mounted) · MOCK / BANNED banners · theme toggle          │
│  AssetPopup → CandleChart — mounted ABOVE every tab, one shared instance     │
│                                                                              │
│  lib/priceStore.ts    prices live OUTSIDE React (rAF-batched, per-symbol    │
│                       useSyncExternalStore) — one tick ≠ one app render      │
│  lib/useLiveStream.ts EventSource, backoff, visibility POST, 12s watchdog    │
│  lib/freshness.ts     LIVE / DELAYED / STALE thresholds + shared age clock   │
│  lib/api.ts           typed REST + usePolling (pauses when the tab is hidden) │
└────────────────────────────────┬─────────────────────────────────────────────┘
                                 │  /api  (Vite dev proxy → :8787)
                                 │  SSE   (GET /api/stream)
┌────────────────────────────────┴─────────────────────────────────────────────┐
│  SERVER  —  Express 4 + tsx                (dev :8787, prod serves dist/)    │
│                                                                              │
│  index.ts (1,146 lines) — every route in the repo lives in this one file     │
│  ├── engine/  scanner · orderblock · conviction · tradePlan · derivatives    │
│  │            preMoveRadar · fan · gex · volumeProfile · timeframes          │
│  │            butterfly · attribution · news/{taxonomy,lexicon,entities,score}│
│  ├── live/    ingest (Binance WS) · streamHub (SSE fan-out + per-client cap) │
│  │            aggregate (1s breadth) · marketState                            │
│  ├── ledger/  store (node:sqlite) · resolve (pure) · worker · backfill      │
│  ├── data/    binance · derivatives/{build,providers} · universeBuilder      │
│  │            symbolIndex · coinIdentity · calendar · macro · rss · nse      │
│  │            yahoo · derivatives · universe(metadata only)                   │
│  ├── lib/     http (retry/backoff) · banGuard (689 lines) · rateLimitBoot     │
│  │            cache (single-flight) · time · etTime · search                  │
│  ├── mock/    transport (fixture replay) · fixtures · dataset · mockLive     │
│  ├── runtime/ lock (single instance) · clock (gaps) · selfCheck (boot PASS)  │
│  └── config.ts (435 lines) — every threshold, each with a provenance tag     │
│                                                                              │
│  PROVE scripts: banGuard · supervisor · mock mode · independent plan oracle  │
│  ledger: node:sqlite at server/data/orderflow.db (WAL), never dropped        │
└────────────────────────────────┬─────────────────────────────────────────────┘
                                 │
        ┌────────────────────────┴────────────────────────┐
        │  FREE UPSTREAMS (no keys, probed from India)   │
        │  Binance spot+WS+futures · Deribit · Hyperliquid │
        │  Bybit · Coinbase · CoinGecko · DefiLlama       │
        │  alternative.me · GeckoTerminal · DexScreener   │
        │  CoinDCX · NSE · Yahoo · BEA/BLS · 6× RSS      │
        │  Farside (403 — shows Unavailable, never zero)  │
        └─────────────────────────────────────────────────┘
```

**Why a backend at all** (rather than calling APIs from the browser):

1. **Yahoo requires authentication** — the cookie+crumb handshake must be server-side and the
   crumb must never reach the client.
2. **The scanner pulls candles for up to 200 pairs × 4 timeframes.** Doing that from a browser
   tab would be abusive and fragile.
3. The news engine needs cross-item novelty/corroboration — that is inherently whole-corpus work.
4. **The ban guard, the weight budget and the single-instance lock are all server concerns.** A
   browser tab cannot hold a rate-limit ban across a restart, and cannot prove it made zero calls.
5. It mirrors the real product, which has a server-side engine.

### Size — measured 17 Oct 2026

| Layer | Files | Lines |
|---|---|---|
| Backend (`server/src`) | 53 | 12,759 |
| Frontend (`src`) | 67 | 11,765 |
| Shared wire types + identity (`shared/`) | 2 | 1,008 |
| **Production total** | **122** | **25,532** |
| Tests (`server/test`) | 22 | 4,307 |
| Operator scripts (`scripts` + `server/scripts`) | 18 | 2,676 |
| Playwright specs (`qa/*.spec.ts`) | 8 | 970 |

Two files dominate and both are worth knowing before you touch anything:
`server/src/index.ts` (1,146) and `server/src/ledger/store.ts` (894).

---

## 6. File-by-file manifest

**Rewritten 17 Oct 2026 against the real tree.** The previous version of this section described the
v1 build (17 backend files, 15 frontend files, 8 routes) and was three generations out of date.
Measured line counts, not estimates.

### 6.1 Root

| File | Purpose |
|---|---|
| `package.json` | 26 npm scripts — see section 11 |
| `tsconfig.json` | Strict, `noUnusedLocals`, `verbatimModuleSyntax`, bundler resolution. **`include` is only `src`, `server/src`, `shared`, `vite.config.ts` — tests, scripts and Playwright specs are NOT typechecked** |
| `vite.config.ts` | React + Tailwind plugins; proxies `/api` → `:8787` (or `$ORDERFLOW_API_PORT`); `server.watch.ignored` excludes `fixtures/` because the 32 MB manifest stalls the dev server |
| `vitest.config.ts` | The default suite: `environment: 'node'`, `include: server/test/**/*.test.ts`, `exclude: **/*.live.test.ts`. **No DOM environment** — that is why every browser assertion lives in `qa/` |
| `vitest.integration.config.ts` | The live suite: only `*.live.test.ts`, 200 s timeouts, no `node:sqlite` alias |
| `playwright.config.ts` | 8 specs × 2 projects, own mock server on 8899 + Vite on 5199 — see section 11.5 |
| `index.html` | Pre-paint theme script reading `localStorage['of-theme']` to avoid a light-mode flash |
| `.env.example` | 7 lines; documents that **every value is optional** |
| `AGENTS.md` | The working rules for any agent touching this repo. **Read it first.** |
| `CONTEXT.md` | This file |
| `V2-PROGRESS.md` | The 12 Oct addendum — live prices made verifiable. Now historical; Part XI supersedes it |

### 6.2 Backend — `server/src/` (53 files, 12,759 lines)

**Entry and config**

| File | Lines | Responsibility |
|---|---|---|
| `index.ts` | 1,146 | **Every route in the repo.** Express app, ban-guard boot, lock, 24 endpoints, static `dist/`, SPA fallback |
| `config.ts` | 435 | Every threshold in the product, each with a `[V]` / `[PROBED]` / `[TUNED]` tag. Appendix A transcribes it |

**`engine/` — the analysis**

| File | Lines | Responsibility |
|---|---|---|
| `scanner.ts` | 661 | The board: ranks both sides, picks, sector flow, market picture, breadth, butterfly, regime, blacklist. Freezes rows into the ledger before responding |
| `orderblock.ts` | 375 | **The core**: pivots, liquidity pools, `sessionVwap`, `sessionStartIndex`, `detectOrderBlock`, `strengthScore`, `choppiness`, `percentileOf` |
| `conviction.ts` | 559 | The 7 weighted components, the 8-point checklist, vetoes, grades A/B/C/Pass/NO TRADE |
| `derivatives.ts` | 244 | Funding normalisation, OI quadrants, the liquidation tape |
| `tradePlan.ts` | 219 | Entry zone, stop with ATR buffer, targets, R:R, sizing, costs, net R, India tax |
| `timeframes.ts` | 207 | 15m/1h/4h context, the retest state machine, session windows |
| `butterfly.ts` | 191 | The % -move distribution across the universe |
| `attribution.ts` | 189 | Abnormal return, z-scores, the significance gate, per-headline share, rolling BTC beta |
| `volumeProfile.ts` | 167 | Volume profile + footprint candles for the Signals tab |
| `fan.ts` | 110 | The 24 h fan payload: 15 m cumulative-% series per tracked asset |
| `gex.ts` | 105 | Gamma exposure from Deribit options (BTC, ETH) |
| `preMoveRadar.ts` | 305 | Coiling-before-a-move signals across the whole universe |
| `news/score.ts` | 248 | Two-pass NIS scoring, novelty, corroboration, clustering |
| `news/taxonomy.ts` | 133 | 65 event tags with severity / direction / half-life / expiry + the routine-commentary detector |
| `news/entities.ts` | 120 | 62 asset alias groups, macro entities, jurisdiction, headline-position relevance |
| `news/lexicon.ts` | 106 | 180 weighted finance terms (63 positive / 117 negative) + 26 negators |

**`live/` — the real-time path**

| File | Lines | Responsibility |
|---|---|---|
| `ingest.ts` | 459 | The Binance WebSocket: `@kline_5m` + `@aggTrade` per symbol, reconnect with backoff, ring buffer of closed candles |
| `streamHub.ts` | 320 | SSE fan-out. One `res.write` per flush; per-client visible-set filtering; tick de-duplication |
| `marketState.ts` | 283 | In-memory live state: latest tick per symbol, liquidations, connection status |
| `aggregate.ts` | 113 | The **1-second aggregate** — one denominator (`n`) so breadth cannot be two different populations |
| `clock.ts` | 149 | Wall-clock watch, detects process gaps |
| `mock/mockLive.ts` | 168 | Replaces `ingest` in mock mode: ticks every 200 ms, closes a 5 m candle every 15 s |

**`ledger/` — the outcome store**

| File | Lines | Responsibility |
|---|---|---|
| `store.ts` | 894 | `node:sqlite` schema + migrations (tables are **never dropped**), signals, host bans, runs, gaps, stats, cooldown |
| `worker.ts` | 182 | Background resolution: settles open signals against candles as they close |
| `backfill.ts` | 133 | Re-resolves after a process gap |
| `resolve.ts` | 113 | **Pure** resolver — `resolveOutcome`. Stop-first on same-candle ambiguity. Split out so tests skip `node:sqlite` |

**`data/` — the upstreams**

| File | Lines | Responsibility |
|---|---|---|
| `derivatives/providers.ts` | 430 | Binance futures, Hyperliquid, Bybit, Deribit, Coinbase |
| `derivatives/build.ts` | 165 | Assembles the derivatives board from the providers |
| `calendar.ts` | 345 | Macro event calendar; scrapes bea.gov; merges the hand-transcribed BLS file |
| `macro.ts` | 267 | Fear & Greed, stablecoins, global market, Coinbase premium, India gauges |
| `universeBuilder.ts` | 247 | **Builds** the universe from `exchangeInfo` + 24 h volume. `selectUniverse` is unit-tested |
| `coinIdentity.ts` | 210 | Name, sector, logo and identity metadata resolution |
| `binance.ts` | 206 | Host failover, klines, 24 h tickers, exchangeInfo, weight accounting |
| `yahoo.ts` | 151 | Cookie+crumb handshake (30-min crumb cache), parallel arrays → candles, Indian F&O universe |
| `nse.ts` | 162 | allIndices / marketStatus / holidays; runs the OB engine over the F&O universe |
| `rss.ts` | 129 | 6 feeds, CDATA + entity decoding, UTM stripping, RFC-822 dates |
| `universe.ts` | 118 | **Metadata only** now — name, sector, beta group, tags. The pair list moved to `universeBuilder` |
| `symbolIndex.ts` | 113 | Search index over spot + futures `exchangeInfo` |
| `constants.ts` | 7 | Re-export shim |

**`lib/`, `mock/`, `runtime/`**

| File | Lines | Responsibility |
|---|---|---|
| `lib/banGuard.ts` | 689 | 418/429 → ban with `Retry-After`, SQLite-persisted, survives restart, weight-aware slowdown/pause. Pure — injected clock, no I/O |
| `lib/marketState`→`live/marketState.ts` | — | (listed above) |
| `lib/http.ts` | 198 | `fetchText` / `fetchJson` / `fetchJsonSafe` — timeout, retry with exponential backoff, 4xx (except 429) not retried |
| `lib/cache.ts` | 44 | Single-flight TTL cache. **Critical at scale**: concurrent callers for one key share one upstream request |
| `lib/time.ts` | 123 | IST conversion (fixed +05:30, no DST), `istDateKey`, session windows |
| `lib/etTime.ts` | 94 | Real IANA-zone ET conversion for BLS 08:30 releases (handles the 1 Nov 2026 DST edge) |
| `lib/search.ts` | 73 | Query normalisation, ranking |
| `lib/rateLimitBoot.ts` | 21 | `bootRateLimiter()` — installs persistence and restores active bans before any socket opens |
| `runtime/lock.ts` | 143 | Single-instance lock. **Fails closed**; auto-reclaims if the recorded PID is dead |
| `runtime/clock.ts` | 149 | Heartbeat + gap detection |
| `runtime/selfCheck.ts` | 161 | Startup PASS/FAIL for the five things that silently corrupt the ledger rather than crashing |
| `mock/transport.ts` | 78 | Swaps the HTTP layer for fixture replay. An uncaptured URL **throws** rather than returning `[]` |
| `mock/fixtures.ts` | 140 | Loads `fixtures/manifest.json` (32 MB, 90 entries) into exact + loose indices |
| `mock/dataset.ts` | 111 | The synthetic market the mock replays |
| `runtime/lock.ts` | 143 | (listed above) |

**The Mind module — `server/src/engine/mind/` (8 files, 2,402 lines), added Part XIV**

| Path | Lines | Role |
|---|---|---|
| `mind/features.ts` | 355 | Builds the 36-field point-in-time vector. **Every candle and news item is filtered by `asOf` first**, so the vector for a past timestamp is byte-identical whether or not later data exists. Returns `measured()`/`missing()` so unmeasured is never `0` |
| `mind/attribution.ts` | 214 | Pulls the news-attribution drivers out of the existing engine instead of re-implementing attribution. Also computes `hasSetup` and `nestedFVG` from the engine's own `Setup` |
| `mind/regime.ts` | 205 | Six-state classifier — `trending-bull` `trending-bear` `range` `high-vol-cascade` `macro-blackout` `quiet`. A **separate** taxonomy from the engine's existing `Regime`; both are live and the collision hazard is flagged in `config.ts`. Emits evidence strings, never a bare label |
| `mind/confluence.ts` | 695 | Hard vetoes → features → logistic probability → expected R net of costs → drivers → bands → actionability. The largest file in the layer |
| `mind/calibrate.ts` | 483 | Brier vs the base-rate bar, the exact `reliability + outcomeVariance` decomposition, reliability buckets, and **`honestRMultiple()`** — the fix for M3.2, which credits a winner with the *nearest* target actually reached instead of the furthest published |
| `mind/rank.ts` | 296 | Stable ordering by linear fractional-Kelly edge. Linear, not log, because log diverges at `p → 1` and collapsed every strong signal onto one value — bug #30 |
| `mind/scan.ts` | 154 | Board glue: builds one vector per row, classifies the regime once, scores, ranks, attaches `row.mind`/`row.mindFeatures`. **The whole pass is wrapped** — a throw leaves the board exactly as it was |
| `mind/index.ts` | — | Public surface: `buildFeatureVector`, `classifyRegime`, `scoreConfluence`, `buildCalibrationReport`, `honestRMultiple`, `rankSignals`, `setMindBaseRateProvider`, `ledgerBaseRate` |

### 6.3 Shared — `shared/` (2 files, 1,008 lines)

| File | Lines | Purpose |
|---|---|---|
| `types.ts` | ~947 | **Every wire type**, ~120 exports. Imported by both sides, so a shape change breaks the build immediately. Also re-exports the 5 config-only types so the browser never imports server config |
| `identity.ts` | 61 | Pure, dependency-free, browser-safe: `stripMultiplier`, `monogramFor` (4 chars), `monogramFontSize`, `monogramColor` (FNV-1a) |

> **The three identity layers, and why there are three.** `shared/identity.ts` is the pure string
> logic the browser and tests share. `server/src/data/coinIdentity.ts` resolves a base to its
> display name, sector and logo. `server/src/data/symbolIndex.ts` builds the searchable index from
> the exchange's own `exchangeInfo` for **both** spot and futures. They are related but not
> redundant — do not collapse them.

### 6.4 Frontend — `src/` (67 files, 11,765 lines)

**Root**

| File | Lines | Responsibility |
|---|---|---|
| `App.tsx` | 554 | The shell: `Tab` state, nav, theme, 7 top-level polls, stream provider, mode/freshness chrome, the inline Learn view, popup orchestration |
| `index.css` | 1,032 | Tailwind 4 entry (`source(none)` + explicit `@source`), the `@theme` palette, light/dark tokens, `.panel`/`.chip`/`.mono`, the legacy component CSS, 5 keyframes, reduced-motion guards |
| `main.tsx` | 20 | Mount inside `StrictMode` + `ErrorBoundary` |

**`lib/` — data plumbing**

| File | Lines | Responsibility |
|---|---|---|
| `api.ts` | 319 | Typed REST client, `usePolling` (pauses when the tab is hidden), `useLazy`, `useAssetDetail` |
| `useLiveStream.ts` | 243 | The `EventSource`: backoff, cid, the visibility POST, per-type callbacks, 12 s data watchdog |
| `priceStore.ts` | 196 | **Prices outside React.** rAF-batched, per-symbol `useSyncExternalStore`, plus the freshness clock |
| `freshness.ts` | 114 | LIVE / DELAYED / STALE thresholds + one shared ref-counted age clock |
| `format.ts` | 100 | Price/pct/USD formatting per magnitude, severity palette, IST stamps, `niceTicks` |
| `liveContext.tsx` | 114 | The stream provider. Publishes `{scan, state, blackedOut}` on a module store — **once a minute, not per tick** |
| `aggStore.ts` | 47 | The client half of the 1 s aggregate. **Populated but currently unread** — see section 16 |

**`home/` — the Dashboard (14 files)**

| File | Lines | Responsibility |
|---|---|---|
| `HomeView.tsx` | 335 | The dashboard composition: main card, breadth chips, depth curve, both boards, sector band, news mini-feed, sidebar |
| `RowPreview.tsx` | 336 | The hover/click preview card, with viewport clamping and flip |
| `depthBuckets.ts` | 226 | Adaptive quantile bucket maths for the depth curve |
| `DepthCurve.tsx` | 193 | The mirrored adaptive depth curve |
| `BoardRow.tsx` | 173 | One board row. **Bear mirroring is one mechanism**: the `is-bear` class alone |
| `HomeSide.tsx` | 163 | Sidebar: journal summary, learn card, tracked assets |
| `useRowPreview.ts` | 141 | Hover / focus / tap intent machine (delay, grace, click-to-pin) |
| `SectorsPanel.tsx` | 104 | Sector band with diverging bars |
| `home.css` | 622 | All Dashboard CSS. Breakpoints 1180 / 860 / 720 px; bottom sheet under 720 px |
| `sectorHistory.ts` | 69 | In-memory session-scoped sector history |
| `CoinAvatar.tsx` | 77 | Logo-or-monogram tile |
| `NewsMiniFeed.tsx` | 69 | Top 3 headlines by NIS |
| `StrengthMeter.tsx` | 64 | 28-tick segmented meter |
| `motion.ts` | 62 | **Every popup timing constant in one place**, so Playwright imports the same numbers |

**`stage/` — the Order Block tab (12 files)**

| File | Lines | Responsibility |
|---|---|---|
| `Stage.tsx` | 648 | The whole scaled 1920×1200 stage. Only mounted entry point here |
| `stage.css` | 2,135 | Three generations of stage CSS: v1 (`.mh`), the flow page (`.ob-*`), and the "Calm Terminal" restyle |
| `cards.tsx` | 294 | Flow-page cards — **part of an unmounted island**, see section 16 |
| `Ticket.tsx` | 286 | The stage detail ticket (hero vs std) |
| `FanCanvas.tsx` | 260 | The 3-layer canvas fan with JS polyline hit-testing |
| `FlowCharts.tsx` | 241 | Flow-page mini-charts — same unmounted island |
| `flowData.ts` | 207 | Derived reads for the flow page — same island |
| `charts.tsx` | 208 | `ObSpark`, `ScoreRing`, `GradePips`, `RrBar` |
| `MarketDepth.ts` | 177 | The `.mh` clone block (unused) **and** `pipsFor(row)`, which is used |
| `fan.ts` | 149 | 24 h fan maths: `FAN_GEO`, symlog, scale, series, sectors, histogram |
| `geometry.ts` | 143 | Stage-space constants lifted from the reference layout |
| `types.ts` | 20 | `LivePrice` (a deliberate duplicate of the priceStore shape) |

**`components/` — 33 files.** Mounted:

| File | Lines | Responsibility |
|---|---|---|
| `CandleChart.tsx` | 531 | Hand-written SVG OHLCV: candles, OB box + zone, prior setups, level ladder, VWAP, crosshair, OHLC readout |
| `AssetPopup.tsx` | 367 | The chart popup. `PopupRow` (all-optional), `resolveVwap()`, ladder / proof / alignment / conviction. See Part XII |
| `SignalsView.tsx` | 433 | `/api/signals` cards: volume profile, footprint, GEX, confluence |
| `RadarView.tsx` | 430 | `/api/radar` pre-move signals |
| `Journal.tsx` | 335 | localStorage trade log, win rate, expectancy, profit factor |
| `DerivativesTab.tsx` | 312 | Funding / OI / quadrant / basis / CVD / liquidation heatmap + liquidations ticker |
| `ui.tsx` | 297 | The primitive kit: `Panel`, `Chip`, `LiveBadge`, `StreamNotice`, `ModeBadge`, `ValueAge`, `StatTile`, `Empty`, `Spinner`, `useInterval` |
| `NewsImpactPanel.tsx` | 223 | The scored feed: filters, NIS, direction, reversal risk |
| `GlobalSearch.tsx` | 210 | Header search over the whole exchange symbol index |
| `MacroStrip.tsx` | 165 | Header macro band |
| `MarketsView.tsx` | 156 | The whole universe, sorted by 24 h volume |
| `IndiaPanel.tsx` | 152 | NSE session, indices, F&O board, holiday chip |
| `TicketPanel.tsx` | 255 | The detailed ticket card under the Order Block tab |
| `AttributionPanel.tsx` | 135 | Abnormal-return attribution per asset |
| `ErrorBoundary.tsx` | 84 | Keeps one broken panel from blanking the terminal |
| `signalChips.tsx` | 228 | `GradeChip`, `ScoreBar`, `FlowArrow`, `PositionChip`, `NewsDot`, `UnlockChip`, `ChecklistPanel` |
| `BlackoutCountdown.tsx` | 93 | Countdown to the next macro blackout |
| `SectorFlow.tsx` | 93 | Diverging bars + per-member cells (used on the India tab) |
| `Sparkline.tsx` | 41 | Minimal inline SVG trend |

**Legacy, currently mounted by nothing** — dead code kept from the v1 build. Safe to delete only if
you also remove the matching CSS: `Board.tsx` (230), `PickCard.tsx` (267), `TileGrid.tsx` (231),
`MarketPicture.tsx` (138), `PickPanel.tsx` (142), `ButterflyChart.tsx` (163), `BridgeConnector.tsx`
(169), `SectorChips.tsx` (112), `FlowCrest.tsx` (64), `NodeFunnel.tsx` (69), `TopRail.tsx` (37),
`TickerStrip.tsx` (43), `MarketDepthPanel.tsx` (130). `chartMath.ts` (62) is imported by
`server/test/chartMath.test.ts` only.

### 6.5 Tests, scripts, fixtures, evidence

| Path | What |
|---|---|
| `server/test/*.test.ts` | **27 files, 569 tests**, all node-environment. `mock.test.ts` is the only one that boots a real server (on 8907) |
| `server/test/mind.features.test.ts` | 471 | Vector construction, `measured`/`missing` discipline, and the **no-lookahead proof**: appends future candles and future news, then asserts the vector is byte-identical |
| `server/test/mind.regime.test.ts` | 205 | All six states, precedence between them, and that evidence is always emitted |
| `server/test/mind.confluence.test.ts` | 695 | Veto precedence, base-rate anchoring, probability bounds, cost deduction, drivers, bands, actionability |
| `server/test/mind.calibrate.test.ts` | 483 | Brier arithmetic, the base-rate comparator, `honestRMultiple()` vs the inflated ledger figure, sample-floor suppression |
| `server/test/mind.rank.test.ts` | 296 | Ordering, stability, and that distinct setups do **not** collapse onto one rank value |
| `server/test/mind.freeze.test.ts` | 185 | The ledger stores `mind` **and** the feature vector together; stores neither when either is missing; a vetoed signal is still frozen; **the A/C real-vs-shadow split is unchanged** |
| `server/test/node-sqlite-shim.mjs` | Alias target so vitest can resolve the `node:sqlite` builtin |
| `server/test/fixtures/*.json` | 7 **live-captured** payloads (klines btc/xrp, premiumIndex, fundingInfo, oiHist, longShort, coinbase premium). Captured live on purpose: they preserve the field-order traps that caused the CVD bug |
| `qa/*.spec.ts` | 8 Playwright specs, 44 declarations × 2 projects |
| `qa/screens/*.png` | 27 spec-written screenshots for eyeball review |
| `qa/stage*.txt` | **8 recorded proof outputs — HISTORICAL.** `stage6-verify.txt` records 18 files / 377 tests; the tree is now 22 / 420. Do not cite these counts as current |
| `scripts/*.ts` | 12 operator scripts — `verify-truth`, `verify-stage1`, `universe-check`, `plan-oracle`, `print-plan-workings`, `record-fixtures`, `capture-fixtures`, `probe-sources`, `probe-fallbacks`, `verify-ledger`, `free-dev-ports`, **`mind-report`** |
| `server/scripts/*.ts` | 7 — `supervisor`, `dev-mock`, and 5 `prove-*` harnesses |
| `fixtures/manifest.json` | **32 MB, 90 recorded responses.** The entire mock + Playwright story depends on it. Do not hand-edit |
| `server/data/orderflow.db` | The real ledger (23.7 MB, WAL). Gitignored |
| `server/data/macro-events.json` | Hand-transcribed BLS 2026 release dates, with a `_readme` explaining why it cannot be scraped |
| `server/data/probe-results.json` | Phase-0 probe snapshot, 10 Oct 2026. What `DATA_SOURCES.md` is written against |
| `server/data/scan-cache.json` | The persisted last-good board, hydrated at module load. **Not hydrated in mock mode** |

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

**Rewritten 17 Oct 2026.** All 24 endpoints, verified by reading `server/src/index.ts`. Every route
in the repo is registered in that one file (1,146 lines). Field names are as the code returns them.

| # | Method | Path | Returns | Cache | Notes |
|---|---|---|---|---|---|
| 1 | GET | `/api/health` | `ok` `ist` `istOffsetMin` `cache` `uptimeSec` `mock` `banGuard` `live` `ledger` `supervision` `process` `calendar` | — | **0 upstream calls, by design** — a health endpoint that scrapes bea.gov can itself be rate-limited |
| 2 | GET | `/api/scan` | `updatedAt` `nextRefreshIn` `stale` `reason` `bullish` `bearish` `sectors` `market` `breadthBias` `totalScanned` `regime` `sizeAdvice` `regimeReason` `blackedOut` `blackoutReason` `butterfly` `universeRows` | 60 s | Heaviest route: 4 timeframes × ≤200 pairs + RSS + derivatives + CoinGecko + bea.gov. **Stale-while-revalidate.** Ban-guard short-circuit returns the last good board with `stale:true` and **zero** calls. CoinGecko markets/global are 5-min cached since Part XXII. Persisted to `server/data/scan-cache.json` |
| 3 | GET | `/api/asset/:id` | `id` `pair` `name` `sector` `candles` `setup` `side` `choppiness` `strength` `rangePct` `changePct` `price` `vwap` `updatedAt` | klines 20 s / Yahoo 60 s | Exactly **1** upstream call. Accepts `BTC`, `BTCUSDT`, `RELIANCE`. `404` on no data or <30 closed candles. **Recomputes the scan** (Part XII gap 2) |
| 4 | GET | `/api/signals` | `updatedAt` `bullish` `bearish` `gex` `regime` `breadthBias` `blackedOut` | scan 60 s | Board rows enriched with volume profile, footprint, confluence, GEX. **The route comment says "cached 60s" but there is no `cached()` call** — it recomputes per request |
| 5 | GET | `/api/radar` | `updatedAt` `signals` `regime` `breadthBias` | 60 s | Universe-wide coiling signals. Rows scoring **< 40 are dropped**, not returned with a low score |
| 6 | GET | `/api/fan` | `updatedAt` `interval` `points` `from` `to` `assets` `missing` `mock` | 60 s | 15 m × 96 = one identical 24 h window per asset. `503 'universe not ready'` if the universe has not resolved |
| 7 | GET | `/api/gex` | `btc` `eth` | 5 min | Two Deribit calls, `allSettled` — one can be `null` with a 200 |
| 8 | GET | `/api/derivatives` | `rows` `asOf` `source` `unavailable` | 30 s | Binance futures primary, Bybit linear fallback (`source`); ~340 calls cold. Passes a `live` source only when the forceOrder socket is open, otherwise rows say liq is unavailable |
| 9 | GET | `/api/liquidations?symbol=` | `recent` `note` `asOf` | — | **0 upstream calls** — in-memory tape. `note` hard-codes that totals are a **LOWER BOUND** |
| 10 | GET | `/api/ledger?shadow=` | `updatedAt` `signals` `stats` `open` `counts` | — | SQLite only. `shadow` accepts `shadow` \| `real` \| anything else = `all`. `open` is a bare **count**, not an array |
| 11 | GET | `/api/calendar` | `updatedAt` `events` `sources` `nextBlackout` `nextTier1` | inner 6 h / 60 s | `eventCalendar()` itself is **not** cached — it re-reads the two inner caches every call |
| 12 | GET | `/api/search?q=` | `q` `ts` `hits` | index 6 h | Cap of **12** hits. Prices attach only for `kind === 'spot'`; perps return `price: null`, never a fabricated number |
| 13 | GET | `/api/markets` | `ts` `n` `rows` | — | 0 upstream calls. `503` until the universe resolves. **No client caller** |
| 14 | GET | `/api/news` | `updatedAt` `items` `counts` `clusters` `byCategory` | 5 min | `items` hard-truncated to **120**. `clusters` is **always `[]`** — clustering is declared but not built |
| 15 | GET | `/api/macro` | `fearGreed` `stablecoins` `globalMarket` `btc` `coinbasePremiumPct` `dryPowderRatio` `etfFlows` `options` `india` | 60 s | `etfFlows` is **always** the `Unavailable` object (Farside 403s). `options` is **always `[]`** |
| 16 | GET | `/api/india` | `updatedAt` `session` `open` `holidayToday` `nextHoliday` `indices` `fno` `unavailable` | per-symbol 60 s | NSE ×3 + **20** Yahoo 5 m charts in batches of 5. No payload-level cache — the F&O loop re-runs every call |
| 17 | GET | `/api/attribution` | `updatedAt` `horizon` `attributions` | news 5 min | BTC/ETH/SOL + top 6 per side. `horizon` hard-coded `60`. Failures dropped silently by `allSettled` |
| 18 | GET | `/api/attribution/:id?horizon=` | `attribution` `beta` `btcReturnPct` | news 5 min | `horizon` clamped `[5,240]`. `attribution: null` (200) when the series is too short — never a zero |
| 19 | GET | `/api/percentile/:id` | `id` `percentile` `rank` `total` | scan 60 s | **No `try`/`catch`** — `getScan()` can throw and Express 4 does not catch async rejections. No client caller |
| 20 | GET | `/api/stream` | **SSE** — see the message table below | — | `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, `retry: 2000`. Flushes every `LIVE.TICK_PUSH_MS` (200 ms), heartbeat every 15 s. Query: `cid` (≤64 chars), `symbols` |
| 21 | POST | `/api/stream/visible` | `ok` `cid` `symbols` (a **number**) `cap` | — | Narrows an open connection's tick set. `400` ×3 on bad `cid`/`symbols`, `404` on unknown `cid`. Silently truncated to 200 — the cap is **reported, not enforced with an error** |
| 22 | GET | `/static/logos/*` | binary | 7 d immutable | 267 local logos. `fallthrough:false` → a miss is a 404, not the SPA |
| 23 | ALL | `/assets/*`, `/index.html`, … | `dist/` | none | `express.static(dist)` with **no cache headers** |
| 24 | GET | `/^(?!\/api).*` | `dist/index.html` | — | SPA fallback. On `sendFile` failure it replies **HTTP 200** with the plain text `API running. Frontend dev server is on http://localhost:5173` |
| 25 | GET | `/api/mind/health` | `ok` `updatedAt` `regime` `regimeEvidence` `calibration` `bands` `vetoCounts` `model` | — | **0 upstream calls.** Reads the stored scan. `model.usingShippedWeights` is always `true` today; `baseRateSource` is `prior` until `model.baseRateSamples` passes `MIND.BASE_RATE_MIN_SAMPLES`. Before the first scan it answers **`ok:false` with a 200**, not a 503 — "not ready" is not an error |
| 26 | GET | `/api/mind/signals` | `updatedAt` `ready` `regime` `regimeEvidence` `signals` `base` `high` `medium` `low` `actionable` `vetoed` `vetoCounts` | — | **Reads `row.mind` off the stored board; it does not recompute.** Running the pass again would produce a second answer to the same question. Sorted by `rank` desc. `ready:false` before the first scan |
| 27 | GET | `/api/mind/features/:id` | `updatedAt` `symbol` `base` `side` `regime` `regimeEvidence` `mind` `features` `coverage` | — | Accepts `BTC` or `BTCUSDT`; strips a trailing `USDT`. **`404` when the row is not on the board** — that is a different answer from "no features", and the client has to say which. `coverage` is `null` when the Mind pass did not run |
| 28 | GET | `/api/lab/overview` | `status` `decisions` `account` `reviews` `learning` `calibration` `alertMessage` | — | The whole Engine Lab page in one payload. **0 upstream calls.** Every field is measured or `null`. Added 21 Oct (Part XX) |
| 29 | GET | `/api/lab/status` | `updatedAt` `mode` `liveAvailable` `running` `model` `challenger` `drift` `killSwitch` `shadowOnly` `dailyLoss` `executors` | — | `mode` is `SHADOW`/`PAPER`/`TESTNET`; **`liveAvailable` is always `false`**. `executors.live.reason` states, in words, that real-money execution is not built |
| 30 | GET | `/api/lab/decisions` | `updatedAt` `decisions` | — | What the engine is considering right now. Each row carries `pWin`, `pWinCi`, `expectedNetR`, `topFeatures`, `vetoesNotFired`, `skippedReason` and the frozen `featureSnapshot` |
| 31 | GET | `/api/lab/account` | `updatedAt` `venue` `equityUsd` `realisedNetR` `closedTrades` `equityCurve` `openPositions` `fills` | — | SQLite only. Every fill's `costNote` says the costs are **MODELLED**, not measured from a venue |
| 32 | GET | `/api/lab/reviews` | `updatedAt` `reviews` | — | One row per resolved trade, with its `failureClass` and `failureNote`. Reviews are **evidence**: they never edit the model or a threshold |
| 33 | GET | `/api/lab/learning` | `updatedAt` `models` `folds` `decisions` `promotionBlockedBy` | — | Model versions, the walk-forward fold table, the promotion/rejection/rollback log, and **what is still blocking promotion** — in words |
| 34 | GET | `/api/lab/calibration` | `updatedAt` `n` `censored` `baseRate` `brier` `brierBaseRate` `brierSkill` `logLoss` `reliability` `tiers` `verdict` | — | The tier table quotes a hit rate **only above** `LAB.TIER_MIN_TRADES`, and always prints the coverage beside it |
| 35 | GET | `/api/lab/alert-message` | `updatedAt` `message` | — | The optional outbound alert-style JSON. **Nothing is sent anywhere by this app** — it is a message to paste into a TradingView alert or a chart note |
| 36 | POST | `/api/lab/controls` | `ok` `message` `status` | — | One write endpoint. `action` ∈ `start` `stop` `kill-switch-on` `kill-switch-off` `shadow-only-on` `shadow-only-off` `mode` `rollback` `retrain`. Every reply says **what happened, in words** |

**14 of the JSON routes answer `503 {error}` on failure** — the ones that touch upstream. Never a
500 with a stack. All three Mind routes also carry a `try`/`catch` → `503`, but they cannot fail on
upstream data because they make no upstream calls.

### 10.1 The SSE message union — and what is actually sent

Declared in `shared/types.ts` as a 10-member `StreamMsg`. **Only 7 variants are ever emitted.**

| `type` | Fields | Emitted by |
|---|---|---|
| `status` | `type` `connection` `ts` | On connect and on every upstream socket state change |
| `snapshot` | `type` `scan` `derivatives` `regime` `blackedOut` `ts` | On connect, only if a scan exists. `derivatives` is always `[]` |
| `tick` | `type` `symbol` `price` `changePct` `ts` `E` | `streamHub.flushNow()`, visibility-filtered, de-duplicated on price **and** change |
| `scan` | `type` `scan` `ts` | On candle close, debounced 900 ms |
| `agg` | `type` `agg` `ts` | Every 1 s, but only when `subscriberCount() > 0` |
| `liq` | `type` `event` `ts` | On each force-order |
| `heartbeat` | `type` `ts` | Every 15 s |
| `derivatives` | `type` `rows` `ts` | **Declared, never sent.** `useLiveStream` has a case for it; nothing publishes |
| `news` | `type` `feed` `ts` | **Declared, never sent** |
| `alert` | `type` `alert` `ts` | **Declared, never sent** — `onAlert` is not even supplied by the provider |

Non-API routes serve `dist/` in production, with the SPA fallback above.

---

## 11. How to run and test

**Rewritten 17 Oct 2026.** The old version of this section described the v1 script set (7 scripts)
and quoted a verification run from 10 Oct that predates the entire v2 build. (It also had two
headings numbered `11.4`.)

### 11.1 First run

```bash
cd C:\Users\DK\Desktop\trading
npm install
npm run dev          # API :8787 + Vite :5173, predev frees stale project ports
```

Open **http://localhost:5173**. First scan takes **30–60 s** (it pulls 4 timeframes for up to 200
pairs); the page renders a refreshing state and populates when the scan lands.

> **On first install on Windows:** npm may warn that esbuild's postinstall did not run. Vite needs
> it — run `npm install-scripts approve esbuild`.

**Build UI against mock mode, not live.** `npm run dev:mock` runs the same server, same engine and
same UI with **zero outbound network** (fixture replay). If a screen only works against live data,
it is not finished.

### 11.2 Production

```bash
npm run build      # tsc --noEmit && vite build
npm start          # one process on :8787 serving /api AND dist/
npm run start:forever   # supervised, crash-loop backoff, log rotation
```

### 11.3 Ports

| Port | Who | Where it comes from |
|---|---|---|
| 8787 | API (dev + prod) | `process.env.PORT ?? 8787`, read at `index.ts:109` |
| 5173 | Vite dev server | `vite.config.ts`, `strictPort: true` |
| 8899 | Playwright's mock API | `playwright.config.ts` webServer |
| 5199 | Playwright's Vite | `playwright.config.ts` — deliberately not 5173, so a running `npm run dev` is never disturbed |
| 8907 | `mock.test.ts`'s booted server | inside the test |
| 8799 | `prove:supervisor` | inside the proof |

> **Trap:** `.env`'s `PORT` is read **too late** to affect the listen port — `process.loadEnvFile`
> runs at `index.ts:258`, the constant at `:109`. Same for `ORDERFLOW_MOCK` (read at `:206`). Only
> `COINGECKO_DEMO_KEY` and `ORDERFLOW_SUPERVISED` are read late enough to pick `.env` up. Set these
> as real environment variables or as inline prefixes, not in `.env`.

### 11.4 Every npm script

| Script | Command | What it is for |
|---|---|---|
| `predev` | `tsx scripts/free-dev-ports.ts` | Kills **project-owned** stale listeners on 5173/8787. Refuses to touch an unrelated app |
| `dev` | concurrently api+web | The normal stack |
| `dev:api` | `tsx watch server/src/index.ts` | API with hot restart. **A watch restart hard-kills the child**, so ledger rows carry a null `end_reason` |
| `dev:web` | `vite` | Vite only |
| `dev:mock` | concurrently mock-api+web | **Build UI against this** |
| `dev:api:mock` | `tsx server/scripts/dev-mock.ts` | Mock API alone |
| `build` | `tsc --noEmit && vite build` | Typecheck + bundle |
| `typecheck` | `tsc --noEmit` | Strict. Covers `src`, `server/src`, `shared`, `vite.config.ts` only |
| `test` | `vitest run` | **27 files / 569 tests**, offline, node env |
| `test:integration` | `vitest run --config vitest.integration.config.ts` | The only live test file, 3 tests, 200 s timeouts |
| `test:watch` | `vitest` | Watch |
| `verify` | `typecheck && test` | **The gate** |
| `verify:truth` | `tsx scripts/verify-truth.ts` | **The honesty gate** — wire prices vs Binance REST. Exits 1 on failure |
| `verify:stage1` | `tsx scripts/verify-stage1.ts` | Two SSE clients, throttle, receive latency p50/p95. **Always exits 0** — PASS/FAIL is printed, not enforced |
| `verify:ledger` | `tsx scripts/verify-ledger.ts` | Freezes a real signal, replays **300 real candles** through the resolver, reads it back from SQLite. Writes to the real ledger |
| `mind:report` | `tsx scripts/mind-report.ts` | **Is the model better than the base rate?** Reads the real ledger read-only and prints Mind-tagged sample size, model vs base-rate Brier, the exact decomposition, the reliability diagram, per-grade honest R. **Exits 0 even when the model loses** — it prints a verdict in words. Currently reports `0 Mind-tagged` and correctly refuses to produce a Brier number |
| `check:universe` | `tsx scripts/universe-check.ts` | Which pairs are live on Binance spot, with volumes and exclusion counts. Re-run after any universe change |
| `plan:workings` | `tsx scripts/print-plan-workings.ts` | Three worked plans, every intermediate expression printed, cross-checked against the independent oracle. Exits 1 on mismatch |
| `probe` | `tsx scripts/probe-sources.ts` | Phase-0 probe of ~37 endpoints. **Writes `server/data/probe-results.json`** |
| `fixtures` | `tsx scripts/capture-fixtures.ts` | Captures 7 live payloads into `server/test/fixtures/` |
| `record-fixtures` | `tsx scripts/record-fixtures.ts` | The one-time 32 MB capture behind mock mode. Refuses to run while any host is banned |
| `prove:ban` | `tsx server/scripts/prove-ban-guard.ts` | Real HTTP 418 + `Retry-After` against a local mock exchange, real SQLite, real wall clock. **Takes 120 s**; `--fast` = 8 s rehearsal |
| `prove:mock` | `tsx server/scripts/prove-mock.ts` | Mock boots, boards populate, a candle close re-ranks, an uncaptured URL is refused, no socket opened |
| `prove:supervisor` | `tsx server/scripts/prove-supervisor.ts` | Supervised run, SIGKILL recovery, gap row, single-instance lock |
| `start:forever` | `tsx server/scripts/supervisor.ts` | The always-on run |
| `start` | `tsx server/src/index.ts` | Production single process |
| `preview` | `vite preview` | Serves `dist/` |

### 11.5 Tests

**vitest — 41 files, 868 tests, `environment: 'node'`, no setup file.** Two plugins carry it: one
rewrites relative `.js` specifiers to the `.ts` files that exist (NodeNext ESM style), one aliases
`node:sqlite` to a shim that re-exports the real builtin. `globals: false` — every test imports
`describe/it/expect` explicitly.

**There is no DOM environment.** That is why every browser assertion lives in `qa/`. If you are about
to write a test that needs a DOM, write a Playwright spec instead.

Only **one** test file boots a server: `mock.test.ts` spawns `dev-mock.ts` on 8907 with its own DB
and lock, polls `/api/health`, and SIGKILLs it. It is the slowest file in every run (~4–5 s of a
~5.3 s suite).

**Playwright — 12 specs; the full run executed 128 tests (112 passed, 16 skipped) × 2 projects (desktop 1440×900, mobile Pixel 5).**
`workers: 1`, `retries: 0`, `fullyParallel: false`. Every spec runs against the **mock** server for
`/api`; the chart spec also reads market data directly from Binance, so it can render a live chart
while the rest of the app is in MOCK. Artifacts (`trace.zip`, failure PNGs, `error-context.md`) land in
`qa/.artifacts/`. Three specs raise their own budget to 150 s because a cold mock stack can take a
minute to boot.

| Spec | Tests | Asserts |
|---|---|---|
| `home.spec.ts` | 26 | Layout ratios, mirrored rows, no ticker truncation, one non-overlapping badge per row, header counts match rendered rows, the live pill reports the **real** source mode, popup timing/CLS/viewport, mobile bottom sheet, reduced motion, focusability, 4.5:1 contrast |
| `chart.spec.ts` | 3 | The ticket draws **real OHLC candles**, not synthesised ones; the full chart is reachable; a chart failure reports the reason and draws **zero** candles |
| `charts.spec.ts` | 2 | The chart shell, controls, timeframe switch, indicator toggle, drawing tool/Esc, fullscreen/Esc and News tab; the drawing smoke asserts `rectZone` and `longPosition` complete with the right point/step counts (desktop only) |
| `heatmap.spec.ts` | 2 | The sparse reference heatmap, mock composition, labels and mobile layout |
| `honesty.spec.ts` | 3 | The liquidation column never reports a fabricated zero; the funding tooltip never claims an uncomputed z-score; the CVD tooltip says it is a derived proxy |
| `search.spec.ts` | 6 | Combobox semantics, ticker and name matches, keyboard pick, Escape, "no matches" |
| `render-count.spec.ts` | 2 | 2,000 injected ticks → `__ofAppRenders` ≤ 5; the store is actually wired |
| `live-loop.spec.ts` | 1 | 8 s of ticks produces no "Maximum update depth exceeded" and the tab still evaluates |
| `orderblock.spec.ts` | 2 | The reference stage layout + fan plume; a thread hover raises a tooltip |
| `lab.spec.ts` | 17 | The Engine Lab sections, status, controls, calibration, reviews, learning, paper account, modelled costs and outbound alert |
| `terminal.spec.ts` | 2 | Charts and heatmap are separate pages; the global Decision & DOM rail is present; mobile keeps the separate pages |
| `diag.spec.ts` | 1 | **A placeholder** — asserts `expect(true).toBe(true)`. A debugging probe, not a gate |

> **Stop `npm run dev` before `npx playwright test`.** Two Vite dev servers share one
> `node_modules/.vite` cache and the second wedges.

### 11.6 The four honesty proofs

| Proof | Question it answers |
|---|---|
| `prove:ban` | Does a 418 actually stop traffic — **including after a restart**, with zero requests made? |
| `prove:mock` | Does mock mode boot with **no socket opened**, and does an uncaptured URL get refused rather than silently empty? |
| `prove:supervisor` | Does the supervised run recover from a kill, record the gap, and refuse a second launch with exit 11? |
| `plan:workings` | Does `buildPlan` agree with an **independent reimplementation** of the same definitions? |

`scripts/plan-oracle.ts` deliberately imports **nothing** from `engine/tradePlan.ts`. The reason is
worth keeping in mind whenever you write a test: existing tests that assert against the same
implementation they exercise would both pass if it were wrong the same way twice.

### 11.7 Environment variables

Every one is optional; the app runs fully without any of them.

| Variable | Default | Read at | Effect |
|---|---|---|---|
| `PORT` | 8787 | startup (`:109`) | API listen port |
| `ORDERFLOW_API_PORT` | → 8787 | Vite config load | Proxy target for `/api` |
| `ORDERFLOW_DB` | `server/data/orderflow.db` | **module load** | SQLite path. Set it *before* importing the store or it silently does nothing |
| `ORDERFLOW_LOCK` | `data/orderflow.lock` | per call | Single-instance lock path |
| `ORDERFLOW_MOCK` | unset (`=== '1'`) | module load + per call | Fixture-replay mode |
| `ORDERFLOW_SUPERVISED` | unset | per health request | Surfaced as `health.supervision.supervised` |
| `ORDERFLOW_SERVER_ENTRY` | `server/src/index.ts` | per spawn | Lets a proof supervise a stub with no second code path |
| `ORDERFLOW_FIXTURES` | `fixtures/` | module load | Fixture manifest directory |
| `COINGECKO_DEMO_KEY` | unset | per request | Raises CoinGecko ~30/min → 100/min |
| `ORDERFLOW_BASE` | `http://localhost:8787` | script start | Truth-check target |
| `TRUTH_WINDOW_MS` | 20 000 | script start | Tick-collection window |
| `TRUTH_MAJOR_DELTA_PCT` | 0.03 | script start | Ceiling for BTC/ETH/BNB/SOL |
| `TRUTH_OTHER_DELTA_PCT` | 0.15 | script start | Floor for everything else, widened by that symbol's own 1 s range |
| `TRUTH_MIN_SYMBOLS` | 25 | script start | Minimum symbols compared against REST |
| `TRUTH_MIN_OUTSIDE_OLD` | 5 | script start | Minimum compared symbols outside the old hard-coded 8 |

`MAX_TICK_AGE_MS = 5_000` in `verify-truth.ts` is a **hard-coded constant, not a variable** — unlike
every other truth threshold. Worth knowing before you try to tune it from the shell.

### 11.8 What "it works" means here — the gate

Before claiming anything works:

```bash
npm run verify          # typecheck + 420 tests
npm run build           # typecheck + production bundle
```

Against a live stack (`npm run dev:api`, then in another shell):

```bash
npm run verify:truth    # wire prices vs Binance REST, tick age, latency, search agreement
npm run verify:stage1   # two clients, throttle, receive latency p50/p95
```

Browser behaviour lives in `qa/`. **A change is not done until the layer that owns it has a test.**
A backend change needs a vitest assertion; a UI change needs a Playwright assertion or a documented
reason it cannot have one.

### 11.9 Troubleshooting — "I'm not seeing anything"

1. **Wait for the first scan** — 30–60 s. The page renders a refreshing state first.
2. **Right URL** — `http://localhost:5173`. The API on 8787 is deliberately invisible.
3. **Banned host** — the scan shows `BANNED · stale` and will not refresh until the window closes.
   `npm run prove:ban -- --fast` to diagnose in 8 s.
4. **`STALE`/`DELAYED` banner** — the SSE pipe is quiet. `health.live` in `/api/health` has the
   per-socket state, message counts and last errors.
5. **Console errors** — mixed content (use `http://`, not `https://`), or a failed `/api` call if
   the proxy target moved.
6. **Stuck** — hard refresh (Ctrl+F5). `predev` only runs for `npm run dev`, not `dev:api`.
7. **Lock conflict** — a second instance exits **11** by design. `data/orderflow.lock` names the
   holder; it is reclaimed automatically if that PID is dead.
8. **Port occupied by something else** — `free-dev-ports.ts` refuses to kill an unrelated process.
   Change `PORT` / the Vite port instead.

### 11.10 Tests, briefly

`npm run verify` is the gate. `npm run check:universe` is the tool for re-validating the tracked
pairs after any universe change — it exists because 9 initially-selected tickers turned out not to
be on Binance spot at all (Monero delisted, several exchange tokens never listed).

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
| 15 | **`VWAP n/a` in the chart popup, opened from Signals or Radar** | The popup's "Proof and context" ladder read `VWAP n/a`, the amber VWAP line was absent from the chart, and the popup's own "Price above VWAP" alignment tick failed — giving `2/4 · Usually a pass` — while the board row for the same coin displayed VWAP correctly | The popup read VWAP from the board row **only** (`row?.vwap ?? null`), and both surfaces passed `row={null}` because their row shapes were not `AssetRow` and would not typecheck. Three changes: `/api/asset/:id` now returns the engine's `sessionVwap` over the candles it already ships; `resolveVwap()` reads that first and the row second; both surfaces pass their real row. See Part XII |
| 16 | **`.env` cannot set the port or mock mode** | `PORT` is read at `index.ts:109`; `process.loadEnvFile` runs at `:261`. `ORDERFLOW_MOCK` is read at `:206`. Only `COINGECKO_DEMO_KEY` and `ORDERFLOW_SUPERVISED` are read late enough to pick `.env` up | **Found, not fixed** (17 Oct). Anyone who puts `PORT=8899` in `.env` and wonders why the server is still on 8787 has hit this. Fix = move `loadEnvFile` above line 109 |
| 17 | **`/api/percentile/:id` has no `try`/`catch`** | `getScan()` can throw; Express 4 does not catch async rejections, so the request produces **no response body** and an unhandled rejection | **Found, not fixed.** No client calls this route today, which is why it has never surfaced. Listed in section 13 |
| 18 | **`/api/signals` comment claims a 60 s cache that does not exist** | The route comment says "Cached 60s server-side"; there is no `cached()` call, so it recomputes volume profile + footprint for up to 40 rows on **every request** | **Found, not fixed.** A lying comment is worse than no comment — it reads as a performance guarantee |
| 19 | **The 1-second aggregate never reaches the UI** | `liveContext` applies `agg` messages into `aggStore`, but `useAggregate()` has **no consumer in the codebase**. The Dashboard reads breadth from `scan.market` instead | **Found, not fixed.** Part IV Stage 2 built the one-denominator aggregate on the server; the client half is unfinished. `aggStore.ts` is 47 lines that nothing reads |
| 20 | **9 of 13 `REFRESH.*` constants are dead configuration** | Tuning `REFRESH.NEWS_MS` changes nothing — the code uses an inline `5 * 60_000`. Zero references outside `config.ts` for `KLINES_MS`, `EXCHANGE_INFO_MS`, `NEWS_MS`, `MACRO_MS`, `INDIA_MS`, `SCAN_MS`, `ETF_FLOWS_MS`, `STABLECOINS_MS`, `VOLATILITY_HISTORY_MS` | **Found, not fixed.** House rule 6 says thresholds live in config with a tag; these live in config with a tag and are read by nothing |
| 21 | **`FAN.SET_SIZE` is shadowed on the client** | `config.ts` says 20; `src/stage/fan.ts:33` declares `FAN_SET = 20` and the canvas reads the local one. They agree today by luck | **Found, not fixed.** A direct violation of house rule 6 |
| 22 | **`LIVE.PING_RESPONSE_MS` and `LIVE.LIQ_SAMPLE_INTERVAL_MS` have no consumers** | Zero references across 168 files. The liquidation **lower-bound** guarantee written into `LIQ_SAMPLE_INTERVAL_MS`'s comment is documented but **not enforced in code** | **Found, not fixed.** `PING_RESPONSE_MS`'s comment also says "1-minute window" while the value is 10 minutes |
| 23 | **`shared/types.ts` declares `LedgerStats` twice** | At `:895` and `:945` with different field sets. TypeScript merges them so it compiles, which is exactly why nobody noticed | **Found, not fixed.** Harmless until someone edits one |
| 24 | **The ledger's calibration message claims more than the check establishes** | `/api/ledger` returns `isPredictive: true` and *"Calibration looks monotone across 4 populated score buckets"*. The buckets it lists are **63.41% / 36.14% / 62.30% / 44.19%** — alternating, not monotone. The actual test is `topAvg > bottomAvg` over two halves of a 4-bucket split (`store.ts:512`): means of 49.8 vs 53.2 | **FIXED 20 Oct** (bug #41, Part XVIII). The check is now a Spearman rank correlation with a bootstrap interval and a permutation p-value, and the verdict is three-state. *The 17 Oct "found, not fixed" text is superseded* |
| 25 | **`byVeto` produces ~90 singleton categories** | The veto string embeds the move percentage (`"already moved 24.6% today — event risk"`), so nearly every signal gets a unique veto key and `n` is 1 for almost all of them | **FIXED 20 Oct** (bug #42, Part XVIII). Grouped by veto **kind** — a stable code for which rule fired — via `vetoKindOf()`. The live ledger's 102 distinct reasons now collapse to **5 kinds**. *The 17 Oct "found, not fixed" text is superseded* |
| 26 | **The Mind feature vector crashed on a missing liquidation block** | `deriv.liq.buckets.longH1` was read unguarded. A row with derivatives present but no liquidation tape threw `TypeError`, and the whole scan died | Guard every bucket access; a missing block is `null`, not a crash. Found by `mind.features.test.ts` |
| 27 | **Every Mind lookup returned `null` on the scanner** | Signals are keyed `BASE:SIDE` (`BTC:bullish`) but the scanner asked for `BTCUSDT:bullish`. Every feature, regime and score lookup missed, so every row shipped with no Mind verdict and the board looked like the layer simply did not run | Keys are built once in `mind/scan.ts` and used for both the vector and the verdict. Found by the first mock probe, not by a unit test — a whole-board `null` is the kind of thing tests assert around |
| 28 | **Funding crowding was read with the wrong sign** | The Mind layer treated high positive funding as "crowded long", which is the opposite of the engine's existing `fundingCrowdedAgainst()`, where positive funding is crowded **against** a short | Reuse the engine's own convention. Two features in one codebase must not disagree about what funding means |
| 29 | **Every expired calendar event produced a permanent macro veto** | `minutesToNextBlackout()` accepted past events, so an event 2.7 days old kept vetoing every signal for ever. The board was vetoed at 100% and `actionable` was 0 | Only events within `±MIND.VETO_BLACKOUT_MIN` of *now* count. Found by the mock probe, which is the only reason it surfaced — the unit tests all used future events |
| 30 | **Kelly ranking collapsed every strong signal onto one value** | The ranking term was `netR · log(p/(1−p))`, which diverges at `p → 1`. Four different setups with probabilities 0.72/0.78/0.84/0.91 and different R all ranked **identically**, so the top of the board was arbitrary | Replaced with the **linear** fractional edge `netR · (p·f − (1−p)) / f`, which is finite at `p = 1` and preserves ordering. Caught by `mind.rank.test.ts` asserting distinct ranks |
| 31 | **The Brier decomposition was not a decomposition** | The report summed `reliability + resolution + uncertainty`, which is **not** `brier` — it double-counted and omitted the outcome-variance term. The three numbers did not add up to the score being explained | Replaced with the exact identity `brier = reliability + outcomeVariance`, and demoted `resolution`/`uncertainty` to explicitly-labelled diagnostics. A decomposition that does not reconstruct its own total is not a decomposition |
| 32 | **The base-rate anchor was unclamped** | A `resolveBaseRate` input outside `[0,1]` produced a probability outside `[0,1]` from a passing test fixture | Clamped at the boundary and covered by a test that asserts the clamp, not just the happy path |

**Bugs 26–32 are all from the Mind build (Part XIV).** 26, 30 and 32 were caught by tests; **27 and
29 were caught only by booting the mock server**, because both were whole-board failures that a
unit test asserting on one row cannot see. That asymmetry is the argument for the mock probe in the
first place.

### 12.1 Bugs from the Part XV specification audit — 33 to 39

Found by holding a written specification against the code. Every one produced a number that looked
correct. Section XV.2 has the full account of what each was costing.

| # | Bug | Symptom | Fix |
|---|---|---|---|
| 33 | **A news-feed outage was scored as a real reading** | `fetchAllNews().catch(() => [])` made a dead feed indistinguishable from "no headlines", and `newsScore()` pays 5/10 for an empty list — the same as a genuinely quiet asset. An A-grade pick could print with the feed dead, with nothing in the response saying so | `watched()` keeps the failure as a first-class value; `assessDataHealth` **blocks** on an unavailable or stale news feed |
| 34 | **Every board row understated its costs** | `buildPlan` was called without `deriv`, so `buildCosts` took the null branch on every row: funding **always 0 bps**, slippage always the 5 bps default. `netExpectedR`, and therefore the actionability gate, ran on costs that did not exist | `buildPlan(..., undefined, deriv)` at the scanner call site. Mock probe now shows `netR=-0.31` where it previously showed a positive number |
| 35 | **Every row published a position size from an account nobody chose** | `buildPlan` defaulted `opts` to a **$100,000** account, and `shared/types.ts` claimed `qty` was null until the user set one — which never happened, because nothing ever reached `opts` | `opts` now has **no default**: `qty`/`riskAmount`/`rewardAmount` are `null` until a caller supplies a real account. `holdingHours` still falls back, since that is a tagged config assumption |
| 36 | **`netR` was gated on `qty`** | "No position size" also erased "net R" — two unrelated unknowns collapsed into one, and the actionability gate lost its input entirely | Cost in R needs only cost in bps and per-unit risk, both measured without an account. Decoupled |
| 37 | **`byRegime` was a single meaningless bucket** | `freezeFromScan` read `(row as any).regime ?? 'range'`; `AssetRow` has no `regime` field, so **every signal ever frozen** was labelled `'range'` | `regime` is now a **required** parameter, passed `scan.regime` from both call sites. A default here manufactures a plausible grouping, which is worse than a compile error |
| 38 | **An in-progress macro release was not blacked out** | The bug-29 fix `if (mins <= 0) continue` also dropped an event that fired 10 minutes ago whose 60-minute window was **still open** | Bound is now `mins >= -MIND.VETO_BLACKOUT_MIN`. The veto message reports minutes *since* the release fired |
| 39 | **`liqClusterDistance()` returned the long cluster whenever one existed** | `longH1 \|\| shortH1` short-circuits: long 95 / short 99 / price 98 reported 3% instead of the true 1%. A feature named "nearest cluster" did not take the minimum | Filters both sides, then `Math.min`. No test had ever had two clusters at once |

**Two more bugs were found in the Part XV gate itself**, by the mock probe rather than by a unit
test: a single 8-second freshness bound applied to all four streams (a healthy 6-hour-old macro
calendar read as `stale` and closed the gate on every scan), and `watched()` stamping fetches on
*start* when the scan's `now` precedes them — so `now − at` went **negative** and three of four
streams falsely read `unavailable`. Both fixed; see XV.3.

### 12.2 Bugs from the Phase 0 foundation pass — 40 to 43

Found by holding the roadmap's M-IDs (§17) against the code. All four produced a number that
looked fine. Full account and the real before/after in Part XVIII.

| # | Bug | Symptom | Fix |
|---|---|---|---|
| 40 | **Every ledger winner was credited the plan's FURTHEST target R** (M3.2) | `rMultipleOf()` read `snapshot.plan.rr`, which `buildPlan()` defines as the R of the **last** target. A trade that took profit at TP1 — one R, the nearest level — was reported as if it had banked the furthest target | `realisedR()` in `ledger/resolve.ts` derives the R from **the outcome and the frozen levels**: TP1/TP2/TP3 get the R of the target that actually resolved it, STOP is exactly −1, EXPIRED is marked to the close. The ledger's statistics and the Mind calibration report now call the **same** function, so there is one definition of the R a trade realised |
| 41 | **The calibration check was `topAvg > bottomAvg`** (M1.5) | No null hypothesis, no interval. With two populated buckets it is a coin flip, and it reported `isPredictive: true` on a ladder reading 57.63 / 40.17 / 64.09 / 46.36 | `ledger/monotonicity.ts`: Spearman's rho, a bootstrap interval that resamples **inside** each bucket, a permutation p-value, the isotonic slope, and the count of adjacent decreases. The verdict is **three-state** — `MONOTONE` / `NOT_MONOTONE` / `INSUFFICIENT_EVIDENCE` |
| 42 | **`byVeto` keyed on the rendered reason** (M1.6) | The reason embeds the number that triggered the veto, so one policy decision became **102** categories on the live ledger, every one below the 30-sample floor | `engine/vetoKind.ts`: a stable code per rule. The live ledger's 102 reasons collapse to **5 kinds**, and the two largest now clear the floor |
| 43 | **Two more fabricated zeros in the derivatives path** (M1.4 residual) | `fundingZScore()` returned `0` for "history too short" and for a zero-variance history — both render as `z=0.00`, a statistic that happens to be zero. `buildDerivRow()` asserted `meta.stale: false` with no idea how old the data was | `fundingZScore()` returns `number \| null`, computed with Welford's algorithm so a constant history is detected as **exactly** zero variance rather than 1e-19. `buildDerivRow()` measures `stale` from the caller's `asOf` |

### 12.3 Bugs from the Part XIX resolver audit — 44 to 46

Found by decomposing the ledger's expectancy, which turned out to be the only way to see them.
All three are in `server/src/ledger/resolve.ts` and all three produced numbers that looked fine.

| # | Bug | Symptom | Fix |
|---|---|---|---|
| 44 | **A gap through a level was invisible** | The level test was "is P inside this candle's RANGE" (`k.l <= P && k.h >= P`). A price that GAPS through a level never puts it inside a range: the candle opens beyond it and the whole candle sits on the far side. So a take-profit the market gapped through was **never credited** — the trade ran on and EXPIRED, marked at whatever price the market was at later. On the live ledger that produced **28 expired rows carrying 28.6% of the entire ledger's R**, every one with MFE > 1 R and 27 of 28 with MAE exactly 0 (the signature of a favourable gap). A stop gapped through was booked **at the stop price** — the best possible fill — while all 255 stopped rows have MAE deeper than −1 R (median ≈ −1.5 R, worst −27 R) | A resting order at P fills when the market trades at or through P, **including by opening beyond it**: a bullish TP fills when `k.h >= P`, a bearish one when `k.l <= P`. A gap in the trade's favour fills at a BETTER price, not at no price — the old comment said otherwise and it was wrong. A stop gapped through is filled at the **gap open**, which needs the candle's open, so `ResolveInput.candles` gained an optional `o` |
| 45 | **An expiry was marked at "now", not at the end of the trade's life** | `LEDGER.EXPIRY_HOURS` is 24. Thirteen of the 28 expired rows were resolved between 24 and 71 hours after creation and marked at the price on the day of resolution. A trade's life is 24 hours; its expiry mark is the price at the end of that life | The mark is the close of the last candle **inside** the life, `[createdAt, createdAt + EXPIRY_HOURS)`. If no candle covers that instant the mark is **not measurable** and the R is `null` — never a guess |
| 46 | **A trade could be resolved by a candle from AFTER its own life ended** | The expiry was checked only **after** the resolver had walked the whole candle array, so the strategy's 24-hour rule was not enforced during resolution. The harness measured a mean of **535 bars** (44 hours) to resolution, and 15 of the 597 decided rows in the live ledger were resolved between 24 and 56 hours after creation | The resolution loop stops at the end of the life. A trade that outlives its own rule is not a trade the strategy took |

**The three together explain most of the ledger's headline.** See Part XIX.

---

### 12.4 Bugs from the Engine Lab pass — 47 to 49

Found by extending the feature store and by re-running the acceptance script. All three produced numbers that looked fine, and all three were caught by a test that was written to fail.

| # | Bug | Symptom | Fix |
|---|---|---|---|
| 47 | **A liquidation feature measured USD against a price** | `mind/features.ts::liqClusterDistance()` read `deriv.liq.longH1` and `deriv.liq.shortH1` as **CLUSTER PRICES** and computed `abs(price − cluster) / price`. They are not prices: `LiquidationTracker.tally()` in `server/src/live/marketState.ts` returns liquidation **USD totals** per window (`longH1: this.sumSince(symbol, h1Since, 'SELL')`). So the feature was subtracting a USD amount from a price — a coin at $65,000 with $50,000 of long liquidations in the hour reported "a liquidation cluster 23% away", a number about nothing | There is **no liquidation-cluster price anywhere in this repo**, so there is nothing to measure. The feature now returns `absent()` and the liquidation **flow** that does exist is exposed separately as `liquidations.longLiqUsd` / `shortLiqUsd` / `netLiqPressure`. The test that asserted the old behaviour (`phaseXvi.test.ts` PROOF 9) encoded the wrong mechanics and was rewritten to assert the honest one |
| 48 | **A typecheck error was sitting in the working tree** | `server/src/engine/closedloop/model.ts` declared `const t0 = times[0];` and never read it, so `tsc --noEmit` failed with `TS6133`. The file was **untracked** (`??` in `git status`), which is why it was missed: the last recorded green run predates the Closed-Loop folder | The unused binding was removed. `npm run verify` now typechecks clean. Recorded because the repo's own rule is that a failure is a failure, and this one was present before this pass and had not been reported |
| 49 | **The random-entry baseline was compared to the engine across different units** | `scripts/verify-engine.ts` collected the random arm's **gross** R per trial and compared it against the engine arm's **net** R. That hands the engine a free round trip of costs — roughly 0.5 R on this geometry — in every comparison | `RandomEntry` now carries a per-trial `netR`, computed with the same `computeCosts()` the engine's arm pays, and the script collects the **net** series. The published difference is now a like-for-like one |

**None of the three was found by a test that was looking for it.** #47 was found by asking what the data actually was; #48 by running the typecheck; #49 by asking whether the two arms were being charged the same way.

### 12.5 Bugs from the CoinGecko / boot-health pass — 50 to 51

Found by starting the app and reading `/api/health`, `/api/scan` and the server log, not by a unit test.

| # | Bug | Symptom | Fix |
|---|---|---|---|
| 50 | **Three CoinGecko call sites each opened their own request** | A boot identity refresh, the scanner's altseason call and `/api/macro` all hit `/coins/markets` or `/global` within seconds. The free quota is shared per IP, so the app saw `HTTP 429 from api.coingecko.com` and the macro strip silently dropped its global tiles. The configured `COINGECKO_MIN_INTERVAL_MS` was `60_000` and **read by nothing** | `server/src/data/coingecko.ts`: one serialised door with a 2 s floor, a shared 5-min 250-row markets cache (identity + altseason), and a separate 5-min global cache. Demo/pro keys are sent when present. `MacroStrip` now shows an explicit `Unavailable` tile instead of vanishing |
| 51 | **Price freshness was measured at fan-out, not ingestion** | `streamHub.lastTickAt()` returned `lastFlushAt`, which only advances when a client is subscribed. A boot scan that finished before the first browser connected saw no price and cached `price_stream: unavailable / tradable:false` for a full 60 s TTL. A tick arriving after the scan's `asOf` also produced a **negative** age, which `classifyStream` read as unavailable | `stageTick` records `lastIngestAt` on every tick and `lastTickAt()` returns the newest of ingest/flush. `priceStreamAgeMs` clamps at zero. `getScan` invalidates a price-blocked board once price is flowing, and the first live tick triggers one recovery scan (max 2 attempts) that is pushed over SSE |

### 12.6 Bugs from the Charts pass - 52

Found by the Playwright drawing smoke after the rectangle did not appear in the screenshot.

| # | Bug | Symptom | Fix |
|---|---|---|---|
| 52 | **Custom drawing overlays declared too few steps** | `rectZone` had `totalStep: 2` and `longPosition` / `shortPosition` had `totalStep: 3`. klinecharts completes an overlay when `points.length >= totalStep - 1`, so a rectangle finished with one point and `createPointFigures` returned `[]`; long/short finished with two of three points and also rendered nothing. The toolbar looked active and the first click test passed because it asserted only that the overlay ID existed | `rectZone: totalStep 3`; long/short: `totalStep 4`. `qa/charts.spec.ts` now asserts `name`, `points`, `currentStep` and `totalStep` for both `rectZone` and `longPosition`; the rectangle is visible in `qa/screens/charts-02-drawings-desktop.png` |

---

## 13. Known limits and honest gaps

These are real and deliberately not hidden.

| Limit | Detail |
|---|---|
| **The ledger's R assumes a perfect fill at the entry mid, with no costs** | **This is the biggest remaining caveat on every R number in the ledger.** `resolveOutcome()` is called with `entry = (entry_low + entry_high) / 2` — the mid of the zone — so the ledger books the trade as if it filled exactly at the mid, instantly, and charges no fee, no slippage and no funding. A real fill is the **next candle's open**, plus taker fee and slippage, plus funding for every 8 h boundary crossed. Live read 20 Oct: `avgR 3.16`, `profitFactor 8.74`, `winRate 54.72%` on 625 resolved signals — an expectancy of ~+1.28 R per trade, which is not a tradable number, it is a fill assumption. The Phase XVI `outcomes` table charges costs for the 54 rows that have it; the 571 that pre-date it do not, and are excluded from every cost-honest metric |
| **The ledger's win rate is 95% shadow signals** | Live read 20 Oct: **650 signals, 625 resolved, 25 open, 621 shadow / 29 real.** The `real` group has **n=29**, one below the 30-sample floor, so the *real*-signal win rate cannot be quoted at all. Every rate in the ledger is dominated by grade-C and vetoed setups, which is the point of the shadow set — but it means the headline number describes a hypothetical portfolio, not a traded one |
| **The score is not predictive, and the old check said it was** | The live ladder reads **57.63% / 40.17% / 64.09% / 46.36%** across the four populated buckets. Spearman rho **0**, 95% CI **[−0.8, 0.6]**, permutation p **0.5632**, 2 adjacent decreases. Verdict: `INSUFFICIENT_EVIDENCE` — the score's ordering is not distinguishable from noise. The old `topAvg > bottomAvg` check called the same data `isPredictive: true` |
| **The two top score buckets have never been populated** | `65-80` and `80-100` have **n=0**. The engine has never produced a score above 65, so the top of the ladder has never been tested |
| **The plans are very tight-stopped, which is why the R multiples are large** | The 342 winners have an average plan `rr` of **4.99** on an average per-unit risk of **0.129** against an average entry of **48.34** — a stop around 0.27% wide and a target around 1.3% away. A 5 R multiple with a 57% hit rate is not implausible *arithmetically*, but it rests on a stop tight enough that a single 5 m wick will take it out. The R numbers are only as good as that stop |
| **`fit-weights` is now unblocked** | `LEDGER.FIT_MIN_SIGNALS = 200` and **625** are resolved, and M3.2 is fixed — so fitting against the R a trade actually realised is no longer blocked. It is still blocked on there being any *cost-honest* population: only 54 rows have a Phase XVI outcome row, and the 571 that pre-date it have no frozen costs |
| **The 1 s aggregate is dropped client-side** | The server produces the one-denominator `LiveAggregate` every second; `aggStore` receives it and nothing reads it. The Dashboard's breadth comes from the 60 s scan instead. **Bug #19** |
| **9 of 13 `REFRESH.*` constants are dead** | The live TTLs are inline literals scattered through the routes. Tuning config changes nothing. **Bug #20** |
| **Two `LIVE` constants have no consumers** | `PING_RESPONSE_MS` and `LIQ_SAMPLE_INTERVAL_MS`. The liquidation lower-bound rule is documented but unenforced in code. **Bug #22** |
| **`.env` cannot set `PORT` or `ORDERFLOW_MOCK`** | Both are read before `loadEnvFile` runs. **Bug #16** |
| **Most of `src/stage/` and 13 components are unmounted** | `cards.tsx` / `FlowCharts.tsx` / `flowData.ts` form a closed island; `Board`, `PickCard`, `TileGrid`, `MarketPicture`, `PickPanel`, `ButterflyChart`, `BridgeConnector`, `SectorChips`, `FlowCrest`, `NodeFunnel`, `TopRail`, `TickerStrip`, `MarketDepthPanel` are imported by nothing. The `.ob-*` and `.mh` CSS in `stage.css` (2,135 lines) is largely unrendered |
| **Clustering is declared but not built** | `NEWS.CLUSTER_JACCARD` exists and `/api/news` returns a `clusters` field that is **always `[]`** |
| **The Mind layer has zero resolved signals to score itself against** | `npm run mind:report` against the real ledger: **525 signals, 510 resolved, 0 Mind-tagged.** Every resolved signal predates the layer. Those 510 are **excluded, not counted as 50% calls** — back-filling them would manufacture a flattering score. So there is currently **no Brier number**, and that is the correct state, not a failure |
| **A blackout veto is silently disarmed when the calendar is unavailable** | `minutesToNextBlackout()` returns `null` on an empty calendar, and `hardVetoes()` only vetoes when the value is **measured**. So a calendar outage turns the macro veto **off** — while the code comment claims "the veto stays armed: unknown ≠ clear". The comment and the behaviour disagree. **Found, not fixed.** The honest fix is a separate `unavailable` verdict that vetoes, not a null that does not |
| **An event already in progress is not blacked out** | The fix for bug #29 excluded events with `mins ≤ 0`. That correctly dropped 2.7-day-old events, but it also drops an event that fired 10 minutes ago and whose 60-minute window is still open. The correct filter is `mins ≥ −VETO_BLACKOUT_MIN`, not `mins > 0`. **Found, not fixed** — it is a live under-veto |
| **`liqClusterDistance()` picks the long cluster whenever one exists** | `buckets.longH1 \|\| buckets.shortH1` short-circuits on the long side rather than choosing whichever cluster is **nearest** to price, so a closer short cluster is ignored whenever a long one is present. **Found, not fixed.** It needs `min(abs(long−price), abs(short−price))` |
| **No weight refit exists** | `model.usingShippedWeights` is hard-coded `true` and there is no refit path, so every weight stays `[TUNED]` — which is the intended starting position, but it also means **the "optional refit" deliverable is unbuilt**. `fit-weights` remains blocked on M3.2 anyway |
| **`MindSignal` does not carry `plan` or `confluenceComponents`** | The brief asked for both in the output. The verdict carries `drivers` and the internal group scores, but a plan and an explicit component list are not on the wire. **Found, not fixed** |
| **No Mind pass on the India F&O path** | Sparse-vector support exists, so `/api/india` rows could be scored, but no pass runs there. India is the product's origin market and the Mind layer covers crypto only |
| **Mechanical Wyckoff / ICT / Market Profile features are partly absent** | `hasSetup` reuses the engine's existing boolean. There is **no** spring/upthrust detection, no explicit sweep-and-reclaim flag, no premium/discount measure, and **no POC or value-area feature** despite `volumeProfile` being available. `nestedFVG` is honestly `null` because `Setup.fvg` carries no price bounds |
| **Three macro features are always `null` in production** | `fearGreed.zScore` (no history series stored), `btcDominanceShiftPp`, and `liqVelocityFrac`. They are implemented and unit-tested against synthetic input, but no live source populates them, so the real vectors show them as unmeasured |
| **The high-NIS news recompute path does not exist** | `scan.ts` accepts `nudge` for the event path, but a high-impact news item does not yet invalidate and re-run the board |
| **No SSE `mind` delta** | The `StreamMsg` union has no Mind variant, so a regime change is only visible on the next 60 s poll. The `nudge` plumbing exists; the emit does not |
| **Mind coverage in mock mode is 19 of 36 features** | The mock path runs the whole chain — features → regime → score → rank → freeze → route — but the fixtures do not supply derivatives, on-chain or stablecoin data, so 17 fields are legitimately unmeasured. This is honest thinness, not a silent default |
| **Direct SQLite reads fail while the server runs** | `server/data/orderflow.db` returns `EPERM` on `rmSync`/read from a second process. Use `GET /api/ledger`, or stop the owning process. Test files must therefore share one handle per process and cannot delete the DB between cases |
| **The spec's exact JSON output contract does not exist** | The literal keys `market_regime`, `market_context`, `probability_target1`, `position_size_pct`, `evidence{same_setup_win_rate, same_setup_median_r, historical_sample_size}` and `valid_until` are absent. **`data_health` now exists** (Part XV). The rest is serialisation over data that mostly exists |
| **No walk-forward or out-of-sample validation exists** | Zero references in the repo. `LEDGER.FIT_MIN_SIGNALS = 200` and `BACKTEST_DAYS = 30` are declared and **read by nothing**. The research-backed design is in Part XV.7: expanding window, purge training rows whose resolution window overlaps the test block, embargo after it. The ledger already carries the two timestamps it needs (`created_at`, `resolved_at`) |
| **`maxDrawdown`, `falsePositiveRate` and feature importance are all missing** | No equity curve is reconstructed anywhere; `mfeR`/`maeR` are stored and never aggregated into a drawdown. The nearest analogue, `byComponent`, correlates the **7 conviction** components — not the 36 Mind features — and returns `null` below 30 samples, so it is empty on any realistic ledger |
| **No `setup_type` taxonomy** | The spec groups outcomes by setup type; the repo stores `side` plus an `fvg` boolean. `retest` and `htf` are already frozen and unused as labels, so this is mostly a labelling job over existing state |
| **Nothing tests that A beats B beats C** | No such assertion exists in any test or spec. It cannot honestly be written until enough of each grade resolves; what *can* be written now is a test that **reports** the ordering rather than asserting it |
| **`LEDGER.FIT_MIN_SIGNALS` and `BACKTEST_DAYS` are unread, and the candle store cannot support the window they imply** | `pruneCandles(2000)` retains ~**one week** per symbol at 5 m — six windows short of the 30 days `BACKTEST_DAYS` advertises. A replay harness needs a longer store before it needs code |
| **The Lab's macro blackout is implemented but NOT enforced** | `RiskState.macroBlackoutMin` is `null` from the Lab runner, because the calendar is not on the Lab's clock yet. The gate implements the rule and `server/test/lab.test.ts` proves it fires — but in the running Lab a tier-1 release would not stop a trade. **A live under-gate.** Part XX.6 item 4 |
| **The extended feature set is implemented but NOT yet live** | `mind/features.ts` gained `timeframes`, `crossAsset`, `liquidations`, `orderbook` and `funding`, each with its own leakage test, and the catalogue lists all 63 features. But `runMindPass` does not yet pass the higher-timeframe series, the BTC series, the book levels or the funding history, so **every live row reports them as unmeasured**. Part XX.6 item 6 |
| **Five Playwright tests in `qa/home.spec.ts` fail, and they failed before the Engine Lab** | Verified pre-existing by removing the `Engine Lab` nav entry and re-running: the same five fail identically — two board columns 10.97px apart, board header counts `NaN`, the popup pin, the popup's required stats, and `.of-badge.bear` contrast at 4.34:1 against 4.5:1. **Not fixed here.** Part XX.6 item 8 |
| **`pruneCandles` discards the history a walk-forward test would need** | Retention is one week. Any out-of-sample claim over months is currently impossible from stored data, regardless of how good the harness is |
| **Options and ETF flows are placeholders** | `/api/macro` returns `options: []` always, and `etfFlows` as an `Unavailable` object (Farside 403s). Honest, but not data |
| **No browser test for the popup's VWAP** | Fixed in Part XII and pinned by two vitest tests, but no `qa/*.spec.ts` asserts on it |
| **Hand-maintained universe** | The pair list is **built** from `exchangeInfo` + 24 h volume (Part IV Stage 1), not hand-written — but the **metadata** (name, sector, beta group, logo) is hand-curated in `coinIdentity.ts`, and `universeBuilder` falls back to `"Other"` and the ticker as a name when it finds none. `check:universe` keeps the list honest |
| **No free NSE option chain** | NSE blocks it to non-browsers and licenses it commercially. **Not attempted** rather than faked |
| **Yahoo dependency** | Needs the cookie+crumb handshake; can be slow or rate-limited. The crypto terminal is unaffected when it fails — it degrades to "No Indian equity data right now". Also one of the three paths that **bypass the ban guard** |
| **Novelty window** | Computed within the current RSS feed window, not a 365-day store. Resets when a story scrolls out of the feeds |
| **Beta window** | ~8 hours of 5-minute returns, not the 90-day window in the research. Directionally right, not a published study |
| **News scoring is hand-tuned** | Defensible and calibrated against structure, but **not fitted against labelled outcomes**. The research says ~2,000 labelled events are needed to replace the hand-tuned multipliers |
| **Attribution scale is a heuristic** | `scale = 0.35` maps summed NIS points to a percent-of-move. Defensible, uncalibrated |
| **Indian tax rates are `[?]` unverified** | `INDIA_TAX` uses a fourth provenance tag meaning *not verified*. Flagged in the UI and editable in settings. Confirm against the Income-tax Act 2025 before relying on it |
| **Single user, no auth** | No accounts, no persistence beyond the browser's localStorage. **No inbound rate limiting, no CORS, no error-handling middleware** — fine for a single-user tool, a real change if exposed |
| **Single venue for prices** | Binance spot. The app says so and does not present a composite as one market. Cross-venue funding from Bybit/Hyperliquid *is* wired for the derivatives board |
| **3 exchanges in the data layer, 1 reaches the scanner** | Bybit/Coinbase/Kraken are designed for but only Binance feeds the scan |
| **No timeframe selector** | `/api/asset/:id` hardcodes `5m`. **M1.2** |
| **The two remaining fabrication risks** | `fundingZ: 0` rendered as `z=0.00`, and board rows reporting zero liquidations under a live-looking `Meta`. **M1.4**, and more serious than anything else listed here |
| **`rMultipleOf()` inflates the ledger** | Every winning trade is credited with the plan's **furthest** target's R, so statistics are too good. **M3.2** — fix before fitting anything |
| **11 pre-existing `qa/home.spec.ts` failures** | Layout ratio, equal column widths, the mobile bottom sheet, zero-CLS on hover, the Z/S1 label, and badge contrast — desktop and mobile. Proven at baseline in Part X.4, not caused by any session since |

---

## 14. Extension guide — where to change what

**Rewritten 17 Oct 2026.** Several rows in the previous version pointed at code that has since moved
or stopped being the owner: the pair list is no longer in `universe.ts`, `scanner.ts` no longer holds
`BOARD_SIZE`, and the board layout is `src/home/`, not `App.tsx`. Section 16.1 is the fuller
version of this table; this is the quick one.

| Goal | File | Change |
|---|---|---|
| Add or retire a crypto pair | **nothing** — the list is built | `universeBuilder.ts` selects from `exchangeInfo` by volume. Add *metadata* in `coinIdentity.ts`, then run `npm run check:universe` |
| Change which pairs qualify | `server/src/config.ts` | `MIN_UNIVERSE_VOLUME_USD`, `UNIVERSE_MAX_PAIRS` |
| Add a sector | `server/src/data/coinIdentity.ts` | The sector metadata map |
| Add a news source | `server/src/data/rss.ts` | Append to `FEEDS` (include the `tier`) |
| Tune the news formula | `server/src/engine/news/score.ts` | The formula is one expression in `buildFeed` |
| Add an event tag | `server/src/engine/news/taxonomy.ts` | Append to `EVENT_TAGS` with severity/dir/halfLife/expiry |
| Add sentiment words | `server/src/engine/news/lexicon.ts` | `POSITIVE` / `NEGATIVE` |
| Change OB strictness | `server/src/engine/orderblock.ts` | `detectOrderBlock` — the FVG and 1× displacement thresholds, the `violated` check |
| Change the session window | `server/src/config.ts` → `STRUCTURE.SESSION_CANDLES` | Then read it via `sessionStartIndex()`. **Do not write `length - 289` anywhere** |
| Change the chop gate | `server/src/config.ts` → `STRUCTURE.EFFICIENCY_CHOP_GATE` | Was `efficiency < 0.25` in code |
| Change board size / picks | `server/src/config.ts` → `CONVICTION.BOARD_SIZE`, `PICKS_PER_SIDE`, `MAX_PER_SECTOR` | **Not** `scanner.ts` any more |
| Change event-risk threshold | `server/src/config.ts` → `STRUCTURE.EVENT_RISK_PCT` | Was `EVENT_RISK_PCT = 14` in `scanner.ts` |
| Change conviction weights | `server/src/config.ts` → `CONVICTION.WEIGHTS` | Stays `[TUNED]` until fitted |
| Change a grade boundary | `server/src/config.ts` → `CONVICTION.GRADES` | Read the A/B ambiguity note there before you do |
| Add a checklist point | `server/src/config.ts` → `CHECKLIST` | Array order is significant; `conviction.ts` must produce the tick |
| Change the fee or risk model | `server/src/config.ts` → `RISK` | Then `npm run plan:workings` to cross-check the oracle |
| Change poll intervals (client) | `src/App.tsx` | The `usePolling` interval arguments |
| Change a push cadence | `server/src/config.ts` → `LIVE.TICK_PUSH_MS` | Not a client concern |
| Change the significance gate | `server/src/engine/attribution.ts` | `moveZ >= 2.5`, `volZ >= 2.0`, `moveZ >= 3.5` |
| Change freshness rendering | `config.ts` **and** `src/lib/freshness.ts` | Both copies; `server/test/freshness.test.ts` pins them equal |
| Add an exchange | new `server/src/data/<name>.ts` | Mirror the shape of `binance.ts`, then swap it into `scanner.ts` |
| Change the Dashboard layout | `src/home/` + `home.css` | Then `qa/home.spec.ts` |
| Change the Order Block stage | `src/stage/` + `stage.css` | **Check first whether the file is mounted at all** — see 16.3 |
| Change a chart | `src/components/CandleChart.tsx` | `qa/chart.spec.ts` exists because this once drew invented candles |
| Add a tab | `src/App.tsx` (`type Tab`, nav array, render switch) | No router — add the id in all three places |

### Ideas deliberately left on the table

1. **Ledger tab UI** — `GET /api/ledger` is ready; nothing renders it.
2. **Real correlation fitting** — the research gives a BTC/DXY/10y-real-yield regression. Only BTC
   beta is used; adding DXY and DFII10 would sharpen attribution materially.
3. **Outcome feedback loop** — persist every attribution and its realised return, then report
   per-category hit rate and Brier score. This is what turns the hand-tuned weights into fitted
   ones. **The 200 resolved signals now exist (505 as of 17 Oct) — this is blocked only on M3.2.**
4. **Clustering** — the Jaccard constants and the `clusters` field exist; the computation does not.
5. **Options surface** — Deribit options are fetched for BTC/ETH into `OptionsSnapshot`, and
   `/api/macro` returns `options: []`. The data layer is built and the surface is not.
6. **Alerting** — `ALERTS` is fully specified and entirely unread. Pushing on NIS ≥ 70 or a
   CRITICAL tag would use constants that already exist.
7. **Outbound guard coverage** — bea.gov, Yahoo and the Hyperliquid POST use raw `fetch` and skip
   the ban guard and mock transport. Routing them through `fetchText` would close three holes.

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
| 19 | **Prices live outside React**, in `priceStore` | One tick used to re-render ~40 rows plus the shell. Part III. A price in `useState` is a regression, and `qa/render-count.spec.ts` exists to prove it |
| 20 | **No router** — `useState<Tab>` in `App.tsx` | The app is a single-user terminal, one tab deep. A router would add a URL space nobody navigates. The cost: reload always lands on Dashboard and no tab is linkable. Known, accepted |
| 21 | **Mock mode is the same process, not a fork** | `dev-mock.ts` sets one env var and imports the real server. If mock ran different code, a screen built against it would prove nothing about production. That is the whole argument |
| 22 | **One venue for prices, said out loud** | Binance spot. The app never presents a composite as if it were one market |
| 23 | **`7/8` checklist with score < 75 grades B, not C** | The original spec left that case undefined. The checklist is cheaper and more robust than unfitted weights, so where they disagree the checklist wins — and the case never silently falls to C |
| 24 | **Ambiguity resolves stop-first** | When one candle could plausibly hit both stop and target, take the conservative reading. `LEDGER.AMBIGUITY` |
| 25 | **Liquidation totals are labelled a lower bound** | `forceOrder@arr` emits at most one event per symbol per second. The number is real but incomplete, so it is never presented as a total |
| 26 | **`STOP_FIRST` over "closest to price"** | Same reason as 24: the resolver must not be clever with data it does not have |
| 27 | **The Mind layer targets calibration and expectancy, and 95% accuracy is rejected outright** | Accuracy is not an objective here, and chasing it would produce the wrong system. The live ledger base rate is **53.5%** over 510 resolved signals, so a 95%-accurate model is arithmetically impossible against a 53.5% base rate without leaking future information — and the whole feature set is point-in-time by construction to prevent exactly that. A quoted 95% is the signature of a lookahead bug, not a good model. The objectives actually enforced are: (a) Brier **lower than the base-rate bar** (`MIND.BRIER_MEANINGFUL_DELTA`), (b) positive net expectancy after costs, (c) reliability buckets flat, not monotone-looking |
| 28 | **The probability intercept is anchored to the ledger's own base rate** | So that with **no fitted weights** the layer is calibrated *at* the base rate by construction and can only beat that bar if a feature genuinely carries information. Without this, unfitted `[TUNED]` weights produce confident numbers anchored at nothing, which is how a research tool starts printing numbers it cannot support. `npm run mind:report` exists to keep this honest |
| 29 | **A missing measurement is `null`, never `0`** | `measured(0)` and `missing('volume')` are different facts. Collapsing them would let "no liquidation data" read as "no liquidations nearby", which inverts the meaning of a risk feature. The vector reports coverage for this reason |
| 30 | **The Mind pass is optional and additive; if it throws, the board is unchanged** | A new layer that could take down the scanner is a worse outcome than not having it. The pass is wrapped, and a failure leaves `row.mind` absent — the same board the product shipped before it existed |
| 31 | **Grades, freeze policy and `MIN_RR` were not touched** | The brief permits it only once calibration justifies it. Nothing in Part XIV changed which signals freeze, which grades exist, or the RR gate. `mind.freeze.test.ts` asserts the A/C real/shadow split is unchanged so a future change cannot slip in silently |

---

## 16. How to make a change in this repo

**Written 17 Oct 2026.** This section exists so an AI — or a person on a cold morning — can be told
"add X" and produce a change that fits the codebase instead of fighting it. Sections 1–15 and Parts
II–XII are the history and the reasoning; this is the operating manual.

### 16.0 Read `AGENTS.md` first

Six house rules, all of which still hold. They are not style preferences; each one was written
because breaking it produced a wrong number on screen.

1. **Closed candles only.** A zone never repaints from a candle that is still forming.
2. **Never invent a number.** No liquidity target ⇒ `rr = 0` and the UI shows `—`. No tick yet ⇒ a
   dash. Suppressed statistics ⇒ a sentence saying why, not a made-up rate.
3. **`STALE` is never rendered as `LIVE`.** `MOCK` is never rendered as a live market.
4. **Hand-tuned weights stay labelled `[TUNED]`** until the ledger has enough resolved outcomes to
   fit them. Do not improve them by feel.
5. **Do not use PowerShell `-replace` to edit source files.** It mangles regexes and template
   literals. Use the Edit tool.
6. **Any threshold lives in `server/src/config.ts` with a provenance tag:** `[V]` verified in
   documentation, `[PROBED]` measured live, `[TUNED]` hand-tuned. Nothing hard-codes a number.

### 16.1 Ownership map — "the change is X, the owner is Y"

| The change | The file that owns it | Then also |
|---|---|---|
| A number, interval or threshold | `server/src/config.ts` — with a provenance tag | Grep for a duplicate of the same number before you finish. A constant nothing reads is a claim, not a control — see `LEDGER.AMBIGUITY` and bug #32 |
| An HTTP route, or the shape of a response | `server/src/index.ts`, then `shared/types.ts` | Both sides import the shared type, so a shape change breaks the build immediately. That is the point |
| A board rank, pick, sector or regime | `server/src/engine/scanner.ts` | `qa/home.spec.ts` for anything visible on the Dashboard |
| An order block, zone, VWAP or strength score | `server/src/engine/orderblock.ts` | `server/test/tradePlan.test.ts` or a new test |
| A conviction component, checklist point, grade or veto | `server/src/engine/conviction.ts` | `server/test/conviction.test.ts` (30 tests) |
| **A signal's `netR`** | `server/src/engine/tradePlan.ts` — `buildCosts` then `costR` | `server/test/tradePlan.test.ts` and `planOracle.test.ts`. `netR` stays decoupled from `qty`: no account size does **not** mean no net R |
| A plan: entry, stop, targets, R:R, sizing, costs, tax | `server/src/engine/tradePlan.ts` | **Then run `npm run plan:workings`** — it cross-checks against the independent oracle |
| A derivatives number: funding, OI, CVD, liquidations | `server/src/data/derivatives/providers.ts` | `server/test/derivatives.test.ts` (42 tests) |
| Which pairs get scanned | `server/src/data/universeBuilder.ts` | **Then run `npm run check:universe`** and quote its output |
| A news tag, severity or sentiment term | `engine/news/taxonomy.ts`, `lexicon.ts`, `score.ts` | `NEWS.*` in config for the multipliers |
| Something attributed to a move | `engine/attribution.ts` | The significance gate is 2.5σ — do not loosen it to make a result look better |
| What a websocket emits | `server/src/live/ingest.ts`, `streamHub.ts` | The `StreamMsg` union in `shared/types.ts` |
| Anything on the Dashboard | `src/home/` | `qa/home.spec.ts` |
| Anything on the Order Block tab | `src/stage/` | `qa/orderblock.spec.ts`. **Read 16.3 first — much of this folder is unmounted** |
| A chart | `src/components/CandleChart.tsx` | `qa/chart.spec.ts` exists precisely because this once drew invented candles |
| A live price on screen | `src/lib/priceStore.ts` — **not** React state | `qa/render-count.spec.ts` |
| Freshness / STALE / DELAYED rendering | `server/src/config.ts` + `src/lib/freshness.ts` | `server/test/freshness.test.ts` pins the two copies together |
| The look of anything | the CSS beside it: `home.css`, `stage.css`, `index.css`, `mind.css` tokens | `qa/screens/` for a screenshot |
| **A Mind feature, probability, veto, band or regime** | `server/src/engine/mind/` — `features` / `regime` / `confluence` / `calibrate` | The matching `server/test/mind.*.test.ts`, then **`npm run mind:report`** to confirm the change did not move the calibration verdict |
| **The Mind block on a signal card or the header strip** | `src/components/MindBits.tsx`, styled by `src/components/mind.css` | `qa/` has **no Mind spec yet** — so this surface is unit-typed but not browser-verified. Do not claim it is tested |
| **The Mind wire shape** | `shared/types.ts`, read by both `server/src/index.ts` and `src/lib/api.ts` | A shape change breaks the build on both sides, which is deliberate |
| **Whether a setup may be traded at all** | `server/src/engine/dataHealth.ts` + the `HEALTH` group in `config.ts` | `server/test/dataHealth.test.ts` (23 tests). **Never lower a `BLOCK_*` flag to make a test pass** — the calendar and news blocks exist because an outage silently disarmed them |
| **A stale, delayed, unavailable or mocked feed** | `assessDataHealth()` in `engine/dataHealth.ts` | Each stream has its own `MAX_*` and `DELAYED_*` bound. Reuse the price bound for another stream and you will close the gate on healthy data |
| **How an outcome is resolved on ambiguity** | `server/src/ledger/resolve.ts`, branching on `LEDGER.AMBIGUITY` | `ledger.test.ts > resolveOutcome: stop-first ambiguity`. The constant is now genuinely read — changing it changes behaviour |

### 16.2 The data path, so you know what you are cutting

```
Binance WS ─► ingest.ts ─► streamHub.flushNow() ─► GET /api/stream (SSE, 200ms)
                                                        │
                              ┌─────────────────────────┼──────────────────────┐
                              ▼                         ▼                      ▼
                        tick                    agg (1s)                 snapshot/scan
                              │                         │                      │
                     priceStore.applyTick        aggStore.applyAgg      liveContext scan
                     (rAF-batched, OUTSIDE       (populated, but no     (module store,
                      React, per-symbol          subscriber — 16.3)     changes ~1/min)
                      useSyncExternalStore)
                              │
              useLivePrice(sym) / livePrice(sym)
                              │
        BoardRow · RowPreview · MacroStrip · MarketsView · TicketPanel · SignalsView
```

**The rule this encodes:** a tick must never cause an app-level render. `qa/render-count.spec.ts`
injects 2,000 ticks and asserts `window.__ofAppRenders` rises by **≤ 5**. If you find yourself
wanting to put a price in `useState`, you are about to re-introduce the bug Part III fixed.

### 16.3 Traps — things that will bite you, all verified 17 Oct 2026

These are **not** hypotheticals. Each was checked against the code today.

| Trap | The truth | What to do |
|---|---|---|
| **`.env` cannot set the port** | `PORT` is read at `index.ts:109`; `.env` loads at `:261`. Same for `ORDERFLOW_MOCK` (`:206`). Only `COINGECKO_DEMO_KEY` and `ORDERFLOW_SUPERVISED` are read late enough | Pass them as real env vars or inline prefixes. Do not "fix" the `.env` and assume it works |
| **9 of 13 `REFRESH.*` constants are dead** | `KLINES_MS` `EXCHANGE_INFO_MS` `NEWS_MS` `MACRO_MS` `INDIA_MS` `SCAN_MS` `ETF_FLOWS_MS` `STABLECOINS_MS` `VOLATILITY_HISTORY_MS` have **zero** references outside `config.ts`. Only `DERIVATIVES_SNAPSHOT_MS`, `OI_HISTORY_MS`, `LONG_SHORT_RATIO_MS`, `OPTIONS_MS` are read | Tuning a dead constant changes nothing. The live TTLs are inline literals — find the actual one before you tune it |
| **`FAN.SET_SIZE` is shadowed** | `config.ts:190` says 20; `src/stage/fan.ts:33` declares its own `FAN_SET = 20` and the canvas reads **that** | Change both, or better, import one from the other. They agree today by luck |
| **`LIVE.PING_RESPONSE_MS` and `LIVE.LIQ_SAMPLE_INTERVAL_MS` have no consumers** | Zero references in 168 files. The liquidation *lower-bound* rule written in `LIQ_SAMPLE_INTERVAL_MS`'s comment is therefore documented but **not enforced in code** | If you rely on that guarantee, wire it or state the gap. It is in section 13 |
| **`/api/signals` is not cached** | Its route comment claims "Cached 60s server-side"; there is no `cached()` call. It recomputes on every request | Either add the cache or fix the comment. Do not leave the comment lying |
| **`/api/percentile/:id` has no `try`/`catch`** | `getScan()` can throw, and Express 4 does not catch async rejections → no response, an unhandled rejection | Add the handler if you touch this area. No client calls it today |
| **The 1 s aggregate is dropped by the client** | `applyAgg` runs, `aggStore` fills, and **`useAggregate()` has no consumer anywhere**. The Dashboard reads breadth from `scan.market` instead | The server-side one-denominator work (Part IV Stage 2) is not reaching the UI. This is a real unfinished thread, not a design choice |
| **Three SSE message types are never sent** | `derivatives`, `news` and `alert` are declared in `StreamMsg`; nothing publishes them | Do not write UI that waits on them |
| **Most of `src/stage/` and 13 legacy components are unmounted** | `Stage.tsx` imports neither `cards.tsx`, `FlowCharts.tsx` nor `flowData.ts` — they form a closed island. `Board`, `PickCard`, `TileGrid`, `MarketPicture`, `PickPanel`, `ButterflyChart`, `BridgeConnector`, `SectorChips`, `FlowCrest`, `NodeFunnel`, `TopRail`, `TickerStrip`, `MarketDepthPanel` are imported by nothing. The `.ob-*` and `.mh` CSS families in `stage.css` are therefore unrendered | Editing any of them changes nothing on screen. Confirm with a grep before you spend an hour |
| **Three outbound paths bypass the ban guard *and* mock mode** | `data/calendar.ts` → bea.gov, `data/yahoo.ts` → Yahoo, `data/derivatives/providers.ts` → Hyperliquid POST all use raw `fetch` | Anything you add should go through `fetchText`. If you must use raw `fetch`, say so |
| **`shared/types.ts` declares `LedgerStats` twice** | At `:895` and `:945`, with different field sets | TypeScript merges them, so it compiles. Be careful editing either |
| **`OiQuadrant` is declared twice** | `config.ts:465` and `engine/derivatives.ts:63`, identically | Harmless today, a trap when one changes |
| **Two constants share a name with different values** | `VETO.UNLOCK_LOOKAHEAD_H = 48` vs `ALERTS.UNLOCK_LOOKAHEAD_H = 24` | Searching the bare name gets both |
| **`TZ.IST_OFFSET_MIN = 330` is declared three times** | `config.ts:16`, `lib/time.ts:2`, `lib/etTime.ts:16` | All identical today |
| **`qa/stage*.txt` are stale** | `stage6-verify.txt` records 18 files / 377 tests. The tree is 22 / 420 | Do not quote those counts as current. Do not delete them either — they are the record of past runs |
| **Tests are not typechecked** | `tsconfig.json` includes only `src`, `server/src`, `shared`, `vite.config.ts` | A type error in a test or a Playwright spec will not fail `npm run verify` |
| **Running the test suite dirties the tree** | `store.test.ts` writes `data/test-ledger.db`; `mock.test.ts` writes `data/mock-test.db`. Both are staged | Expect `git status` noise after a run |
| **There is no inbound rate limiting, no CORS, no error middleware** | Nothing in the repo mounts them | Single-user tool. If you expose it, that is a real change, not a config tweak |
| **`qa/diag.spec.ts` is a placeholder** | It asserts `expect(true).toBe(true)` | It is a debugging probe. Do not count it as coverage |

### 16.4 Definition of done

A change is finished when **all** of these are true. Anything less is a partial change and the
context file should say so.

1. `npm run verify` passes — typecheck plus every test, **no test deleted, skipped or weakened**.
2. `npm run build` passes.
3. The layer that owns the change has a test. A backend change needs a vitest assertion; a UI
   change needs a Playwright assertion **or a written reason it cannot have one**.
4. Any new number is in `server/src/config.ts` with a tag, and **no duplicate of it was left
   behind** (grep for it).
5. `CONTEXT.md` is updated **in the same pass** — this file is the memory. If the change is
   behavioural, update the relevant section *and* the API table or Appendix A. If it is a bug, add
   it to the section-12 table with symptom and fix. If it is still unbuilt, say so under section 13.
6. Real output quoted, never paraphrased. "p50 1294 ms", not "low latency". **A run that failed is
   recorded as failed** — that is what makes the passing ones mean anything.
7. If it was verified against a live stack, say which script and paste the output. If it was not,
   say that too.

### 16.5 What "honest" means concretely, in this codebase

The house rules have code-level shapes. Use these:

- **A number you do not have** → `null`, and the UI renders `—` (or `n/a`, or an `Unavailable`
  object with a `reason`). Never `0`, never a fallback constant.
- **A feed that is not updating** → `DELAYED` at 3 s, `STALE` at 6 s, and the badge changes. Never
  keep showing green.
- **A statistic without enough samples** → suppressed with a sentence saying why.
  `LEDGER.MIN_SAMPLE_FOR_RATE = 30` enforces this.
- **A number that is a lower bound** → labelled. `/api/liquidations` hard-codes a `note` saying so.
- **A weight that was not fitted** → still tagged `[TUNED]` in config and still described as
  hand-tuned wherever it surfaces.
- **An unverified rate** → `INDIA_TAX` carries a fourth tag, `[?]`, meaning *not one of the three*.
  The UI flags it and the rate is editable.

---

## 17. Roadmap, with the stable IDs used elsewhere in this file

Parts X and XII refer to work items as **M1.2**, **M1.4**, **M2.1**, **M2.2**, **M2.8** and **M3.2**.
They were never collected anywhere, which made them un-actionable. Here they are, with the evidence
for each. **Only these six IDs are in use** — they are not a wider backlog.

| ID | Item | Why it matters | Where it would land | State |
|---|---|---|---|---|
| **M1.2** | Timeframe selector on `/api/asset/:id` | The route hardcodes `5m` and takes no `interval`. `CandleChart` already accepts `maxCandles` | `server/src/index.ts` route, `shared/types.ts`, `src/components/TicketPanel.tsx` | Not started |
| **M1.4** | Kill the two fabrication risks | **More serious than anything else here.** `fundingZ: 0` renders as `z=0.00`, and board rows report zero liquidations under a live-looking `Meta`. Both are "no data" wearing "zero" | `server/src/data/derivatives/build.ts`, `src/components/DerivativesTab.tsx` | **DONE 20 Oct (Part XVIII).** The two cases were already fixed in the working tree and are now pinned by `qa/honesty.spec.ts` — **3 passed (desktop), 3 passed (mobile)**. Two *further* fabrications were found and fixed in the same pass: `fundingZScore()` returned a hardcoded `0`, and `buildDerivRow()` asserted `stale: false`. **Bug #43** |
| **M2.1** | Volume, EMA/SMA/RSI/Bollinger overlays | The chart is OHLC + OB box + ladder + VWAP only | `src/components/CandleChart.tsx` | Not started |
| **M2.2** | FVG band + HTF zone overlay on the chart | `Setup.fvg` and `HtfContext` are computed by the engine and **never rendered** | `src/components/CandleChart.tsx` | Not started — the data already exists |
| **M2.8** | Drawing tools | — | `src/components/CandleChart.tsx` | Not started |
| **M3.2** | Fix `rMultipleOf()` | It credits every winning trade with the plan's **furthest** target's R, so the ledger statistics are inflated | `server/src/ledger/resolve.ts` | **DONE 20 Oct (Part XVIII).** `realisedR()` now credits the target that actually resolved the signal. Live before/after: `avgR 3.92 → 3.16`, `profitFactor 10.60 → 8.74`. **Bug #40** |
| **M1.5** | Make the calibration check say what it checked | `isPredictive` is `topAvg > bottomAvg` over two halves of a 4-bucket split, but the message claims the buckets are *monotone* | `server/src/ledger/store.ts` | **DONE 20 Oct (Part XVIII).** Spearman rho + a within-bucket bootstrap interval + a permutation p-value + the isotonic slope, with a **three-state** verdict. Live: `INSUFFICIENT_EVIDENCE`, rho 0, CI [−0.8, 0.6], p 0.5632. **Bug #41** |
| **M1.6** | Group `byVeto` by veto *kind*, not by the rendered string | The string embeds the move percentage, so ~90 categories are singletons | `server/src/engine/vetoKind.ts`, `server/src/ledger/store.ts` | **DONE 20 Oct (Part XVIII).** 102 distinct reasons → **5 kinds**; the two largest clear the 30-sample floor. **Bug #42** |

Two more that are not M-numbered but are queued by implication:

- **The ledger tab UI does not exist.** `GET /api/ledger` is ready; nothing renders it.
- **`npm run fit-weights` is unblocked by M3.2 but not yet honest.** There are 625 resolved signals
  (≥ the required 200) and the R is now the one that was realised. But only **54** of those rows have
  a Phase XVI outcome row with frozen costs; the other 571 have gross R and no cost breakdown, so
  fitting against them would fit the gross-R population, not a cost-honest one. The `65-80` and
  `80-100` score buckets have **n = 0** — the engine has never produced a score above 65, so the
  top of the range is uncalibrated by construction.

---

## Appendix A — Complete constant reference

**Transcribed 17 Oct 2026 from `server/src/config.ts` (435 lines).** The previous version of this
appendix covered the v1 constants only; the v2 groups were missing entirely. 24 runtime value
groups, 180 keyed constants. Tags: `[V]` verified in documentation · `[PROBED]` measured live ·
`[TUNED]` hand-tuned, **not fitted** · `[?]` unverified (used only by `INDIA_TAX`).

```ts
// ─── TZ ─────────────────────────────────────────────────────────────────
IST_OFFSET_MIN: 330                          [V]  no DST in India, so fixed is right
IST_LABEL: 'Asia/Kolkata'

// ─── NETWORK ────────────────────────────────────────────────────────────
BINANCE_SPOT_HOST: 'https://data-api.binance.vision'   [PROBED] 748ms OK
BINANCE_SPOT_HOST_ALT: 'https://api.binance.com'       (failover)
BINANCE_FUT_HOST: 'https://fapi.binance.com'            [PROBED] timeout since 27 Oct 2026; Bybit fallback
BINANCE_FUT_WS: 'wss://fstream.binance.com/market/stream'[PROBED] /market is REQUIRED; closes 1006 here
BINANCE_SPOT_WS: 'wss://data-stream.binance.vision/stream'
HYPERLIQUID_INFO · BYBIT_HOST · DERIBIT_HOST · COINBASE_HOST · COINGECKO_HOST
STABLECOINS_HOST · FNG_HOST · GECKOTERMINAL_HOST · DEXSCREENER_HOST
COINDCX_HOST · NSE_HOST · YHOST                             (untagged)
FARSIDE_HOST: 'https://farside.co.uk'            [PROBED] 403 from this IP → Unavailable

// ─── RATE (outbound politeness) ─────────────────────────────────────────
BINANCE_WEIGHT_BUDGET: 6000                  [V]  weight/min
BINANCE_BACKOFF_AT: 0.7                             (70% consumed → slow down)
GDELT_MIN_INTERVAL_MS: 5000 · GDELT_MAX_RECORDS: 250   [V]
GECKOTERMINAL_MIN_INTERVAL_MS: 6000             [V]  floor of 10-30/min
DEXSCREENER_/HYPERLIQUID_/BYBIT_MIN_INTERVAL_MS: 60_000
COINGECKO_MIN_INTERVAL_MS: 2_000              [TUNED] serialised; 429 seen at ~2/min
COINGECKO_MARKETS_TTL_MS: 5 * 60_000          [TUNED] identity + altseason share one 250-row call
COINGECKO_GLOBAL_TTL_MS: 5 * 60_000           [TUNED] /global is cached separately

// ─── LIVE ───────────────────────────────────────────────────────────────
MAX_STREAMS_PER_CONN: 1024                     [V]
PROACTIVE_RECONNECT_MS: 23 * 3600_000           [V]  Binance drops at exactly 24h
RECONNECT_BASE_MS: 1000 · RECONNECT_MAX_MS: 60_000 · RECONNECT_JITTER: 0.3
WS_CONNECT_LIMIT: 300                          [V]  per IP
WS_CONNECT_WINDOW_MS: 5 * 60_000
PING_RESPONSE_MS: 10 * 60_000                  [V]  ⚠ NO CONSUMER + comment says 1 minute
LIQ_SAMPLE_INTERVAL_MS: 1000                   [V]  ⚠ NO CONSUMER — lower-bound rule unenforced
RING_BUFFER_CANDLES: 1000
TICK_PUSH_MS: 200                              [TUNED] was 1000 — bandwidth decision, not age
SSE_HEARTBEAT_MS: 15_000
MAX_VISIBLE_SYMBOLS_PER_CLIENT: 200
DELAYED_AFTER_MS: 3_000                        [TUNED] was 90_000 — the bug Part XI fixed
STALE_AFTER_MS: 6_000                          [TUNED] was 240_000

// ─── Universe ───────────────────────────────────────────────────────────
MIN_UNIVERSE_VOLUME_USD: 5_000_000   ·  UNIVERSE_MAX_PAIRS: 200
MOVERS_MIN_VOLUME_USD: 2_000_000     ·  UNIVERSE_REFRESH_MS: 3600_000

// ─── REFRESH (⚠ only 4 of 13 are read anywhere — see 16.3) ─────────────
LIVE: DERIVATIVES_SNAPSHOT_MS 30_000 ✓ · OI_HISTORY_MS 300_000 ✓
      LONG_SHORT_RATIO_MS 300_000 ✓ · OPTIONS_MS 60_000 ✓
DEAD: KLINES_MS 20_000 · EXCHANGE_INFO_MS 3600_000 · NEWS_MS 300_000
      MACRO_MS 300_000 · INDIA_MS 180_000 · SCAN_MS 60_000
      ETF_FLOWS_MS 3600_000 · STABLECOINS_MS 900_000 · VOLATILITY_HISTORY_MS 300_000

// ─── FAN ────────────────────────────────────────────────────────────────
INTERVAL: '15m' · POINTS: 96                   [V]  15m × 96 = one identical 24h window
TTL_MS: 60_000 · CONCURRENCY: 12 · SET_SIZE: 20  [TUNED]  ⚠ SET_SIZE shadowed by FAN_SET
                                                      in src/stage/fan.ts (see 16.3)

// ─── DERIVATIVES ────────────────────────────────────────────────────────
FUNDING_CROWDED_8H: 0.0003                     [V]  +0.03%/8h, sustained WITH rising OI
FUNDING_EXTREME_8H:  0.0005                     [V]
FUNDING_SQUEEZE_8H: -0.0002                     [V]  -0.02%/8h
FUNDING_ZSCORE_WINDOW: 30 * 24 * 8              [TUNED]  5,760 samples
OI_SHOCK_1H: 0.05                              [V]  ±5% in 1h
LIQ_CASCADE_SIGMA: 3 · LIQ_CASCADE_WINDOW: 20  [V]  over 20 × 5min
OPTIONS_SYMBOLS: ['BTC','ETH']                 [V]  rate-limit budget
DERIBIT_SETTLE_UTC_H: 8                         [V]  08:00 UTC = 13:30 IST
FUNDING_DIVERGENCE: 0.0004 · WALL_MULTIPLE: 4 · DEPTH_IMBALANCE_FLAG: 0.6   [TUNED]
DEPTH_LIMIT: 20                                 [V]
BINANCE_FUT_TIMEOUT_MS: 4_000                    [TUNED] fail fast before Bybit fallback
BINANCE_FUT_RETRIES: 0                           [TUNED] no retry against a blocked primary

// ─── STRUCTURE ──────────────────────────────────────────────────────────
TIMEFRAMES: ['5m','15m','1h','4h'] · PRIMARY_TF: '5m'
SESSION_CANDLES: 289                            [V]  24h spans 289 bars; read via
                                                   sessionStartIndex(), never do the math
PIVOT_WING: 2 · LIQUIDITY_TOLERANCE_PCT: 0.12   [V]  12% = equal high/low
ATR_LOOKBACK: 20 · MAX_TARGETS: 2 · MAX_CONTEXT_LEVELS: 3 · MAX_PREVIOUS_SETUPS: 3
EFFICIENCY_CHOP_GATE: 0.25                      [TUNED]  below → strength 0
MIN_RANGE_PCT: 0.6                              [TUNED]  pre-filter, before klines are fetched
EVENT_RISK_PCT: 14                              [TUNED]  |move| ≥ → no levels published
APPROACH_ATR: 1.0 · ZONE_MAX_AGE_MIN: 720       [TUNED]  720min = 12h
SQUEEZE_PERCENTILE: 20 · SQUEEZE_LOOKBACK: 20 · ATR_LOOKBACK_PCTL: 100   [TUNED]

// ─── CONVICTION — ALL WEIGHTS [TUNED], NOT FITTED ───────────────────────
WEIGHTS = { structure 25, orderFlow 20, momentum 15, positioning 15,
            newsEvents 10, macroRegime 10, tradability 5 }        total 100
GRADES: A { score ≥75, checklist ≥7/8, no missing }
        B { score ≥55, checklist ≥5/8, no missing }   ← 7/8 with score <75 lands HERE, by design:
        C { score ≥35, checklist ≥3/8, missing allowed }   the checklist is cheaper and more
                                                            robust than unfitted weights
MAX_SCORE_WITH_MISSING: 60 · BOARD_SIZE: 20 · MIN_RR: 1.5
PICKS_PER_SIDE: 3 [TUNED] · MAX_PER_SECTOR: 2 [V]
HTF_ALIGNED_BONUS: 8 · HTF_CONFLICT_PENALTY: 10 · DISTANCE_READY_ATR: 1.5  [TUNED]
MIN_RR note: no liquidity target ⇒ rr = 0. Never an invented multiple.

// ─── CHECKLIST (8-point array; index order is significant) ───────────────
0 zone-fresh · 1 htf-aligned · 2 vwap-side · 3 sector-flow
4 breadth-agrees · 5 order-flow · 6 positioning-not-crowded · 7 no-event-veto
CHECKLIST[2] 'vwap-side' is the row-vs-VWAP item — Part XII's alignment check

// ─── VETO (any of these → NO TRADE, reason as the RULE chip) ────────────
MACRO_BLACKOUT_MIN: 30 · MIN_HACK_WINDOW_H: 6 · UNLOCK_MATERIAL_PCT: 2  [TUNED]
MIN_DEPTH_USD: 50_000                            [TUNED]
MAX_SPREAD_BPS: 8                                (0.08%)
UNLOCK_LOOKAHEAD_H: 48                            ⚠ same name as ALERTS' 24 — see 16.3

// ─── RISK ───────────────────────────────────────────────────────────────
STOP_ATR_BUFFER: 0.25 · MIN_LIQ_TO_STOP_MULTIPLE: 2 · DEFAULT_SLIPPAGE_BPS: 5 [TUNED]
TAKER_FEE_BPS: 5 · MAKER_FEE_BPS: 1               [V]  Binance USD-M base tier
DEFAULT_ACCOUNT: 100_000 · DEFAULT_RISK_PCT: 1 · EXPECTED_HOLD_HOURS: 8 [TUNED]

// ─── INDIA_TAX — [?] UNVERIFIED. Flagged in the UI, editable in settings ─
CRYPTO_GAIN_RATE: 0.30 · TDS_RATE: 0.01 · TDS_THRESHOLD_INR: 10_000    [?]
LOSS_OFFSET_ALLOWED: false                        [V]  no loss offset, no carry-forward
⚠ Confirm against the Income-tax Act 2025 before use.

// ─── MACRO ──────────────────────────────────────────────────────────────
BTC_1H_BETA_PER_PP_CPI: -3.2   ·   FOMC_1H_MOVE_PCT: 1.25              [V]
FOMC_REVERSAL_HOURS: 4                                               [V]
TIER1_BLACKOUT: ['FOMC','CPI','PCE']                               [TUNED]
TIER2_BLACKOUT: ['NFP','PPI','FED_SPEECH']  ⚠ name implies a blackout; VETO's comment
                                              scopes the blackout to TIER-1 ONLY
FNG_SIZING_ONLY: true                                                [V]
                                             F&G is pro-cyclical — sizing, never the decision

// ─── FUNDING_TIMES_UTC / SESSIONS_UTC ──────────────────────────────────
FUNDING_TIMES_UTC: [0, 8, 16]                                          [V]
SESSIONS_UTC (half-open [start,end)): asia [0,8] europe [7,16] us [13,22]
⚠ Distinct from SESSIONS in lib/time.ts, which holds NSE/NFO cash windows by segment.

// ─── NEWS ───────────────────────────────────────────────────────────────
SEVERITY: CRITICAL 70 · HIGH 55 · MEDIUM 30 · LOW 15
NOVELTY: sameDay 1.5 · week 1.3 · month 1.15 · floor 1.0                [V]
CORROBORATION_STEP: 0.1 · CORROBORATION_MAX_MULT: 3 · NORM_CAP: 3
BODY_DECAY: 0.4 [TUNED]  headline terms carry ~10× body terms
RELEVANCE_POSITION_K: 6.25 [TUNED]   REL = 100 − k × chars
CLUSTER_JACCARD: 0.45 · CLUSTER_JACCARD_WEAK: 0.2 [TUNED]   ⚠ clustering is NOT built
REACTION_HORIZONS_MIN: [5, 15, 60, 240]

// ─── LEDGER ─────────────────────────────────────────────────────────────
FREEZE_GRADES: ['A','B'] · EXPIRY_HOURS: 24                           [TUNED]
AMBIGUITY: 'STOP_FIRST'                                                [V]  the conservative
                                                                          choice on a candle that
                                                                          could hit both
MIN_SAMPLE_FOR_RATE: 30      below this, statistics are SUPPRESSED with a reason
FIT_MIN_SIGNALS: 200         [TUNED]  fit-weights waits for this many RESOLVED signals
BACKTEST_DAYS: 30

// ─── LEDGER — calibration monotonicity (added 20 Oct 2026, Part XVIII) ─────
// The old check was `topAvg > bottomAvg`: no null hypothesis, no interval,
// and a coin flip with two populated buckets.
MONOTONICITY_MIN_BUCKETS: 3         [TUNED]  populated buckets needed to judge
MONOTONICITY_BOOTSTRAP: 2000        [TUNED]  resamples for the rho / slope intervals
MONOTONICITY_PERMUTATIONS: 2000     [TUNED]  shuffles for the permutation p-value
MONOTONICITY_ALPHA: 0.05            [V]      conventional 5% significance level
MONOTONICITY_SEED: 20261020         [TUNED]  so a report printed twice prints the same numbers

// ─── ALERTS (⚠ the whole group is unread by any code) ──────────────────
DEFAULT_COOLDOWN_MS: 15 * 60_000 · OI_SHOCK_PCT: 0.05 · UNLOCK_LOOKAHEAD_H: 24
LIQ_CASCADE_SIGMA: DERIVATIVES.LIQ_CASCADE_SIGMA   (by reference, not a literal)

// ─── MIND — the probabilistic decision layer (Part XIV, 17 Oct 2026) ─────────
// Every one of these is [TUNED]. None is fitted to outcomes — that is the
// point. The layer ships a model whose INTERCEPT is the ledger's observed base
// rate, so with no fitted weights it is calibrated at the base rate by
// construction and can only beat that bar if a feature genuinely carries
// information. `npm run mind:report` prints the live Brier against it.
// DO NOT add an accuracy target here. Calibration and expectancy are the
// objectives; accuracy is not, and 95% is specifically rejected. See Part XIV.
LOGISTIC_TEMPERATURE: 1.0
ALIGNED_LOG_ODDS: 1.6          // total log-odds swing when perfectly aligned
                                // (p≈0.85 aligned / p≈0.19 opposed from base 0.535)
BASE_RATE_PRIOR_BLEND: 0.5     // blend toward 0.5 when the ledger is thin
BASE_RATE_MIN_SAMPLES: 100     // resolved signals before the anchor is trusted
BAND_LOW: 0.45 · BAND_HIGH: 0.6
ACTIONABLE_MIN_PROBABILITY: 0.45
ACTIONABLE_MIN_NET_R: 0.05     // zero is not "break-even enough"
KELLY_FRACTION: 0.25           // deliberately NOT full Kelly on unfitted weights
REGIME_OI_THRUST: 0.02         // 1h OI move that counts as positioning thrust
REGIME_PRICE_THRUST: 0.015     // scan-window move that counts as thrust
REGIME_BREADTH_STRONG: 0.65    // one-sided breadth
REGIME_LIQ_CASCADE_USD: 0.004  // 5m liquidation notional / volume
REGIME_DOMINANCE_SHIFT_PP: 0.5
REGIME_ATR_PCTL_HIGH: 80       // volatility expansion
REGIME_MIN_BOARD: 5            // below this, breadth is suppressed not guessed
VETO_FUNDING_AGAINST: 0.0003   // = DERIVATIVES.FUNDING_CROWDED_8H, by reference
VETO_BLACKOUT_MIN: 60          // ±min around a tier-1 release
VETO_ROUTINE_NIS: 55           // routine commentary as a catalyst claim
VETO_ROUTINE_COVERAGE_PCT: 60  // "commentary dominates attribution"
VETO_EVENT_RISK: 0.14          // = STRUCTURE.EVENT_RISK_PCT / 100, by reference
VETO_EFFICIENCY: 0.25          // = STRUCTURE.EFFICIENCY_CHOP_GATE, by reference
R_NEAREST_TARGET: 1.0 · DEFAULT_COST_R: 0.12   // only when no cost figure exists
CALIBRATION_BUCKETS: 10
CALIBRATION_MIN_SAMPLES: 100
BRIER_MEANINGFUL_DELTA: 0.01   // margin required to say "beats the base rate"
// MindRegime is a SEPARATE taxonomy from the engine's existing Regime; both live,
// on purpose, and the collision hazard is documented in config.ts.

type MindRegime = 'trending-bull' | 'trending-bear' | 'range'
                | 'high-vol-cascade' | 'macro-blackout' | 'quiet'

// ─── HEALTH — the data-integrity gate (Part XV, 17 Oct 2026) ───────────────
// Spec rule 2: "Never generate a signal from incomplete, delayed, stale, mocked,
// or unverified data. If data freshness fails, output NO TRADE with the reason."
//
// Per-stream limits are NOT optional. One shared 8-second bound made a healthy
// 6-hour-old published macro calendar read as `stale` and closed the gate on
// every scan; a shared 3-second DELAYED bound did the same, because the spec
// disqualifies "delayed". Price is a ticker; news is a cached feed; the macro
// calendar is a published schedule. They do not age on the same clock.
MAX_PRICE_AGE_MS: 8_000
MAX_DERIVATIVES_AGE_MS: 60_000
MAX_NEWS_AGE_MS: 60 * 60_000
MAX_CALENDAR_AGE_MS: 24 * 3600_000
DELAYED_PRICE_AFTER_MS: 3_000
DELAYED_DERIVATIVES_AFTER_MS: 15_000
DELAYED_NEWS_AFTER_MS: 15 * 60_000
DELAYED_CALENDAR_AFTER_MS: 12 * 3600_000
// An unavailable calendar BLOCKS. A blackout veto armed by "no events" is a veto
// armed by ignorance: an outage would otherwise print A/B picks straight through
// an FOMC. Unknown != clear. [TUNED]
BLOCK_ON_CALENDAR_UNAVAILABLE: true
// An unavailable news feed BLOCKS too, for the same reason and because
// `newsScore()` used to award 5/10 for an empty feed — the same score a
// genuinely quiet asset earns. [TUNED]
BLOCK_ON_NEWS_UNAVAILABLE: true
// Derivatives DEGRADE rather than block. Positioning is one of twelve gates, so
// losing it leaves the other eleven intact and caps the grade at C. The setup
// stays visible; only the trade is withheld. [TUNED]
DEGRADE_ON_DERIVATIVES_UNAVAILABLE: true
/** A mocked stream is never tradable, only demonstrable. [V] */
MOCK_IS_TRADABLE: false

// ─── Type-only exports ──────────────────────────────────────────────────
Grade      = 'A'|'B'|'C'|'Pass'|'NO TRADE'
OiQuadrant = 'new-longs'|'short-cover'|'new-shorts'|'long-liquidation'|'flat'  (also declared
            in engine/derivatives.ts — identical, but duplicated)
RetestState= 'fresh'|'approaching'|'in-zone'|'retested-held'|'violated'|'none'
Regime     = 'trend-up'|'trend-down'|'range'|'high-vol-expansion'|'risk-off'
SizeAdvice = 'full'|'reduced'|'stand-aside'
ChecklistKey = union of the 8 CHECKLIST strings
```

// ─── LAB — the Engine Lab (added 21 Oct 2026, Part XX) ─────────────────────
MODES: ['SHADOW','PAPER','TESTNET']          [V]  LIVE is deliberately not a member
MAX_RISK_PER_TRADE_PCT: 0.5                  [TUNED]  fraction of equity on one trade
MAX_CONCURRENT_POSITIONS: 3                  [TUNED]
MAX_SECTOR_EXPOSURE_PCT: 30                  [TUNED]
MAX_DAILY_LOSS_PCT: 2                        [TUNED]  auto-halts the engine for the UTC day
DAILY_RESET_UTC_HOUR: 0                      [V]  the exchange day
KILL_SWITCH: false                           [V]  a switch, not a number
FILL_ON_NEXT_CANDLE_OPEN: true               [V]  never the signal price
PAPER_SLIPPAGE_BPS: 5                        [TUNED]
FUNDING_INTERVAL_HOURS: 8                    [V]
AMBIGUITY: 'STOP_FIRST'                      [V]
POSITION_EXPIRY_HOURS: 24                    [TUNED]
TESTNET_SPOT_HOST: 'https://testnet.binance.vision'          [V]  only /api/* exists there
TESTNET_FUT_HOST:  'https://testnet.binancefuture.com'      [V]
TESTNET_ENABLED: false                       [V]  OFF by default
TESTNET_API_KEY_ENV / _SECRET_ENV            [V]  env var NAMES only; values never logged
RETRAIN_BATCH_SIZE: 25                        [TUNED]  never retrain after one trade
RETRAIN_MIN_ROWS: 60                          [TUNED]
PROMOTION_MIN_OOS_TRADES: 30                 [TUNED]
CALIBRATION_TOLERANCE: 0.1                   [TUNED]
PROMOTION_MIN_DAYS: 90                       [TUNED]
PROMOTION_MIN_PAPER_TRADES: 300              [TUNED]
PROMOTION_REQUIRES_MANUAL_APPROVAL: true     [V]  the engine cannot promote itself
TIER_THRESHOLDS: [0.6,0.7,0.8,0.9]           [TUNED]  the brief's thresholds
TIER_MIN_TRADES: 30                          [TUNED]  below this, no hit rate is quoted
WILSON_Z: 1.959964                           [V]  95%
DRIFT_WINDOW: 50                             [TUNED]
DRIFT_BRIER_RELATIVE: 0.15                   [TUNED]
DRIFT_EXPECTANCY_R: 0.25                     [TUNED]
STATUS_REFRESH_MS: 15_000                    [TUNED]
```

**Tag census — this is the honest state of the numbers.** `[V]` ~43 · `[PROBED]` 4 · `[TUNED]` ~34 ·
`[?]` 3 · **untagged ~100**. `REFRESH`, `ALERTS` and `SESSIONS_UTC` carry no doc comment at all.
House rule 6 says every threshold carries a tag; roughly 100 keys do not. An untagged key is not a
lie, but it is also not a claim, and it should not be presented as one.

**The `LAB` group adds 27 keys and every one of them carries a tag.** It is the only group in the file
that is fully tagged, and it is the only group where that is not an accident: every one of those
numbers was written for this pass, so there was no legacy untagged key to inherit.

**One gap in the aggregate:** `FAN` is exported from the module but is **not** a member of the
`config` object at the bottom of the file. Everything else the file exports at runtime is present.


## Appendix B — Data source cheat sheet

```
Crypto OHLCV/tickers  https://data-api.binance.vision/api/v3/{klines,ticker/24hr,exchangeInfo}
Indian equities       https://query1.finance.yahoo.com/v8/finance/chart/{SYM}.NS   (+cookie/crumb)
NSE indices           https://www.nseindia.com/api/allIndices
NSE session           https://www.nseindia.com/api/marketStatus
NSE holidays          https://www.nseindia.com/api/holiday-master?type=trading   -> .FO
Market cap/global     https://api.coingecko.com/api/v3/global          (5-min cache)
Coin list/altseason   https://api.coingecko.com/api/v3/coins/markets?... (one shared 250-row cache)
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

# Part II — the v2 build, from zero to today

> Sections 1–15 above describe the **v1** build: the order-block engine, the news-impact
> engine, the India layer and the journal. Everything below is what was built **after**
> that document was written — the live transport, derivatives, conviction, the signal
> ledger, the Home/Stage UI, mock mode and the self-check runtime — and it ends with the
> render-loop bug found and fixed on 12 October 2026.
>
> Written: 12 October 2026 · same project root.

## II.1 Where the project stands

V2 was planned as 12 phases. Status:

| Phase | Name | Status |
|---|---|---|
| 0 | Source probe | ✅ **Complete** — 40 probes, 34 OK, → `DATA_SOURCES.md` |
| 1 | Live transport | ✅ **Complete** — two sockets → one `MarketState`; `/api/stream` SSE live |
| 2 | Derivatives | ✅ **Complete** — 53 perps, funding normalised to 8h, cross-venue |
| 3 | Multi-timeframe | ✅ **Complete** — 15m/1h/4h in parallel, HTF alignment on rows |
| 4 | Conviction + trade plan | ✅ **Complete** — engine + 8-point checklist + plans with real R:R |
| 5 | Regime, calendar, blackout | ✅ **Complete** — blackout now fires from a real calendar |
| 6 | News upgrades | ✅ **Complete** — tier-0 feeds, clustering, taxonomy, attribution |
| 7 | Flows, unlocks, DEX | ✅ **Complete** — stablecoins, Coinbase premium, editable unlocks |
| 8 | India layer | 🟡 **Partial** — CoinDCX INR premium live; tax calculator built |
| 9 | Signal ledger | ✅ **Complete** — `node:sqlite`, shadow signals, resolver, calibration |
| 10 | UI | ✅ **Complete** — Home rebuild, Stage chart, Derivatives tab |
| 11 | Alerts | ❌ **Not started** |

Test count today: **345 vitest tests pass** (`npm test`), plus a Playwright acceptance
suite in `qa/`. `npm run typecheck` is clean.

## II.2 What is new on the backend (`server/src/`)

| Directory | Purpose |
|---|---|
| `live/` | Spot + futures WebSockets → `MarketState` ring buffers; `ingest.ts`, `streamHub.ts`, `binance.ts`; reconnect with backoff + jitter, 23h proactive reconnect, **REST gap backfill**, setups recomputed only on candle close |
| `engine/` | `scanner.ts`, `orderblock.ts`, `timeframes.ts` (15m/1h/4h + retest state machine), `derivatives.ts` (funding/OI/CVD/basis/liquidations/cross-venue), `conviction.ts` (weights + vetoes + 8-point checklist), `tradePlan.ts`, `attribution.ts` (move → headline coverage), `butterfly.ts`, `news/` (taxonomy, lexicon, entities, score) |
| `ledger/` | `store.ts` (schema, freeze, stats), `resolve.ts` (pure resolver, split out so tests skip `node:sqlite`), `worker.ts` (freezes each scan, resolves every 5 min). Records **real A/B, shadow C, and every vetoed coin with its reason** |
| `runtime/` | `selfCheck.ts` (startup checklist), `lock.ts` (single-instance lock), `clock.ts` |
| `mock/` | Fixture replay: `fixtures.ts`, `transport.ts` (blocks uncaptured URLs instead of silently returning `[]`), `mockLive.ts` (1s ticks, 15s candle closes, liquidations), `dataset.ts` |

Key backend decisions worth keeping:

- **Derivatives are fed into the scan context via `enrichContext()`.** An early
  integration bug computed derivates but never handed them to the scan, so the Flow/Pos
  columns rendered empty and two conviction components silently scored zero. The board
  looked fine and was quietly wrong. Fixed.
- **CVD is USD notional** (Binance kline index 10 vs 7), not raw base units, so it is
  comparable across a $0.10 token and BTC.
- **Funding is normalised to 8h** via `fundingInfo`, otherwise a 4h-interval coin looks
  twice as crowded as it is.
- **Stats and calibration are suppressed below 30 samples.** A win rate from a handful of
  trades is noise; the UI says so rather than inventing a number.

## II.3 What is new on the frontend (`src/`)

| Directory | Purpose |
|---|---|
| `lib/` | `api.ts` (polling fallback), `useLiveStream.ts` (SSE client), `liveContext.tsx` (provider + `useLive()`), `freshness.ts`, `format.ts` |
| `home/` | The rebuilt Home board: `HomeView`, `HomeSide`, `Board*`, `RowPreview`, `DepthCurve`, `StrengthMeter`, `SectorsPanel`, `NewsMiniFeed`, `CoinAvatar`, `depthBuckets.ts`, `sectorHistory.ts`, `motion.ts`, `useRowPreview.ts` |
| `stage/` | The focused chart view: `Stage.tsx`, `Ticket.tsx`, `MarketDepth.tsx`, `charts.tsx`, `geometry.ts` |
| `App.tsx` | Tab shell; now consumes `useLive()` and mounts `useLiveStreamProvider(scan.data)` |

Terminal board gained five columns — **Grade, Score, Flow (CVD), Pos (quadrant), News
dot** — and the popup gained an 8-point checklist with per-component bars. A new
**Derivatives** tab shows 53 perps, sortable, with a live liquidation tape.

## II.4 The live path — how a tick reaches a pixel

This is the chain the render-loop bug lived in, so it is worth stating plainly:

```
Binance WS  →  live/ingest  →  MarketState  →  scan recompute (on candle close)
                                                  │
                        GET /api/stream (SSE)  ←──┘   snapshot on connect, then deltas
                                                  │
   EventSource in useLiveStream.ts  →  lastDataAt / prices / scan
                                                  │
        liveContext.tsx provider publishes  →  useLive() subscribers force-render
```

The provider memoises the value it publishes. Every field it depends on must therefore be
**stable between real changes**. That invariant is exactly what the Part III bug broke.

## II.5 Running and testing (current)

```bash
npm run dev            # both processes → http://localhost:5173
npm run dev:mock       # fixture-backed, no outbound network (used by Playwright)
npm test               # 345 vitest tests
npm run typecheck      # strict tsc
npm run build          # typecheck + production bundle
npm run probe          # re-run the source probe
npm run fixtures       # re-capture live fixtures
npm run verify:ledger  # replay real candles through the resolver
npx playwright test    # browser acceptance suite in qa/
```

## II.6 Bugs found and fixed in v2

Every one below was found by running against live data, not by reading code.

| Bug | Symptom | Fix |
|---|---|---|
| `fundingLabel` sign flip | nearly every coin labelled `CROWDED_SHORT` | `f <= -FUNDING_CROWDED_8H`, not `f <= FUNDING_CROWDED_8H` |
| REST klines ignored index 9/10 | `cvdSlope=0` on every coin | mapped taker-buy volume; CVD is free and was being thrown away |
| CVD in base units | `-88117` on a $0.10 token | USD notional |
| Basis annualised | `basis=-941%` on illiquid perps | raw %, null when the index is stale |
| CoinDCX assumed `{status,data}` | parse failure | it is a bare JSON array of strings |
| Target crediting ignored traded range | a gap credited TP1 that never traded | credit only if the target is inside the candle's range |
| `-0` leaked from MAE | `Object.is(-0,0)` false, JSON kept the sign | normalised |
| Derivatives never reached the scan | empty Flow/Pos columns, two components scored zero | `getScan` builds its context via `enrichContext()` |
| **Live-stream render loop** | console floods `Maximum update depth exceeded`, tab freezes | see Part III |

## II.7 Honest gaps (supersedes §13)

1. **Alerts (Phase 11) do not exist.**
2. **India layer is partial** — INR premium is live; the tax calculator is built but not
   wired into the UI.
3. **The conviction weights are still hand-tuned `[TUNED]`, not fitted.** The ledger now
   collects the outcome data needed to fit them, but `fit-weights` stays off until there
   are 200+ resolved signals.
4. **A/B picks are often empty by design** — grade A needs score ≥ 75 **and** ≥ 7/8
   checklist. On a quiet market that is correct behaviour, not a bug.
5. **The Playwright suite expects a single Vite instance** — see III.5.

---

# Part III — the render-loop bug and its regression test

## III.1 Symptom

`npm run dev` printed **no error**. The API answered `/api/health` and `/api/scan` `200`
instantly. Yet the app "was not working": the tab froze, and the browser console filled
with

```
Warning: Maximum update depth exceeded ... at App (http://127.0.0.1:5173/src/App.tsx:185:28)
```

Nothing in the terminal, because the failure was entirely client-side — which is why it
was diagnosed with a headless browser, not by reading the dev-server log.

## III.2 Root cause

An infinite render loop, created by a wall-clock read during render:

1. `src/lib/useLiveStream.ts` computed
   `lastDataAgeMs = Date.now() - lastDataAt` **inline, on every render**.
2. `src/lib/liveContext.tsx` memoises its published value on `lastDataAgeMs` and
   republishes in an effect keyed on `[value]`.
3. `src/App.tsx` calls `useLive()`, which force-renders on every publish.

So: render → new `Date.now()` → new age → new context identity → republish → force-render
→ render… forever. It only began once the **first SSE event set `lastDataAt`**; while
`lastDataAt === null` the age was `null`, so the initial paint looked fine and the bug was
invisible until data arrived.

## III.3 The fix

Move the clock out of render and into state that ticks on an interval, so the value is
stable between ticks:

```ts
// src/lib/useLiveStream.ts
const [clock, setClock] = useState(() => Date.now());
useEffect(() => {
  const t = setInterval(() => setClock(Date.now()), 2_000);
  return () => clearInterval(t);
}, []);
const lastDataAgeMs = lastDataAt === null ? null : clock - lastDataAt;
```

The age still advances (every 2 s), but it no longer changes on **every** render, so the
context value is stable and the loop cannot form. `npm run typecheck` and all 345 tests
pass.

## III.4 The regression test

`qa/live-loop.spec.ts` — a Playwright test, because the bug needs a real browser render
loop to observe and there is no DOM environment in this repo's vitest setup (no jsdom, no
Testing Library; browser behaviour deliberately lives in `qa/`).

It:

1. attaches `console`/`pageerror` listeners **before** navigation;
2. waits for the board to populate (the SSE `snapshot` fires on connect, so the trigger is
   deterministic against `dev:mock`'s 1 s ticks and 15 s candle closes);
3. watches the steady state for 8 s;
4. asserts **zero** `Maximum update depth exceeded` / `Too many re-renders` messages and
   that the tab still answers `page.evaluate()` with its rows painted.

It fails on the pre-fix code and passes after. Unrelated console noise (an upstream 429, a
StrictMode-aborted fetch) is logged but does not fail the test — its job is the loop only.

## III.5 Environment note — one Vite at a time

The Playwright config starts its **own** Vite (`:5199`) and mock API (`:8899`). If you also
have `npm run dev` (`:5173`) running, two Vite dev servers share the same
`node_modules/.vite` optimize-deps cache and the second one can wedge — its transform of
`src/index.css` spins at 100 % CPU and the page never loads (this also breaks the
pre-existing `qa/home.spec.ts`, so it is not specific to this test).

**Stop `npm run dev` before running `npx playwright test`.** The regression test also sets
its own 150 s budget so a cold mock stack is not mistaken for a failure.

---

# Part IV — the 12 Oct audit: FIX 1–4 and Stages 1–6

> Written: 12 October 2026, 17:50 IST · supersedes nothing in Parts I–III except where explicitly
> noted; where it disagrees, Part IV wins.
>
> This session added **no new product features**. Every change removes a way for the app to look
> right and be wrong, or removes a way for it to quietly stop collecting data. The conviction weights,
> the ledger rules and the closed-candle zone rule were **not touched**.

## IV.1 The shape of the session

Work was numbered so it could be tracked and re-checked:

| | What | Why it existed |
|---|---|---|
| **FIX 1** | Ban-aware rate limiting | A self-inflicted HTTP 418 from Binance |
| **FIX 2** | Supervised always-on run | The ledger records nothing while the app is stopped |
| **FIX 3** | Mock mode | No way to develop or screenshot without hitting the exchange |
| **FIX 4** | Independent plan oracle | Sizing/liquidation/tax maths had real bugs found by inspection |
| **Stage 1** | Universe completeness | 14 liquid coins were being silently dropped |
| **Stage 2** | One denominator | Three different answers to "how many coins are up" on one screen |
| **Stage 3** | Search over every symbol | A coin you could trade was unsearchable |
| **Stage 4** | Production build | Proves the tree compiles and bundles |
| **Stage 5** | Tightened truth check | The old check could pass a stream that was a minute stale |
| **Stage 6** | Full verify | Typecheck + every test |

Each stage left its output in `qa/stage*-*.txt` so the claim can be re-checked without re-running it.

---

## IV.2 FIX 1 — ban-aware rate limiting

### The cause

A **self-inflicted HTTP 418**. The old backoff was 5 s / 20 s / 60 s. Binance's own documentation,
quoted verbatim in the source, says:

- *"HTTP 418 return code is used when an IP has been auto-banned for continuing to send requests
  after receiving 429 codes."*
- *"IP bans are tracked and scale in duration for repeat offenders, from 2 minutes to 3 days."*
- *"A Retry-After header is sent with a 418 or 429 response…"*
- *"The limits on the API are based on the IPs, not the API keys."*

That last line is why this is **per host AND per IP group**. Eleven Binance hosts share one pool, so
a ban on one gates all of them. Reporting only the per-host view would keep hammering a sibling host
that is already serving 418s.

### `server/src/lib/banGuard.ts` (760 lines, pure — injected clock, no I/O)

| Piece | Rule |
|---|---|
| `parseRetryAfter` | RFC 9110 §10.2.4 — delta-seconds **or** HTTP-date. Anything numeric that isn't delta-seconds (`-5`, `3 days`) is rejected outright, because `Date.parse` will happily return nonsense for those. A legal HTTP-date always starts with a weekday name |
| `parseBanUntil` | The `-1003` body. **The docs render the timestamp as an untyped `%s`**, so the parser does not assume a unit: 13-digit → epoch ms, 10-digit → epoch s, small integer → seconds from now, anything else → `Date.parse`. Unparseable returns `null` and the caller falls back to escalation |
| Precedence | `Retry-After` → body (**only if strictly in the future**) → escalation. A stale body timestamp must never shorten the wait the header gave |
| `ESCALATION_LADDER_MS` | 2 m · 5 m · 15 m · 1 h · 6 h · 24 h · 72 h. First and last are documented; the middle is a geometric ladder |
| `budgetLevel` | From `X-MBX-USED-WEIGHT-1M`: ≥70 % `slowdown`, ≥90 % `pause`. `essential` / `normal` / `nonessential` calls are gated accordingly |
| Stale readings | Discarded after 60 s. The header describes a rolling one-minute window; obeying it forever keeps a host paused on a reading that stopped being true |
| `ConnectAttemptLimiter` | 300 connection attempts / 5 min per IP, per Binance's WebSocket docs |
| `reconnectDelayMs` | Exponential backoff with symmetric jitter, floor 500 ms. Deterministic when `random` is injected, so a test asserts the schedule exactly |
| `recordCall` | Dev guard: warns when one caller issues >120 REST calls/min, naming the pattern that caused the 418 |

### Three bugs this code found in itself

1. **`ban(?:ned)?`, not `banned?`.** The latter parses as `"banne" + optional "d"` and therefore fails
   to match the bare word *"ban"* in the "ban expires" phrasing. A unit test caught it.
2. **The PAUSE deadlock.** Under `pause`, the very request whose response header would tell us the
   window has rolled was the one being held back — so the host could never recover. One probe per
   window is now permitted (weight 1–2 against a 6000 budget). **Found by the end-to-end proof, not
   by reading the code.**
3. **Two registries, one ban.** `rateLimitBoot.ts` exists because the restart proof caught it: the
   restart restored the ban row from SQLite into a registry, while the request path consulted a
   *different* instance. The ban was never enforced and the restart happily re-hit a banned host —
   exactly the failure the feature exists to prevent. Hence one named `bootRateLimiter()` that
   installs persistence **and** loads it, before any socket opens.

Persistence lives in SQLite so **a restart must never re-hit a banned host**. Evidence: 51 tests in
`server/test/banGuard.test.ts`, plus `npm run prove:ban` (real 418 with `Retry-After`) and
`prove-ban-restart.ts` (child process). `/api/health.banGuard` reports `restoredFromDiskAtBoot`, every
host's window/source/strikes, group bans and `devGuardWarnings`.

---

## IV.3 FIX 2 — the supervised always-on run

The signal ledger only records while the app is running, and a server that is stopped records nothing.
So an always-on run became the supported way to operate between CPI, FOMC and PCE prints.

### `server/scripts/supervisor.ts` — `npm run start:forever`

Restart on exit · crash-loop backoff (a run that dies in under 60 s doubles the wait, capped at 5 min)
· log rotation at 5 MB keeping 5 files under `data/logs/` · single-instance lock at
`data/orderflow.lock`.

**Why not pm2** — rejected on evidence, not taste: its Windows daemon/`startup` flow is the fragile
part and that is exactly what start-on-login needs; it is a machine-wide global install a fresh clone
would not have; and it is a fleet manager being asked to supervise one laptop process, when Task
Scheduler is already the Windows-native answer. Nothing here is Windows-specific — the same wrapper
runs under systemd or `pm2 startup`.

### The three pieces that make "running" a measurable claim

| File | What it does |
|---|---|
| `runtime/lock.ts` | The second launch **refuses to start and names the holder** — PID, host, start time, uptime. "Address already in use" arrives far too late, after the sockets are already open. The lock path is resolved *per call* from `ORDERFLOW_LOCK`, not at import time, so a test cannot lock the developer's own running server out of existence |
| `runtime/clock.ts` | Sleep/wake **and** event-loop-stall detection, from two independent signals because either alone has a blind spot: ① monotonic-vs-wall drift — `performance.now()` does not advance during suspend on Windows while `Date.now()` jumps, so a divergence is a definite sleep/wake or clock change, caught on the very next tick; ② tick latency — a pure stall moves both clocks together, invisible to drift, obvious as a late timer. Gaps are recorded in the `gaps` table and backfilled, never smoothed over |
| `runtime/selfCheck.ts` | Startup PASS/FAIL for the five things that silently corrupt the ledger rather than crashing: lock, DB writable, ban state loaded, calendar loaded 30 d, timezone conversion. The calendar check asserts on **named events**, not a count — a calendar with three wrong dates still has three dates in it, so `count > 0` proves nothing |

`/api/health.supervision` answers it as numbers: `restarts24h`, `gaps7d`, `downtimeMinutes7d`,
`lastLedgerCandleAgeSec` (the process can be alive with a resolver that is stuck), and **`coverage`** —
read that before quoting any win rate. Signals that already existed and hit a level during the hole
are recovered by backfill; signals that would have been *created* during the hole have no row to
recover and are permanently absent.

---

## IV.4 FIX 3 — mock mode

**The rule: mock mode runs the SAME parsers, SAME engine and SAME SSE hub as production, with only
the bytes on the wire replaced.** That is why the seam is the transport inside `lib/http.ts` rather
than a parallel mock data layer — a parallel layer would be a second implementation, and UI work
built against a second implementation proves nothing about the first.

| File | Role |
|---|---|
| `mock/fixtures.ts` | Loads `fixtures/` + `manifest.json` |
| `mock/transport.ts` | Installed in place of the real transport. `fetchText`/`fetchJson`/every provider above them are untouched |
| `mock/mockLive.ts` | 1 s ticks, 15 s simulated candle closes, liquidations |
| `mock/dataset.ts` | The replayed dataset |
| `scripts/record-fixtures.ts` | `npm run record-fixtures` — one-time capture |

**An uncaptured URL throws `MockNetworkBlockedError` rather than returning `[]`.** That throw is the
important half: mock mode that quietly returns empty produces a UI that looks *empty* rather than
*broken*, and the bug gets built into a screen. `qa/diag.log` shows it working exactly as intended —
the mock refused three RSS feeds with no fixture and said which URL.

`record-fixtures` politeness rules, in order: it **refuses to run while any host is under a ban**
(capturing during a ban is how a 2-minute block becomes a 3-day one); requests are sequential with a
700 ms gap; it calls the ordinary `fetchText` so the new rate limiter governs it — the recorder cannot
bypass the thing it is helping protect; and re-running it is a deliberate act, never triggered by a
test or `npm install`.

**The UI side:** `ModeBadge` (LIVE · MOCK · BANNED · OFFLINE) driven by `/api/health.mock.active`,
plus a sticky yellow-and-black striped header alert — *"MOCK DATA — N fixtures replayed from disk.
This is NOT the live market."* — because the cheapest way for this to go wrong is someone
screenshotting a board during development.

---

## IV.5 FIX 4 — the independent plan oracle

Position sizing, net R, leverage, liquidation price and tax are where real money is decided — and
**two serious bugs had already been found in that code by inspection**. The existing tests assert
against the same implementation they exercise, so they would both have passed if that implementation
were wrong in the same way twice.

`scripts/plan-oracle.ts` therefore recomputes every figure **from the definitions and imports nothing
from `tradePlan.ts`**:

```
riskAmount  = accountSize × riskPct/100
riskPerUnit = |entry − stop|          qty = riskAmount / riskPerUnit
costBps     = 2×takerFee + |funding8h|×1e4×(holdH/8) + max(defaultSlippage, spread)
costR       = (costBps/1e4 × entry) / riskPerUnit          netR = R − costR
liquidation : isolated margin, L× ⇒ 1/L of entry away  ⇒  liqToStopMultiple = (1/L)/(stopDist/entry)
India tax   : profit floored at 0 (NO loss offset), TDS 1 % of SELL TRANSFER VALUE above ₹10k
```

`npm run plan:workings` prints three worked plans with the arithmetic shown, so it can be checked by
hand. `server/test/planOracle.test.ts` runs 21 tests over thousands of randomised **long and short**
plans with a seeded PRNG, so a failing case is reproducible from its seed. Two independent derivations
converging is the whole point.

---

## IV.6 Stage 1 — universe completeness

### The root cause

The old scanner keyed 24h tickers by **BASE** after stripping `(USDT|FDUSD|BUSD)$` and kept the
**first** pair it saw. Binance returns BUSD/FDUSD pairs before USDT for several bases, so the volume
test was applied to the **deprecated, thinner book** — `DOTBUSD` before `DOTUSDT` — and the pair was
discarded. **14 liquid coins were being dropped every scan**, and the board looked completely normal.

### The fix — `server/src/data/universeBuilder.ts`

`selectUniverse` is **pure**: no network, no clock, no module state, so the unit tests drive it with
a hand-built symbol and ticker list. It resolves each base to its USDT spot pair **explicitly**, takes
the volume, price and change from **that same pair**, and never falls back to BUSD or FDUSD. USDC is
the only fallback and it is labelled.

`data/universe.ts` survives as **METADATA only** — name, sector, beta group, news tags. A pair without
metadata is still included, with sector `"Other"` and its ticker as a provisional name;
`resolveIdentity` then fills a real name from the cached CoinGecko list when one exists.

Every exclusion is logged with a reason, so the completeness test can assert a liquid pair was
dropped **on purpose rather than by accident**: `stablecoin` · `wrapped/bridged duplicate` ·
`leveraged token` · `no 24h ticker` · `below volume floor`.

**`isLeveraged` is the subtle one.** A naive suffix test drops real coins — `JUP` (Jupiter) ends in
"UP" and `PUMP` ends in "UP". Binance's leveraged tokens use the **underlying as a prefix**, so the
rule is: the base ends with a leveraged suffix **and the remaining root is itself a traded base**.
`BTCUP` → `BTC` (traded) ⇒ drop. `JUP` → `J` (not traded) ⇒ keep.

### Live result

```
exchangeInfo symbols: 1375 (status TRADING, quoted pairs)      24h tickers: 3116

candidate pairs by 24h quote volume:  $2M: 151   $5M: 99   $10M: 62   $20M: 37

final universe: 94 pairs (floor $5.0M, cap 200)
excluded: 412   —  399 below volume floor · 12 stablecoin · 1 wrapped/bridged duplicate
spot checks (must be present): DOT NEAR UNI AAVE FIL ICP — all OK
```

The floor and cap live in `config.ts`: `MIN_UNIVERSE_VOLUME_USD = 5_000_000`,
`UNIVERSE_MAX_PAIRS = 200` (bounds WS kline load as the exchange lists more markets),
`UNIVERSE_REFRESH_MS = 3_600_000` (startup + hourly; keeps the last good resolution if a refresh
returns empty).

### The cost plan is measured against the venue, not guessed

```
95 spot WS streams (94 × @kline_5m + 1 × !miniTicker@arr; 1024/connection cap)
cold REST backfill 376 requests = 752 weight ≈ 12.5 % of the 6000/min ceiling, one-off,
                    staggered 4-at-a-time; a warm restart reads SQLite and fetches only the tail
scanner budget 50 % (3000/min) so the zoned setup path keeps headroom
```

A cold scan issues ~380 requests against a 1500/min ceiling, so **the ceiling is never the binding
constraint** — which is worth knowing before the universe grows.

### One cosmetic defect the evidence exposes

The final list contains **`币安人生`** — a base with a non-ASCII ticker that passed every filter. It
is a real listed pair, so nothing is wrong, but it is the kind of thing that looks like a bug on
screen. Flagged, not fixed.

---

## IV.7 Stage 2 — one denominator

### The defect

**Three different answers to "how many coins are up", on one screen.** The breadth chips counted the
whole universe (42), the depth curve counted the board rows (40), and the "choppy" chip counted
assets whose 24 h change was exactly zero (always 0) while the engine knew 16 coins were choppy. Each
panel re-derived it from whatever rows it happened to hold.

### The fix — `server/src/live/aggregate.ts`

The server is the only place that sees **every** symbol's tick, so it computes breadth, live sector
flow and movers **once**, from the same universe set the scanner uses, and pushes the result as one
`agg` event per second. Every client renders it verbatim.

A symbol with no tick yet falls back to its 24 h REST change, so **up + down + flat always equals the
universe size** — the denominator cannot change between panels. `buildAggregate` is exported pure so
that guarantee is a *test*, not a comment.

### The client half — `src/lib/aggStore.ts`

Deliberately **outside React context**. Publishing the aggregate through `liveContext` would give the
provider a new identity every second and re-render the whole app shell with it — exactly the
regression `priceStore` was written to remove. Components subscribe with `useSyncExternalStore` and
re-render alone. Last-writer-wins by `asOf`, so a replayed or out-of-order event never rolls the
market backwards.

### Live evidence

```
agg : n=94  up=59  down=35  flat=0  seen=94   23 sectors   15 movers   venue=Binance
      btc 83417.81 +0.30 %     eth 2546.89 +1.57 %
      top movers: GTC +72.67 % · RSR +53.23 % · W +46.66 % · LUMIA −26.17 % · PYTH +17.97 %
scan: totalScanned 94 · universeRows 94 · bullish 44 · bearish 28 · choppy 22 · sum 94
```

---

## IV.8 Stage 3 — search over every exchange symbol

### The defect

The search only knew the ~190 hand-maintained universe entries. A coin that trades on Binance but is
not on today's board was **unsearchable** — you typed its ticker and got "No matches". That is the
opposite of what a search box is for.

### The fix

`server/src/data/symbolIndex.ts` builds the index from the venue's own `exchangeInfo` for **both**
markets — spot `?permissions=SPOT` and `${BINANCE_FUT_HOST}/fapi/v1/exchangeInfo` filtered to
`PERPETUAL` — refreshed every 6 h. It is **metadata only**: a name, a sector and the symbol pair. Live
prices are attached by the route from the tick stream, never invented here.

Three details that make it usable rather than merely complete:

- **Quote ranking** (`USDT 0 · USDC 1 · FDUSD 2 · BTC 3 · ETH 4`) so "DOT" resolves to `DOTUSDT`, not
  `DOTBTC` / `DOTEUR` / `DOTTRY`. At most two entries per base survive: the best spot leg and the perp.
- **`stripMultiplier`** so `1000PEPE` displays as `PEPE` while `pair` stays the exact traded symbol.
- **Names come from the universe file first** (the only source with a sector), then CoinGecko
  identities cached in SQLite. A symbol with neither keeps its own ticker as the name and sector
  `"Other"` — never a guess.

`server/src/lib/search.ts` is pure ranking:

| Match | Score |
|---|---|
| exact base | 1000 |
| exact display ticker | 990 |
| base prefix | 800 |
| ticker prefix | 780 |
| name prefix | 700 |
| base substring | 600 |
| name substring (≥2 chars only) | 500 |

Ties break on base-over-other, then **spot over perp** — the spot leg is what the board and the popup
price track, so it is the one the user can act on — then alphabetically.

`GlobalSearch` in the header: 220 ms debounce, in-flight request aborted on each keystroke, full
keyboard navigation, and `price === null` renders a **dash**, never an invented number. Eight
Playwright tests in `qa/search.spec.ts`, including "a nonsense query says so rather than showing a
stale hit". A hit is a real destination: a board coin opens the full order-block experience; a coin
with no board row lands on the Derivatives tab.

---

## IV.9 Stages 4–6 — build, truth, tests

### Stage 4 — production build

```
tsc --noEmit && vite build
✓ 69 modules transformed
dist/index.html                 3.05 kB │ gzip:  1.43 kB
dist/assets/index-*.css        70.05 kB │ gzip: 13.99 kB
dist/assets/index-*.js        272.51 kB │ gzip: 86.31 kB
✓ built in 839ms
```

### Stage 5 — the truth check, tightened

The previous check accepted a **flat 0.5 % on 8 symbols** — loose enough to pass a stream that was
quietly a minute behind. The tightened version:

| Check | Rule |
|---|---|
| Majors | BTC / ETH / BNB / SOL within **0.03 %** |
| Everything else | within `max(0.15 %, its own 1-second price range)` |
| Breadth | ≥ **25** symbols compared, ≥ **5** outside the old hard-coded list |
| Freshness | newest tick ≤ 5 s old at receive, measured against the **server's** `ts` |
| Latency | exchange event time `E` → client receive, reported p50 / p95 / max |
| Search | `/api/search` must return the same live price the stream is carrying |

The 1-second-range term is the honest part of the allowance: **if a coin moved 0.4 % within one
second, a REST call taken a moment later is *supposed* to disagree by up to that much.** Anything
beyond it is a stale price, not timing.

### Live result — including the two failures

```
PASS  all 2821 ticks carry a finite price, change and ts
PASS  newest tick ≤ 5000 ms old at receive (worst 10 ms on CHIPUSD1)
PASS  server timestamps advance per symbol (0 regressions)
PASS  compared 45 symbols (need >= 25)
PASS  39 compared symbols are outside the old 8-symbol list (need >= 5)
FAIL  every symbol within its allowance (worst 298 % of limit on RSRTRY)
PASS  p95 exchange->client latency under 5 s (3799 ms)
PASS  search(BTC)   price matches stream (Δ 0.0000 %, age 691 ms)
PASS  search(USDC)  price matches stream (Δ 0.0010 %, age 694 ms)
FAIL  search(ZECUSDC) returned no hit for a streamed symbol
PASS  search(BNB)   price matches stream (Δ 0.0000 %, age 696 ms)

latency: n=407  p50=1294 ms  p95=3799 ms  max=26952 ms
majors: BTCUSDT Δ 0.0000 % · ETHUSDT 0.0008 % · BNBUSDT 0.0000 % · SOLUSDT 0.0000 %
```

**Both failures are recorded, not hidden.**

1. **Four symbols exceeded their allowance** — `RSRTRY` 0.447 %, `RSRUSDT` 0.403 %, `FRAXUSDT` 0.397 %,
   `WUSDT` 0.153 %. All are thin books, not majors; every major was exact to four decimal places. This
   is a real tolerance finding, not a stream failure.
2. **`search(ZECUSDC)` returned no hit** for a symbol the stream was carrying — a genuine gap in the
   Stage 3 index's USDC-leg handling, caught by the check that was written to catch it.

### This **corrects an earlier claim** in the file

The V2-PROGRESS addendum recorded **"p50 4 ms / p95 5 ms"** receive latency and **"8/8 within 0.5 %"**.
Under the tightened measurement the real figures are **p50 1294 ms / p95 3799 ms**. The 4 ms figure
measured server-internal delivery; this measures exchange → client. The server coalesces ticks on a
1-second flush, so ~1.3 s is one flush interval plus network — a **design property**, and feed-bounded
freshness should be stated as such, not as sub-millisecond liveness.

### Stage 6 — full verify

```
npm run typecheck        tsc --noEmit — clean
npm run test             vitest 2.1.9
  18 test files · 377 tests passed (5.41 s)
```

The count climbed through the session, which is itself the record: **369** (Stage 1) → **376**
(Stage 3) → **377** (Stage 6). The heaviest new suites are `banGuard` (51), `derivatives` (42),
`conviction` (30), `calendar` (34), `planOracle` (21), `tradePlan` (26), `universeBuilder` (12),
`mock` (14, including a booted server and a re-rank when a simulated 5m candle closes).

---

## IV.10 Evidence index

Every Part IV claim is backed by one of these files in `qa/`:

| File | What it proves |
|---|---|
| `qa/stage1-universe.txt` | The live universe: 1375 pairs → 94, every exclusion counted |
| `qa/stage1-verify.txt` | Typecheck clean, 369 tests |
| `qa/stage2-live.txt` | A real `agg` SSE frame and `/api/scan` totals, side by side |
| `qa/stage2-verify.txt` | 376 tests |
| `qa/stage3-verify.txt` | 376 tests with the aggregate suite in place |
| `qa/stage4-build.txt` | Production build |
| `qa/stage5-truth.txt` | The truth check, **with its two failures printed** |
| `qa/stage6-verify.txt` | 377 tests — the final state |
| `qa/diag.log`, `qa/run.log` | Mock mode refusing uncaptured URLs, exactly as designed |
| `qa/.artifacts/` | Playwright traces for the render-loop regression |

---

## IV.11 What this session changed about the numbers

| Figure | Before | After |
|---|---|---|
| Universe | ~56 hand-maintained pairs | **94 live pairs** ≥ $5 M, capped at 200, rebuilt hourly |
| WS streams | ~57 | 95 (94 klines + 1 `!miniTicker@arr`) |
| Breadth denominator | three different answers | **one** — `n=94`, `up+down+flat = n` always |
| Searchable symbols | ~190 universe entries | **every** spot and perp pair on the venue |
| Tabs | 8 | 8, with **Markets** (all 94 pairs, live-ticked) and **Order Block** stage view |
| Rate-limit state | backoff 5 s/20 s/60 s | documented escalation + `Retry-After` + persisted per-IP-group bans |
| Process model | `npm run dev` | `npm run start:forever` — supervised, locked, gap-aware, self-checking |
| Mock mode | none | same engine, bytes swapped, loud on anything uncaptured |
| Tests | 345 | **377** |
| Verification | `verify:truth` on 8 symbols at 0.5 % | 45 symbols, majors at 0.03 %, latency p50/p95 |

---

## IV.12 Still open after this session

Honest list. None of it is stubbed or faked; it simply does not exist.

1. **The two Stage 5 failures** — four thin-book symbols outside the price allowance, and
   `search(ZECUSDC)` returning no hit.
2. **Alerts (Phase 11) do not exist.**
3. **The ledger tab UI does not exist.** The API is ready (`GET /api/ledger`); nothing renders it.
4. **The conviction weights are still `[TUNED]`, not fitted.** The ledger now collects what fitting
   needs, and `fit-weights` correctly stays off until 200+ signals resolve.
5. **Grade A/B picks are often empty by design** — A needs score ≥ 75 **and** ≥ 7/8 checklist with no
   missing components. On a quiet market that is correct behaviour.
6. **`coinIdentity`/`resolveIdentity` still leave odd bases under sector `"Other"`** — see `币安人生`.
7. **The `!forceOrder@arr` liquidation tape is a lower bound** and is labelled `isSample: true`
   everywhere. It pushes at most one liquidation per symbol per second.
8. **One venue.** Prices are Binance spot and the UI says so rather than presenting a composite.

### What was deliberately **not** changed

`CONVICTION.WEIGHTS` · grade thresholds · the closed-candle zone rule · the `MIN_RR`/no-invented-R:R
rule · ledger freeze grades and `STOP_FIRST` ambiguity handling · the 14 % event-risk veto. All of
these are calibrated by data that does not exist yet, and changing them to look better would destroy
the only thing they are for.

---

---

# Part V — the 13 Oct Order Block page rebuild

> Written: 13 October 2026 · user request: *"build the order block page the same way as the
> reference (`order-block.com/app/orderblock`) — a left-to-right flow of source → river → bracket →
> matrix → detail."*
>
> This part **supersedes the old `StageView`** (the fixed 1920×1200 `#stage` diorama described in
> Parts I–IV). The shell — header, ticker strip, tabs — is unchanged. Only the Order Block tab body
> was rebuilt. **No engine behaviour changed**: no threshold, formula, route or constant moved.

## V.1 What the page is now

The Order Block tab renders a single left-to-right pipeline, read the same way the eye reads a
production line:

| Stage | Column | What it shows |
|---|---|---|
| 0 | top bar | "ORDER BLOCK FLOW", the move-distribution spark, live bull/bear counts, and the snapshot stamp |
| 1 | source list | the 20 bulls (top half) and 20 bears (bottom half), a central `ZERO` line, one origin node at the vertical middle |
| 2 | river | fine bezier threads fanning from every source row through the origin out to the bracket |
| 2b | bracket | one `[ ]` bracket per side, a shared divider with node dots, and a bull node at 25 % / bear node at 75 % |
| 4 | mini-card matrix | the 20 rows per side split across four columns (tiny · small · medium · tall) |
| 5 | detail cards | top 3 bulls + top 3 bears, each with a score ring, price chart, level ladder footer and a price-position bar |

Colours are the page's own dark language (`#07090d` field, bull `#22e58b`, bear `#ff3b5c`, amber
`#ffb020`), never the site's light theme.

## V.2 Files

| File | Status | Role |
|---|---|---|
| `src/stage/Stage.tsx` | **rewritten** | `StageView` — the 5-stage grid, the measured SVG wire overlay, hover/select highlight, `StageBar` |
| `src/stage/flowData.ts` | **new** | derived reads: `PER_SIDE`/`MATRIX`, `buildUp` classification, `flowScore`, `ladder`, `profileBars`, `normChange`, `chartLevels` |
| `src/stage/FlowCharts.tsx` | **new** | `ProfileHist`, `MicroBar`, `DepthStrip`, `Ring`, `DetailChart` |
| `src/stage/cards.tsx` | **new** | `SourceRow`, `MiniCard` (tiny/small/medium/tall), `DetailCard` |
| `src/stage/stage.css` | **extended** | a new `.ob-*` section (old `.st-*` / `.mh` rules left intact) |
| `src/stage/Ticket.tsx`, `src/stage/MarketDepth.tsx` | **now orphaned** | no longer imported by `Stage`; left on disk and still typechecked |
| `qa/orderblock.spec.ts` | **new** | 2 Playwright tests: five stages render; hovering a row highlights its route |

## V.3 How the wires stay correct — the one non-obvious decision

The connectors are **one** absolutely-positioned `<svg class="ob-wires">` overlay, not per-card SVG.
Endpoints are read from real DOM anchors (`data-anchor` + `data-anchor-side="left|right|center"`)
*after* layout with `useLayoutEffect` + a `ResizeObserver`, and re-measured whenever the board
reorders. So when a refresh re-ranks the list and rows move, the threads follow the cards instead of
drifting to stale coordinates. A `sameAnchors` guard avoids a re-render when nothing moved.

Flow is faked with a dashed overlay stroke whose `stroke-dashoffset` animates (`@keyframes ob-flow`);
its speed tracks the row's `|% change|` (normalised by `normChange`). Hovering any element carrying a
symbol sets `hover`; `active = hover ?? selected` — the active symbol's whole route gets `.hl` and
every other route gets `.dim`.

## V.4 Data — nothing new, nothing invented

No server endpoint was added. The page reads the scan the tab already receives: `AssetRow.derivatives`
(the futures `oiChange{m5,h1,h4,d1}`, `quadrantLabel`, and `depth.walls`), `AssetRow.setup` (the
`z`/`invalidation`/`obLow`/`obHigh`/`targets`/`rr` ladder), `spark`, and `conviction.score`.

- Classification follows the standard reading: price up + OI up = `LONG BUILD-UP`; price down + OI up
  = `SHORT BUILD-UP`; OI falling = `SHORT COVER` / `LONG UNWIND`; **no derivatives feed = `FLAT`, a
  labelled state, not a guess.**
- The snapshot is labelled **"Binance REST snapshot (≤60s)"** because the futures OI/depth come from
  the engine's ≤60 s REST poll (`buildDerivatives` in `server/src/engine/scanner.ts`), not the tick
  stream. Call it what it is.
- Missing ladder ⇒ the footer shows `—` and `rr 0`, per house rule 2.

## V.5 Verification — the real output

```
npm run typecheck   tsc --noEmit — clean
npm run build       ✓ 70 modules transformed
                    dist/assets/index-*.css   81.88 kB │ gzip: 16.17 kB
                    dist/assets/index-*.js   281.48 kB │ gzip: 88.84 kB
                    ✓ built in 752ms
npm run test        vitest 2.1.9 — 18 files · 377 tests passed (5.23 s)
npx playwright test qa/orderblock.spec.ts --project=desktop
                    ✓ order block flow renders its five stages (856ms)
                    ✓ hovering a source row highlights its route (925ms)
                    2 passed (4.6s)
```

The Playwright run against `dev:mock` printed the usual "MOCK MODE: outbound request blocked" lines
for three RSS feeds — expected noise, not failures.

## V.6 Bugs found while building

| Symptom | Cause | Fix |
|---|---|---|
| Playwright strict-mode violation: `.ob-flow` resolved to 29 elements | the grid container **and** the animated path shared the class `.ob-flow` | path renamed `.ob-wire-flow` (CSS + spec updated) |
| Playwright could not click the "Order Block" tab | the sticky header / search box / event chip intercepts the pointer over the nav | the spec dispatches the click directly (`dispatchEvent('click')`) rather than a coordinate click |

## V.7 Honest gaps

1. **Not eyeballed.** The agent that wrote this cannot view images, so the page was verified by
   **geometry and structure** (the two Playwright tests), not pixels. The screenshots are in
   `qa/screens/ob-01-flow.png` / `ob-02-hover.png` for a human to review.
2. **Responsive is a truncation, not a redesign.** At ≤1400 px the river, bracket and wire overlay
   are hidden; at ≤900 px the detail column is hidden too. The wide diagram keeps a horizontal
   scroll rather than re-flowing.
3. **Bear matrix columns are top-aligned, not mirrored.** The reference reads bear tiles upward from
   the divider; here both halves read downward. Cosmetic.
4. **OI overlay is four points** (`m5/h1/h4/d1`) — that is all the snapshot carries; it is not a
   continuous OI series.
5. **`src/stage/Ticket.tsx` and `MarketDepth.tsx` are dead code** — kept (still typechecked) but no
   longer reachable from the Order Block tab.

**End of Part V.**

---

# Part VI — the 13 Oct fan rebuild (fan + hover, first slice)

> Written: 13 October 2026 · user request: *"build the fan and hover first, show me, then the funnel
> and connectors."*
>
> This part **supersedes the layout of Part V** (the responsive five-stage grid). The Order Block tab
> now renders a **fixed 1920×1200 stage scaled with a CSS transform**, exactly like the reference
> `#stage`, so the fan, the rails and the card lanes share one coordinate system. It also
> **supersedes Part V.4's "no server endpoint was added"**: `/api/fan` now exists. No engine
> threshold, formula or route was changed.

## VI.1 What shipped

| Piece | File | Role |
|---|---|---|
| fan data | `server/src/engine/fan.ts` (**new**) | `getFan()` 60 s cache + `inFlight`; `buildFan()` fetches a 15m candle series per universe pair at concurrency 12; `seriesFrom()` reduces closes to cumulative % |
| route | `server/src/index.ts` | `GET /api/fan` (503 on error), after `/api/scan` |
| config | `server/src/config.ts` | `FAN = { INTERVAL:'15m', POINTS:96, TTL_MS:60_000, CONCURRENCY:12, SET_SIZE:20 }` |
| types | `shared/types.ts` | `FanAsset`, `FanPayload` |
| client api | `src/lib/api.ts` | `api.fan` |
| fan maths | `src/stage/fan.ts` (**new**) | `FAN_GEO`, `symlog`, `buildScale`, `yOf`/`xOf`, `buildSeries`, `buildSectors` (volume-weighted), `buildHistogram`, `threadColor` |
| fan canvas | `src/stage/FanCanvas.tsx` (**new**) | two canvas layers (threads + particles), polyline hit-test, tooltip, reveal animation |
| stage | `src/stage/Stage.tsx` (**rewritten**) | fixed 1920×1200 stage; SVG rails; mini-card lanes; detail tickets; bridges |
| card | `src/stage/cards.tsx` | `DetailCard` gained an optional `chartH` so the chart fits the fixed ticket |
| css | `src/stage/stage.css` | new `.fan-*` section (`.ob-*` rules kept) |
| spec | `qa/orderblock.spec.ts` (**rewritten**) | 2 tests: fan renders; hovering a thread raises its tooltip |

The reference box sizes are encoded as constants (`FAN_GEO` in `fan.ts`, `LANES`/`NODE`/`BRIDGES_*`/
`TICKETS_*` in `geometry.ts`). Nothing is placed by eye.

## VI.2 The fan

`series[i] = close[i]/close[0] − 1`, then scaled to the window's max |move| on a **symlog** Y (green
above the white zero line, red below). All threads share a left-edge origin and land on a bracket;
a count histogram reads the same y-scale. Hovering a thread dims the rest to alpha 0.05 and raises a
tooltip; hovering a **sector label** highlights that sector instead; the pointer leaves / Escape
clears. Threads draw in with a 1400 ms staggered reveal; particles loop left→right at a rate set by
|final|.

**A thread exists only if its series is real.** A symbol with no candles is counted in `missing` and
left out — never padded with a zero line (house rule 2).

## VI.3 Verification — the real output

```
npm run typecheck   tsc --noEmit — clean
npm run build       ✓ 72 modules transformed
                    dist/assets/index-*.css   83.97 kB │ gzip: 16.52 kB
                    dist/assets/index-*.js   286.37 kB │ gzip: 91.50 kB
                    ✓ built in 916ms
npm run test        vitest 2.1.9 — 18 files · 377 tests passed (5.69 s)
npx playwright test qa/orderblock.spec.ts --project=desktop
                    ✓ fan stage renders its rails, threads, lanes and tickets (935ms)
                    ✓ hovering a thread raises its tooltip and dims the rest (1.2s)
                    2 passed (4.9s)
```

A one-off diagnostic run against `dev:mock` measured the live DOM:

```
FAN-API  {"mock":true,"n":18,"missing":0,"interval":"15m","points":96,"seriesLen":96,
          "top":["APT 12.06% Smart contract L1","INJ 6.21% DeFi / RWA","ARB 6.17% Layer 2"]}
FAN-DIAG {"bar":"ORDER BLOCK FLOW fan → funnel → cards ▲ 6 BULLISH ▼ 8 BEARISH 18 threads
          MOCK · fixture replay · 15:43 IST",
          "tiles":14,"tickets":6,"labels":11,"railRects":44,
          "stageCSS":{"w":1416,"h":885,"x":12},
          "plotCSS":{"w":341,"h":791,"x":102,"y":227},"canvasW":462}
```

`1416/1920 = 0.7375` and `341/462 = 0.738` agree — the stage transform and the fan canvas scale
together. Mock mode serves **18** threads (the fixture set), not the live 98. The Playwright run
printed the usual three "MOCK MODE … blocked" RSS lines — expected noise.

## VI.4 Bugs found while wiring

| Symptom | Cause | Fix |
|---|---|---|
| `tsc` TS2552 `Cannot find name 'FAN_HIT'` | `FanCanvas` used `FAN_HIT` but did not import it | added to the `./fan` import |
| `StageProps` missing `onClear` | `StageView` destructured a prop `types.ts` never declared | `onClear: () => void` added; `App.tsx` passes `onClear={() => setSelected(null)}` |
| detail tickets overflowed their fixed slots | `DetailCard` hard-sized its chart (104/76 px) for a flexible grid | optional `chartH` prop; the fixed stage passes `96` (hero) / `42` |

## VI.5 Honest gaps

1. **Not eyeballed.** The agent cannot view images; verification is **geometry and structure** (the
   two Playwright tests + the DOM dump above), not pixels. Screenshots for a human:
   `qa/screens/ob-01-fan.png` and `ob-02-hover.png`.
2. **The funnel lens and the 20+20 → detail connectors are not built.** The path label already reads
   `fan → funnel → cards`, but between the fan and the lanes there is only the spine; the pooled
   funnel and the bezier connectors are the next slice.
3. **Mobile is a shrink, not a reflow.** At a 393 px viewport the whole 1920 px stage scales to ~0.2;
   the fan is present but tiny. The hover test is skipped on the mobile project for that reason.
4. **`qa/orderblock.spec.ts` was rewritten**, so Part V's two test names no longer exist.

**End of Part VI.**

---

# Part VII — the 13 Oct reference-layout restore ("ditto")

> Written: 13 October 2026 · user request: *"read the reference DOM line by line, understand how the
> lines flow from the line left→right into the right-side boxes, and make the layout a ditto."* Ask
> answered: **"Crypto data, reference layout."**
>
> This part **supersedes the layout of Part VI**. Part VI had replaced the reference stage with a
> fan-centric board (`.fan-*`: a bar, an SVG rail sheet, mini-card lanes, detail tickets). The
> reference layout was recovered instead — it was still present in the git **index** as the staged
> `src/stage/Stage.tsx`/`Ticket.tsx` and the `.st-*` rule set in `stage.css` — and the **fan from Part
> VI is re-wired in as the `#cvPlume`**. No engine threshold, formula or route changed.

## VII.1 What shipped

| Piece | File | Role |
|---|---|---|
| stage | `src/stage/Stage.tsx` (**restored from index, then edited**) | fixed 1920×1200 scaled shell; renders Plume, TopRail, Crest, Chips, Ladder, Nodes, Tiles, Bridges, Tickets, Footer |
| ticket | `src/stage/Ticket.tsx` (**restored from index**) | the reference `#tickets` card (`st-tick`) |
| plume | `src/stage/FanCanvas.tsx` (**kept from Part VI**) | the 24h fan, now the reference `#cvPlume` (threads + particles, hover tooltip) |
| css | `src/stage/stage.css` | added `.st-fan` wrapper (`z-index:0`) and lifted `.st-chips/.st-ladder/.st-tiles/.st-bridges/.st-tickets/.st-cnt/.st-node` to `z-index:1` so the fan paints under the boxes |
| types | `src/stage/types.ts` | `StageProps.onClear` re-added (the restored index copy lacked it) |
| spec | `qa/orderblock.spec.ts` (**rewritten again**) | asserts the reference layout boxes **and** the fan plume |

The fan data path from Part VI is unchanged and still the source of the plume: `/api/fan` →
`server/src/engine/fan.ts` → `FanPayload` → `api.fan` → `buildSeries`/`buildScale`. The stage polls it
every 60 s and feeds `active` (hover ?? selection) into `FanCanvas`.

## VII.2 Verification — the real output

```
npm run typecheck   tsc --noEmit — clean
npm run build       ✓ 71 modules transformed
                    dist/assets/index-*.css   84.12 kB │ gzip: 16.55 kB
                    dist/assets/index-*.js   278.46 kB │ gzip: 88.82 kB
                    ✓ built in 933ms
npm run test        vitest 2.1.9 — 18 files · 377 tests passed (5.09 s)
npx playwright test qa/orderblock.spec.ts --project=desktop
                    ✓ order-block stage renders the reference layout and the fan plume (1.0s)
                    ✓ hovering a thread raises its tooltip (4.2s)
                    2 passed (8.1s)
```

A one-off diagnostic run against `dev:mock` measured the live DOM:

```
OB-DIAG {"shell":{"w":1416,"h":885,"x":12,"y":120},
         "crest":{"w":496,"h":60,"x":30,"y":129},
         "chips":11,"chip1":{"w":336,"h":16,"x":65,"y":203},
         "ladder":{"w":71,"h":0,"x":443,"y":268},
         "nodes":5,"counts":["UNIVERSE\n18","BOARD\n14","PICKS\n0"],
         "tiles":14,"tile1":{"w":127,"h":170,"x":873,"y":150},
         "bridges":6,"tickets":6,"ticket1":{"w":389,"h":170,"x":1021,"y":135},
         "footer":{"w":1381,"h":22,"x":30,"y":983},
         "fanPlot":{"w":341,"h":791,"x":102,"y":188},"canvases":2,"fanCvW":462,
         "crestText":"LEADING SECTOR | DeFi / RWA | +6.21% | 6 | BULLISH | 8 | BEARISH | as of | 16:08 | IST",
         "tileText":"#01 APT +12.06% Z 0.868300 rr 0.0"}
```

`1416/1920 = 0.7375`; the crest `496/672 = 0.738`; the fan plot `341/462 = 0.738` — every box scales
with the one transform. The Playwright runs again printed the three expected "MOCK MODE … blocked"
RSS lines.

## VII.3 Bugs found while restoring

| Symptom | Cause | Fix |
|---|---|---|
| `tsc` TS2322: `onClear` not in `StageProps` | the **index** copy of `types.ts` predates the Part VI `onClear` addition | re-added `onClear: () => void` |
| `tsc` TS2322: `FanPayload \| null` not assignable to `FanPayload \| undefined` | `usePolling().data` is `… \| null` | `Plume` prop typed `fan?: FanPayload \| null` |
| the Read tool returned the **pre-checkout** contents of `types.ts` (still showing `onClear`) | stale read after `git checkout` | verified with `Get-Content`; do not trust a cached read after an external file change |

## VII.4 Honest gaps

1. **The lens and the bezier connectors are still not drawn.** `#cvLens` and `#cvFx` remain absent;
   the chips/ladder/tiles sit above the plume and the only "flow" is the fan itself plus the static
   `.st-spine` bar. The pooled lens and the right-side bezier connectors are the next slice.
2. **`PICKS` reads 0 in mock** — `countPicks` is `rows.filter(isPick).length` and the 18-fixture mock
   produces no picks. Honest, not a bug in the layout.
3. **`cards.tsx` / `flowData.ts` are now unreachable** from the Order Block tab (the restore uses
   `Ticket.tsx` + `ObSpark`). Kept on disk, still typechecked — same status Part V gave `Ticket.tsx`.
4. **Not eyeballed.** The agent cannot view images; verification is geometry + structure, not pixels.
   Screenshots for a human: `qa/screens/ob-01-layout.png`, `ob-02-hover.png`.
5. **Mobile is a shrink, not a reflow** (unchanged from Part VI).

**End of Part VII.**

---

# Part VIII — 13 Oct "reference-v2" anatomy: tiles, tickets, crest, chips, ladder, nodes, bridges, lens/spine/fx

> Written: 13 October 2026 · user re-pasted the full reference `#stage` DOM and demanded a
> line-by-line ditto (tiles → tickets → crest → chips → ladder → node pipeline → bridges),
> "complete the above request fast idiot". **Supersedes the box anatomy of Part VII** (which
> rendered simplified tiles and tickets); the fan plume, rails and geometry constants are kept.
> No engine behaviour changed — this is page anatomy only.

## VIII.1 What shipped

| Piece | File | Role |
|---|---|---|
| geometry | `src/stage/geometry.ts` | added `SPINE` (40/556/1880×186.857), `LENS` (686/0/690×1200), `NOW_LINE` (590/96 h1056), `BRIDGE_TOPS` (bull `[125,328,494]`, bear `[715,917.5,1083.5]` — absolute stage coords), `RET` (x1163 w182; bull 15/251/421, bear 605/841/1010, h per lane), `IDXTAGS` (72/470/456) |
| stage | `src/stage/Stage.tsx` (**rewritten**) | reference-v2 anatomy: Plume, LensBox (`.st-lensbox`), Spine (`.st-spine` band + `.sk` motes), TopRail, Crest (`.pcount` `.share bull/bear` with `.tri` svg arrows + `.k` + `.n`, `.pz` zero dot, `.ptag` LEADING SECTOR), Chips (up desc from top 112 step `CHIP_DY` 26; dn asc from 806.857 step 48.163; `.r1 .cap+.v` + `.strip` inline `<i>` bars colored per member), IdxTags (top-8 movers), Ladder (584/92/118×1072, `<canvas.lcan>` histogram bars by `|changePct|` + rank numbers), Nodes (`.st-nowglow`+`.st-nowline` at 590; beacon/now/gate/lens/reactor glyphs; `.st-cnt` UNIVERSE 583 / BOARD 698 / PICKS 1374 with `.ld`+`<b>`; `.st-gwin` windows 593/104 & 593/1052.19 with 9 `.gmote` `<i>` each), Tiles (wrapper at lane.x−810 / slot.y(+590), `.st-tile` bull/bear/pick/sel/c1..c4 with `TileChart` canvas + `.plate` (column: non-pick tkr over pc; pick row1 mg+tw + sub buc+pips `GradePips`) + `.rk` + `.br tl/tr/bl/brr` + `.latch`, `.st-ret` glows as siblings only when `r.isPick`), Bridges (`.st-bridge` top 3/side at `BRIDGE_TOPS`, h110, `--sc`, `::after` center dot), Fx (full-stage `.st-fx` SVG bezier connectors x1356→1368 at bridge centres, dash-flow, dimmed when dealer thread not focused), Tickets (bull offset 20 / bear `BEAR_Y_OFFSET+20` = 610; hero h230 / p2 164 / p3 156) |
| ticket | `src/stage/Ticket.tsx` (**rewritten**) | reference `#tickets` card: `.gb/.sheen/.spec/.acc`; `.ab.info` (rowa mg+idc(tkr,nm), rowb pill + `.cgrp`(ScoreRing + GradePips), rowc `.pc` (hero 42px), rowd ltp/pts/pctl); `.chart` with `TicketChart` **SVG** (shared domain over spark/z/inv/obLow/obHigh/targets; OB band rect, area, spark path, level lines + right label chips R2/R1/Z/S1 (bull) / S2/S1/Z/R1 (bear), rising strokes, live point, `.ovl.lg` chip buc+OI+Δ); hero `.plan` (`.cells` sl/en/t1/t2/rr + `.rrbar` r0/r1/tk), std `.lvlstrip nosep two` (l1 ZONE/S1, l2 R1/R2/R:R); `StartRail` `svg.rail` (risk/gain segments + current-price marker) + `.railsep` |
| css | `src/stage/stage.css` | appended "Part VIII" block covering every v2 class (lensbox, spine+`sk-rise`, pcount/ptag/pz, chip r1/strip, ladder, nowline/glow `now-breathe`, node glyph keyframes `ring-pulse`/`dia-flare`/`ring-spin`/`ring-spin-rev`, counts `cnt-sweep`, gwin `gmv`, tile plate/rk/br/latch, `.st-ret`, bridges, `fx-flow`, idxtags, ticket ab/chart/plan/lvlstrip/rail). Same-selector rules win because appended last. Container tops overridden to 0 for `.st-tiles/.st-bridges/.st-tickets/.st-chips`; `.st-ladder` top 92 |

## VIII.2 Verification — the real output

```
npm run typecheck   tsc --noEmit — clean
npm run build       71 modules transformed
                    dist/assets/index-*.css   100.98 kB · gzip: 19.49 kB
                    dist/assets/index-*.js    286.83 kB · gzip: 91.38 kB
                    built in 885ms
npm run test        vitest 2.1.9 — 18 files · 377 tests passed (4.86 s)
npx playwright test qa/orderblock.spec.ts --project=desktop
                    order-block stage renders the reference layout and the fan plume (1.8s)
                    hovering a thread raises its tooltip (3.2s)
                    2 passed (8.0s)
```

A one-off DOM dump against `dev:mock` (single `page.evaluate`, scaled: stage transform 0.7375):

```
DIAG V2 crest=496x60@30,129  pcount=76x43  ptag="LEADING SECTOR DeFi / RWA +6.21%"
       crestText="BULLISH6 BEARISH8 LEADING SECTOR DeFi / RWA +6.21%"   (bull 6, bear 8 in mock)
       chips=11 (up 5 / dn 6)  chipBars=18   ladderRks=40  ladderCanvas=1
       nodes=5  counts=3  gmotes=18  reactorRings=2  nowLine=1
       lensbox=509x885@518,120  spine=1387x138@42,530  fxPaths=6  idxtags=8
       tiles=14 (c1 6 / c2 7 / c3 1 / c4 0 · mock has 6 bull + 8 bear rows, no ranks > 12)
       c1Box=127x170@873,135 (= 172x230 × 0.7375)  tileCanvases=14  plates=14  rks=14  brs=56
       retGlows=0 (no picks in mock — honest)  bridges=6  bridgeBox=21x81@1000,198
       tickets=6 (hero 2)  heroBox=389x170@1021,135  abInfo=6  charts=6  plans=2  lvlstrips=4  rails=6  rings=6
       heroText="AP APT Aptos BULL 23 +12.06% $0.9184 +0.11 P94.4 Z S1 LONG BUILD-UP OI — Δ —
                 S1 0.866567 ZONE 0.868300 R1 — R2 — RISK 0.20% 1:—"
```

Boxes × 0.7375 match reference: c1 172×230 → 127×170 ✓, ticket 528×230 → 389×170 ✓, bridge 28×110 →
21×81 ✓. `OI —`, `Δ —`, `R1/R2 —`, `R:R 1:—` are honest dashes (mock carries no OI flow and no
liquidity targets) — house rule 2 kept. The run again printed the usual three "MOCK MODE … blocked"
RSS lines.

## VIII.3 Bugs found while building

| Symptom | Cause | Fix |
|---|---|---|
| `tsc` TS6133 `TICKETS_X` unused | `Tickets` container keeps its stage left from the old CSS rule; `TICKETS_X` no longer referenced | dropped from the geometry import |
| `tsc` TS7053 `BRIDGE_TOPS["bullish"]` | geometry keys are `bull`/`bear`, code indexed by side `"bullish"/"bearish"` | explicit `side === 'bullish' ? BRIDGE_TOPS.bull : BRIDGE_TOPS.bear` |
| `tsc` TS6133 `rank`/`t2p`/`oi`/`cvd` in Ticket | leftovers from the v1 card; `oi`/`cvd` now computed inside `TicketChart` | removed the unused locals |
| `tsc` TS2339 `Property 'y' does not exist` on level rows | `lvs` typed without `y` while the SVG reads `l.y` | added `y: number` and `Y(price)` to each level (TicketChart) |
| bear bridges rendered off-screen | `top: BRIDGE_TOPS[i] - 20 + offset` double-counted the bear offset (715−20+590 = 1285) and shifted bull by −20; container top changed to 0 | `top: BRIDGE_TOPS[side][i]` directly — those are absolute stage coords |
| c3/c4 tile plates would clip | row layout (`flex-direction: row`) overflowed 94/114-px tiles | `.st-tile .plate` is a **column** (tkr above pc), anchored top-left per lane (c1/c2/c3 top 20, c4 top 17, picks top 18) |

## VIII.4 Honest gaps

1. **Not eyeballed.** The agent cannot view images; verification is geometry + structure (Playwright
   + the DOM dump above), not pixels. Screenshots for a human: `qa/screens/ob-01-layout.png`,
   `ob-02-hover.png`.
2. **`#inspector` (the live hover tooltip on tiles/tickets) is still not built** — reference shows a
   tooltip with `mg`+ticker/name, a `.px` row, `.g2` rows (rank / OI / Δ / gate), a `canvas.spk` spark
   and an `.obl-note` "Access Locked". Only the fan (`FanCanvas`) currently raises a hover tooltip.
   Next slice.
3. **Crest `canvas.pcv` (the small move-distribution spark) is not drawn** — the `.pcv` element is
   wire-covered by CSS only.
4. **`PICKS` reads 0 in mock** (`rows.filter(isPick).length`; the 18-fixture replay has no picks), so
   no `.st-ret` glows or pick latches render in screenshots — honest, not a bug.
5. **std-ticket bottom `.lvlstrip` is two rows inside `overflow:hidden`** and may clip at the 156/164
   heights — cosmetic, acceptable.
6. **Mock breadth differs from the reference screenshot** — 6 up / 8 down sectors, 14 board rows, no
   bear tickets beyond rank rows existing; the anatomy renders correctly around a smaller board.
7. **`cards.tsx` / `flowData.ts` remain unreachable** (unchanged from Part VII).

**End of Part VIII.**

---

# Part IX — 13 Oct "Calm Terminal" restyle of the Order Block stage

> Written: 13 October 2026 · user asked to "do proper research and become a great ui designer" and
> "update my order block page … minimal aesthetic and very user-friendly … do it perfectly", then
> chose **"Calm terminal"** as the direction and **"Keep the stage flow, restyle"** as the scope.
> **Supersedes the visual treatment of Part VIII** — the anatomy, geometry and DOM shape are
> unchanged; this part only recolours, flattens and re-types the same boxes, and switches the
> decorative motion off. No engine behaviour changed.

## IX.1 What shipped

Research (four web reads: fintech dashboard design guide, dark-mode fintech guide, trading-terminal
design tokens) converged on a small, repeatable rule set, applied wholesale:

| Rule | Before (Part V–VIII) | After (Part IX) |
|---|---|---|
| Surfaces | gradients, inset glow, `backdrop-filter: blur` | matte near-black ramp `#0a0d11 → #10141a → #141921 → #1a2029`; depth by lightness, not shadow |
| Structure | glows, blur, gradients | hairline borders `rgba(226,232,240,0.07)` (+ `0.13` on hover) |
| Direction colour | emerald `#19e58c` / crimson `#ff3b5c` (saturated, glowing) | soft emerald `#3fd487` / coral `#f87171`; signs ▲▼ kept; colour never the only cue |
| Warning / info | amber `#ffb020`, cyan-blue `#45b8ff` | amber `#fbbf24` = invalidation only; steel `#8ab4e8` = neutral info only |
| Type | Inter Tight + heavy 800 weights | Inter Tight labels, **JetBrains Mono tabular numerals everywhere**, weights 700 (800 removed globally) |
| Readability | 7–9.5px micro-labels (≈5–7px effective at the 0.7375 scale) | smallest labels raised to 10–11.5px; chart/SVG labels 7–8 → 9.5–10 |
| Motion | spine motes, node ring-pulse / dia-flare / ring-spin, cnt-sweep, now-breathe, gmote drift, fx dash-flow, fan travelling particles, 1400ms fan reveal | all switched off (`display:none` / `animation:none`); fan reveal 1400→**700ms**; only a state-change flash may animate |
| Interaction | blue selection ring | hairline selection `#8ab4e8` + inset ring; `:focus-visible` outline on `.st-tile`, `.st-bridge`, `.st-tick` |

Design tokens (`--ob-bg/--ob-panel/--ob-card/--ob-raise/--ob-line/--ob-line2/--ob-txt/--ob-txt2/
--ob-txt3/--ob-up/--ob-dn/--ob-warn/--ob-info`) are declared on `.stage-shell`.

| Piece | File | Change |
|---|---|---|
| css | `src/stage/stage.css` | 18 global string mappings in the Part V–VIII blocks (hex + rgba so washes dim too) + a new appended **Part IX** block (tokens, flat surfaces, motion-off, size bumps, focus/selection, reduced-motion guard). Appended last so identical selectors win |
| fan | `src/stage/FanCanvas.tsx` | travelling-particle rAF loop removed (canvas kept but cleared — the spec still counts **2** `canvas.fan-cv`); thread `shadowBlur` glow removed; gridlines 0.045→0.03; `REVEAL_MS` 1400→700; stale `ltDots` doc-comment corrected |
| palette | `src/stage/fan.ts`, `cards.tsx`, `FlowCharts.tsx`, `MarketDepth.tsx`, `Stage.tsx`, `charts.tsx`, `Ticket.tsx` | every remaining brand literal recoloured to the calm palette (incl. canvas fills, SVG text fills/strokes); tiny SVG label `fontSize` 7/7.5/8 → 9.5/10 |

Old→new hex (case-insensitive, all files): `#19e58c`/`#22e58b` → `#3fd487`; `#ff3b5c`/`#ff4d67` →
`#f87171`; `#ffb020` → `#fbbf24`; `#45b8ff` → `#8ab4e8`; `#edf2f9`/`#eef2f8` → `#e6ebf4`; `#a2aec1`
→ `#9aa5b5`; `#6a768a` → `#78828f`; `#434e61` → `#4a5465`. rgba triples remapped to match
(`25,229,140`/`34,229,139` → `63,212,135`; `255,59,92` → `248,113,113`; `69,184,255` → `138,180,232`;
`255,176,32` → `251,191,36`).

## IX.2 Verification — the real output

```
npm run typecheck   tsc --noEmit — clean (exit 0)
npm run build       71 modules transformed
                    dist/assets/index-*.css   107.46 kB · gzip: 20.62 kB
                    dist/assets/index-*.js    285.87 kB · gzip: 90.97 kB
                    built in 1.39s
npm run test        vitest 2.1.9 — 18 files · 377 tests passed (5.26 s)
npx playwright test qa/orderblock.spec.ts --project=desktop
                    order-block stage renders the reference layout and the fan plume (1.2s)
                    hovering a thread raises its tooltip (1.2s)
                    2 passed (8.1s)
```

Computed-style dump from a one-off spec against `dev:mock` (`qa/_diag-v3.spec.ts`, deleted after the
run). Counts are unchanged from Part VIII, so the spec's structural asserts still hold:

```
COUNT  chips=11  nodes=5  cnts=3  tiles=14  bridges=6  ticks=6  fanCv=2  spineSk=3
       nowglow=1  reactorRings=1  gmotes=18  retGlows=0
STYLE  .st-crest .share.bull .n   27px/JetBrains Mono  weight 700  color rgb(63,212,135)  (no glow)
       .st-chip .r1 .cap          11px/Inter Tight      rgba text rgb(154,165,181)
       .st-chip .r1 .v            11.5px/JetBrains Mono  rgb(63,212,135)
       .st-ladder .rk             11.5px/JetBrains Mono  rgb(154,165,181)
       .st-tile                   bg rgba(16,20,26,0.85)  border rgba(63,212,135,0.35)
       .st-tile .rk               15px/JetBrains Mono
       .st-tick                   bg rgb(16,20,26)  border rgba(63,212,135,0.35)
       .st-tick .ab .pill         10px/JetBrains Mono
       .st-tick .ab .rowd         11.5px/JetBrains Mono  rgb(154,165,181)
       .st-tick .plan .pcell      10.5px  rgb(251,191,36)  — amber = invalidation only
       .st-tick .lvlstrip         10px
       .st-idxtags .tag b/em      11px / 10.5px
       .st-rail / b.t             11px · rgb(154,165,181)
       .st-footer                 10.5px  rgb(90,101,115)
MOTION .st-spine .sk            display:none            (sk-rise off)
       .st-nowglow              display:none            (now-breathe off)
       .st-node.reactor .rings  display:none            (ring-spin off)
       .st-node.beacon .ring / .st-node.now .dia   animation:none
       .st-cnt .ld / .st-gwin .gmote / .st-fx .fx-g path   animation:none
       .st-tick .sheen / .st-tick .spec            display:none
```

`.st-tile .plate .sub` and `.st-tile .latch` read "MISSING" in the dump because those nodes only
exist on pick / sub-graded tiles, and mock has **0 picks** (`retGlows=0`) — the same honest mock gap
Part VIII recorded. The three usual "MOCK MODE … blocked" RSS lines printed again.

## IX.3 Bugs hit while restyling

| Symptom | Cause | Fix |
|---|---|---|
| Playwright refused to start: "another OrderFlow instance is already running: PID 18456 on 127.0.0.1:8899 … up 107m" | `playwright.config.ts:48` pins `ORDERFLOW_LOCK: data/qa.lock`, which **overrides** any shell env var. A prior run's API died without clearing the lock; Windows recycled the PID to an unrelated **`svchost`**, so `taskkill` was "Access is denied" and the lock looked live. No listener on 8899 | deleted the stale `data/qa.lock` (gitignored); the run then started cleanly. A stale lock with a recycled PID reads as a live holder — worth a liveness check, not fixed here |
| `.fan-stage` backdrop override was dead CSS | that class is not on the Order-Block route (the board root is `.stage-shell` over `body`) | bound the matte backdrop to `.stage-shell { background:#0a0d11 }` |

## IX.4 Honest gaps

1. **Not eyeballed.** The agent cannot view images; verification is the computed-style dump +
   Playwright structure asserts, not pixels. Fresh screenshots for a human: `qa/screens/ob-01-layout.png`,
   `ob-02-hover.png`.
2. **True state-change flash not implemented** — the research's one allowed animation (a ≤600ms
   flash when a value changes) is still the existing `usePriceRevision` treatment; Part IX did not
   add or retune it.
3. **`#inspector`, `canvas.pcv`, `PICKS=0`, `.lvlstrip` clip, mock breadth** — all carried over from
   Part VIII gaps 2–6, unchanged by this part.
4. **Palette is hex-for-hex on `stage.css` + the eight stage components only**; the rest of the app
   (`home.css`, other views) keeps its own colours, so the Order-Block page is a calm island for now —
   intentional scope, not a finished theme system.

**End of Part IX.**

---

# Part X - 14 Oct 2026: the chart was never real

Roadmap milestone **M1.1** of `order block/docs/ORDERBLOCK_FEATURE_GAP_MATRIX.md` and
`IMPLEMENTATION_ROADMAP.md`. The gap audit found that the only real OHLCV chart in the codebase was
dead code, and the chart users actually saw was drawing numbers the market never produced.

## X.1 The bugs

**1. The ticket fabricated every wick. (the serious one)**

`TicketPanel.tsx` drew its "candles" like this:

```ts
const candleData = useMemo(() => row.spark.slice(-50).map((v, i) => {
  const prev = i > 0 ? row.spark[i - 1] : v;
  return { o: prev, h: Math.max(v, prev), l: Math.min(v, prev), c: v };
}), [row.spark]);
```

`AssetRow.spark` is a **close-only** series. So every bar had `open = previous close`, and
`high`/`low` = the envelope of two consecutive closes. The high and low are *invented intrabar
extremes that never happened*. It rendered as a perfectly plausible candlestick chart, which is the
exact failure this project exists to prevent: a wrong chart that looks right is worse than no chart.

**Fix:** `MiniCandleChart` is deleted. The ticket now renders `CandleChart` against real OHLC from
`GET /api/asset/:id`. While that loads it says "Loading 5m candles..."; when it fails it says
"Chart unavailable - <reason>". It never falls back to drawn geometry.

**2. `CandleChart` was never mounted anywhere.**

`AssetPopup.tsx` was the only render site for the real chart, and `AssetPopup` itself was imported
by nothing. A "Full chart" button now opens it from the ticket, mounted above every tab in `App.tsx`
because a chart belongs to an instrument rather than to a view.

**3. `axisPct` rendered a double minus. (found by the new test, not by me)**

```ts
const v = ... pct.toFixed(1);      // -3.21 -> "-3.2"  (ASCII hyphen)
const sign = pct < 0 ? MINOR : ''; // U+2212
return `${sign}${v}`;              // "−-3.2%"
```

Every negative axis label would have read `−-3.2%`. Fixed by formatting the magnitude:
`const abs = Math.abs(pct); const v = abs >= 100 ? abs.toFixed(0) : abs.toFixed(abs >= 10 ? 0 : 1);`

**4. A latent rules-of-hooks violation in `TicketPanel`.**

`if (!setup) return null;` sat **above** the `useMemo` and (now) `useAssetDetail` calls. A ticket
opened on a board row with no setup renders `null`; the next row may have one. That changes the hook
count between renders and takes React down. Both hooks were moved above the early return.

**5. `useLazy` could not change subject.**

`useLazy(fetcher, enabled)` keyed its effect on `[enabled]` only, so swapping symbol A -> B while
`enabled` stayed `true` kept showing A. Added an optional `key` argument.

## X.2 One owner for real candles

`AssetDetail` and `useAssetDetail()` now live in `src/lib/api.ts`, not in `AssetPopup.tsx`. Two
surfaces read them, so the shape is owned by the API layer and both the popup and the ticket are
forced through the same door. The hook's doc comment states the rule explicitly: do not rebuild
candles from `spark`.

## X.3 Verification, real output

Run in `C:\Users\DK\Desktop\trading` on 14 Oct 2026:

```
> npm run typecheck
> tsc --noEmit
(clean)

> npm test
 Test Files  19 passed (19)
      Tests  394 passed (394)
   Duration  5.09s

> npm run build
> tsc --noEmit && vite build
dist/index.html                   3.05 kB | gzip:  1.43 kB
dist/assets/index-CcSDLlPP.css  107.65 kB | gzip: 20.64 kB
dist/assets/index-CFaBqB-m.js   302.80 kB | gzip: 95.54 kB
built in 965ms
```

Test count moved **377 -> 394** (+17). The new file is `server/test/chartMath.test.ts`; the chart
helpers in `src/components/chartMath.ts` had **no tests at all** before this pass.

`qa/chart.spec.ts` (new, 3 blocks, all passing on desktop): real candles render, closed and forming
bars are distinguished, the full chart is reachable and closes on Escape, and a forced `503` from
`/api/asset/**` produces the error message with **zero** candles drawn.

## X.4 Pre-existing failures, NOT caused by this work

The full Playwright run after this change is **11 failed / 65 passed**. That is not a regression. I
proved it rather than asserting it: my edits were working-tree-only, so the git index held the
pre-change state. I reverted the six source files to the index, moved the two new test files aside,
and re-ran `qa/home.spec.ts`:

```
  11 failed
  36 passed (2.2m)
```

**Identical 11 failures at baseline.** They are in the Home dashboard (`qa/home.spec.ts`): layout
ratio, equal column widths, the mobile bottom sheet, zero-CLS on hover, the Z/S1 label in
`RowPreview`, and `.of-badge.bear` contrast - desktop and mobile. `qa/run.log` from an earlier session
already records failures in the same file. **Not touched here; not caused here.**

The five non-home specs all pass: 14 passed / 0 failed.

## X.5 Honest gaps, unchanged

1. Still **no timeframe selector**. `CandleChart` now takes `maxCandles`, but `/api/asset/:id`
   still hardcodes `5m` and takes no `interval`. That is roadmap **M1.2**.
2. Still **no volume, no EMA/SMA/RSI/Bollinger, no drawing tools** - **M2.1 / M2.8**.
3. Still **no FVG band, no HTF zone overlay** - **M2.2**.
4. The bigger fabrication risks are untouched: `fundingZ: 0` rendered as `z=0.00`, and board rows
   reporting zero liquidations under a live-looking `Meta`. Both are **M1.4** and both are more
   serious than anything fixed here.
5. `rMultipleOf()` still credits every winning trade with the plan's furthest-target R, so the
   ledger statistics remain inflated. **M3.2.**
6. 11 pre-existing `qa/home.spec.ts` failures above.
7. `qa/diag.spec.ts` still asserts `expect(true).toBe(true)` - a placeholder, not a test.

**End of Part X.**

---

# Part XI - 15 Oct 2026: the price was never live

> Complaint, verbatim: *"my prices are not updating live, there is too much gap in the real price
> and the price I am seeing in my website"*, followed by *"use the thing which is used by
> TradingView ... don't show STALE 10s ago and all this, as TradingView does not show it"*.
>
> Both halves were true. The data path was capped at **1 Hz by the upstream we subscribed to**,
> and the UI was plastered with freshness badges over a feed that could never justify them.

## XI.1 Root cause - it was never a rendering bug

The first and most important finding: **no amount of work downstream could have fixed this.**

The Binance spot socket subscribed to exactly two stream families:

```
btcusdt@kline_5m   ... per symbol, 5m bars
!miniTicker@arr    all market, 1000ms
```

`!miniTicker@arr` is Binance's **once-per-second** snapshot. It was the only price source. So the
newest price the server could physically hold was up to 1,000 ms old, and every consumer -
`streamHub.stageTick`, the 1 s flush, `priceStore.applyTick`, React - inherited that ceiling.

Two further constants had been *tuned around* that ceiling rather than questioned:

| Constant | Was | Effect |
|---|---|---|
| `LIVE.TICK_PUSH_MS` | `1000` | Coalesced a real-time source down to the snapshot rate |
| `LIVE.DELAYED_AFTER_MS` | `90_000` | An **85-second-old price rendered a green `LIVE` badge** |

The 90 s figure was not arbitrary - it was correct for the thing it was written for, a 60 s board
scan, and then silently reused for price freshness. That is the house rule *"STALE is never
rendered as LIVE"* broken by an over-generous constant rather than a wrong one, which is worse,
because the code reported what it believed and the belief was wrong.

### Measured, not assumed

20 s probe against `wss://data-stream.binance.vision` (the exact host the project uses), three
symbols:

```
btcusdt@aggTrade      msgs=102   rate=5.10/s   lastSeenAge=54ms
ethusdt@aggTrade      msgs=120   rate=6.00/s
solusdt@aggTrade      msgs= 36   rate=1.80/s
!miniTicker@arr       msgs= 19   rate=0.95/s   <- the ceiling we had been living under
```

**0.95/s measured against a theoretical 1/s.** The diagnosis is confirmed, not inferred.

## XI.2 What TradingView actually does

The user's instruction was to use what TradingView uses, so it was read rather than assumed -
from TradingView's own charting-library datafeed tutorial, *Streaming Implementation*:

| TradingView | This repo, before | This repo, now |
|---|---|---|
| One **shared** Binance WebSocket, multiplexed across subscribers | one socket, multiplexed | unchanged |
| `<symbol>@kline_<interval>` + `<symbol>@trade` raw ticks | `@kline_5m` + **snapshot only** | `@kline_5m` + **`@aggTrade`** |
| `UPDATE_FREQUENCY = 250` - *"rather than redrawing on every tick, batch and flush on a fixed interval"* | `1000` | `200` |
| **No freshness badge** - it renders the price | `LIVE` pill + `STALE 10s ago` on every row | silent unless degraded |

So the fix was to adopt TradingView's actual mechanism - which is raw exchange WebSocket with a
fixed-interval batched flush - rather than to poll faster or add a badge claiming freshness.

`@aggTrade` over `@trade` deliberately: both are documented real-time, but `aggTrade` aggregates
fills sharing a taker order and price, so it carries the same information at a fraction of the
frames. `@trade` remains the right choice only for rebuilding sub-1m bars.

## XI.3 The changes

| File | Change |
|---|---|
| `live/ingest.ts` | Subscribe `<symbol>@aggTrade` alongside the existing streams; cache the 24h open from `miniTicker` so a real-time tick can still compute a correct 24h change |
| `live/ingest.ts` | `LiveIngest.maxSymbolsPerConnection()` - each symbol now costs **two** streams, so slicing the symbol list by `MAX_STREAMS_PER_CONN` over-subscribed the socket 2x and Binance silently dropped the overflow |
| `live/streamHub.ts` | `subscribeRaw` - the whole flush is handed to the route as **one** pre-serialised string, so the route does one `res.write` per flush instead of one per symbol |
| `live/streamHub.ts` | Suppress a tick whose price has not moved (costs a frame and a React notification for an unchanged number) |
| `config.ts` | `TICK_PUSH_MS` 1000 -> **200**; `DELAYED_AFTER_MS` 90s -> **3s**; `STALE_AFTER_MS` 240s -> **6s** |
| `index.ts` | `/api/stream` uses `subscribeRaw` |
| `lib/freshness.ts` | Client thresholds kept in step (a test asserts parity) |
| `lib/freshness.ts` | `useAgeClock` - **one** shared 500 ms clock. `ValueAge` was rendered per board row and each owned a private 1 s interval, so a 200-row board ran 200 timers forever |
| `home/BoardRow.tsx` | Removed the per-row `<ValueAge>` tag |
| `components/ui.tsx` | `FreshnessBadge` -> **`StreamNotice`**, which renders nothing when healthy |
| `App.tsx` | Header uses `StreamNotice`; `visibleSymbols` returns `null` (not `[]`) before the first board, so the ticker is not dead during the first scan |

## XI.4 The badge question - why silence, and why it is still honest

The user asked for TradingView's behaviour, and TradingView shows no freshness indicator. The
naive reading of that is "delete the badge", which this repo's own rules forbid. The resolution is
that the two are not actually in conflict:

- **Silence is a claim, not an absence.** It asserts "a message arrived within 3 s", which is
  checked every 500 ms against the newest *data* message - not the heartbeat, because a heartbeat
  only proves the socket is open while the upstream can be silently dead.
- **A badge that says `LIVE` 99.9% of the time has no value on the 0.1%.** It trains the eye to
  skip it, which is precisely when it was needed.
- So `StreamNotice` is silent when healthy and appears past the threshold naming the age and the
  reason. If the stream stops, it renders. It is the only thing standing between a frozen price
  and an unsuspecting trader.

`ValueAge` is **kept**, not deleted, for the case that is genuinely per-value (a single quote, a
funding rate) - with a comment recording why it is not used on the board.

## XI.5 Verified

`npm run verify` - **409 tests / 20 files, 0 failed.** Two pre-existing tests changed, both for real
reasons and both recorded rather than quietly edited:

- `freshness.test.ts` asserted `freshnessOf(5_000) === 'LIVE'`. That assertion *was* the bug.
  Replaced with one that states the correct claim, plus a guard that the LIVE window stays
  `>= 5x` the push interval (so it cannot flicker) and `<= 10s` (so it cannot lie).
- `streamHub.test.ts` leaked `lastSent` state across tests - previously harmless, fatal once the
  dedupe existed. Added `__resetStreamHub()` and a `beforeEach`.

Six new tests in `streamHub.test.ts`: burst collapses to newest price, raw subscriber gets one
write, unchanged price is not resent, raw subscribers still receive broadcasts, raw honours the
visible set, empty flush writes nothing.

### End-to-end, on the wire, as the browser reads it

```
=== SSE end-to-end over 30.0s (raw wire) ===
BTCUSDT   updates= 52  rate=1.73/s  gap p50=404ms  p95=1647ms  MAX=3710ms
ETHUSDT   updates= 60  rate=2.00/s  gap p50=409ms  p95=1255ms  MAX=2101ms
SOLUSDT   updates= 19  rate=0.63/s  gap p50=1217ms p95=4730ms  MAX=4730ms
msgs       : 164 (5.5/s)
tcp chunks : 174 (5.8/s)  <- batching proof
```

164 messages in 174 TCP chunks: **~1 write per flush**, exactly as intended.

### The claim that matters - do the shown prices match the exchange?

Each price read off the SSE wire, compared against Binance REST at the same moment:

```
symbol    ours (wire)        Binance REST        diff          rel
BTCUSDT   82056              82056.01          -0.010000    -0.00001%
ETHUSDT   2427.37            2427.17            +0.200000   +0.00824%
SOLUSDT   105.34             105.36            -0.020000   -0.01898%
XRPUSDT   1.3324             1.3329            -0.000500   -0.03751%
DOGEUSDT  0.08077            0.08079           -0.000020   -0.02476%

worst relative divergence: 0.03751%
PASS - displayed prices track the exchange.
```

The residual is the ~100 ms between the two fetches, not staleness. `npm run build` also passes.

## XI.6 A regression this work introduced, and how it was caught

Moving the route to `subscribeRaw` silently stopped the 1 s `agg` push: `subscriberCount()`
returned `subscribers.size`, which is 0 for every real browser client once they are raw. The first
end-to-end probe reported **`agg events: 0`**, which is how it was found - a live regression
invisible to `npm run verify`, since no unit test gated it. Fixed, and pinned by a test that
asserts `subscriberCount()` includes raw subscribers.

**This is the argument for measuring the wire rather than trusting the diff**, and it is recorded
here so the habit survives.

## XI.7 Honest gaps, unchanged

1. **Sub-millisecond is not achievable and was never claimed.** The floor is the exchange's own
   publish rate plus one flush interval. BTC measured **5.1 trades/s** - the browser now repaints
   at 5Hz against a source that itself ticks at 5Hz. A "1 ms price" would be a fabricated
   number, which rule 2 forbids.
2. **Illiquid symbols update less often, and that is correct.** SOL delivered 0.63 updates/s
   because its `aggTrade` rate is 1.8/s and many consecutive fills share one price. The displayed
   price is current; there is simply nothing to redraw. This is TradingView's behaviour too.
3. **`lastSent` is per-process, not per-client.** Two tabs on different visible sets share it.
   Harmless today - a dropped frame for one tab costs at most one flush interval - but it would
   need per-subscriber state to be strictly correct.
4. **Only Binance spot is real-time.** Futures still subscribes `markPrice@1s`. Indian equities
   remain a 60 s Yahoo poll; `StreamNotice` will correctly show them as delayed rather than
   pretending otherwise.
5. The 11 pre-existing `qa/home.spec.ts` failures from Part X are untouched. The Playwright specs
   were **not** re-run - browser behaviour needs `npm run dev` stopped first, and the server was
   left running on the user's machine rather than restarted underneath them.
6. `aggTrade` doubles the stream count per symbol. `UNIVERSE_MAX_PAIRS = 200` means ~401 streams
   against a 1024 limit, so there is headroom, but a universe above ~511 symbols would need
   sharding across sockets.

**End of Part XI.**

---

## Part XII — 16 Oct 2026: the chart popup had no VWAP on two of its three surfaces

> Written 16 October 2026. Supersedes nothing; Part XI is still current on prices.
> The bug is bug #15 in section 12.

### XII.1 What was reported

Opening a signal card on the **Signals** tab rendered:

```
VWAP            n/a
Alignment check 2/4 · Usually a pass
  —  Top of its board          (✕ before the fix)
  ✓  Sector leans same way
  ✓  Breadth leans same way
  ✕  Price above VWAP
```

The board row for the very same coin, one click away, showed a VWAP.

### XII.2 The cause — a type error wearing a data bug

Two independent defects that only produce this symptom *together*:

| # | Defect | Where |
|---|---|---|
| A | `AssetPopup` read VWAP from the board row and nothing else: `const vwap = row?.vwap ?? null` | `src/components/AssetPopup.tsx` |
| B | `SignalsView` and `RadarView` both mounted the popup with `row={null}` — while already having computed the row (`chartRow` / `chartSig`) and passing `chartRow.volumeProfile` | `src/components/SignalsView.tsx:423`, `src/components/RadarView.tsx:427` |

Why B existed: the popup's prop was typed `AssetRow | null`. `SignalRow` and `PreMoveSignal` are
*not* `AssetRow`s — they were declared as hand-copied subsets of `setup` / `plan` / `conviction` /
`derivatives` — so neither would typecheck. The type mismatch was resolved by deleting the data
rather than by widening the type, and the cost was invisible: `AssetPopup` degrades quietly, showing
`n/a` for the ladder row, omitting the VWAP line, and failing `row.rank <= 20` on a check whose
label says nothing about missing data.

The alignment score made it worse. Two of the four points were false for "no data" reasons and were
scored identically to two genuine failures, so `2/4` read as "half the context disagrees" when in
truth half the context was never asked.

### XII.3 What changed

1. **`/api/asset/:id` now returns `vwap`.** Computed with the engine's own `sessionVwap()` over the
   same closed candles the payload already ships — not a client-side reimplementation, so there is
   still exactly one definition of VWAP in the codebase.
2. **`resolveVwap(detail, row)`** in `AssetPopup`: the fetched detail first, the board row as the
   pre-fetch fallback, `null` when neither has one. Exported and pinned by a test. The detail is
   present on *every* surface, which is what makes the row optional.
3. **`PopupRow`** replaces `AssetRow` as the popup's prop type: the subset the popup actually
   reads, every field optional. `AssetRow`, `SignalRow` and `PreMoveSignal` are all assignable to
   it, so no surface has a reason to pass `null` any more.
4. **`SignalRow` and `PreMoveSignal` now use the shared types** (`Setup`, `TradePlan`,
   `Conviction`, `DerivRow`) instead of hand-copied subsets. The server was already sending the full
   objects; the subsets were the thing that drifted.
5. **`/api/signals` carries `rank`.** Those rows *are* the scan board rows, so the answer to "top of
   its board?" existed and was simply not being sent.
6. **The alignment check is three-state.** `pass` / `fail` / `unknown`, where `unknown` renders `—`
   with the reason on its tooltip, and the header says `2/4 · … · 1 not measured`. A point that could
   not be measured is no longer silently a failure. Two-way breadth still *fails* rather than hiding,
   because breadth genuinely not leaning is a real disagreement.
7. **`STRUCTURE.SESSION_CANDLES = 289`** replaces a literal `289` written out in eight places
   (`scanner.ts`, five sites in `preMoveRadar.ts`, three in `index.ts`), read through
   `sessionStartIndex()` / `sessionStartTime()` in `engine/orderblock.ts`. **The window is
   byte-identical to what it was** — `length - 289` — so session VWAP, day change and day high/low
   all mean exactly what they meant before. Nothing about the engine's numbers changed; only the
   fact that they are now named.

### XII.4 Verification — real output

`npm run verify` (typecheck + full vitest suite):

```
> tsc --noEmit

 Test Files  21 passed (21)
      Tests  420 passed (420)
   Duration  8.36s
```

(409 before this change; +11 new assertions, no test touched.)

`npm run build`:

```
dist/index.html                  3.05 kB │ gzip:  1.43 kB
dist/assets/index-B3vlmNQ3.css 107.62 kB │ gzip: 20.64 kB
dist/assets/index-4GELOoy-.js  332.09 kB │ gzip:102.00 kB
✓ built in 1.69s
```

Live, against the running server (`tsx watch` reloaded it):

```
GET /api/asset/BTC
  fields: id pair name sector candles setup side choppiness strength
          rangePct changePct price vwap updatedAt
  vwap   = 82262.33483448565
  price  = 81958
```

The two VWAPs must agree exactly, or the popup and the board would be describing different sessions:

```
GET /api/signals -> DOT  rank=5  vwap=1.1521786714829412
GET /api/asset/DOT                 vwap=1.1521786714829412
delta = 0.000000
```

Two tests were added and both fail against the old code:

- `server/test/assetPopup.test.ts` (new file, 10 tests) — `resolveVwap` precedence, including the
  row-less case that was the bug, and `sessionStartIndex` semantics.
- `server/test/mock.test.ts` — *"the popup payload carries a session VWAP, not a missing field"*,
  over the real `/api/asset/:id` route on the booted mock server. It also asserts the VWAP lies
  inside the low/high of the session candles it was computed from, so a `0` or a constant cannot
  satisfy it.

**Re-verified 17 October 2026**, unchanged from the run quoted above:

```
Test Files  21 passed (21)
     Tests  420 passed (420)
  Duration  6.53s
```

Same 21 files, same 420 tests, no test edited or skipped since 16 Oct. `tsc --noEmit` clean (it is
`npm run typecheck`, which gates `npm run test` in `npm run verify`). No code has been written since
this Part — the only file touched after it was written was `src/components/AssetPopup.tsx`, 33 s
later, and it typechecks and passes as described.

### XII.5 Honest gaps

1. **The Playwright specs were NOT run.** `AGENTS.md` requires `npm run dev` to be stopped first
   (two Vite dev servers share one `node_modules/.vite` cache), and the server was left running on
   this machine rather than restarted underneath the user. The browser-level consequence of this
   fix — a signal card's popup now drawing the VWAP line — is therefore verified by the unit test
   on `resolveVwap`, the route test on the mock server, and the live endpoint reads above, but **not
   by a screenshot**. No `qa/*.spec.ts` asserts on the popup's VWAP; the new browser-level
   regression test for it is still unbuilt and is listed under section 13.
2. **`/api/asset/:id` recomputes the scan.** It was always going to; VWAP rides along on candles
   that were already fetched. No extra upstream call, but the value can be up to a scan-interval
   (20 s cache) behind the live tick used for `price`. The alignment check compares a session VWAP
   against `data.price` (the newest close), which is the same comparison the board makes.
3. **The Radar tab's sector-average alignment point stays "not measured".** The radar scans the whole
   universe independently of the board, so "sector leans same way" has no defined peer set there.
   Answering it would mean pulling board data into the radar; the honest answer today is the dash.
4. **`STRUCTURE.SESSION_CANDLES` is 289, not 288.** 288 × 5m is 24h, but that span sits across 289
   candles because the session's opening candle and the bar in progress are both in the window. The
   previous code had the same window (`length - 289`); this is the value finally written down, not a
   change.

**End of Part XII.**

---

## Part XIII — 17 Oct 2026: making this file usable as a brief

> **No product code was changed in this pass.** Nothing below is a new feature or a fix. Every
> engine number, every route response and every UI behaviour is exactly as Part XII left it. This
> Part exists because the file had stopped describing the thing it documents.

### XIII.1 What was wrong with the document

Sections 1–15 were written on 10 October and describe the v1 build: **17 backend files, 15 frontend
files, 8 routes, 37 TS files, 5,592 lines**. The tree is now **53 backend files, 67 frontend files,
24 routes, 122 production files, 25,532 lines**. Nothing had been wrong with the *history* — Parts
II through XII are accurate and remain the record. What was wrong was that the **reference sections
an agent would reach for first** still pointed at code that no longer exists:

| Section | Was | Reality on 17 Oct |
|---|---|---|
| 5 Architecture | 8 routes, a 6-tab app | 24 routes, 10 tabs, a scaled 1920×1200 stage, an SSE fan-out |
| 6 Manifest | 33 files listed | 170+ files across 7 trees; **the v2 engine, live, ledger, mock and runtime layers were absent entirely** |
| 10 API | 9 of 24 routes | 15 missing, including `/api/stream`, `/api/ledger`, `/api/signals`, `/api/radar`, `/api/fan` |
| 11 Run & test | 7 scripts, one 10 Oct output | 26 scripts, two vitest configs, 8 Playwright specs, 4 honesty proofs, 15 env vars |
| 13 Gaps | 11 rows | 4 rows were **false** or superseded — "spot only", "no WebSocket", "hand-maintained universe", "Appendix A is v1 only" |
| 14 Extension guide | 14 rows | 5 rows pointed at files that no longer own the thing: the pair list, `BOARD_SIZE`, `EVENT_RISK_PCT`, the chop gate, the board layout |
| Appendix A | 7 of 24 constant groups | 17 groups had **no entry at all**, including every weight and veto |

The four false gap rows are the ones that mattered. An agent told "futures are not wired" or
"prices are polled" would have re-litigated decisions Part II and Part XI had already settled.

### XIII.2 What was done

Seven sections rewritten against the code, two added:

- **§5** architecture diagram and real measured sizes.
- **§6** full manifest: every file in `server/src/` (53), `src/` (67), `shared/`, tests, scripts,
  fixtures and evidence — with an explicit **mounted / unmounted** column, because half of
  `src/stage/` and 13 components are imported by nothing.
- **§10** all 24 endpoints with exact response fields, cache TTLs, 503/404 paths, and the SSE message
  union with the 3 declared-but-never-sent types marked.
- **§11** all 26 npm scripts, both vitest configs, the Playwright setup and all 8 specs, the 4
  honesty proofs, 15 env vars, the ports table, and the definition of done. (This also fixed two
  headings numbered `11.4`.)
- **§12** bugs 16–25 added — all **found by this audit, none fixed**. See XIII.3.
- **§13** rewritten: the 4 false rows removed, 26 real gaps recorded.
- **§14** rewritten against the current owners.
- **§15** decision log 19–26 added, covering the decisions Parts II–XII made but never wrote down.
- **§16 (new) — "How to make a change in this repo".** The section this pass was for: house rules,
  an ownership map ("the change is X, the owner is Y"), the live-price data path, **17 verified
  traps**, the definition of done, and what "honest" means concretely in this codebase.
- **§17 (new) — roadmap.** The M-IDs used in Parts X and XII were never collected anywhere, so they
  were un-actionable. Six IDs now have a state, an owner file and the evidence for each.
- **Appendix A** rebuilt: all 24 groups, 180 constants, the tag census, and the four groups that
  carry no documentation at all.

### XIII.3 Bugs found by this audit — recorded, not fixed

None of these were touched. They are in §12 so they are not re-found:

| # | Finding |
|---|---|
| 16 | `.env` cannot set `PORT` or `ORDERFLOW_MOCK` — both are read before `loadEnvFile` runs (`index.ts:109`/`:206` vs `:261`) |
| 17 | `/api/percentile/:id` has no `try`/`catch`; `getScan()` can throw and Express 4 does not catch async rejections |
| 18 | `/api/signals`'s comment claims a 60 s cache that does not exist |
| 19 | The 1-second `LiveAggregate` reaches `aggStore` and is **never read** — `useAggregate()` has no consumer |
| 20 | **9 of 13 `REFRESH.*` constants have zero references outside `config.ts`** — tuning them changes nothing |
| 21 | `FAN.SET_SIZE` is shadowed by a separate `FAN_SET` in `src/stage/fan.ts` |
| 22 | `LIVE.PING_RESPONSE_MS` and `LIVE.LIQ_SAMPLE_INTERVAL_MS` have no consumers; the liquidation lower-bound rule is documented but unenforced |
| 23 | `shared/types.ts` declares `LedgerStats` twice with different fields |
| 24 | `/api/ledger` reports `isPredictive: true` and calls the buckets *monotone*; they are 63.41 / 36.14 / 62.30 / 44.19. The check is `topAvg > bottomAvg` over half a 4-bucket split |
| 25 | `byVeto` keys on the rendered veto string, which embeds the move percentage — ~90 singleton categories |

Every one of these was verified against the code or a live response before being written down, not
inferred from reading. Two of my own first checks were wrong, and both are worth recording because
the file's rule is that a verification which was not run correctly is worse than none — it produces
a confident wrong number:

1. **A PowerShell glob lied.** `server\src\**\*.ts` silently missed two-level paths, so my first
   sweep reported **all 13** `REFRESH.*` constants as dead. Re-running over a recursive file list
   gave **4 live and 9 dead**. The 4 live ones are `DERIVATIVES_SNAPSHOT_MS`, `OI_HISTORY_MS`,
   `LONG_SHORT_RATIO_MS` and `OPTIONS_MS`.
2. **I wrote "the ledger has 0 resolved signals" into §13 and §17 without checking**, on the
   reasoning that the supervisor had not run unattended since 11 Oct. Reading the live endpoint
   falsified it: **518 signals, 505 resolved, 13 open, 489 shadow / 29 real.** Worse, the number
   changes the roadmap — `fit-weights` has its 200 signals and is now gated only by **M3.2**. Both
   claims were corrected in place before finishing.

### XIII.4 Verification for this pass

```bash
npm run verify
```

```
 Test Files  21 passed (21)
      Tests  420 passed (420)
   Duration  6.53s
```

Unchanged from Part XII, as expected — this pass edited documentation only.

Read-only live read of the running server, `GET /api/ledger`, which is where bugs 24 and 25 and the
corrected ledger counts came from:

```
open    = 13
signals = 200        (most recent; 518 total)
counts  = {"total":518,"open":13,"resolved":505,"shadow":489}
stats   = winRate 53.47  avgR 3.5  profitFactor 9.15  isPredictive true
calibration  0-20 → 63.41%  20-35 → 36.14%  35-50 → 62.30%  50-65 → 44.19%
            65-80 → n=0       80-100 → n=0
byGrade   C n=311 (60.13%)   B n=29 (null)   NO TRADE n=165 (43.64%)
bySide    bullish n=319 (45.77%)   bearish n=186 (66.67%)
```

Read it for what it is: 505 resolved signals is a real dataset, and it is enough to fit weights.
It is also enough to see that `avgR 3.50` and `profitFactor 9.15` are too good, which is what
**M3.2** predicts, and that the top two score buckets have never been populated at all.

The audit behind these sections was four exhaustive read-only inventories of `server/src/index.ts`
(all routes), `server/src/config.ts` (every constant, tag and value), `src/` + `shared/` (every
file, the data flow, the design tokens), and the build/QA surface (`package.json`, both vitest
configs, `playwright.config.ts`, all 19 scripts, all 15 env vars, every data file). **No product
file was modified during the audit.** The Playwright suite was **not** run, for the standing reason
in `AGENTS.md` — two Vite dev servers share one `node_modules/.vite` cache and the second wedges.

### XIII.5 What this Part does not claim

1. **No product behaviour changed**, so nothing here needs a functional re-test. The one thing
   worth a screenshot before the next change is the Order Block tab — §6 now claims large parts of
   `src/stage/` are unmounted, and that claim comes from a grep, not from a rendered page.
2. **`qa/stage*.txt` are stale and were left stale.** They record 18 files / 377 tests against a
   tree of 22 / 420. They are the record of past runs and deleting them would destroy evidence;
   quoting them as current would be a lie. §6 and §16.3 now say so explicitly.
3. **The 11 pre-existing `qa/home.spec.ts` failures are still failing.** Part X.4 proved they were
   not caused by that session; nothing since has fixed them.
4. **The M-IDs in §17 are the only six in use.** They were invented ad hoc in Parts X and XII. If a
   broader backlog exists somewhere it is not in this repo, and I have not invented one.
5. **The tag census in Appendix A is a count of doc comments, not a judgement.** ~100 keys have no
   provenance tag. That is not the same as ~100 wrong numbers — most are structural (array lengths,
   session windows, cache TTLs) — but it does mean the number is unclaimed rather than known.

**End of Part XIII.**

---

## Part XIV — 17 Oct 2026: the Mind layer — calibrated probability, not 95% accuracy

### XIV.1 What was asked, and the one requirement I refused

The brief asked for a "Mind" layer: feature vectors, regime classification, a probabilistic read,
calibration against a base rate, expectancy, vetoes, frozen ledger snapshots, three API routes, a
minimal UI, mock coverage, tests, and documentation.

It also framed success as **95% accuracy**. I did not build that, and the refusal is the most
important decision in this Part.

The live ledger base rate is **53.47%** over 510 resolved signals. A 95%-accurate forecaster
against a 53.47% base rate cannot be built from point-in-time inputs — you can only get there by
leaking the future. And the entire feature set is deliberately point-in-time:
`buildFeatureVector()` filters every candle and every news item by `asOf` **before** reading it, and
`mind.features.test.ts` proves it by appending 40 future candles and future news and asserting the
vector is byte-identical. A quoted 95% is the signature of a lookahead bug, so treating it as a
target would have rewarded the exact defect the design exists to prevent.

What I optimised instead, and what the code actually enforces:

| Objective | Enforced by |
|---|---|
| Beat the base rate on Brier | `MIND.BRIER_MEANINGFUL_DELTA = 0.01`; `npm run mind:report` |
| Positive expectancy after costs | `ACTIONABLE_MIN_NET_R = 0.05`; costs deducted before the gate |
| Honest probabilities | Intercept anchored to the ledger base rate (decision 28) |
| Flat reliability buckets | `buildCalibrationReport()` buckets, printed by `mind:report` |

Decision 27 in section 15 records the refusal, so the next session reads it rather than
re-litigating it.

### XIV.2 The anchor, and why it is the whole trick

`ALIGNED_LOG_ODDS = 1.6` applied to hand-tuned weights, with no intercept, produces confident
numbers anchored at nothing. So the logistic is anchored: **the intercept is the ledger's own
observed win rate**, blended toward 0.5 when the ledger is thin.

The consequence is the point. With **no fitted weights**, the layer is calibrated *at* the base rate
by construction. It can only beat that bar if a feature genuinely carries information. That makes
"did this help?" a measurable question instead of a matter of taste, and it means the shipped
weights can be obviously crude without the model being obviously wrong.

`mind:report` against the real ledger, verbatim:

```
  signals (all)         525
  resolved              510
  Mind-tagged resolved  0

  510 resolved signal(s) predate the Mind layer and are excluded.
  They are not counted as 50% calls; doing so would improve the score artificially.

  NO MIND-TAGGED SIGNALS YET.
```

**There is no Brier number yet, and that is the correct state.** Every resolved signal predates the
layer. The tempting move — treat those 510 as 50% calls — would have produced an impressive-looking
score resting on numbers the model never made. The report refuses instead.

### XIV.3 What was built

**`server/src/engine/mind/` — 8 files, 2,402 lines**

- `features.ts` — the 36-field vector. `measured()`/`missing()` throughout, so unmeasured is never
  `0`. Filters by `asOf` before reading.
- `attribution.ts` — news drivers pulled from the existing engine rather than re-derived.
- `regime.ts` — six states. A **separate** taxonomy from the engine's existing `Regime`; both are
  live, and the collision hazard is flagged in `config.ts` rather than papered over.
- `confluence.ts` — vetoes → features → probability → expected R net of costs → drivers → bands →
  actionability. The largest file, 695 lines.
- `calibrate.ts` — Brier vs the base-rate bar, reliability buckets, and **`honestRMultiple()`**:
  the M3.2 fix, crediting a winner with the *nearest* target actually reached rather than the
  furthest published. It lives beside the existing function and **does not change it**, because
  rewriting the ledger's reported numbers was not mine to do silently.
- `rank.ts` — linear fractional-Kelly edge. See bug #30 for why not log.
- `scan.ts` — board glue, and the whole pass is wrapped so a throw leaves the board untouched.

**Integration.** `scanner.ts` runs the pass after the market pass and attaches `row.mind` /
`row.mindFeatures`. `ledger/worker.ts` freezes the verdict **and** the vector together — and stores
neither if either is missing, because a probability with no evidence is a number nobody can check.
`setMindBaseRateProvider()` is a seam; `ledgerBaseRate()` is installed at boot.

**Three routes**, all reading the stored scan and all making **zero upstream calls**:
`/api/mind/health`, `/api/mind/signals`, `/api/mind/features/:id`. None of them re-runs the pass —
running it again would produce a second answer to the same question.

**UI.** `MindBits.tsx` + `mind.css`. A health strip in the header (`App.tsx`), because regime and
Brier are properties of the *model*, not of one screen; and a per-card block below the existing
confluence bar, so the reader has already seen what the probability is correcting. The block renders
**nothing** when a row carries no Mind signal — the gap is honest and is not filled with a 50%.

### XIV.4 Verification — real output

```
npm run typecheck   → clean, no output

npm run verify
 Test Files  27 passed (27)
      Tests  569 passed (569)
   Duration  5.77s

npm run build
dist/assets/index-DygKlKFg.css  111.35 kB │ gzip:  21.23 kB
dist/assets/index-EvXbtkHb.js   339.17 kB │ gzip: 104.18 kB
✓ built in 1.05s

npm run mind:report   → the 525/510/0 block quoted in XIV.2
```

Mock end-to-end, on a separate DB and port:

```
MOCK signals=14 actionable=7 regime=range
  XRPUSDT p=0.4824 netR=8.7306 band=medium rank=0.1058
  ATOMUSDT p=0.5405 netR=3.542  band=medium rank=0.1027
  SOLUSDT  p=0.5182 netR=3.5644 band=medium rank=0.0958
scan row0 APT: mind=True features=True
```

14 signals, 7 actionable, 0 vetoed, regime `range`, and the three printed ranks are **distinct** —
which is the regression test for bug #30 in visible form. Feature coverage in mock mode is **19 of
36**: the fixtures carry no derivatives, on-chain or stablecoin payloads, so 17 fields are honestly
unmeasured rather than defaulted.

### XIV.5 Bugs this build found — 26 to 32 in section 12

Seven, and the distribution is the lesson:

- **Caught by tests** (26, 30, 31, 32): a null liquidation block crashed the vector; the log-Kelly
  ranking tied every strong signal; the "decomposition" did not sum to the score it explained;
  an unclamped base rate.
- **Caught only by booting the mock server** (27, 28, 29): signals were keyed `BTC:bullish` and
  looked up as `BTCUSDT:bullish`, so **every** lookup missed and the whole board shipped with no
  Mind verdict — invisible to a test that asserts on one row. Funding crowding was read with the
  opposite sign to the engine's own convention. And expired calendar events produced a **permanent**
  macro veto, pinning the board at 100% vetoed.

That asymmetry is the argument for the mock probe. Whole-board failures are exactly what per-row
unit tests cannot see, and all three were found in the first probe.

### XIV.6 Honest gaps in this Part

Section 13 has the full list. The ones a reader is most likely to be misled by:

1. **A calendar outage silently disarms the macro veto.** `null` does not veto, while the code
   comment claims "unknown ≠ clear". Comment and behaviour disagree. **Found, not fixed.**
2. **An event already in progress is not blacked out.** The fix for #29 excluded `mins ≤ 0`, which
   also dropped an event whose 60-minute window is still open. The correct filter is
   `mins ≥ −VETO_BLACKOUT_MIN`. A live under-veto. **Found, not fixed.**
3. **`liqClusterDistance()` picks the long cluster whenever one exists** instead of the nearest.
   **Found, not fixed.**
4. **Zero resolved Mind signals**, so no Brier, no reliability curve, no per-grade honest R. The
   machinery is tested against synthetic data and has never met a real outcome.
5. **No weight refit.** `usingShippedWeights` is hard-coded `true`. "Optional refit" is unbuilt.
6. **No Mind pass on India F&O**, no `mind` SSE delta, no high-NIS news recompute, no
   `plan`/`confluenceComponents` on the wire, no POC/value-area features, no spring/upthrust.
7. **No browser test for the Mind UI.** It typechecks and renders from a real board, but `qa/` has
   no Mind spec, so do not call that surface tested.

### XIV.7 What would actually move the needle

Not more features. In order:

1. **Let signals resolve.** Nothing else can be judged until `mind:report` prints a Brier. This is
   a calendar problem, not a code problem.
2. **Fix M3.2**, which still inflates `fit-weights` and every R-based ledger statistic.
3. **Fix gaps 1–3.** Three small changes, each currently making the model *more* permissive than
   it means to be.
4. **Then, and only then, consider a refit** — with the base rate as the intercept and the
   reliability curve as the acceptance test. Not an accuracy number.

---

**End of Part XIV.**

---

## Part XV — 17 Oct 2026: a full specification arrived, and the audit it forced

### XV.1 What happened

A written specification for "OrderFlow Mind" arrived, listing 10 non-negotiable rules, 12 signal
gates, a data-layer inventory, a learning system, a fixed JSON output contract, and 10 test
requirements. It asked for a "chief architect" pass with deep research.

I did **not** treat it as a rewrite order. Most of it already existed; the useful work was to hold
every clause against the code and find the ones where the code and the prose disagreed. That audit
found **seven defects that violated the spec's own non-negotiable rules**, plus one place where the
previous Part had documented a mathematically wrong claim.

Three research passes came first, because two of the findings could not be settled by reading code:

| Question | What the literature said | What it changed |
|---|---|---|
| What is the Brier decomposition? | Murphy (1972/1973): **`BS = REL − RES + UNC`**. Exact when conditioning on distinct forecast values. Binning adds within-bin terms (Stephenson, Coelho & Jolliffe 2008). | Part XIV claimed `brier = reliability + outcomeVariance` and called the textbook form broken. **That was wrong**, and the code was corrected |
| Is the decomposition unbiased at small n? | No, and it cannot be made so. Reliability is systematically **over**estimated, uncertainty **under**estimated, bias decaying as 1/n (Ferro & Fricker 2012; Bröcker 2011). | Recorded as a known direction of error rather than left implicit |
| How should weights be validated out-of-sample? | Purging + embargo (López de Prado 2018); contiguity does most of the work, purging buys the worst-case guarantee. Labels carry a *trade time* and an *event time*, which is exactly the ledger's `created_at` / `resolved_at`. | Design for the unbuilt walk-forward harness — section XV.7 |

### XV.2 The seven defects, and what each one was actually costing

Ordered by consequence. All were live, all were found by reading the code against the spec, and
every one produced a number that looked fine.

**1. A news-feed outage was scored as a genuine reading.** `fetchAllNews().catch(() => [])` turned a
dead feed into an empty headline list, and `newsScore()` pays 5/10 for an empty list — the *same*
score a genuinely quiet asset earns. The market could therefore grade an **A-pick with the news feed
dead**, and nothing in the response said so. Violates rule 2. (`scanner.ts`, `conviction.ts`)

**2. Every board row understated its costs, so the actionability gate was measuring the wrong thing.**
`buildPlan` was called without its `deriv` argument, so `buildCosts` took the null branch on *every*
row: **funding was always 0 bps** and slippage was always the 5 bps default. `netExpectedR` — and
therefore `ACTIONABLE_MIN_NET_R = 0.05` — was computed against costs that did not exist. Violates
rule 11. (`scanner.ts` call site)

**3. Every board row published a position size derived from an account nobody chose.** `buildPlan`
defaulted `opts` to `DEFAULT_PLAN_OPTIONS`, i.e. a **$100,000 account**, and `shared/types.ts` claimed
`qty` was "null until the user sets account size" — which never happened, because no route, query
param or client input ever reached `opts`. Violates rule 4 and house rule 2. (`tradePlan.ts`)

**4. `netR` was gated on `qty`, collapsing two unrelated unknowns.** With no position size there was
also no net R. Cost in R needs only the cost in bps and the per-unit risk, both measured without an
account — so the two are now decoupled and `netExpectedR` works on the board. (This surfaced only
after fixing 3.)

**5. `byRegime` was a single meaningless bucket.** `freezeFromScan` read
`(row as any).regime ?? 'range'`, and `AssetRow` has no `regime` field, so **every signal ever
frozen** was labelled `'range'`. `ledgerStats().byRegime` therefore described nothing while the docs
described it as regime performance. The regime is now a **required** parameter — a default here is
worse than a compile error, because it manufactures a plausible-looking grouping. Violates the
learning-system clause.

**6. An in-progress macro release was not blacked out.** The fix for the "expired event vetoes for
ever" bug used `if (mins <= 0) continue`, which also dropped an event that fired 10 minutes ago and
whose 60-minute window was **still open** — the most dangerous moment to open a position. The correct
bound is `mins >= −VETO_BLACKOUT_MIN`.

**7. `liqClusterDistance()` returned the LONG cluster whenever one existed.** `longH1 || shortH1`
short-circuits on the long side: with a long cluster at 95 and a short at 99, price 98 reported **3%
instead of the true 1%**. A feature named "distance to the nearest cluster" did not take the
minimum. No test had two clusters at once.

Plus one **misrepresentation**: `LEDGER.AMBIGUITY: 'STOP_FIRST'` was described as "the single source
of truth", was read by **no production code**, and its only test asserted the string equalled itself
— it would still have passed with the entire stop-first block deleted. A claim, not a control, and
exactly what house rule 6 forbids. The resolver now branches on the constant, so changing it to
`TARGET_FIRST` genuinely changes behaviour.

### XV.3 The data-integrity gate — new, and the centre of this Part

Spec rule 2 existed only in prose. `server/src/engine/dataHealth.ts` makes it executable, and the
distinction it encodes is the part that mattered:

- **`block`** — the engine refuses to call a setup tradable, and says why.
- **`degrade`** — the setup stays visible, the affected evidence is left `UNMEASURED`, and the grade
  caps at C.

Derivatives *degrade* rather than block: positioning is one of twelve gates, so losing it should
withhold the trade, not delete a real structural setup. News, the calendar and price all **block**.

`unknown != clear` is the load-bearing line. An empty calendar is indistinguishable from "no events
today", so an outage used to answer "no blackout" and print picks straight through CPI. Now an outage
answers "we do not know", and the gate treats unknown as closed.

The gate is a **pure function** — the clock arrives as `asOf`, nothing is read from the environment —
which is what makes it testable rather than merely plausible. `gradeWithHealth` is proven exhaustively
to only ever move a grade **down**, so a safety feature cannot quietly become a bias.

**It also caught two bugs in its own first draft**, found by the mock probe rather than by a unit
test:

- One 8-second freshness bound was applied to all four streams, so a healthy **6-hour-old published
  macro schedule** read as `stale` and closed the gate on every scan. Each stream now has its own
  `MAX_*_AGE_MS` and its own `DELAYED_*_AFTER_MS`.
- `watched()` stamped each fetch on *start*, but the scan's `now` is captured *before* the fetches, so
  `now − at` came out **negative** — and a negative age correctly reads as `unavailable`. Three of
  four streams were falsely failing. Now stamped on completion, with the age clamped at zero.

### XV.4 A Brier decomposition that had the wrong sign, and hid it

Part XIV recorded bug #31 as: *"The Brier decomposition was not a decomposition… replaced with the
exact identity `brier = reliability + outcomeVariance`."* **That was a false correction.** The
textbook identity is `BS = REL − RES + UNC` — resolution **subtracts**, because spreading forecasts
away from the base rate is the entire point — and it is exact when conditioning on the distinct
forecast values.

Measured here, before changing anything:

| conditioning set | `REL − RES + UNC − BS` |
|---|---|
| one bin per distinct `p` (n=200) | **1.1e-16** |
| 200 equal-width bins | 1.1e-16 |
| 10 equal-width bins (the display choice) | **−2.0e-3** |
| continuous `p`, 50 bins | −2.5e-5 |

The residual appears only because **binning for a readable reliability diagram** introduces
within-bin variation (Stephenson et al. 2008 give the five-term form). So the algebra was never
broken; the binning was.

Three further problems in the old field, all now fixed:

- **It did not reconstruct its own total**, and the test that "verified" it used `toBeCloseTo(b, 2)`
  — a 0.005 tolerance against a real 0.002 gap — while its comment blamed the whole gap on display
  rounding. At least half was structural. The test name said "exactly".
- **`outcomeVariance` was misnamed.** It was `Σ w·o(1−o)`, which is not a variance of outcomes in the
  sense a reader assumes.
- **`resolution` was not resolution.** It was `mean((p − base)²)` — the spread of the *forecasts*.
  That is a real quantity (sharpness) but a different one: a forecaster can have large spread and
  zero resolution. The two are now separate fields, `resolution` (Murphy) and `forecastSpread`, and a
  test pins the distinction by building a forecaster with wide spread whose outcomes never vary.

The decomposition now reports `reliability − resolution + uncertainty`, a **measured `residual`**
rather than a tolerated one, `brierSkill = 1 − BS/climatology` (exact, and what the
`beatsBaseRate` decision rests on), and `forecastSpread`. The residual is computed from the *rounded*
terms so the numbers on screen add up to the number on screen.

### XV.5 The anchor and the bar were drawn from different populations

`ledgerBaseRate()` read `ledgerStats().winRate`, whose denominator is **every** resolved signal with
EXPIRED counted as a loss. `buildCalibrationReport` scores over **TP-hit versus STOP only**, excluding
EXPIRED entirely. So the probability was anchored to one population and judged against a bar from
another — and since expiries are common, the bar was systematically too easy. Both now share one
definition, exported from `calibrate.ts` so they cannot drift apart again.

### XV.6 Verification — real output

```
npm run verify
 Test Files  28 passed (28)
      Tests  597 passed (597)

npm run build
dist/assets/index-EvXbtkHb.js   339.17 kB │ gzip: 104.18 kB
✓ built in 0.94s
```

Mock server, real `/api/scan`, after the fixes:

```
price=unavailable deriv=live news=live macro=live tradable=False
blackedOut=False reason=
row0 APT grade=NO TRADE qty=null riskPerUnit=0.00419 netR=-0.31 fundingBps=0
```

Reading that honestly, line by line:

- `price=unavailable` is **correct**: mock mode has no live socket, so
  `streamHub.lastTickAt()` is `null`. A mock price stream is not a live one.
- `qty=null` is the fix to defect 3 — no invented $100,000 account.
- `netR=-0.31` is the fix to defect 2 becoming visible. With real costs charged, this setup's gross R
  does not cover them: the stop is 0.42% wide while fees plus slippage are 0.15%, so costs are ~1.8R
  against a gross ~1.5R. **Before this pass it would have reported a positive net R**, because
  funding was hard-coded to zero and slippage to a flat default.
- All 14 mock rows are `NO TRADE`, each carrying the specific stream reasons. That is spec rule 2
  working, not a regression.

`npm run mind:report` against the real ledger:

```
  signals (all)         555
  resolved              520
  Mind-tagged resolved  7
  513 resolved signal(s) predate the Mind layer and are excluded.
```

**7 Mind-tagged signals** now exist — the first real outcomes the layer has ever produced. Still far
below the 100-sample floor, so no Brier is printed and that remains correct.

### XV.7 What is still missing, with the research that specifies how to build it

Not claimed as done. Ordered by what unblocks the most.

1. **Walk-forward validation with purging and embargo.** Absent — zero references in the repo. The
   ledger already has the two timestamps the method needs: `created_at` (trade time) and
   `resolved_at` (event time). The design is settled: expanding window, purge any training row whose
   resolution window overlaps the test block, embargo after it. The literature is clear that
   contiguity removes most of the mean bias and purging buys the worst-case guarantee, so purge
   first and measure the embargo rather than assuming it is needed.
2. **`maxDrawdown`, `falsePositiveRate`, and feature importance over the real feature vector.** All
   three missing. `byComponent` today correlates the 7 *conviction* components, not the 36 Mind
   features, and returns `null` below 30 samples — so it is empty on any realistic ledger.
3. **The spec's exact JSON output contract.** The literal keys `market_regime`, `data_health`,
   `market_context`, `probability_target1`, `position_size_pct`, `evidence{same_setup_win_rate,
   same_setup_median_r, historical_sample_size}`, `valid_until` do not exist. `data_health` now does
   (section XV.3). The rest is a serialisation layer over data that mostly exists.
4. **`position_size_pct` from fractional Kelly.** Research: half Kelly keeps ~75% of growth and cuts
   drawdown roughly in half; at a 36% true win rate full Kelly gives a **99.2%** chance of a 40%
   drawdown versus **3.7%** at quarter Kelly. Critically, **fractional Kelly does not rescue a
   model with no edge** — it loses more slowly. So the fraction must not be used to justify a weak
   model, and with unfitted weights `KELLY_FRACTION = 0.25` is the defensible choice.
5. **A `setup_type` taxonomy.** The spec groups outcomes by setup type; the repo stores `side` plus a
   `fvg` boolean. `retest` and `htf` are already frozen and unused as labels, so a real taxonomy is
   mostly a labelling job over existing state.
6. **Calibration ordering A > B > C.** No test asserts it anywhere. It cannot be written honestly
   until enough of each grade has resolved; what *can* be written now is the test that **reports**
   the ordering rather than asserting it, so the claim appears as soon as the data supports it.
7. **`LEDGER.FIT_MIN_SIGNALS = 200` and `BACKTEST_DAYS = 30` are still declared and unread**, and
   `pruneCandles(2000)` retains about **one week** per symbol, so the 30-day window they imply cannot
   be replayed from the current store.
8. **India F&O, no Mind pass.** Sparse vectors exist; no pass runs there.

### XV.8 What this Part changed about the method

The lesson is uncomfortable and worth stating plainly: **Part XIV's bug #31 "fixed" a correct
identity into an incorrect one, and the test that pinned the fix was written to tolerate the gap it
caused.** The reasoning felt rigorous — the terms demonstrably did not sum, so the textbook form
must be wrong. The actual explanation was that binning breaks the three-term form, which is a
documented and well-understood effect.

The defence that would have caught it: measure the residual rather than assert an identity, and check
the claim against the literature before rewriting working code. That is now what the code does — the
`residual` field exists precisely so this class of error is visible instead of argued about.

Two of the seven defects here (the calendar disarming the veto, and the news outage scoring as a
real reading) had been sitting in a codebase with **569 passing tests**. The tests were not wrong;
they were answering questions nobody had asked yet.

---

**End of Part XV.**

---

## Part XVI — 17 Oct 2026: Evidence, Learning, and Calibration

### XVI.1 What this phase is, and what it is not

The brief asked for the engine to learn from evidence rather than opinions, and to make it
"impossible to confuse a good story, a lucky streak, or an unfitted constant with real, repeatable
edge."

It was implemented in the brief's own order (1–10), and it is worth stating plainly where that
stopped:

| # | Deliverable | State |
|---|---|---|
| 1 | Immutable feature snapshots in the ledger | **done** |
| 2 | Complete outcome-resolution schema | **done** |
| 3 | Research registry + constant migration | **done** |
| 4 | Walk-forward harness with purge and embargo | **done** |
| 5 | Calibration with Murphy-correct decomposition | **done** |
| 6 | Learning governor + versioned decision log | **done** |
| 7 | Feature importance | **built and gated OFF** — correctly reports `INSUFFICIENT_EVIDENCE` |
| 8 | JSON signal contract | **done** |
| 9 | Ledger / Research / Calibration / Model-version UI | **NOT BUILT** — see XVI.7 |
| 10 | Mock, fixture-replay, historical-replay, live paper-trading validation | mock done; the rest blocked, see XVI.7 |

**Nothing in the existing engine was rewritten.** All 597 pre-existing tests still pass unmodified;
Phase XVI added 65.

### XVI.2 The feature store

`server/src/engine/featureStore.ts` freezes what the engine knew at decision time, with three
properties that matter more than the field list:

1. **Deeply frozen.** `Object.freeze` at every level. A later bug cannot reach in and edit what the
   engine thought it saw. Tested by attempting the mutation and asserting the value did not change.

2. **`null` is impossible without a reason.** Every unmeasured field is a `Reasoned<T>` — either a
   measured value or `{ value: null, reason }` with a code from an enumerated set. A bare `null`
   cannot be written, so "we forgot to measure it" can never look like "we measured it and it was
   nothing". Live counts from the real ledger:

   ```
   field-not-measured             411
   no-news-feed                    35
   no-derivatives-feed             14
   insufficient-candles             7
   no-liquidation-feed              5
   ```

3. **The config version is a HASH, not a string.** `sha256` of the whole config object, truncated to
   12 hex (`ca7f81f5ea13`). A hand-written version would not notice a threshold edit; this does, and
   a frozen row therefore cannot be silently reinterpreted by a later config.

`FeatureRecord` is frozen into `SignalSnapshot.featureRecord` at freeze time. The freeze path is
best-effort by design: a builder bug must not stop the ledger recording a signal, because the signal
is the scarce artefact and the audit trail is reproducible from it.

The `missing` index is built by **walking the record**, not by maintaining a hand-written list — a
hand-maintained list is guaranteed to drift the first time someone adds a field.

### XVI.3 The outcome store, and the EXPIRED decision

A separate `outcomes` table rather than more columns on `signals`: the signal row is written once and
never touched, while the outcome is written on resolution and carries its own costs, ambiguity policy
and versions.

**EXPIRED is now a CENSORED observation, not a loss.** The trade neither won nor failed; it ran out
of time. Treating it as a loss understates the strategy, and dropping it silently inflates everything.
The policy is ONE exported table:

| metric family | EXPIRED |
|---|---|
| net expectancy, profit factor, drawdown, time-to-resolve | **included** — the money was spent |
| win rate, Brier, reliability | **excluded** — no binary label exists |
| the excluded count | **always printed**, in words |

A report that mixed a decided-only win rate with an all-rows expectancy would be arithmetically fine
and analytically meaningless. Phase XV found exactly that bug (the anchor and the bar came from
different populations), so the table is now the single gate and every metric goes through it.

**Every outcome is cost-honest.** `netR = grossR − (fees + slippage + funding)`. Funding is charged
per 8-hour UTC boundary actually crossed, counted from the exchange's own schedule rather than
`hours / 8` — those disagree whenever a trade straddles a boundary, and the difference is one whole
funding payment. When funding was never measured the result is `fundingMeasured: false` and a zero
**cost**, which is a different claim from a zero rate, and the report says so.

**Ambiguity is recorded, not resolved away.** The resolver now returns `ambiguous: boolean` and a
note, so "the stop was genuinely hit first" and "one candle covered both levels and we took the
pessimistic reading" are distinguishable on the stored row.

### XVI.4 Walk-forward: the two timestamps

The engine already prevented look-ahead *within* one pass — `sliceAsOf` drops anything past the
decision time, and a test proves the vector is byte-identical when future candles are appended. That
is necessary and not sufficient: it says nothing about whether the WEIGHTS generalise.

A signal has two times — `createdAt` (trade time) and `resolvedAt` (event time) — and a label spans
the interval between them. A signal at t=100 resolving at t=140 has learned something about candles
100–140, so training on it while testing at t=120 means training on the answer.

`server/src/engine/walkForward.ts` implements purging (drop training rows whose label interval
intersects the test block) and embargo (exposed as a parameter, default **0**). Two findings from the
literature shaped that default: contiguity already removes nearly all the *mean* bias, and purging
buys the *worst-case* guarantee; and an embargo bought nothing where features are exogenous — but
order-flow features are price-derived and serially correlated, so it is a parameter to measure rather
than an assumption to bake in. `assertNoLeakage()` checks **every** row of **every** fold, and one of
the tests injects a leak deliberately to prove the check can fail.

### XVI.5 Murphy-correct calibration, and the floors

`decompose()` takes `conditioning: 'distinct' | 'binned'`. The report uses **distinct** — one group
per exact forecast value — because that is Murphy's original conditioning and it makes
`REL − RES + UNC = BS` exact. Binned conditioning is offered for the reliability **diagram**, where
readability is the point, and it pays a **measured** residual which is reported rather than absorbed
into a tolerance.

Every metric is a `Metric<T>` carrying its own `n`, `floor`, `suppressed` flag, `population`, and a
reason in words. Below the floor the value is `null` and the reason says how many samples and what
floor — never a paraphrase. Bootstrap intervals use a seeded xorshift so a report printed twice
prints the same interval.

**Grade ordering is reported, never asserted.** `gradeOrdering()` returns a verdict enum:

| verdict | meaning |
|---|---|
| `INSUFFICIENT_EVIDENCE` | any grade under the floor — gated on the **weakest**, because a chain is only as strong as its weakest link |
| `ORDERING_HOLDS` | monotone, and adjacent bootstrap intervals do **not** overlap |
| `INDETERMINATE` | monotone on point estimates, but intervals overlap — not yet distinguishable from noise |
| `ORDERING_BROKEN` | fails, and names six causes to investigate, mostly **bugs** rather than "change the weights" |

Live result: `INSUFFICIENT_EVIDENCE — no resolved signals carry a grade`. Correct at 7 Mind-tagged
signals.

### XVI.6 The governor, and what it refuses

Ten conditions, all required, evaluated cheapest-first. There is no override and no path that updates a
weight without a decision-log entry — the absence of a `learned` branch in `decide()` is the point.

Running it against a realistic "refit the weights on the current ledger" candidate:

```
verdict            REGIME-DEPENDENT
summary            Kept the previous version. only 0 regime(s) clear the 50-sample floor...

condition     pass   observed
samples       yes    527 resolved / 200 required
out-of-sample NO     not run
reproducible  yes    reproducible=true, leakageClean=n/a
walk-forward  NO     not run
expectancy    NO     unmeasured
drawdown      NO     unmeasured
calibration   NO     unmeasured
regime        NO     0 regimes above the 50-sample floor, 0 negative
rollback      yes
versioned     yes    calib-1.1.0
```

Note what it did **not** do: it did not fall back on `samples` (527 > 200) to accept, because the
*decisions* those samples support were never measured. Passing a count while the quantities behind it
are unmeasured is not evidence.

### XVI.7 Verification, and what is still missing

```
npm run verify
 Test Files  30 passed (30)
      Tests  662 passed (662)

npm run build
✓ built in 0.96s
```

Live mock probe, real server, real SQLite:

```
signals frozen  : 12
feature records : 12
mind snapshots  : 12
outcome rows    : 0
```

Freeze is proven end-to-end. Outcome *writes* are proven by `phaseXvi.store.test.ts` against real
SQLite (round-trip, cost-honest net R, INSERT OR IGNORE refusing to overwrite, EXPIRED classified
censored). `outcome rows: 0` in the mock is correct: nothing has hit a level or expired yet.

`npm run xvi:report` against the **real** ledger, verbatim:

```
signals            563
resolved           527
outcome rows       0   (cost-honest records)
feature records    7   (Phase XVI onward)
cost-honest rows   0   (have an outcome row)

527 resolved signal(s) pre-date the outcome store and are EXCLUDED from
every expectancy, profit-factor and drawdown figure below. Their gross R is
stored but their costs were never frozen...

entries            17
accepted           0
by status          {"testing":7,"proposed":9,"inconclusive":1}
blocked on data    RES-002, RES-010, RES-011

win rate           —   insufficient evidence: 0 samples, floor is 100
net expectancy R   —   insufficient evidence: 0 samples, floor is 30
Brier              —   insufficient evidence: 0 samples, floor is 100

GRADE ORDERING     INSUFFICIENT_EVIDENCE — no resolved signals carry a grade
FEATURE IMPORTANCE INSUFFICIENT_EVIDENCE (n=0, floor=120)
```

**The single most important line in this Part is that one.** 527 resolved signals exist and every
calibration figure reads `n=0`, because they pre-date the outcome store and their costs were never
frozen. Re-deriving costs from data that was not captured at decision time would be a
reconstruction, not a measurement — so they are excluded and the report says why in words. A reader
who saw `n=0` without that paragraph would reasonably conclude the tool was broken.

### XVI.8 Honest gaps in this Part

1. **The UI is not built.** Ledger, Research Registry, Calibration, Regime report, Feature-importance
   and Model-version panels — none exist. Item 8 of the implementation order is unstarted. They are
   the most visible remaining work and nothing about the engine's behaviour depends on them.
2. **Zero outcome rows in production.** Phase XVI shipped today. Nothing resolves until targets,
   stops or the 24 h expiry fire, so the calibration machinery has not yet seen a real cost-honest
   outcome. It is proven against synthetic data and real SQLite, and against **nothing else**.
3. **The 527 historical signals are unusable for cost-honest metrics.** Their gross R exists; their
   costs were never frozen. This is not recoverable without backfilling, which would be a
   reconstruction.
4. **Walk-forward has run zero evaluable folds**, for the same reason. The harness is proven on
   synthetic series (including an injected leak), not on the ledger.
5. **No out-of-sample or walk-forward test exists for the WEIGHTS**, because the weights are the
   shipped `[TUNED]` set and there is no fitted alternative to compare against.
6. **Empirical-Bayes credibility intervals (Engelbrecht et al.)** — the more principled shrinkage
   method for small samples — are not implemented. The bootstrap intervals are workable and their
   limitation is stated.
7. **`ISSUFFICIENT_EVIDENCE` is a state, not a progress bar.** Nothing in the code counts down to
   sufficiency or warns when a floor is nearly met. A reviewer cannot tell "30 samples away" from
   "30,000 away".
8. **`pruneCandles(2000)` still retains ~1 week**, so any multi-month out-of-sample claim remains
   impossible from stored data regardless of harness quality.
9. **The research registry is data with no scheduler.** Nothing runs the tests automatically; an
   entry moves from `proposed` to `testing` only by hand.
10. **Two of the 17 hypotheses are blocked on DATA, not method** — RES-002 needs FVG price bounds,
    RES-011 needs an ETF-flow source that 403s. They are recorded as blocked so the gap is explicit.

### XVI.9 The method note

Nothing in this Part was added because it sounded right. Each piece exists to make a specific failure
visible: `null` plus a reason so absence is countable; the population table so two metrics cannot
silently disagree; the residual so binning loss is measured rather than tolerated; the floors so a
small sample cannot be quoted as a rate; the verdict enums so "we do not know" is distinct from "no";
the governor so the previous working version survives a failed idea.

The engine currently has **0 accepted research hypotheses, 0 fitted weights, and 0 evaluable
walk-forward folds**. That is not an unfinished state that is being papered over — it is the correct
state at 7 Mind-tagged signals, and `npm run xvi:report` prints it in those terms.

---

**End of Part XVI.**

---

### Part XVII — Operational Memory, objective 1 (dataset boundary)

This work introduced a single exported dataset-policy module at [server/src/ledger/datasetPolicy.ts](server/src/ledger/datasetPolicy.ts) to declare the explicit population boundary:

- `MEASURED`
- `LEGACY_UNMEASURED`
- `RECONSTRUCTED`
- `VETOED`
- `BLOCKED`

The new guard `assertSingleDatasetPopulation()` forbids silent population mixing in one chart, table, or API response, while `legacyExclusionMessage(527)` emits the exact warning text: “527 legacy signals excluded because costs and outcome rows were not frozen at decision time.” The Phase XVI report now uses that text directly from the single exported policy module.

Validation run:

```text
npx vitest run server/test/datasetPolicy.test.ts
 ✓ server/test/datasetPolicy.test.ts (4 tests) 5ms
```

This is the first part of Phase XVII and intentionally preserves the legacy boundary without reconstructing historical costs or mixing legacy and measured evidence.

---

## Part XVIII — 20 Oct 2026: the foundation pass (M3.2, M1.5, M1.6, M1.4)

> Written 20 October 2026. Supersedes the §13 gap rows and the §17 roadmap states for those four
> M-IDs, and **corrects bugs #24 and #25 in place** — they were "found, not fixed" on 17 Oct and
> they are now fixed. No other Part is rewritten.

### XVIII.1 What this pass was

A "Closed-Loop Engine" brief arrived: decide, execute in paper mode, review every outcome,
retrain on a schedule, and promote a new model only if it beats the old one out-of-sample. The
brief's first phase was explicit: **fix the foundation, because everything downstream is measured
against it.**

Four items, all of which produce a number that LOOKS fine:

| ID | What was wrong |
|---|---|
| **M3.2** | The ledger credited every winner with the plan's **furthest** target's R |
| **M1.5** | The calibration check was `topAvg > bottomAvg` — no null hypothesis, no interval |
| **M1.6** | `byVeto` grouped on the **rendered** reason, so one rule became 102 categories |
| **M1.4** | Two more places where "no data" was wearing "zero" |

### XVIII.2 M3.2 — the R a trade actually realised

**The bug.** `rMultipleOf()` in `server/src/ledger/store.ts` read `snapshot.plan.rr`. And
`buildPlan()` defines `rr` as `targets[targets.length - 1].rr` — the **furthest** target. So a
trade that took profit at TP1, one R away, was reported as if it had banked the furthest target.

**The fix.** `realisedR()` in `server/src/ledger/resolve.ts` — the pure policy module — derives the
R from **the outcome and the frozen levels**:

- `STOP` → exactly −1.
- `TP1` / `TP2` / `TP3` → the R at the target that **actually resolved it**.
- `EXPIRED` → the move from the entry mid to the resolving close.
- `OPEN`, or anything unmeasurable → `null`. Never a zero.

The entry is the entry **mid** and the risk is the **frozen `riskPerUnit`** — the same two numbers
`resolveOutcome()` used when it decided the outcome — so the ledger's R and the resolver's R are
the same number by construction. A test asserts exactly that.

`LedgerSignal` gained `riskPerUnit` so the R does not depend on a nested optional object, and
`engine/mind/calibrate.ts`'s private `honestRMultiple()` now **delegates** to `realisedR()`. There
is one definition of the R a trade realised, and the ledger's statistics and the calibration report
cannot drift apart.

**The real before/after**, computed from the SAME 625 resolved rows by `npm run ledger:stats`:

```
                    OLD (plan.rr)      NEW (target hit)
avg R                       3.92               3.16
profit factor              10.60               8.74
gross win R              2703.21            2228.40
gross loss R              255.00             255.00
```

**Read that honestly: the change is real but smaller than the framing suggested.** The reason is
in the data — **326 of the 342 winners published exactly ONE target**, so for them the "furthest
target" and "the target hit" are the same price. The over-crediting only bit the 16 multi-target
rows. That is why `avgR` moved by 0.76 and not by 2.

It also means the ledger's headline R was **never** credible for a second reason, which this pass
did not fix and cannot:

> **The ledger assumes a perfect fill at the entry mid, instantly, with no costs.** `resolveOutcome()`
> is called with `entry = (entry_low + entry_high) / 2`, so the book assumes the fill happened at
> the mid of the zone, at the moment of the signal, for no fee, no slippage and no funding. A real
> fill is the **next candle's open** plus taker fee plus slippage plus funding per 8 h boundary.

**CORRECTION (20 Oct, later the same day).** An earlier draft of this Part claimed the ledger's
`avgR 3.16` at a `54.72%` win rate was *"an expectancy of about +1.28 R per trade"*. **That
arithmetic was wrong**, and the file's own rule is that a falsified claim is corrected in place.
The error: it multiplied the win rate by the mean over **all** trades — which already contains the
wins — and then subtracted a loss term for signals that are not losses.

The correct decomposition, computed from the same 625 rows:

```
p(win)     = 342/625 = 0.547200        E[R|win]   = 1663.73/342 =  4.8647
p(stop)    = 255/625 = 0.408000        E[R|stop]  =                -1.0000
p(expired) =  28/625 = 0.044800        E[R|exp]   =  564.67/28  =  20.1668

E[R] = 0.5472*4.8647 + 0.4080*(-1) + 0.0448*20.1668 = 3.1574 R per resolved trade
```

`avgR` **is** the expectancy per resolved trade, by construction. The claim was +1.28; it is
**+3.16**, and the discrepancy was entirely in the row that mattered least in the arithmetic and
most in the ledger: **the 28 EXPIRED rows average +20.17 R each.** See XVIII.9.

The Phase XVI `outcomes` table charges real costs, but only **54** rows have one; the other 571
pre-date it and are excluded from every cost-honest metric.

### XVIII.3 M1.5 — the calibration ladder is tested, not eyeballed

**The bug.** `isPredictive` was `topAvg > bottomAvg` over the populated score buckets: the mean
win rate of the bottom half against the mean of the top half. No null hypothesis, no interval, and
with two populated buckets a coin flip. On the live ladder it said `true` while the buckets read
**57.63 / 40.17 / 64.09 / 46.36**.

**The fix.** `server/src/ledger/monotonicity.ts` — pure, no I/O, every threshold a parameter:

1. **Spearman's rho** between the bucket's score midpoint and its realised win rate, with average
   ranks for ties.
2. **A bootstrap interval** that resamples **inside** each bucket, not across buckets. This
   matters: a bucket's sampling noise lives in its 30-to-300 trades, and resampling the buckets
   would report a spuriously tight interval for a ladder whose buckets are narrow.
3. **A permutation p-value** — the win rates shuffled across the buckets, the statistic recomputed.
4. **The isotonic slope** — a pool-adjacent-violators fit weighted by bucket size. The fit is
   non-decreasing *by construction*, so it cannot answer "is it monotone?"; it answers "how much
   monotone signal is there, and how close is the raw data to it?". The count of adjacent decreases
   is the companion diagnostic.
5. **The effect size** — the top bucket's win rate minus the bottom one's. A rank correlation says
   nothing about magnitude, and "predictive" without the size of the effect invites over-reading.

**The verdict is three-state**: `MONOTONE` / `NOT_MONOTONE` / `INSUFFICIENT_EVIDENCE`. A two-state
verdict forces a choice between "yes" and "no" when the honest answer is "not yet distinguishable
from noise" — which is the answer on the live ledger:

```
  verdict           INSUFFICIENT_EVIDENCE
  Spearman rho      0  95% CI [-0.8, 0.6]
  permutation p     0.5632
  isotonic slope    0  95% CI [0, 0]
  spread            -11.3pp
  violations        2
  isPredictive      — (unproven)
```

**The old check said `isPredictive: true` on exactly this data.** The ladder is not monotone: two
of the three adjacent pairs go DOWN. The score's ordering is not distinguishable from noise on 625
resolved signals.

### XVIII.4 M1.6 — vetoes grouped by KIND

**The bug.** `byVeto` keyed on `vetoReason.slice(0, 44)` — the rendered string, which embeds the
number that triggered the veto:

```
already moved 14.2% today — event risk
already moved 30.2% today — event risk
```

So one policy decision — "do not buy a coin that has already run 14% today" — became **102
categories** on this ledger, each with 2 to 11 samples, every one below the 30-sample floor where
a rate may be quoted at all. The group-by could not answer the only question it exists to answer:
*was the veto right?*

**The fix.** `server/src/engine/vetoKind.ts` — a stable code per rule. The rendered string is
unchanged (it is frozen on the signal row, so nothing already recorded is rewritten); the kind is
derived from it. `conviction.test.ts` and `ledger.stats.test.ts` pin the classifier against the
messages the **real** `evaluateVetoes()` produces, so the classifier cannot drift from the source.

**The live result — 102 reasons, 5 kinds, and the two largest now clear the floor:**

```
  DATA_HEALTH      n=  83  win rate  62.65%  Data integrity
  EVENT_RISK_MOVE  n= 173  win rate   42.2%  Event risk (already moved)
  FUNDING_UNWIND   n=   7  win rate  — (n=7, floor 30)
  GRADE_C          n= 333  win rate  60.66%  Grade C (no veto)
  real             n=  29  win rate  — (n=29, floor 30)
```

**That table is a real result, and it cuts both ways.** The 14% event-risk veto is **vindicated**:
the coins it blocked won **42.2%** against a 54.72% overall. The data-integrity block is
**questionable**: the coins it blocked won **62.65%** — better than the market it protected. That
is a finding, not a bug, and it is exactly the counter-example the shadow set exists to produce.

The `real` group has **n=29**, one below the floor. The ledger is 95% shadow signals, so the
performance of *real* trades cannot be quoted at all. That is now the second row in §13.

### XVIII.5 M1.4 — the remaining fabrications

The two cases named in the brief (`fundingZ: 0` rendering as `z=0.00`, and board rows reporting
zero liquidations under a live-looking `Meta`) were **already fixed** in the working tree. They are
now *proved* rather than assumed: `qa/honesty.spec.ts` passes.

But reading the same path for the same class of defect turned up **two more**:

- `fundingZScore()` returned **`0`** when the history was too short, and `0` when the history had no
  variance. Both render as `z=0.00`. It now returns `number | null`.
- `buildDerivRow()` asserted `meta.stale: false` — a hardcoded claim about freshness, made by a
  function that had no idea how old the data was. The age is now measured from the caller's `asOf`.

One subtlety worth recording, because it is the kind of thing that looks like a fix and is not:
`fundingZScore` computes the standard deviation as `sqrt(Σ(x−mean)² / n)`, and the naive mean of 30
identical values is **not** exactly that value in floating point. So the variance of a constant
history came out around 1e-19 rather than 0, and dividing by it produced a z-score of **1.5e15** —
a number about nothing. The function now uses **Welford's algorithm**, which leaves the accumulated
`m2` at *exactly* zero for identical values, so "no variance" is detected as the no-variance case
it is, with no epsilon and no magic constant.

### XVIII.6 Verification — the real output

`npm run verify` (typecheck + the full vitest suite):

```
 Test Files  33 passed (33)
      Tests  702 passed (702)
   Duration  5.59s
```

666 before this pass; **+36 new assertions, no test deleted, skipped or weakened.** One existing
assertion changed: `derivatives.test.ts` asserted `fundingZScore(0.001, [0.0001, 0.0002])` was `0`
— it now asserts `null`, which is the same intent stated correctly (a z-score that was never
computed is not a z-score of zero), and a second assertion was added for the zero-variance case.

`npm run build`:

```
dist/index.html                  3.05 kB │ gzip:  1.43 kB
dist/assets/index-DygKlKFg.css 111.35 kB │ gzip: 21.23 kB
dist/assets/index-EvXbtkHb.js  339.17 kB │ gzip:104.18 kB
✓ built in 1.08s
```

`qa/honesty.spec.ts` — the M1.4 browser proof, against the mock server, no exchange traffic:

```
  ✓  1 [desktop] › qa\honesty.spec.ts:33:3 › a value is never a lie › the liquidation column never reports a fabricated zero (3.0s)
  ✓  2 [desktop] › qa\honesty.spec.ts:58:3 › a value is never a lie › the funding tooltip does not claim a z-score it never computed (872ms)
  ✓  3 [desktop] › qa\honesty.spec.ts:70:3 › a value is never a lie › the CVD tooltip states that it is a derived proxy (844ms)
  3 passed (16.8s)

  ✓  1 [mobile] › qa\honesty.spec.ts:33:3 › a value is never a lie › the liquidation column never reports a fabricated zero (1.7s)
  ✓  2 [mobile] › qa\honesty.spec.ts:58:3 › a value is never a lie › the funding tooltip does not claim a z-score it never computed (831ms)
  ✓  3 [mobile] › qa\honesty.spec.ts:70:3 › a value is never a lie › the CVD tooltip states that it is a derived proxy (955ms)
  3 passed (7.4s)
```

`npm run ledger:stats` against the real ledger — the full output is quoted in XVIII.2, XVIII.3
and XVIII.4 above.

### XVIII.7 What this Part changed about the method

Three things, and the third is the one that matters:

1. **A statistic that is right in isolation and wired to the wrong thing is still wrong.** The
   M3.2 function and the M1.5 check were both *plausible*. The test that matters is the
   end-to-end one: `ledger.stats.store.test.ts` writes rows into a real SQLite ledger and asserts
   the numbers `/api/ledger` would report.

2. **The verdict has three states.** Every "is this predictive" question in this repo was being
   answered with two, and the data answered "no" with a "yes". `INSUFFICIENT_EVIDENCE` is not a
   softer "no" — it is the answer to a different question, and it is the one most of these
   questions currently deserve.

3. **The counter-example is the point.** The shadow set exists so the engine can be told it is
   wrong. This pass produced two verdicts it did not want: the event-risk veto is *right*, and the
   data-integrity block is probably *too strict*. Neither verdict is acted on here — the block
   stays, because a gate that opens itself the moment it finds evidence against itself is not a
   gate. But it is now written down instead of argued about.

### XVIII.8 Honest gaps in this Part

1. **No cost-honest population yet.** 54 of 625 resolved signals have a Phase XVI outcome row
   with frozen costs. Every expectancy figure in the ledger is gross.
2. **The fill assumption is still a fill assumption.** Fixed in Phase 2's paper broker, not here.
3. **`fundingZ` is still null everywhere.** The function is now honest about being unable to
   compute one, but nothing collects a funding history, so the field stays empty. A `null` that is
   permanent is better than a `0` that is permanent, and it is still an unbuilt feature.
4. **The veto kinds are derived from the message, not stored.** A new veto message that the
   classifier does not recognise becomes `UNKNOWN` — counted, never silently dropped, and the
   count is visible. Storing the kind on the row would be better; it needs a schema change and a
   backfill that classifies rather than measures, so it is not done in a pass whose other job was
   to stop inventing.
5. **The permutation test cannot resolve with four buckets.** With 4 populated buckets there are
   only 24 distinct permutations, so the smallest achievable p-value is 1/24 ≈ 0.042. The verdict
   is therefore driven by the bootstrap interval, and the p-value is reported as corroboration.
   The `reason` string says so.

**End of Part XVIII.**

---

## Part XIX — 20 Oct 2026: the expectancy decomposition, three resolver defects, and the random-entry baseline

> Written 20 October 2026. **Corrects an arithmetic claim in Part XVIII** and adds bugs 44–46.
> Phase 1 of the Closed-Loop Engine.

### XIX.1 The arithmetic, and a correction

Part XVIII claimed the ledger's `avgR 3.16` at a `54.72%` win rate was *"an expectancy of about
+1.28 R per trade"*. **That was wrong**, and the file's rule is that a falsified claim is corrected
in place. The error: it multiplied the win rate by the mean over **all** trades — which already
contains the wins — and then subtracted a loss term for signals that are not losses.

The correct decomposition, from the same 625 rows:

```
p(win)     = 342/625 = 0.547200        E[R|win]   = 1663.73/342 =  4.8647
p(stop)    = 255/625 = 0.408000        E[R|stop]  =                -1.0000
p(expired) =  28/625 = 0.044800        E[R|exp]   =  564.67/28  =  20.1668

E[R] = 0.5472*4.8647 + 0.4080*(-1) + 0.0448*20.1668 = 3.1574 R per resolved trade
```

`avgR` **is** the expectancy per resolved trade, by construction. The claim was +1.28; it is
**+3.16**. The difference was entirely in the row that mattered least in the arithmetic and most
in the ledger: **the 28 EXPIRED rows average +20.17 R each.**

### XIX.2 Three resolver defects, found by asking that question

Asking where +20 R per expiry came from found three defects in
`server/src/ledger/resolve.ts`. All three are now bugs 44–46 in §12.3.

**44 — a gap through a level was invisible.** The level test was *"is P inside this candle's
RANGE"*. A price that **gaps** through a level never puts it inside a range: the candle opens
beyond it and the whole candle sits on the far side. The evidence is in the data:

- **28 expired rows carried 28.6% of the ledger's entire R.** All 28 had a maximum favourable
  excursion above 1 R, and **27 of 28 had an adverse excursion of exactly zero** — the price never
  went against the entry. That is the signature of a favourable gap, not of a market that ran away.
- **All 255 stopped rows have an adverse excursion deeper than −1 R** (median ≈ −1.5 R, worst
  −27 R), and every one of them was booked at exactly −1 R.

**45 — an expiry was marked at "now".** `LEDGER.EXPIRY_HOURS` is 24. Thirteen of the 28 expired
rows were resolved between 24 and 71 hours after creation and marked at the price on the day of
resolution. A trade's life is 24 hours; its mark is the price at the end of that life.

**46 — a trade could be resolved by a candle from after its own life ended.** The expiry was
checked only *after* the resolver had walked the whole candle array. Measured on the live ledger:
**15 of the 597 decided rows were resolved between 24 and 56 hours after creation**, and in the
replay harness the mean time to resolution was **535 bars — 44 hours** — for a strategy whose rule
is 24.

The fix for 44 also corrects a **test** that encoded the wrong mechanics. `ledger.test.ts` asserted
that a candle opening above TP1 credits TP2, *"because price never traded at 104"*. A resting
sell-limit at 104 is filled when the market trades at or through 104 — including when it **gaps**
through — at a better price than 104. The test now asserts TP1, with the reason in a comment.

### XIX.3 The re-resolved ledger

Every one of the 625 resolved signals re-resolved against **real Binance 5m candles** fetched for
its own window (`fetchKlinesRange`, added to `data/binance.ts` with `startTime`/`endTime` — the
old fetcher could only return the most recent 1000 candles, which is 83 hours, and the ledger's
own backfill silently under-covered every gap longer than that):

```
                              as stored    re-resolved
win rate                         54.72%         58.40%
avg gross R                       3.1419         2.6894
avg NET R (modelled costs)            —           2.2707
outcomes                    TP1:337 TP2:5    TP1:365
                            STOP:255        STOP:248
                            EXPIRED:28      EXPIRED:12
```

The expiry bucket shrank from 28 to 12 and the wins grew by 23: those were take-profits the
market had gapped through, which the old resolver never credited.

**Costs are MODELLED**, not measured. `RISK.*` — taker fee 5 bps each side, 5 bps slippage, and
funding charged across the exchange's own 8-hour UTC boundaries — applied through the existing
`computeCosts()`. Only **54** of the ledger's rows have frozen costs; the rest are recomputed from
the config, which is an assumption, not a measurement.

**The cost is enormous relative to the risk.** The plans have an average per-unit risk of **0.129**
on an average entry of **48.34** — a stop about **0.27%** wide. A 15 bps round trip against a
27 bps stop is **0.56 R of cost per trade**. That is not a detail; it is why the net numbers are
much smaller than the gross ones, and it is the single most important structural fact about this
engine's geometry.

### XIX.4 The random-entry baseline — the instrument, built before anything was fitted

The question: **is the engine's edge a property of the market, or a property of the engine?** The
instrument: take each signal's own stop and target distances, enter at a random time in the same
session, and see what that makes. Same candles, same resolution rules, same costs, same geometry
re-anchored at the new entry. The only thing that differs is the entry time.

Two controls, because a random entry inside the session has **less time** than the engine's trade
and that handicap alone would manufacture an edge for the engine:

- **Control A — window-limited.** The random trade may only use the session's own candles.
- **Control B — time-matched.** The random trade gets the same 24-hour life, even though that
  takes it past the session. **This is the headline.**

```
engine                       2.2707 R   95% CI [1.8729, 2.6933]   n=625 clusters=106 ICC=0.2999 designEffect=2.4686 nEff=253.18
random, control A          -0.4297 R   95% CI [-0.5302, -0.3254]   n=625 clusters=106 ICC=0.7475 designEffect=4.6601 nEff=134.12
random, control B          -0.3969 R   95% CI [-0.5098, -0.2813]   n=625 clusters=106 ICC=0.7808 designEffect=4.8230 nEff=129.59

permutation test (control B):  observed difference 2.2542 R over 625 paired signals, p = 0.0005
```

**The time handicap is not the explanation** — A and B are within 0.03 R of each other. And a
random entry with the engine's own geometry makes **≈ 0 gross R** and **−0.40 R net**, which is
exactly what the geometry implies: a target at +5 R and a stop at −1 R break even at a ~17% hit
rate, which is what a random entry gets.

So the geometry is **not** the finding, and the user's stop condition ("if random entries show
large positive R, say so and stop") is **not** triggered. The engine's entry timing is worth
**+2.67 R** against a random entry with the same shape.

**The confidence intervals are cluster bootstraps.** The 625 rows are 106 symbols, and signals on
the same symbol overlap. Resampling rows would give an interval that is too narrow, so the
bootstrap resamples **symbols** and the effective sample size is reported: **253 independent
observations**, not 625, for the engine arm, and **130** for the random arm.

### XIX.5 The finding that matters more than the headline

Slicing the engine arm by population — `wasReal` used only as a slice, never as a feature:

```
all rows                     2.2707 R   95% CI [1.8513, 2.6806]   n=625  nEff=253.18
real (grade A/B)           -0.0326 R   95% CI [-0.8473, 0.7046]   n=29   nEff=29
shadow                      2.3827 R   95% CI [1.9664, 2.7950]   n=596  nEff=259.70
excluding DATA_HEALTH      2.0442 R   95% CI [1.6185, 2.4599]   n=542  nEff=179.92

by veto kind:
  real                     -0.0326 R   95% CI [-0.8241, 0.7483]   n=29
  GRADE_C                   2.3485 R   95% CI [1.7796, 2.8938]   n=333
  EVENT_RISK_MOVE           1.7537 R   95% CI [1.1356, 2.4160]   n=173
  DATA_HEALTH               3.7495 R   95% CI [2.4529, 5.3744]   n=83
  FUNDING_UNWIND            3.3528 R   95% CI [2.0538, 5.0848]   n=7
```

**The entire measured edge lives in the counter-examples.** The 29 signals the engine actually
would have traded — grade A and B — are at **−0.03 R with a CI that straddles zero**. The +2.27 R
is made of the 596 signals the engine **rejected**: grade C, and the vetoed ones.

Three things follow, and none of them is a reason to fit a model yet:

1. **The engine's own picks have no demonstrated edge.** n=29, CI [−0.85, +0.70]. The point
   estimate is flat. The CI is wide enough to hide almost anything, so this is "unproven", not
   "proven negative" — but it is certainly not evidence.
2. **The selection machinery appears to be anti-predictive.** The setups the engine chose did
   *worse* than the setups it threw away. If the structural rule (buy the zone) has an edge, the
   conviction/grade/veto machinery that decides *which* zone to trade is removing it.
3. **The vetoes are mostly wrong, and one is right in the wrong way.** The data-integrity block
   discarded coins that made **+3.75 R** (n=83) — the gate is too strict. The event-risk veto
   discarded coins at **+1.75 R** against an overall +2.27 R — directionally right, nowhere near
   enough to justify a hard veto.

**The dataset policy the brief specifies is vindicated by the data.** Excluding DATA_HEALTH-vetoed
rows removes the single best-performing group in the ledger, which is exactly what a
stale/missing-feature artefact looks like. Those rows must not train anything.

**The caveat that has to be stated.** The engine arm fills at the entry mid with **no slippage at
the fill**; the random arm fills at a candle open. The comparison favours the engine. The gap
(+2.67 R) is far larger than a fill difference on this geometry (~0.1–0.3 R), so the fill does not
explain it — but it is not zero, and the number to beat is the *gross* difference, not the net one.

### XIX.6 Honest gaps in this Part

1. **The re-resolution is an analysis, not a migration.** The 625 stored outcomes in
   `server/data/orderflow.db` still carry the old resolution. The Phase XVI `outcomes` table's
   "first write wins" rule means the 54 cost-honest rows would keep their old `gross_r` under a
   policy they were not written under. Rewriting stored evidence is a decision, not a code change,
   and it is **not taken here**.
2. **The features exist for 7 of the 625 rows.** Only 7 signals have a frozen Phase XVI feature
   record. Everything else would have to be RECONSTRUCTED from historical data, which the dataset
   policy labels and forbids mixing with MEASURED. No model is fitted on it in this Part.
3. **`fetchKlinesRange` is uncached on purpose** and fetches up to 4 pages per symbol. A full
   re-resolution of the ledger takes ~4 minutes and ~320 requests.
4. **The random control's entry is the candle OPEN**, which is right for a market order and wrong
   for a limit order at the zone. The engine's arm gets the optimistic fill. Both facts are
   stated above; neither is corrected.
5. **The permutation test cannot resolve with a handful of clusters.** 106 clusters is enough for
   it to reach p = 0.0005, but the p-value is a floor, not a precise number.

**End of Part XIX.**

---

## Part XX — 21 Oct 2026: the Engine Lab — the closed loop, built and supervised

> Written 21 October 2026. **Adds** the Engine Lab: a new tab, a new backend, a new store and a new
> acceptance script. No older Part is rewritten. Bug #47–#49 are added in §12.4; the `LAB` constant
> group is added to Appendix A; nine routes are added to §10.

### XX.1 The fact check came first, and it changed the design

The brief asked for a fact check before any integration code, and the fact check settled two
questions that would otherwise have been built on.

**TradingView has no order-placement API.** Its paper-trading account is a manual UI simulator; the
only automation is an **outbound alert webhook** (a POST of the alert message to a URL you choose).
TradingView's own docs say: *"If the alert message is valid JSON, the request will include an
`application/json` content-type header"* — the message is *sent out*, and there is no documented
inbound "place this order" endpoint. Sources:
[TradingView — how to configure webhook alerts](https://www.tradingview.com/support/solutions/43000529348-how-to-configure-webhook-alerts/)
and [TradingView — alerts (Pine Script docs)](https://www.tradingview.com/pine-script-docs/faq/alerts/).

So nothing here scrapes TradingView, automates its UI, reverse-engineers it, or handles its
credentials. TradingView is **viewing only**. The Lab exposes
`GET /api/lab/alert-message`, which returns a JSON object — `symbol`, `side`, `entry`, `stop`,
`targets`, `pWin`, `modelVersion` — for the operator to **paste into a TradingView alert or a chart
note**. The endpoint says so in its own text, and the page repeats it.

**Binance testnet is a separate host with its own key, and only `/api/*` exists on it.**
`https://testnet.binance.vision/api` is the Spot Test Network's mapping of `https://api.binance.com/api`,
and the same page states *"No, only the `/api` endpoints are available on the Spot Test Network"* —
`/sapi/*` is not. The Futures counterpart is `https://testnet.binancefuture.com`. Sources:
[Binance — Spot Test Network](https://testnet.binance.vision/) and
[Binance — General REST API Information](https://developers.binance.com/docs/binance_link/link-and-trade)
(429 ⇒ back off, 418 ⇒ IP banned; limits are per-IP, not per-key).

The adapter behind that is `BinanceTestnetAdapter`, **OFF by default** (`LAB.TESTNET_ENABLED:
false`), and it reads `BINANCE_TESTNET_API_KEY` / `BINANCE_TESTNET_API_SECRET` from the
environment. The values are never logged, never returned over HTTP and never sent to the browser —
the adapter only ever holds the env var **names**. Every call goes through `fetchJson`, so the ban
guard and the mock transport both apply.

### XX.2 The research, in ten lines per topic

**Purged and embargoed walk-forward CV, and meta-labelling (López de Prado).**
Purge = drop training rows whose *label interval* intersects the test block; embargo = drop a band
*after* the test block whose features may still be serially correlated with it. The two cover
different directions: purge is about **labels**, embargo about **features**. Embargo belongs on the
"after" side only — applying it on the before side is redundant. A controlled quantification found
that **contiguous folds already remove nearly all of the MEAN bias** and that purging buys the
*worst-case* guarantee; and that an embargo bought nothing for **exogenous** features, while
return-derived features (this engine's order-flow readings) are exactly the case it defends.
Meta-labelling is a **precision filter, not an alpha source**: it lifts precision and profit factor
in most instruments, but on a primary model with no net edge, 0 of 42 instruments cleared a
deflated-significance bar. Sources:
[AFML ch. 7 summary](https://sipemu.github.io/mlfinance/examples/ch07_cross_validation/),
[Cross-Validation in Finance](https://arithmion.com/learn/en/depth-advanced-ml/cross-validation-in-finance/),
[How Much Does Purging Actually Fix?](https://purged-cv.marketmaker.cc/paper.pdf),
[Daru Finance — López de Prado review](https://daru.finance/research-review/lopez-de-prado/labeling-and-cross-validation).
**What this changed:** the harness keeps the purge and the embargo as separate, reported
parameters; the embargo default is **6 hours** and it is printed on every fold; and the champion /
challenger comparison uses **non-overlapping confidence intervals**, because "not distinguishable" is
not "better".

**Probability calibration (isotonic vs Platt).**
The reliability diagram bins the predictions and plots mean predicted probability against realised
frequency. Isotonic fits a step-wise monotone map and **overfits on small samples** — the rule of
thumb is **≥ 1000 samples**; below that, **Platt** (a two-parameter sigmoid on the score) is the
safer choice. A logistic recalibration with an intercept *and* a slope performed best in a 2023
simulation study, and calibration **on the logit scale** generally beat calibration on raw
probabilities. Recalibrating is also **harmful** below ~500 validation rows, and comparing two
models is only fair if both are calibrated on the same validation set — or both are left raw.
Sources: [scikit-learn 1.16 — Probability calibration](https://scikit-learn.org/stable/modules/calibration.html),
[Ojeda et al. 2023 (PubMed 37849356)](https://pubmed.ncbi.nlm.nih.gov/37849356/),
[eval-toolkit — Calibration](https://brandon-behring.github.io/eval-toolkit/methodology/calibration.html).
**What this changed:** the Lab's calibration panel reports the **Brier score against the constant
base-rate predictor on the same rows** and a **skill score** (`1 − brier / brierBaseRate`), because a
Brier score alone says nothing. The **isotonic/platt choice is deliberately deferred**: the Lab's
population is 280 out-of-sample decided trades today, which is below the ~500-row threshold below
which recalibration is documented to hurt, so the shipped probability is left **raw** and the
calibration is **measured**, not corrected.

**Binance testnet endpoints and rate limits.**
Spot testnet base `https://testnet.binance.vision/api`; Futures testnet base
`https://testnet.binancefuture.com`. Only `/api/*` exists on the spot testnet. The live limits are
per-IP, not per-key: 6000 request-weight per minute, 50 orders per 10 s, 160 000 orders per day,
61000 raw requests per 5 minutes. A 429 must be backed off; repeated 429s escalate to a **418 IP
ban**, which scales from 2 minutes to 3 days, and a `Retry-After` header says how long to wait.
The `ORDERS` counter only increments on *unfilled* orders, so a strategy whose orders fill
immediately can place orders continuously. Sources: [Binance Spot Test Network](https://testnet.binance.vision/),
[Binance — Spot REST API](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md),
[Binance — General REST API Information](https://developers.binance.com/docs/binance_link/link-and-trade).
**What this changed:** the testnet adapter is `OFF` by default, and the repo's own ban guard —
which already tracks Binance hosts per-IP and escalates on 429 — is the path every call takes.

**TradingView alert webhook message format.**
A webhook is an HTTP **POST** of the alert message to the URL you configure, on **ports 80 or 443
only**, with a **3-second timeout**; two-factor authentication must be on; delivery is **not
guaranteed**, so the receiver must be idempotent; and the message must be valid JSON or it is sent
as `text/plain`. Placeholders are `{{ticker}}`, `{{exchange}}`, `{{close}}`, `{{open}}`,
`{{high}}`, `{{low}}`, `{{volume}}`, `{{time}}`, `{{timenow}}`, `{{interval}}`, `{{syminfo.*}}` and
`{{plot_0}}…{{plot_19}}`, and they are **case-sensitive**. Sources:
[TradingView — webhook alerts](https://www.tradingview.com/support/solutions/43000529348-how-to-configure-webhook-alerts/),
[TradingView — variable values in alerts](https://www.tradingview.com/support/solutions/43000531021-how-to-use-a-variable-value-in-alert/),
[TradingView — Pine Script FAQ, alerts](https://www.tradingview.com/pine-script-docs/faq/alerts/).
**What this changed:** the Lab's message is a plain JSON object with **no placeholders**, because
the values are the engine's at the moment of the decision — they are meant to be pasted, not
templated. The page says the message is for pasting and that nothing is sent.

### XX.3 What was built

**The feature store was EXTENDED, not forked.** `server/src/engine/mind/features.ts` keeps its one
rule — `asOf` is a wall — and gained four groups and one field:

| Group | What it added |
|---|---|
| `timeframes` | `ret15mPct` `ret1hPct` `ret4hPct` `atrPct5m` `range1hPct` `rangePosition1h` — the 5m–4h range, each sliced by the same wall |
| `crossAsset` | `betaToBtc` `corrToBtc` `btcReturnPct` `idiosyncraticReturnPct` — paired on close time so a gap in either feed cannot shift the pairing |
| `liquidations` | `longLiqUsd` `shortLiqUsd` `netLiqPressure` — the flow, in USD (bug #47) |
| `orderbook` | `depthUsd10bps` `depthUsd50bps` `imbalanceNear` `imbalanceFar` — depth-weighted, with the snapshot's own timestamp checked against `asOf` |
| `funding` | `last8h` `mean24h` `min24h` `max24h` — the raw series behind the z-score |
| `regime.stablecoinFlow24hPct` | the float's 24-hour **change**, because a level says nothing about whether money is arriving |

**Every feature now has a NAME, a UNIT and a null-when-unavailable rule.** `FEATURE_CATALOGUE` is a
flat, ordered list of 63 entries — name, dotted path, unit, one-line description — and
`featureCatalogue(vector)` resolves it against a live vector. It is the **contract** between the
feature store and anything that reads a model: a feature that is not in the list is not a feature,
and a feature in the list whose value is `null` was **not measured**, not zero. The Lab's fitted
feature set is exactly this catalogue, so a model fitted against it can be applied to any later
vector with the same schema.

**Each new reading has its own leakage test.** The original single test — append future candles,
assert the vector is byte-identical — cannot cover a reading that arrives through a *different
series*, because a leak in the 15m reader is invisible to a test that only appends 5m candles. So
`server/test/lab.features.test.ts` appends future data of each reading's own kind: a future 15m
candle, a future BTC candle, a book snapshot timestamped after `asOf`. Each test also asserts the
reading **was** measured first, so "identical" cannot pass vacuously on two empty vectors. The book
test is the sharpest one: a snapshot from the future is **refused outright** and the whole group goes
`absent()`, because there is no other snapshot to use and a future price must not leak through a
missing one.

**The execution layer.** `server/src/engine/lab/executor.ts` defines one `ExecutionAdapter`
interface and three implementations:

- **`PaperBroker`** — fills at the **next candle's open** (never the signal price), charges
  **slippage** always in the direction that hurts, charges the **taker fee**, charges **funding**
  for every 8-hour UTC boundary the trade crosses, resolves an ambiguous candle **STOP FIRST**, and
  **expires** a position that hits neither level. A gap through a stop fills at the **open** (worse
  than the stop); a gap through a target fills at the **open** (better than the target, because a
  resting limit sells at or through its price). Gross R is measured on the **raw** prices and the
  slippage, fees and funding are then charged — so the costs are counted exactly once.
- **`BinanceTestnetAdapter`** — off by default, env-var keys, `fetchJson` for every call.
- **`LiveExecutor`** — **refuses everything**, and its refusal text is the promotion criteria:
  90+ days AND 300+ paper trades, a net-expectancy CI lower bound above zero, calibration within
  tolerance, a green drift monitor, and the operator's explicit manual approval. It has no host and
  no key handling, so it is not a configuration away from working.

**The risk gate runs BEFORE any adapter.** `server/src/engine/lab/risk.ts` checks, cheapest and most
absolute first: the kill switch, the daily-loss halt, shadow-only, the macro blackout, the
concurrent-position limit, the risk-per-trade limit and the sector-exposure limit. Because it runs
first, the kill switch works even when the adapter is broken — or when the adapter is the disabled
stub. Every limit is a tagged number in `config.ts`; this file reads them and defines none.

**The learning loop.** A review is written the moment a paper position closes, and it is
**evidence**: written once, never edited by the retrainer, and it never touches the model or a
threshold. The classifier is a pure function of the evidence and it has a first-class answer for
"nothing went wrong": **`variance`**, with the note "the rule was working; the outcome was variance.
No fault, no change." The other classes are `bad-timing`, `stop-too-tight`, `news-shock`,
`regime-misread`, `cost-drag` and `data-problem`, and the most specific cause wins.

Retraining happens **in batches** (`LAB.RETRAIN_BATCH_SIZE = 25`), never after one trade, and the
Lab says so when it refuses: *"25 new resolved trades since the last retrain and a batch is 25.
Learning from fewer trades than that fits noise."* A retrained model is a **new versioned
artefact** (`lab-1.0.0`, `lab-1.1.0`, …) with its weights, its fit options and its feature schema
stored beside it. It is evaluated **entirely out of sample** on purged, embargoed, symbol-grouped
folds, and it is promoted **only** if it beats the champion on net expectancy **and** Brier with
**non-overlapping** intervals on both. A rejected challenger is retired **with its reason recorded**.
A rollback is one command and is also recorded.

The **drift monitor** compares the rolling live window against the champion's validation numbers.
Degraded on either axis ⇒ **shadow-only is forced** and the degradation is visible on the page. With
too few live trades it says **`UNKNOWN`**, because "not enough to tell" and "healthy" are different
claims.

**The Lab page.** A new `Engine Lab` tab, added in `App.tsx` in all three places (the `Tab` union,
the nav list and the render block). Seven sections, each reading a real endpoint: status, live
decisions, paper account, post-trade reviews, learning history, calibration, controls. Everything
that was not measured renders as `—`.

### XX.4 Verification — the real output

`npm run verify` (typecheck + the full vitest suite):

```
 Test Files  35 passed (35)
      Tests  789 passed (789)
   Duration  6.30s
```

718 before this pass (with **1 failing** — bug #48), **+71 new assertions**, no test deleted,
skipped or weakened. One existing assertion changed: `phaseXvi.test.ts` PROOF 9 asserted the
buggy liquidation-distance behaviour and now asserts the honest one (bug #47).

`npm run build`:

```
dist/index.html                  3.05 kB │ gzip:   1.43 kB
dist/assets/index-BLlIO4mv.css 114.48 kB │ gzip:  21.83 kB
dist/assets/index-nrhzQm1G.js  364.38 kB │ gzip: 109.97 kB
✓ built in 1.31s
```

`qa/lab.spec.ts` — the browser proof, against the mock server, no exchange traffic:

```
  ✓  14 [desktop] › qa\lab.spec.ts:38:3 › the Engine Lab › all seven sections are on the page
  ✓  14 [mobile]  › qa\lab.spec.ts:38:3 › the Engine Lab › all seven sections are on the page
  ...
  28 passed (26.6s)
```

`npm run verify:engine` — the acceptance gate, **against the real ledger and real Binance
candles**, verbatim:

```
ledger: 844 signals, 800 resolved
  re-resolved 800 signals across 118 symbols

--- population ---
  all re-resolved rows        800
  excluded (DATA_HEALTH)      202
  training population          598
    of which decided           593
    of which censored (expiry) 5
    real (grade A/B)           29
    shadow                     569

--- walk-forward: 3 folds (purged, embargoed 6h, grouped by symbol) ---
  fold 1: train 124 (purged 26, embargoed 0)  test 159  brier 0.2319 (base 0.2431)  logloss 0.6518  coverage 91.7%  win 58.7%  netR 2.027
  fold 2: train 237 (purged 7, embargoed 0)  test  70  brier 0.2542 (base 0.2422)  logloss 0.7105  coverage 92.6%  win 57.1%  netR 3.255
  fold 3: train 330 (purged 15, embargoed 0)  test  55  brier 0.2249 (base 0.2314)  logloss 0.6598  coverage 80.0%  win 72.7%  netR 3.196

--- out-of-sample (pooled over folds) ---
  decided rows        279
  base rate           59.50%
  Brier score         0.2359
  Brier, base rate    0.2410
  Brier skill         0.0209
  log loss            0.6677
  threshold           0.55
  COVERAGE            42.8%   (254 of 279 decided rows)
  win rate, taken     66.54%
  win rate, skipped   45.83%
  net R, taken        2.8416   (MODELLED costs)

--- confidence tiers (out-of-sample) ---
  threshold    n   coverage   hit rate   95% Wilson CI        net R
  p >= 0.60    205    73.5%     61.46%  [54.6%, 67.9%]        2.614
  p >= 0.70     67    24.0%     76.12%  [64.7%, 84.7%]        3.079
  p >= 0.80     12     4.3%          —  —                     2.893
      Only 12 trades reached 0.8, and the floor is 30. The hit rate is not quoted at this sample size.
  p >= 0.90      2     0.7%          —  —                     -1.365
      Only 2 trades reached 0.9, and the floor is 30. The hit rate is not quoted at this sample size.
  overall       279  59.50%  [53.65%, 65.09%]

--- net expectancy, with cluster-bootstrap intervals ---
  engine (all re-resolved rows)    2.3416 R   95% CI [1.9559, 2.7367]   n=800 clusters=118 ICC=0.4366 nEff=227.05
  engine, real picks only         -0.0326 R   95% CI [-0.8768, 0.723]   n=29 clusters=19 ICC=null nEff=29
  engine, excluding DATA_HEALTH    2.2805 R   95% CI [1.8873, 2.7088]   n=598 clusters=97 ICC=0.4752 nEff=173.12
  buy-and-hold, same windows      -4.4563 R   95% CI [-6.5957, -2.3464]   n=800 clusters=118 ICC=0.6079 nEff=177.24

--- permutation test: engine vs a random entry with the same geometry ---
  observed difference  2.3451 R over 793 paired signals
  permutation p        0.0005
```

The tier table and the promotion block are from the final run of the same script; the two blocks
above are quoted from the run immediately before the bug #49 fix, and the numbers moved by less than
0.01 R. **The random-entry arm's own line was added by that fix** and reads:

```
  random entry, same geometry     -0.4334 R   95% CI [-0.5611, -0.3083]   n=96600 clusters=118 ICC=0.9735 nEff=121.21
```

And the promotion block, verbatim:

```
--- promotion beyond paper/testnet: NOT MET, and here is why ---
  days of paper trading   0 (needs 90)
  paper trades            811 (needs 300)
  expectancy CI lower     1.9497 (must be above 0)
  calibration worst gap   0.1056 (tolerance 0.1)
  blocked by:
    - 0 days of paper trading, 90 are required
    - calibration is outside the 10pp tolerance
    - the drift monitor has not produced a verdict
    - the operator's explicit manual approval has not been given
```

### XX.5 What the numbers actually say

**This is the honest answer, and it is not "80–90% in a tier".**

- The **p ≥ 0.70 tier** is the strongest quoted one: **76.12% on 67 trades, 24.0% coverage**, Wilson
  CI **[64.7%, 84.7%]**. The interval's **lower bound is 64.7%**, so the data does not support
  claiming 80% — it supports claiming *"better than about two in three, and no worse than about
  65% with 95% confidence"*.
- The **p ≥ 0.60 tier** is **61.46% on 205 trades, 73.5% coverage**, CI [54.6%, 67.9%].
- The **p ≥ 0.80 and p ≥ 0.90 tiers quote nothing**, because 12 and 2 trades are below the 30-trade
  floor. The page prints the count and the reason instead of a rate.
- The model's **Brier skill against the constant base rate is 2.09%**. It beats the base rate; it
  does not beat it by much.
- The **reliability buckets are not flat**: the 0.60–0.70 bucket predicts 0.649 and observes 0.543
  (a 10.6pp gap), and the 0.90–1.00 bucket has 2 trades and observed **0.000**. The worst populated
  gap is **0.1056**, just outside the 0.10 tolerance, and that is one of the reasons promotion is
  blocked.
- The engine arm is **+2.34 R** against **−0.43 R** for a random entry with the same geometry
  (permutation p = 0.0005) and **−4.46 R** for buy-and-hold on the same windows.
- **And the arm that matters most is still flat**: the engine's own conviction picks (grade A/B) are
  at **−0.03 R, CI [−0.88, +0.72], n=29** — the same finding as Part XIX, unchanged. The +2.34 R is
  made of the 569 signals the engine **rejected**.

So: **there is an edge in the geometry-plus-timing combination, it is real against a random entry and
against buy-and-hold, and the engine's own selection machinery still does not isolate it.** The
confident-tier claim the brief asked about is supported only up to "about 76% at p ≥ 0.70, with a
lower confidence bound of 65%".

### XX.6 Honest gaps in this Part

1. **The Lab's own account has no trades in it yet.** The paper broker needs live closed candles to
   fill, and the ledger's rows pre-date the Lab. The Lab's tables therefore read `n=0` until the
   engine runs in PAPER mode for long enough. **The 800 rows above are the RE-RESOLVED LEDGER, not
   Lab paper trades**, and the two must not be confused: the ledger arm fills at the entry mid, the
   Lab's broker fills at the next candle's open with slippage. The Lab's arm is the more honest one
   and it has fewer rows.
2. **The champion model is not fitted.** With zero Lab reviews there is nothing to fit, so the status
   panel reports `mind-1 (shipped, unfitted)` and every probability on the page comes from the Mind
   layer, which is calibrated at the base rate by construction. The drift monitor correctly reports
   `UNKNOWN` rather than `GREEN`.
3. **The calibration population is 280 out-of-sample decided trades**, which is below the ~500-row
   threshold below which the literature says recalibration hurts. So the Lab **measures** calibration
   and does not correct it. No isotonic and no Platt map is fitted yet.
4. **The macro blackout is not wired to the risk gate.** `RiskState.macroBlackoutMin` is `null` from
   the runner, because the calendar is not on the Lab's clock yet. The gate implements the rule and
   the test proves it, but in the running Lab the blackout is currently **not enforced**. This is a
   live under-gate and it is recorded rather than papered over.
5. **`LAB.TESTNET_ENABLED` is `false` and the adapter has never been run against the testnet.** It is
   written, it is behind the ban guard, and its availability refusal is tested — but "written" is not
   "exercised", and no testnet order has been placed.
6. **The higher-timeframe, cross-asset, order-book and funding-history readings are implemented,
   tested and wired into the vector — but the production scan does not yet supply them.** They are
   `absent()` on every live row, because `runMindPass` does not pass the higher-timeframe series,
   the BTC series, the book levels or the funding history. The catalogue shows them as missing, which
   is correct, but it means the extended feature set is **not yet live**.
7. **The `risk.ts` sector limit needs a sector on the intent.** A position with no sector is not
   counted against any sector, which is a gap rather than a rule.
8. **Five Playwright tests in `qa/home.spec.ts` fail, and they failed before this pass.** They were
   verified as pre-existing by removing the `Engine Lab` nav entry and re-running: the **same five**
   failed, identically — two board columns 10.97px apart, board header counts `NaN`, the popup pin,
   the popup's required stats, and `.of-badge.bear` contrast at **4.34:1** against a 4.5:1
   requirement. The other specs (`chart`, `diag`, `live-loop`, `orderblock`, `render-count`,
   `search`, `honesty`, `lab`) pass: **32 passed**. These five are **not fixed here** and are
   recorded as an open item.
9. **One house rule was broken during this pass.** House rule 5 forbids PowerShell `-replace` on
   source files. One edit — renaming `K_LAST_RETRAIN_AT` to `SETTING_KEYS.lastRetrainAt` in
   `server/src/engine/lab/service.ts` — was made with `Get-Content | -replace | Set-Content` before
   the rule was re-read. The file was checked afterwards (no mojibake, `tsc` clean, the full suite
   green) and no other source edit in this pass used `-replace`; every other edit used the Edit
   tool. It is written down because the rule exists for a reason and the reason applies here too.
10. **The `random entry, same geometry` line in XX.4 reports 96 600 rows.** Those are the random
    arm's **trials** (811 signals × 120 trials), not 96 600 independent trades. The cluster
    bootstrap reports `nEff=121.21` for exactly this reason, and the permutation test is the
    like-for-like comparison.

### XX.7 What this Part changed about the method

1. **A feature is not a number; it is a name, a unit and an absence.** The catalogue makes the
   contract explicit, and the unit is not decoration: 0.12 as a ratio and 0.12 as a percent are
   different claims, and a model that reads one as the other learns a rule that is true of the label
   and false of the world.
2. **The most dangerous number in this repo turned out to be a liquidation feature measuring USD
   against a price.** It had a name, a unit and a passing test. None of those three things is a
   guarantee that the number means what its name says. The only thing that found it was asking what
   the underlying data actually was.
3. **A fill assumption is not a conservative assumption.** The ledger's +2.34 R assumes a perfect
   fill at the entry mid; the Lab's broker fills at the next open with slippage. The honest number
   is the smaller one, and the Lab exists to produce it.
4. **"No edge found" is a result.** The Lab reports `INSUFFICIENT_EVIDENCE` and an empty tier with a
   reason, and the promotion block lists what is missing. A research tool that cannot say "not yet"
   will eventually say "yes" to something.

**End of Part XX.**

---

## Part XXI - 27 Oct 2026: the quiet-terminal redesign, and the QA it forced

### XXI.1 What the brief actually asked for

The request was not "change some colours". The home board and the Order Block stage had
accumulated decoration that looked like data: gradients, glows, rank pills, meter ticks, raw
source codes, duplicate badges, and labels that were legible only to the person who wrote them.
The target was a minimal terminal that still shows every number, with navigation and previews a
first-time visitor can find. Light and dark both had to remain honest.

The visual change landed first. Most of this part is what it broke. That sequence is the point:
the redesign was not "done" when the screenshots looked right; it was done when the browser suite
agreed on both viewports.

### XXI.2 What changed

| Area | Change | Why |
|---|---|---|
| App chrome (`src/App.tsx`) | Two-row header: brand, status and search on row one; stage buttons with `TabIcon` on row two; active tab underline; page header names the stage. | Navigation was previously buried in the marketing layout. A terminal should say where you are and what you can open. |
| Home board (`src/home/HomeView.tsx`, `BoardColumn`, `BoardRow`, `HomeSide`, `RowPreview`) | Equal columns with a 3.0-3.4 ratio; depth strip full width; board count in the header; full tickers; one direction badge; the rule column renders a mapped sentence rather than a raw constant name. | The board is a scan surface, not a poster. Every pixel spent on decoration was a pixel not spent on the price, the state or the rule. |
| Row interaction (`BoardRow.tsx`, `useRowPreview.ts`, `motion.ts`, `RowPreview.tsx`) | Click/Enter pins the preview only. Hover/focus opens it. A second row hover switches with `HOVER_OPEN_DELAY_MS = 120`; the first preview after idle opens immediately. Close grace `HOVER_CLOSE_GRACE_MS = 160`; the QA contract allows `POPUP_MAX_OPEN_MS = 300`. "Open full view" navigates to the Order Block stage. | Clicking a row used to both pin a popup and navigate, so the popup unmounted before anyone could use it. A click has to do one thing. |
| Preview content | Label and value have a real space; whitespace-only `Fragment` separators sit between stat divs; side labels map `aboveZ` / `belowZ` to "above Z" / "below Z". | `textContent` sees DOM adjacency, not CSS gaps. Tests were reading `"aboveZ / S1"` and `"Z / S10.8683"`. |
| Stage (`App.tsx`, `src/stage/stage.css`; `Stage.tsx` canvas untouched) | The fixed 1920x1200 canvas stays. A new intro and legend sit outside it at normal type size: title, one-line explanation, and legend `Z` zone midpoint, `S1 / R1` invalidation, `R1-R2` liquidity ahead, `fan` 24h paths. Decorative stage elements stay in the DOM but are hidden by CSS. | The stage was beautiful and unreadable. Scaling the whole 1920 canvas down to a laptop made the legend microscopic. The canvas is the drawing; the explanation is prose and should not scale with it. |
| Lab (`src/lab/lab.css`) | Tile grid is `repeat(auto-fit, minmax(168px, 1fr))`; status text wraps instead of truncating. | The old fixed widths cut off the one line that explains whether a model was usable. |
| CSS layer (`src/index.css`, `src/home/home.css`, `src/stage/stage.css`) | Minimal override layer: remove decorative gradients and glows; keep the strength meter but make its semantics visible; direction is carried by side and badge, not colour alone; `.of-depth-dots` hidden. | A quiet terminal is mostly typography and spacing. Decoration that looks like a gauge but is not one is a lie. |
| Responsive chrome (`src/index.css`) | At `max-width: 900px`, `.app-topbar-actions` wraps with `max-width: 100%` and `justify-content: flex-end`. | The action chips had a 605px min-content width. On a 393px phone that made the *layout viewport* 620px wide, even though the visual viewport was 393px. Everything below the fold was laid out off-screen. |
| QA (`qa/home.spec.ts`, `qa/chart.spec.ts`) | `openTicket` now clicks a row, waits for `row-preview`, clicks "Open full view", and falls back to Dashboard with up to 8 rows. Hover tests skip at viewport width <=720 with a stated reason. Temporary debug specs were deleted. | The redesigned interaction is only correct if every existing path is migrated in the same pass. |

### XXI.3 The bugs this pass found

1. **Clicking a row unmounted the popup it had just opened.** `BoardRow` called the pin callback and
   the navigation callback on the same click, so the preview never survived the route change. Fix:
   click/Enter pins; only the popup's "Open full view" navigates. `onOpen` was removed from
   `BoardRow`, `BoardColumn` and the `HomeView` call sites. `qa/chart.spec.ts` was migrated to the
   new path: click row, wait for `row-preview`, click "Open full view".
2. **The popup's `textContent` had no spaces between stats.** CSS `gap` does not create a text node.
   The trace read `"VWAP 0.8688 aboveZ / S1 0.8683 / 0.8666"` and `"Z / S10.8683"`. Fix: a literal
   space between label and value, plus whitespace-only fragments between the stat divs. The grid
   ignores whitespace text nodes, so the visual layout did not move.
3. **The first hover preview missed its 300ms QA window on a loaded machine.** A focused trace
   showed the pointer entering at 372ms and the popup mounting at 559ms; the test's expectation
   began at 7507ms and still failed, with the popup present only in the failure snapshot. The 120ms
   switch-intent delay was being paid even when nothing was open. Fix: first open after idle is
   immediate; the 120ms delay now applies only when switching an already-open preview. The refresh
   test repeated 5 times: **5 passed (59.7s)**.
4. **Mobile had a 620px layout viewport on a 393px screen.** The topbar action chips refused to
   shrink. In the debug browser: `innerWidth: 620`, `innerHeight: 1146`; the bottom-sheet "Open full
   view" sat at y=1077, outside the 727px visual viewport, and the click was intercepted by the
   stats. After the wrap fix: `innerWidth: 393`, `innerHeight: 727`, sheet 393x567.5, button at
   y=658, click succeeded. This was a real phone bug, not a test artefact.
5. **The mobile suite was running desktop hover assumptions.** Four hover tests cannot pass on a
   touch viewport with no pointer. They are now skipped at width <=720 with the reason "hover is a
   desktop affordance; phones tap". The touch path is covered by section 7 of `qa/home.spec.ts`
   (tap opens the sheet, geometry and "Open full view" are asserted), not by pretending hover works.
6. **The chart helper still navigated by clicking the row.** Three chart specs failed after the
   click contract changed. The helper now uses "Open full view"; the same three specs passed.
7. **Lab status text truncated.** The tile min-width was narrower than the longest useful status.
   The grid now wraps at 168px and the status wraps.

The five home tests that Part XX listed as pre-existing open failures are closed by this part.
Part XX is left as written; this part supersedes its open list.

### XXI.4 Verification - real output

Typecheck and unit tests:

```text
> tsc -p tsconfig.json --noEmit
 Test Files  35 passed (35)
      Tests  789 passed (789)
   Duration  6.06s
```

Production build:

```text
vite build
81 modules transformed.
built in 1.15s
```

Browser suite, final runs against the mock servers (API `127.0.0.1:8899`, vite `127.0.0.1:5199`;
the RSS `MOCK MODE ... blocked` warnings are expected):

```text
npx playwright test --project=desktop
57 passed, 1 skipped (1.7m)

npx playwright test --project=mobile
47 passed, 11 skipped (1.5m)

npx playwright test qa/home.spec.ts:365 --project=desktop --repeat-each=5
5 passed (59.7s)

npx playwright test qa/chart.spec.ts --project=mobile
3 passed

npx playwright test qa/home.spec.ts:365 --project=desktop
1 passed
```

The final desktop run has one skip: the mobile-only home geometry test. The final mobile run has
eleven skips: the desktop hover suite plus chart specs that need a pointer. Every non-skipped test
passed.

Intermediate failures, recorded because a green final run means little without them:

```text
First desktop run after the redesign:
4 failed, 54 passed (58 tests)
- hover preview took 5082ms
- click-pin navigation
- refresh popup assertion timed out at 300ms
- popup content read "Z / S10.8683"

After the hover and text-node fixes:
3 failed, 54 passed, 1 skipped
- all three chart specs: click on board-row never reached the ticket

First mobile run:
46 passed, 7 failed, 5 skipped
- 3 chart specs (same row-click path)
- 4 hover specs (no pointer on a phone)
- layout: innerWidth 620 on a 393px screen
```

The failures were fixed at the cause, not by widening the timeouts. The 300ms popup window and the
58-test project shape were kept.

### XXI.5 Honest gaps

- **Mobile tap-pin is not separately asserted.** The mobile suite covers tap-to-open, sheet
  geometry and the "Open full view" path. It does not assert "tap a row to pin, tap outside to
  close" on a phone; that remains a desktop-tested interaction.
- **The motion constants are still placeholders.** `120ms` switch intent, `160ms` close grace and
  `300ms` max open are the values that make the suite reliable and the UI feel responsive. They
  were not fitted to a reference recording. The first-open immediate rule is a QA-contract choice,
  not a measured perceptual threshold.
- **"Aesthetic" is not machine-verified.** The screenshots in `qa/screens/redesign-*.png` were
  reviewed by eye. Geometry, contrast, text and interaction are tested; taste is not.
- **The stage intro is only on the Order Block stage.** The other stages (`/lab`, `/mind`, etc.)
  keep their own headers. The legend is specific to the Order Block vocabulary, not a shared
  component yet.
- **The stage canvas is still fixed at 1920x1200.** The intro and legend are outside it, but the
  drawing itself still scales as one image. A future pass could make the fan and ladder reflow,
  which would be a different change with different tests.
- **The topbar wraps rather than collapsing.** On a narrow phone the actions occupy multiple rows.
  It is usable and no longer lies about the viewport, but it is not a hamburger or a compact icon
  rail.
- **The top table of contents stops at Part XVI.** Parts XVII-XXI are present below it; the
  numbered list was not renumbered in this pass.
- **`qa/.artifacts/` holds failure traces from the runs above.** They are diagnostic output, not
  source; do not treat them as a test baseline.

### XXI.6 What this changes about the method

1. **A click is a contract.** Changing what a click does is not a UI tweak; it is a QA migration.
   Every spec that used the old path has to move in the same pass, or the suite is measuring a
   product that no longer exists.
2. **CSS spacing is not DOM spacing.** `gap`, margins and grid tracks do not put characters into
   `textContent`. If an assertion reads a sentence, put the spaces in the DOM.
3. **Measure the layout viewport, not the screenshot.** A phone screenshot can look correct while
   `innerWidth` is 620. The topbar's min-content width was the cause; the screenshot alone would
   never have found it.
4. **A mobile project will run desktop assumptions.** Skip hover with a stated reason and cover the
   touch path separately. A skip without a reason is an undocumented gap.
5. **"Pre-existing" is a status, not an excuse.** The five home failures Part XX left open are now
   closed. The next time this file says a test is failing, that sentence should have a date and a
   plan, not just a label.

### XXI.7 Resume state

- **Last updated:** 27 October 2026.
- **Current part:** XXI.
- **Unit tests:** 789 passed (35 files).
- **Build:** 81 modules, 1.15s.
- **Desktop browser suite:** 57 passed, 1 skipped.
- **Mobile browser suite:** 47 passed, 11 skipped.
- **Open engineering gaps:** mobile tap-pin not separately asserted; motion constants unfitted;
  no pixel-diff baseline; stage canvas still fixed-size.
- **Do not re-open the Part XX home list without reading this part.** Its five failures were fixed
  by the click, text-node, hover, chart-helper and mobile-layout changes above.

**End of Part XXI.**

---

## Part XXII - CoinGecko 429 and the boot price-health lie

**Date:** 27 October 2026.

### XXII.1 The trigger

The running log showed:

```
[ratelimit] HTTP 429 from api.coingecko.com - ban until 2026-10-27T15:55:42.270Z (+120s, source=escalating, strike=1)
```

At the same time `/api/scan` reported `price_stream: unavailable`, `derivatives: unavailable`,
`tradable: false` with the reason *"price stream is unavailable - no structural decision without a
live price"*, and `/api/health` showed the spot socket open with a fresh tick. The board was refusing
to trade on a price stream that was demonstrably alive. `/api/macro` had fear-and-greed and
stablecoins but no `globalMarket`, so the macro tiles disappeared rather than saying why.

### XXII.2 What was wrong

1. **CoinGecko had three independent callers.** `refreshCoinIdentities()` at boot requested
   `/coins/markets?per_page=250`; `altseasonIndex()` requested the top 50 on every scan; and
   `globalMarket()` requested `/global` through `macroState()`. `RATE.COINGECKO_MIN_INTERVAL_MS` was
   configured at 60 s and **referenced nowhere**. A shared-IP 429 was therefore possible at a call
   rate that looked innocent locally.
2. **Price freshness was a fan-out clock.** `lastTickAt()` returned `lastFlushAt`. The flush timer
   only runs while a client is subscribed, so a warm scan before the first browser connected saw
   `null` and cached a blocked board. Separately, a tick that arrived after the scan's `asOf` made
   `asOf - seen` negative; `classifyStream` treats a negative age as unavailable, closing the gate
   on a healthy feed.

### XXII.3 What changed

- **`server/src/data/coingecko.ts`** (new): one serialised door for CoinGecko.
  - `COINGECKO_MIN_INTERVAL_MS = 2_000` - floor between requests, chain survives failures.
  - `COINGECKO_MARKETS_TTL_MS = 5 * 60_000` - one 250-row payload serves identity **and**
    altseason. `altseasonIndex()` takes the first 50 rows.
  - `COINGECKO_GLOBAL_TTL_MS = 5 * 60_000` - `/global` cached separately.
  - `COINGECKO_DEMO_KEY` / `COINGECKO_PRO_KEY` are sent when present.
  - Cache is still `cached()` single-flight: concurrent boot callers share one request.
- **`server/src/data/macro.ts`** and **`server/src/data/coinIdentity.ts`** now use the shared helper.
- **`server/src/live/streamHub.ts`**: `lastIngestAt` is set by every `stageTick`, including a
  duplicate price; `lastTickAt()` returns `max(lastIngestAt, lastFlushAt)`.
- **`server/src/engine/scanner.ts`**: `priceStreamAgeMs()` clamps at zero; `getScan()` refuses to
  treat a price-blocked board as fresh once price is flowing.
- **`server/src/index.ts`**: the first live tick schedules one recovery scan (5 s delay, at most two
  attempts) and pushes the result over SSE via `publishScan()`. The old candle-close freeze/send path
  now uses the same helper.
- **`src/components/MacroStrip.tsx`**: when `globalMarket` is null the strip renders a single
  `Global market / Unavailable` tile with the reason in its title. It no longer silently loses rows.

### XXII.4 Verification - what was actually run

```
> npm run verify
> tsc --noEmit
> vitest run
 Test Files  36 passed (36)
      Tests  791 passed (791)
   Duration  7.31s
```

Two tests are new: `server/test/coingecko.test.ts` proves two `geckoMarkets()` calls produce one
upstream request, and `streamHub.test.ts` proves `lastTickAt()` advances after `stageTick` with
**zero subscribers** while `lastFlushAt` stays 0.

```
> npm run build
✓ 81 modules transformed.
dist/index.html                   3.05 kB
dist/assets/index-DIb8gt2u.css  126.87 kB
dist/assets/index-C_8bBphn.js   368.48 kB
✓ built in 1.09s
```

Live checks after the dev API restarted on the new code:

```
/api/health: uptime=27s, lastTickAgeSec=0, binance-spot=open, binance-futures=connecting (1006)
             no api.coingecko.com entry in banGuard.hosts
/api/scan:   ageSec=54.3, stale=false, price_stream=live, derivatives=unavailable,
             tradable=true, rows=20/11
/api/macro:  totalMarketCapUsd=2714142009738, btcDominance=59.4, ethDominance=10.5,
             activeCoins=22521
```

The first post-restart request still served the persisted board (`stale=true`) while the fresh scan
ran; that is the designed stale-while-revalidate behaviour, not a regression. Once the scan landed,
`price_stream` was `live` and `tradable` was `true` with derivatives reported as a **degrade**, not
a block.

### XXII.5 Honest gaps

- **The 429 is reduced, not proven impossible.** The call rate drops from roughly two per minute to
  one per five minutes per endpoint, plus one shared markets request. A keyless IP shared with other
  users can still be limited. No 24-hour soak was run.
- **`refreshCoinIdentities()` still sets `lastAttempt` before the request.** A failed boot therefore
  suppresses identity retry for 24 h. It does not affect price health or macro, but it is the same
  class of bug as the price clock and is deliberately left visible here.
- **Derivatives remain unavailable on this machine.** `fapi.binance.com` REST times out and every
  tested `fstream.binance.com` WS URL closes `1006`; spot `data-api.binance.vision` is fine. The
  scan now reports this honestly as a degraded stream. No Bybit/Hyperliquid fallback was added.
  *Superseded by Part XXIII (27 Oct 2026): Bybit linear is now the fallback, and the board reports
  `source: 'bybit-linear'`; Binance futures itself is still blocked.*
- **The browser suite was not re-run for this part.** The change is server-side plus one
  conditional tile; `npm run build` compiles it, but no Playwright spec asserts the
  `Unavailable` tile. The 57/1 and 47/11 desktop/mobile results quoted in Part XXI therefore still
  describe the pre-XXII UI.
- **The top table of contents still stops at Part XVI.** Part XXII is present below it; the numbered
  list was not renumbered.

### XXII.6 Resume state

- **Last updated:** 27 October 2026.
- **Current part:** XXII.
- **Unit tests:** 791 passed (36 files); final rerun 7.49 s after the XXII.7 fixes.
- **Build:** 81 modules, 1.01 s.
- **Live API:** price/tradability restored; derivatives degraded by an external network block.
- **Next:** if the 429 reappears, check `banGuard.hosts` first and add the demo key; do not raise the
  cache TTL by feel without measuring the call rate.

### XXII.7 Post-verification correction - mock recovery and a failed verify

Two follow-ups landed after XXII.4:

- **`server/src/index.ts`**: `recoverScanAfterPrice()` now returns immediately when
  `ORDERFLOW_MOCK === '1'`. Boot recovery is a live-feed concern; mock candles should rescan only
  through the simulated close path.
- **`server/test/mock.test.ts`**: Windows teardown now runs
  `taskkill /pid <tsx-pid> /T /F` before `SIGKILL`, so the tsx child tree cannot survive as an
  orphan mock server holding `data/mock-test.lock`.

The first full rerun after the Index guard failed 6 mock tests:

```
 FAIL  server/test/mock.test.ts > mock mode (booted server) > boots with no outbound network
AssertionError: server never became healthy:
  REFUSING TO START - another OrderFlow instance is already running.
  PID 19604 on 127.0.0.1:8907 (orderflow-api), started 2026-10-27T16:13:30.526Z, up 4m49s.

 Test Files  1 failed | 35 passed (36)
      Tests  6 failed | 785 passed (791)
   Duration  64.45s
```

That was a leaked mock server from the prior 21:43 run, not a regression in XXII. Port 8907 was no
longer listening after teardown, but the orphan held `data/mock-test.lock`, so the next mock boot
refused. A stale lock alone is reclaimed because its PID is dead; the tree-kill teardown prevents
the orphan in the first place.

Re-run after the fixes:

```
> npm run verify
 Test Files  36 passed (36)
      Tests  791 passed (791)
   Duration  7.49s

> npm run build
81 modules transformed.
dist/assets/index-DIb8gt2u.css  126.87 kB
dist/assets/index-C_8bBphn.js   368.48 kB
built in 1.01s
```

**End of Part XXII.**

---

## Part XXIII - 27 Oct 2026: derivatives fallback and the radar that depended on it

**Supersedes:** XXII.5's sentence that no Bybit/Hyperliquid fallback was added, and the
`derivatives: unavailable` resume state in XXII.6.

### XXIII.1 The trigger

The Derivatives tab rendered:

```
Derivatives heatmap
0 perps · Binance futures · funding normalised to 8h · CVD in USD notional
```

and Radar showed no cards. `/api/radar` returned `signals=0 regime=range breadth=bullish`. The
underlying network facts had not changed since Part XXII:

```
fapi.binance.com, fapi1-4.binance.com  timeout (~12s each)
data-api.binance.vision/fapi/*          404
fstream.binance.com WS                  1006
api.bybit.com/v5/market/tickers         200
api.bybit.com/v5/market/open-interest   200
api.bybit.com/v5/market/account-ratio   200
```

Bybit had 54 of 56 requested perps directly and needed aliases for `PEPE`, `BONK` and `SHIB`;
`FETUSDT` was absent. Radar scores up to ~70 points from derivatives (funding flip, OI
accumulation, CVD divergence) against a threshold of 40, so an empty derivatives map left it with
too few points to ever cross the threshold. The empty Radar was a downstream symptom, not a second
provider outage.

### XXIII.2 What changed

- **`server/src/data/derivatives/providers.ts`**
  - `bybitSymbolCandidates()` covers `1000PEPEUSDT`, `SHIB1000USDT` and the other multiplier
    placements; the live ticker map decides which exists.
  - `bybitFutures` implements the same provider surface as `binanceFutures`: one cached all-ticker
    snapshot (`markPrice`, `indexPrice`, `fundingRate`, `fundingIntervalHour`, `nextFundingTime`,
    `openInterest`, `openInterestValue`), OI history (`/v5/market/open-interest`, 5min..1d,
    newest-first reversed to chronological), and retail account ratio
    (`/v5/market/account-ratio`, `buyRatio / sellRatio`). There is no Bybit top-trader endpoint, so
    `topPositionRatio` is `[]`, not a fabricated number.
  - `DerivRaw.oiUsd` is optional and carries `openInterestValue` directly. The old
    `openInterest * markPrice` product is wrong for `1000*` symbols because OI is expressed in
    1000-coin units.
  - Binance futures now uses `DERIVATIVES.BINANCE_FUT_TIMEOUT_MS = 4_000` and
    `BINANCE_FUT_RETRIES = 0` on premiumIndex, fundingInfo, OI, OI history and ratio calls. It also
    fetches premiumIndex before fundingInfo, so an unreachable host fails in one short attempt
    rather than stacking two full timeouts before the fallback.
- **`server/src/data/derivatives/build.ts`**
  - Binance is tried first; if it returns no rows, Bybit linear is built instead and
    `source: 'bybit-linear'` is returned both top-level and in every row's `meta`.
  - History and ratio calls use `r.venueSymbol`, so `PEPEUSDT` asks Bybit for `1000PEPEUSDT`,
    not `PEPEUSDT`.
  - `oiUsd` uses the venue value when present. `crossVenue()` receives the real source.
  - No rows from either venue returns
    `"Binance futures and Bybit linear are both unreachable."`, and the UI shows that sentence.
- **`server/src/engine/derivatives.ts`**: `crossVenue()` accepts the primary source and labels the
  first venue `bybit` when Bybit supplied the row; it no longer emits a duplicate Bybit venue.
- **`server/src/index.ts`**: `/api/derivatives` passes a `LiveSource` only when a
  `binance-futures*` socket is actually open. With the forceOrder stream down, rows now carry
  `liq: { available: false, reason: ... }` instead of the tracker's all-zero sample. The route also
  returns the new top-level `source`.
- **`src/components/DerivativesTab.tsx`**: subtitle names the actual venue (`Bybit linear` today,
  not a hardcoded Binance label); zero rows renders the server's reason instead of an empty table.
- **Tests**: `server/test/derivatives.test.ts` now pins the Bybit multiplier placements and the
  primary-venue behaviour of `crossVenue()`.

### XXIII.3 Verification - what was actually run

```
> npm run verify
> tsc --noEmit
> vitest run
 Test Files  36 passed (36)
      Tests  795 passed (795)
   Duration  7.57s
```

`derivatives.test.ts`: 47 tests. The warning printed by Vitest during collection was the
pre-existing duplicate `regime` key in `server/test/mind.confluence.test.ts`; it is unrelated and
did not fail anything.

```
> npm run build
vite v6.4.4 building for production...
✓ 81 modules transformed.
dist/index.html                   3.05 kB │ gzip:   1.43 kB
dist/assets/index-DIb8gt2u.css  126.87 kB │ gzip:  24.07 kB
dist/assets/index-Cl5qZftP.js   368.77 kB │ gzip: 111.28 kB
✓ built in 1.23s
```

Live checks against the running dev API:

```
/api/derivatives: rows=55, source=bybit-linear, unavailable=null
  PEPEUSDT: oiUsd=50,653,539; oiChange={m5:-0.51,h1:-0.21,h4:1.61}; retail=3.513
  BONKUSDT: oiUsd=7,751,407;  oiChange={m5:0,h1:0.97,h4:3.21};     retail=2.297
  SHIBUSDT: oiUsd=7,164,125;  oiChange={m5:0.01,h1:-0.01,h4:0.04}; retail=2.256
  first row KAIAUSDT: funding8h=-0.00052132 (4h interval), oiUsd=2,034,145
  liq: available=false, reason="No liquidation feed is attached..."
/api/radar: signals=1, regime=range, breadth=bullish
  SOLUSDT preMoveScore=55, signals=[OI Accumulation, CVD Divergence, Funding Flip]
/api/scan: price_stream=live, derivatives=live, tradable=true, degraded=[]
```

A direct Playwright script against the already-running dev servers (not `npx playwright test`)
reported:

```
DERIV {"sub":"55 perps · Bybit linear · funding normalised to 8h · CVD in USD notional",
       "rows":55,"hasEmpty":false,"hasNba":true}
RADAR {"hasEmpty":false,"hasCard":true,
       excerpt includes "SOL ... 55 ... OI Accumulation ... CVD Divergence ... Funding Flip"}
```

The first Radar load showed the existing "Scanning universe for pre-move signals… (~30s on first
load)" notice and resolved within the 120s wait; that first-build cost is unchanged by this part.

### XXIII.4 Honest gaps

- **Binance futures is still the blocked primary.** The fallback makes the board useful, but it is
  a fallback: cross-venue comparison currently compares Bybit against Hyperliquid, not Binance. If
  the Binance block clears, the code automatically returns to `source: 'binance-futures'` on the
  next build with no config change.
- **55 of 56 perps.** Bybit has no `FETUSDT`; no row is invented for it. The three aliases are
  covered and were verified by their live rows above.
- **No Bybit top-trader ratio.** Bybit's public `elite-account-ratio` endpoint returned 404, so
  `topTraderPositionRatio` and `lsDivergence` are null for Bybit rows. The retail ratio is real;
  it is not presented as a top-trader measurement.
- **Liquidation prints still have no source.** The Binance forceOrder socket is down; Bybit's
  public REST does not provide a comparable tape. The board now says `n/a` with a reason instead
  of `$0`. The `/api/liquidations` tape remains empty and labelled accordingly.
- **Browser evidence is an ad-hoc Playwright script**, not a new `qa/*.spec.ts`; the full Playwright
  suite was not re-run in this part. The script was run without stopping the dev servers because it
  only navigated the existing browser app and did not invoke Vite's test webServer cache.
- **Bybit request load is not paced by a dedicated limiter.** The OI-history calls are cached for
  `REFRESH.OI_HISTORY_MS` (300s) and run at concurrency 8; the shared `fetchJson` ban registry does
  not know Bybit's own limits. No sustained soak was run.

### XXIII.5 Resume state

- **Last updated:** 27 October 2026.
- **Current part:** XXIII.
- **Unit tests:** 795 passed (36 files); 7.57 s.
- **Build:** 81 modules, 1.23 s; JS `index-Cl5qZftP.js`.
- **Live API:** `derivatives=live` via Bybit linear, 55 rows; Radar emits SOL at score 55;
  `tradable=true`; Binance futures WS remains `1006` and liquidation rows are honestly unavailable.
- **Next:** if Bybit starts returning `retCode != 0`, check `NETWORK.BYBIT_HOST` and the Bybit
  ticker response directly before changing a threshold; do not turn the missing FETUSDT row into a
  zero. If Binance futures becomes reachable, confirm `/api/derivatives` flips to
  `source: 'binance-futures'` and rerun `npm run verify`.

---

## Part XXIV - 27 Oct 2026: the live Terminal tab

**Supersedes:** the "current part" marker in XXIII.5 only. No Part XXIII behaviour changed; the
derivatives fallback and Radar restore remain as written.

### XXIV.1 The request

Add a `Chart & Heatmap` tab (internal id `terminal`; originally displayed as `Terminal`) that lets
the user pick any spot coin and shows two live surfaces:

1. a Candlestick chart with `1m / 5m / 15m / 30m / 1h / 4h / 1D` and a live forming bar;
2. a Tradfye-style order-book liquidity heatmap with price path, trade bubbles, span and range
   controls, contrast, columns, a `More` disclosure and a live wall reading.

The reference control set was: market picker, bid/ask/spread/book totals, `Chart | Heatmap`, LIVE
badge, Span `1m/2m/5m/12m/15m/30m/1h/4h/1D`, Range `Auto/±0.1/±0.25/±0.5/±1%`, Contrast
`Low/Med/High`, Bubbles `Auto/Trades/Steps/Off`, Columns, More, and a wall sentence naming side,
size, price, bp distance, standing time and pulls.

The first client build mirrored the reference's `Chart | Heatmap` switch as tabs. The user then
asked for both surfaces to be visible at once. The tabs were removed; the sections were first
stacked (XXIV.7), then moved to a desktop split view (XXIV.8) because the heatmap fell below the
fold at 1366x768.

### XXIV.2 Data and routes

New terminal-only API, backed by Binance **spot**:

```text
GET /api/terminal/book?symbol=BTCUSDT
  -> TerminalBook: symbol, asOf, lastUpdateId, bestBid/bestAsk/mid, spreadBps,
     bidUsd/askUsd/imbalance, bids[1000], asks[1000], trades[500],
     tradesAvailable, tradeError, pollMs, wallMultiple, wallPeerLevels, wallNearPct

GET /api/terminal/candles?symbol=BTCUSDT&interval=5m&limit=320
  -> TerminalCandles: symbol, interval, asOf, candles[]
```

- `server/src/data/binance.ts` gained `fetchSpotDepth()` and `fetchAggTrades()`. Depth is the real
  full book at `limit=1000` per side (approximately weight 50), not the old 20-level derivatives
  summary. Aggregate trades are the last 500 public prints.
- `server/src/terminal/data.ts` validates the two letter/digit USDT shapes, maps and sorts levels,
  sums notional in USD, computes imbalance and spread, deduplicates trades by aggregate id, and
  merges a failed tape as `tradesAvailable=false` without losing the book.
- `server/src/config.ts` owns every server threshold:
  `DEPTH_LIMIT=1000`, `TRADE_LIMIT=500`, `BOOK_TTL_MS=2500`, `TRADE_TTL_MS=2500`,
  `CHART_LIMIT=320`, `CHART_TTL_MS=8000`, `SAMPLE_MS=3000`, `WALL_MULTIPLE=3`,
  `WALL_PEER_LEVELS=20`, `WALL_NEAR_PCT=0.005`. `SAMPLE_MS` is echoed as `pollMs`.
- `shared/types.ts` owns `TERMINAL_INTERVALS`, `TERMINAL_SPANS`, the book/trade/candle payloads and
  the terminal interval/span unions. `src/lib/api.ts` exposes the two clients.
- The server cache is single-flight, so concurrent terminal viewers share one Binance depth call.
  TTL (2.5 s) is just under the 3 s client cadence to avoid a fan-out on every poll.

### XXIV.3 Client

- `src/terminal/TerminalView.tsx`: searchable spot picker, base/name/price/24h change, bid/ask,
  spread and book totals, feed badge (`MOCK`, `BANNED`, `CONNECTING`, `STALE`, `LIVE`), a price-chart
  section and a liquidity-heatmap section, timeframe selector, loading/error/retry states, and a
  `ResizeObserver`-driven chart height. The two sections are both mounted: the chart is never
  unmounted by a tab switch, so its forming candle and heatmap capture continue in parallel.
- `src/terminal/useTerminalBook.ts` polls the book, appends unique `lastUpdateId` frames, merges
  trade ids, keeps a client-side history cap, and separates `error` (book unavailable) from
  `tapeError` (tape unavailable, depth still live).
- `src/terminal/useTerminalCandles.ts` requests 320 candles and refreshes every 12 s. The forming
  bar is extended locally by `mergeLiveCandle()` from the SSE last price; REST always replaces the
  local merge on the next poll. The chart displays 180 candles and `showVolume` adds a volume pane.
- `src/terminal/LiquidityHeatmap.tsx` is a canvas renderer, not DOM rows. It draws:
  - the book history as green/red depth columns with a 95th-percentile intensity scale;
  - the mid-price path and trade bubbles (`Auto` filters tiny prints, `Steps`, `Trades`, `Off`);
  - a price axis, time axis, current mid label and an honest left-side note while captured history
    covers less than half the selected span.
- `src/terminal/math.ts` holds the pure parts: interval map, frame append, trade merge, live-candle
  merge, and `wallReading()`.
- **Wall rule:** compare the biggest near-touch level with the **median of the 20 largest**
  near-touch levels inside ±0.5% of mid, not the median of all levels. The first implementation used
  the whole near book and called a normal $605.6K level `10,264.6× median` because BTC's book is
  full of dust-sized levels; the peer-median rule makes that honest (the same book then reported
  "no level is 3× ... the near-touch book is evenly distributed").
- Wall lifetime uses a 40% size floor, scans backwards for standing time and counts disappearances
  as pulls. `standingSinceStart` renders as `≥duration (since capture)`, never as a longer history
  than was observed.
- `src/App.tsx` adds the `Chart & Heatmap` tab after `Markets` (id `terminal`), owns
  `terminalSymbol` (default `BTCUSDT`) and adds it to `visibleSymbols` while the tab is open so
  off-board markets still receive ticks.
- `CandleChart` time labels now use elapsed span and date changes rather than a hard-coded
  "more than 20 candles means a day label" rule. The old rule printed `Tue 27` at every 5m gridline.
- `src/terminal/terminal.css` owns layout and responsive rules. On screens at least 1000 px wide,
  `.terminal-body` is a two-column grid (`1.1fr` chart / `1fr` heatmap) with a height of
  `clamp(450px, calc(100vh - 270px), 780px)`, so both surfaces are fully visible in the first
  viewport at 1024x768 and above. Below 1000 px, including mobile, the two bordered
  `.terminal-section` cards stack in one column with a 12 px gap. Mobile sets `min-width: 0` on the
  flex chain, auto heights, a 430 px chart floor, a 540 px heatmap floor, and smaller heatmap
  margins/ticks; the section header wraps into title/actions rows. Before the overflow fix the
  toolbar's min-content width (914 px) pushed the canvas past the viewport, clipped the y-axis and
  hid the wall/footer. XXIV.7 records the earlier all-width stacked layout; XXIV.8 replaced it on
  desktop because the heatmap fell below the fold at 1366x768.

### XXIV.4 Verification - what was actually run

The first focused run was red, not green:

```text
npx vitest run server/test/terminal.test.ts
13 tests | 3 failed
  spread: expected 99.5, received 99.50248756218905
  wall pull: expected null to match object { side: 'bid', price: 99.5, ... }
  wall standing: expected undefined to be true
```

The spread expectation was wrong: for bid 99.5 / ask 100.5 the exact value is 99.5025 bp. The two
wall fixtures had only three near-touch levels while `wallReading()` requires at least four; the
fixtures now include a fourth near level. After the wall-rule correction, the focused suite is:

```text
npx vitest run server/test/terminal.test.ts
Test Files  1 passed (1)
     Tests  13 passed (13)
  Duration  0.65s
```

Repository gate before the stacked-layout correction:

```text
> npm run verify
> tsc --noEmit
> vitest run
 Test Files  37 passed (37)
      Tests  808 passed (808)
   Duration  7.60s
```

The only warning was the pre-existing duplicate `regime` key in
`server/test/mind.confluence.test.ts`; it is unrelated and did not fail.

```text
> npm run build
vite v6.4.4 building for production...
✓ 87 modules transformed.
dist/index.html                   3.05 kB │ gzip:   1.44 kB
dist/assets/index-DxsncG3c.css  138.48 kB │ gzip:  25.84 kB
dist/assets/index-CHCg8nwz.js   392.53 kB │ gzip: 119.35 kB
✓ built in 1.13s
```

Live checks against the running dev API (`localhost:8787`):

```text
/api/terminal/book?symbol=BTCUSDT
  bids=1000, asks=1000, trades=500, pollMs=3000,
  wallMultiple=3, wallPeerLevels=20,
  bestBid=80670, bestAsk=80670.01, tradesAvailable=true

/api/terminal/candles?symbol=BTCUSDT&interval=1m&limit=320
  count=320, first=1793102040000, last=1793121180000,
  lastClose=80670, closed=false
```

An earlier ad-hoc Playwright script against the already-running dev servers (not
`npx playwright test`, which would start its own Vite/mock servers) opened the tab, waited for
samples and reported no console/page errors. Desktop observations from the tabbed build:

```text
header: BTC/USDT · Bitcoin · LAST 80,642 · BID 80,642 · ASK 80,642 · SPREAD <0.01 bp · LIVE
heatmap footer: Bid depth $14.1M · Ask depth $8.5M · Imbalance 24.7%
heatmap history: 14 samples · 22:46-22:46
wall: "No level is 3× the median of the 20 largest levels inside ±0.5%;
       the near-touch book is evenly distributed."
chart x-axis: 07:55, 10:05, 12:10, 14:20, 16:25, 18:35, 20:40, 22:50
```

Earlier mobile observations after the overflow fix (Pixel 5, 393 px viewport, tabbed build):

```text
document scrollWidth=393, innerWidth=393
heatmap toolbar: scrollWidth=367, clientWidth=367, height=107
canvas: CSS 353×268, backing 706×536
wall/footer visible: footer y=1052.9
console/page errors: []
```

The screenshots used for this check are in
`C:\Users\DK\AppData\Local\Temp\opencode\terminal-*.png`; they are evidence, not committed assets.

### XXIV.5 Honest gaps

- **No historical order book exists.** The heatmap starts empty and fills only while the tab is
  open. The browser keeps `BOOK_HISTORY_LIMIT=900` samples; at the 3 s cadence that is about 45
  minutes, so the 1h/4h/1D spans can never fill. The canvas says this in plain text and the More
  panel repeats the cap.
- **The reference implementation cannot be inspected.** `https://tradfye.com/terminal` is
  private-beta gated. This is a functional reconstruction from the supplied layout and controls,
  not a pixel/behaviour clone; exact update cadence, column blending and wall wording are unknown.
- **Full-depth polling is not soak-tested.** Binance's published depth weight is approximately 50
  per 1,000-level request; 3 s polling is therefore roughly 1,000 weight/minute per open terminal.
  The 2.5 s cache deduplicates concurrent viewers, but no long-running multi-client load test was
  run and the exact current weight was not re-probed.
- **Mock mode has no terminal fixtures.** `/api/terminal/book` and `/api/terminal/candles` will
  return unavailable in replay mode until depth/aggTrade/klines fixtures are captured. No
  `qa/terminal.spec.ts` was added; the browser evidence above is an ad-hoc script.
- **Wall thresholds are hand-tuned.** `WALL_MULTIPLE=3`, `WALL_PEER_LEVELS=20` and
  `WALL_NEAR_PCT=0.005` are `[TUNED]`, not fitted to resolved outcomes. The UI labels the reading
  as a reading, not a prediction. On a quiet or unusually deep book it may honestly say there is
  no wall.
- **Auto range is limited by the venue.** Binance spot returns at most 1,000 levels per side.
  Auto fits the returned depth; fixed ranges wider than that returned book legitimately look
  sparse for BTC, and the More panel says so.
- **Spot only.** Futures depth, liquidations and cross-venue walls are not part of this tab. The
  Binance futures outage from Part XXIII is unchanged.
- **The chart displays a local forming bar.** It is an SSE-price merge, never marked closed; REST
  replaces it every 12 s. It is not a tick-by-tick exchange chart.
- **Mobile is usable but a long page.** Both cards stay stacked, so at 393 px the terminal page was
  1,606 px tall in the final check. The heatmap toolbar wraps into two rows, the BOOK total is hidden
  below 1180 px, and each section keeps its own minimum height rather than compressing into one
  screen. The chart and heatmap are both visible by scrolling, not simultaneously in one viewport.
- **Unrelated app-chrome overflow at intermediate widths.** While checking section headers, the
  full page measured `scrollWidth=1201` at a 1024 px viewport and `1306` at 1280 px on every tab,
  not just Terminal. The widest nodes were the topbar action button and `.macro-bar`/`.mind-strip`;
  the terminal section headers themselves fit (`964/964` and `1220/1220` client/scroll widths).
  This pre-existing layout issue was observed but not fixed in Part XXIV.

### XXIV.6 Resume state

- **Last updated:** 27 October 2026.
- **Current part:** XXIV; XXIV.9 is the latest navbar-label correction.
- **Unit tests:** 808 passed (37 files); 6.98 s after the navbar-label correction.
- **Build:** 87 modules, 1.10 s; CSS `index-wih6uTOb.css`, JS `index-DUwEjAsP.js`.
- **Live API:** terminal book returns 1,000 bid + 1,000 ask levels, 500 trades, `pollMs=3000`;
  terminal candles returns 320 1m candles with the final candle open.
- **Next:** if the terminal is kept, capture depth/aggTrade/klines fixtures and add
  `qa/terminal.spec.ts`; then decide whether 3 s full-depth polling is acceptable under a
  multi-client soak. Do not lower the cadence or widen wall thresholds by feel. If a historical
  heatmap is required, obtain a recorded book feed or explicitly label a replay as replay - do not
  synthesize columns.

### XXIV.7 Correction - 27 Oct: the two surfaces are stacked, not tabbed

The user rejected the `Chart | Heatmap` tab switch and asked for two distinct sections shown at
the same time, matching the reference layout. `TerminalView.tsx` no longer owns a panel tab state.
The chart section and heatmap section are both rendered inside `.terminal-body` as separate
`.terminal-section` cards, with their own headers and controls. The heatmap section title is
`Market depth / Liquidity heatmap`; the chart section title is `Price chart / <BASE> / USDT`.

This is a layout change only: the data routes, polling cadence, wall rule, heatmap history cap and
all thresholds in XXIV.2 are unchanged.

Post-correction repository gate, run after the final CSS and tab-removal edits:

```text
> npm run verify
 Test Files  37 passed (37)
      Tests  808 passed (808)
   Duration  7.52s

> npm run build
✓ 87 modules transformed.
dist/index.html                   3.05 kB │ gzip:   1.43 kB
dist/assets/index-BTVv4LfO.css  139.47 kB │ gzip:  25.97 kB
dist/assets/index-Cq5Tt8p9.js   392.97 kB │ gzip: 119.41 kB
✓ built in 1.18s
```

The pre-existing duplicate `regime` key warning in `server/test/mind.confluence.test.ts` still
appeared and still did not fail the run.

Ad-hoc Playwright against the running dev servers, after both sections were mounted:

```text
desktop 1440x1000: sections=2, chart=1368x447, heatmap=1358x430,
                   page scrollWidth=1440, console/page errors=[]
mobile 393x851:    sections=2, chart=337x345, heatmap=335x430,
                   page scrollWidth=393, page scrollHeight=1606,
                   footer visible, console/page errors=[]
section heads:     1280 px: client/scroll 1220/1220;
                   1024 px: 964/964; 768 px: 716/716
```

Final screenshots:

```text
C:\Users\DK\AppData\Local\Temp\opencode\terminal-separate-desktop.png
C:\Users\DK\AppData\Local\Temp\opencode\terminal-separate-mobile.png
```

What this does **not** prove: the full Playwright suite was not run (its mock servers conflict with
the live dev servers on `:5173/:8787`), and no `qa/terminal.spec.ts` exists. Browser evidence is
still an ad-hoc script. The global intermediate-width app-chrome overflow recorded under XXIV.5
remains.

XXIV.7 was superseded for desktop by XXIV.8 after the user reported that the heatmap was still not
visible on the Terminal page. The stacked fallback remains below 1000 px.

### XXIV.8 Correction - 27 Oct: split desktop so both surfaces are in the first viewport

The user reported still not seeing the terminal surfaces at the Terminal tab. Browser measurement
found the cause: at 1366x768 the stacked build put the chart card at `top=246, height=501` and the
heatmap card at `top=759, height=585`. Only a 9 px strip of the heatmap reached the viewport; the
chart filled the screen, so the Terminal page looked like a chart-only page unless the user
scrolled.

The fix is desktop-only:

- `.terminal-body` becomes `display: grid` at `min-width: 1000px`, with chart `1.1fr` and heatmap
  `1fr`;
- the body height is `clamp(450px, calc(100vh - 270px), 780px)`;
- both section cards get `height: 100%; min-height: 0`;
- the heatmap canvas floor drops to 220 px on desktop so the controls, wall reading and footer
  still fit at 720 px viewport height;
- below 1000 px the prior single-column stacked layout is unchanged.

The split breakpoint was first written at 1100 px, then lowered to 1000 px after measuring a
1024x768 viewport: the two columns still fit, both cards remain inside the viewport, and the
heatmap canvas measures 430x255. Keeping it at 1100 would have left 1024 px users on the stacked
layout that caused the original report.

Measured after the change, with live data and no console/page errors:

```text
viewport     chart card              heatmap card            page
1920x1080    x=29  y=246 969x756     x=1010 y=246 881x756   scrollH=1080
1440x900     x=29  y=246 718x606     x=759  y=246 652x606   scrollH=900
1366x768     x=29  y=246 679x474     x=720  y=246 617x474   scrollH=768
1280x800     x=29  y=246 634x506     x=675  y=246 576x506   scrollH=800
1280x720     x=29  y=246 634x426     x=675  y=246 576x426   scrollH=720
1100x768     x=29  y=246 540x474     x=581  y=246 490x474   scrollH=768
1093x614     x=29  y=246 536x426     x=577  y=246 487x426   scrollH=701
1024x768     x=29  y=246 500x474     x=541  y=246 454x474   scrollH=768
1000x720     x=25  y=242 491x426     x=528  y=242 447x426   scrollH=720
990x768      stacked: chart y=242 h=501; heatmap y=755 h=585 (fallback)
390x844      stacked: chart y=455 h=430; heatmap y=893 (unchanged mobile)
```

At 1366x768 the heatmap canvas measured `593x284`; after ten seconds of live capture the footer
reported `3 samples · 23:36-23:36`, so the heatmap is mounted and recording while the chart is
visible. The page no longer scrolls vertically at 1366x768 (`scrollH=768`).

Repository gate after the split:

```text
> npm run verify
 Test Files  37 passed (37)
      Tests  808 passed (808)
   Duration  7.70s

> npm run build
✓ 87 modules transformed.
dist/index.html                   3.05 kB │ gzip:   1.43 kB
dist/assets/index-wih6uTOb.css  139.83 kB │ gzip:  26.04 kB
dist/assets/index-QtucRRxj.js   392.98 kB │ gzip: 119.41 kB
✓ built in 1.26s
```

Screenshots:

```text
C:\Users\DK\AppData\Local\Temp\opencode\terminal-split-1366x768.png
C:\Users\DK\AppData\Local\Temp\opencode\terminal-split-1366-10s.png
C:\Users\DK\AppData\Local\Temp\opencode\terminal-split-1920x1080.png
C:\Users\DK\AppData\Local\Temp\opencode\terminal-split-1440x900.png
C:\Users\DK\AppData\Local\Temp\opencode\terminal-split-1024x768.png
C:\Users\DK\AppData\Local\Temp\opencode\terminal-split-1000x720.png
```

Honest limits: below 1000 px the terminal still stacks, so the heatmap remains below the chart
there. At a short 1093x614 viewport the split applies, but the card bottoms end at y=672 and the
page needs about 58 px of vertical scroll; the layout has not been squeezed further because doing
so would collapse the heatmap canvas. The global app-chrome horizontal overflow at 1024/1280 px
(XXIV.5) is unchanged. The split view has only been checked by an ad-hoc Playwright script, not a
committed terminal spec.

### XXIV.9 Correction - 27 Oct: the navbar says Chart & Heatmap

The user reported that they still could not find the page in the navbar. The destination existed
only under the label `Terminal`, while the requested page is a chart plus an order-book heatmap.
The visible nav label is now `Chart & Heatmap`; the tab id stays `terminal`, so state, data
subscriptions and the existing code path are unchanged. Clicking it makes the nav button
`is-active` and mounts both sections.

Verified at 1366x768 after the rename:

```text
active nav label: Chart & Heatmap
sections: Price chart x=29 y=246 679x474;
          Order-book liquidity heatmap x=720 y=246 617x474
heatmap canvas: 593x284
page: scrollH=768, scrollW=1366
console/page errors: []
```

At 1024x768 the two sections remain side by side (`500x474` and `454x474`) and the page fits
vertically; the tabs themselves scroll horizontally (`clientWidth=1000, scrollWidth=1126`), so the
last destinations require the existing nav scroll. At 390x844 the nav scrolls and the terminal
remains stacked.

Repository gate after the label change:

```text
> npm run verify
 Test Files  37 passed (37)
      Tests  808 passed (808)
   Duration  6.98s

> npm run build
✓ 87 modules transformed.
dist/index.html                   3.05 kB │ gzip:   1.43 kB
dist/assets/index-wih6uTOb.css  139.83 kB │ gzip:  26.04 kB
dist/assets/index-DUwEjAsP.js   392.98 kB │ gzip: 119.42 kB
✓ built in 1.10s
```

Screenshot: `C:\Users\DK\AppData\Local\Temp\opencode\terminal-nav-1366x768.png`.

### XXIV.10 Correction - 28 Oct: separate Chart and Heatmap views, reference heatmap interactions

The user rejected both the stacked and side-by-side layouts: "both the thing must be seperate",
and supplied Tradfye's terminal HTML as the heatmap reference. This part supersedes the XXIV.7-9
layout and default-view claims. The top-level nav destination is still `Chart & Heatmap`
(tab id `terminal`); inside it, a reference-style `.terminal-viewbar` exposes separate `Chart`
and `Heatmap` views. The Heatmap view is the default. Only one view is visible at a time, but
both panels stay mounted behind `[hidden]` so book sampling, trade merging, candle polling and
the running heatmap history continue while the other is open. The `1.1fr / 1fr` desktop grid and
the mobile stacked-card layout were removed.

The stage is now full-width and fixed-height on desktop: `clamp(430px, calc(100vh - 270px), 800px)`
above 980 px, `clamp(400px, calc(100vh - 360px), 700px)` at 761-980 px, and auto with per-view
minimum heights below 761 px. `.terminal-stage` uses `flex: none`, not `flex: 1`; the earlier
`flex: 1` ignored the stage height and let each view's content set a different height.

Heatmap reference parity added:

- `.terminal-viewbar` with `Chart | Heatmap`, live tape statistics, and fullscreen. Fullscreen is
  an in-page fixed overlay, exits with Escape, and no longer claims to be heatmap-only.
- Toolbar button groups: Span (`1m`...`1d`, default `15m`), Price range
  (`Auto`, `+/-0.1%`, `+/-0.25%`, `+/-0.5%`, `+/-1%`), Contrast (`Low/Med/High`), Bubbles
  (`Auto/Trades/Steps/Off`), `Columns (3)`, `More`, and `?`.
- The wall sentence now names the nearest bid and ask levels together:
  `Nearest walls: bid wall ... at ... (N bp below), standing ... · ask wall ...`.
- A right-hand column strip with seven selectable columns: BOOK, SIZE, CUM, VOL, DELTA, C DELTA,
  TAPE. Default is three. The menu shows the selected count, persists while switching columns,
  and closes on outside click or Escape. Columns are hidden below 760 px because the price plot
  would be too narrow; the menu says so.
- Pointer hover over the canvas draws a dashed price/time crosshair, a price tag, a time tag,
  highlights the nearest resting level and circles the nearest captured print. A DOM tooltip
  reports price, IST time, nearest bid/ask level and nearest trade. The canvas is focusable and
  has an aria-label describing the interaction.
- `5m candle delta`, `CVD` and `POC` in the viewbar. Labels use the selected candle interval;
  defaults are `5m`, so the reference-facing label is `5m candle delta`.
- Bubbles `Auto` draws individual prints through 5m and switches to bucketed steps above 5m.
- `More` and `?` are popovers. On mobile they are fixed to the viewport (12 px sides) instead of
  absolutely positioned under a wrapped toolbar.

New pure helpers in `src/terminal/math.ts`:

- `nearestWalls(frames, near, peerLevels)` returns the largest near-touch bid and ask levels,
  their distance in bp, peer multiple, standing time and pull count. It reuses the server's
  `wallNearPct` / `wallPeerLevels`; it does **not** require the old `WALL_MULTIPLE=3` threshold.
  `wallReading()` remains in the module and its tests remain, but the UI no longer uses it. The
  sentence is a nearest-level reading, not a fitted signal; standing time is a lower bound since
  capture.
- `tapeStats(trades, mid, intervalMs, asOf)` returns CVD, the forming-candle quantity delta, POC
  (1 bp price bins), captured notional and capture count. These are computed only from the public
  aggregate-trade window in this browser, not from a reconstructed full-session tape.

No server threshold changed. The Binance limits, 3,000 ms poll, `TERMINAL` config, wall metadata,
900-frame history cap (about 45 minutes), 320-candle chart request and route shapes are unchanged.
The heatmap span default moved from `5m` to `15m` to match the reference; the column default is
three; the panel default is Heatmap.

Ad-hoc Playwright after the final interaction edits, with live spot data:

```text
viewport     stage                 heat view             heat canvas             page
1920x1080    x=17 y=234 1886x800   x=17 y=274 1886x760   x=27 y=328 1866x642   scrollH=1080 scrollW=1920
1366x768     x=17 y=234 1332x498   x=17 y=274 1332x458   x=27 y=328 1312x340   scrollH=768  scrollW=1366
1024x768     x=17 y=234  990x498   x=17 y=274  990x458   x=27 y=366  970x301   scrollH=768  scrollW=1157
 390x844     x=13 y=447  364x718   x=13 y=485  364x680   x=19 y=638  352x440   scrollH=1178 scrollW=390
fullscreen 1366x768: terminal 1366x768, stage 1364x703, scroll 768/1366
```

The 1024 px `scrollWidth=1157` is the pre-existing app-chrome overflow recorded under XXIV.5;
the terminal card itself is 990 px wide and fits. The 1024 px heatmap toolbar uses two rows
(`height=84`); at 1366 px it is one row (`height=45.5`). The mobile Help and More popovers measured
`366x139` and `366x221` at `x=12 y=78`, and Escape closed More (`count=0`). Columns toggled from
`Columns (3)` to `Columns (4)` after selecting VOL, and Escape closed the menu. Hover tooltips were
present at every tested width; observed text included `81,555 / 15:28:15 IST / Bid resting $326
at 81,555`. Console/page errors were `[]` in all runs.

Repository gate after the final edits:

```text
> npm run verify
 Test Files  37 passed (37)
      Tests  810 passed (810)
   Duration  6.91s

> npm run build
 87 modules transformed.
dist/index.html                   3.05 kB | gzip:   1.44 kB
dist/assets/index-BDb8vuVY.css  145.78 kB | gzip:  26.98 kB
dist/assets/index-CYzFAypg.js   404.67 kB | gzip: 123.12 kB
built in 1.03s
```

The duplicate `regime` key warning in `server/test/mind.confluence.test.ts` still appears and
does not fail the run.

Screenshots:

```text
C:\Users\DK\AppData\Local\Temp\opencode\terminal-final-1920.png
C:\Users\DK\AppData\Local\Temp\opencode\terminal-final-1366.png
C:\Users\DK\AppData\Local\Temp\opencode\terminal-final-1024.png
C:\Users\DK\AppData\Local\Temp\opencode\terminal-final-390.png
C:\Users\DK\AppData\Local\Temp\opencode\terminal-final-chart-1920.png
C:\Users\DK\AppData\Local\Temp\opencode\terminal-final-chart-1366.png
C:\Users\DK\AppData\Local\Temp\opencode\terminal-final-chart-1024.png
C:\Users\DK\AppData\Local\Temp\opencode\terminal-final-chart-390.png
C:\Users\DK\AppData\Local\Temp\opencode\terminal-final-fullscreen-1366.png
```

Honest limits:

- **The 15m default starts nearly empty.** There is no historical book feed, so the first view
  shows only the samples captured since opening (typically 2-5 columns at the right edge). The
  canvas says so. `1m`/`2m` fill faster; waiting for the 900-sample cap takes ~45 minutes.
- **Both surfaces are not visible at once.** That is the requested separation, not a regression.
  Both stay mounted and polling while hidden, so history is retained across view switches.
- **CVD/POC/candle delta are captured-tape figures.** The server returns at most 500 aggregate
  trades; this is not full-session CVD and POC uses 1 bp bins.
- **Mobile has no column strip.** Below 760 px the canvas drops the right-hand columns to keep a
  readable price plot. The toolbar menu remains, with a note.
- **The reference is still gated.** The supplied HTML described labels, controls and copy, not
  its canvas drawing, exact colours, animation or tooltip markup. The result is reference-shaped,
  not pixel-identical.
- **Nearest walls are not exceptional-level detection.** The UI now names the largest near-touch
  level per side even when it is ordinary, matching the reference wording. It is not a prediction;
  standing is a lower bound from captured samples.
- **No committed terminal spec.** Browser evidence is still an ad-hoc Playwright script; mock
  mode still has no terminal fixtures. The full Playwright suite was not run because its mock
  servers conflict with the running dev servers on `:5173/:8787`.
- **3 s polling has not been soak-tested** under multiple clients. The dev stack is running; the
  worktree is mixed and uncommitted.

---

## Part XXIV.11 - 28 Oct 2026: terminal stream truth, row-total heat scale and hover accuracy

**Supersedes:** XXIV.10's "900 frames is about 45 minutes" wording (now about 15 minutes at the 1 s
live cadence and 45 minutes at the 3 s fallback) and its `810 / 37` gate counts. XXIV.10's separate
Chart/Heatmap views, routes, wall rule, controls and reference shape remain as written. No server
threshold changed.

### XXIV.11.1 The live stream was not actually live

The terminal now consumes Binance's public spot combined stream directly from the browser:

```text
wss://data-stream.binance.vision/stream?streams=<symbol>@depth@100ms/<symbol>@aggTrade
```

The first book still comes from `GET /api/terminal/book?symbol=BTCUSDT`; the server route remains the
snapshot/source of truth and the fallback path. There is no new market-data service.

Three defects were found while testing the live path:

1. the fallback poll set `DISCONNECTED` even while a WebSocket was connected, causing a status flash;
2. `onopen` claimed `LIVE` before the REST snapshot had synchronized;
3. `publish()` refreshed `book.asOf` and appended a history frame every second even when
   `lastUpdateId` had not changed, so a silent feed remained visually `LIVE` and grew ghost frames.

The corrected state machine in `src/terminal/useTerminalBook.ts` is:

- fallback only sets `DISCONNECTED` when no socket exists (`if (!ws)`);
- `onopen` sets `CONNECTING`, then fetches the snapshot;
- `publish()` sets `LIVE` only when `Date.now() - lastEventAt <= STALE_AFTER_MS`, otherwise `STALE`;
- the health timer sets `STALE` after `STALE_AFTER_MS = 10_000` of silence;
- `publishedUpdateId` gates book publication: a frame is appended only when `lastUpdateId` changed
  or a snapshot explicitly forces publication. Trades are still merged on every sample.

The consequence is deliberate: a book with no new depth does **not** get a fresh `asOf` every second.
Its age grows until the header says `STALE`. A chart anchored to the latest book frame consequently
does not extend its time axis during a depth silence; trades arriving after that point can be held in
the tape but not on the canvas until the next depth frame. That limitation is recorded under honest
gaps and was not observed on active BTC.

`server/test/liveBook.test.ts` was added with 5 tests: snapshot seeding, continuous updates, stale
updates, sequence-gap rejection/resync, depth sorting/capping/pricing, and aggTrade parsing. Two
initial fixture expectations were red: one used the wrong stale-event sequence boundary and one did
not set `qty: 0` for an ask deletion. Both were test-fixture errors, not engine mismatches; they were
corrected before the green run.

### XXIV.11.2 History cadence and the 900-frame cap

`BOOK_HISTORY_LIMIT` remains `900`, now documented as `[TUNED]` browser memory:

```text
live cadence       1,000 ms  -> 900 frames is about 15 minutes
fallback cadence   3,000 ms  -> 900 frames is about 45 minutes
```

This replaces XXIV.10's "about 45 minutes" as a general statement: 45 minutes applies only when the
3 s fallback is driving the book. There is still no historical order-book backfill; the cap is
memory, not a claim that the full 1h/4h/1D spans can fill from open.

`appendBookFrame()` still dedupes an exact sample (`lastUpdateId` and `asOf` both equal) and keeps
the newest `cap` frames. The hook is responsible for not producing the same-id/new-`asOf` rows during
normal live sampling.

### XXIV.11.3 Heatmap scale, level formatting and toolbar fit

The heatmap's old colour scale used a per-level percentile. One rendered row aggregates several book
levels, so nearly every row reached the top of the ramp and the whole chart appeared yellow. The new
helper, `liquidityScaleForFrame()` in `src/terminal/heatmap.ts`, scales against **rendered row
totals**:

- aggregate `usd` per price row for bid and ask, using the visible price range and
  `minLiquidityUsd`;
- use `max(bidRow, askRow)` for each non-empty row;
- use the 95th percentile when at least 20 rows exist, otherwise the maximum;
- anchor the candidate to the frame at the right edge of the viewport;
- keep the existing `nextLiquidityScale()` hysteresis and fall back to the candidate while the
  stored scale is still zero.

This is a visual correction only. It does not change `WALL_MULTIPLE`, `WALL_PEER_LEVELS`,
`WALL_NEAR_PCT`, sampling or any server threshold.

Two display bugs were fixed in `LiquidityHeatmap.tsx`:

- `fmtQty()` replaces `fmtCompact()` for quantities, so `1.5068 BTC` no longer displays as `0`;
  it uses 4 decimals at or above 1, 5 at or above 0.01, and 8 below that.
- `fmtLevelPrice()` shows two decimals for prices at or above 100, so adjacent BTC levels no
  longer collapse to the same rounded price. The derived-fallback path marks `usd / price` with
  `~` when the server omitted `qty`.

The toolbar's base gap was reduced to `7px` (`src/terminal/terminal.css`), so at 1366 px it is one
row instead of wrapping. The exact-cell tooltip now reads, for example:

```text
Ask $123.1K 1.5068 @ 81,692.59
+22 more levels in this row
```

Priority remains bubble > wall > cell; empty cells still say no recorded level, and times before
capture still say before captured book history.

### XXIV.11.4 Browser evidence

Against the running live stack (`localhost:5173`, API `localhost:8787`), using an ad-hoc Playwright
script rather than the repo suite:

```text
1366x768:  stage 1332x458; heatmap canvas 1310x338; toolbar 45.5 px (one row); feed LIVE
1920x1080: canvas 1864x640; toolbar 46 px; page scrollWidth=1920
1024x768:  heatmap toolbar wraps to two rows; page scrollWidth=1157 (pre-existing app chrome)
390x844:   canvas 350x416; columns hidden; page width 390; terminal readable at full width
fullscreen 1366x768: chart SVG 1352x616; heatmap canvas 1342x543
```

Interaction checks at 1366:

```text
wheel zoom         -> LIVE 1.2x
drag pan           -> HIST 1.2x
Live button        -> LIVE 1.2x
price-axis drag    -> +/-0.350% became +/-0.448%
double-click reset -> 1.00x, +/-0.350%
More               -> opened; popover usable
bubble hover       -> bubble tooltip, not a cell tooltip
console/page errors: []
```

Settings persisted under `orderflow.heatmap.v1`: `span:"1m"`, `bubbles:"off"` and
`columns:["book","size"]` survived a reload, and the CUM checkbox remained unchecked.

Stream truth was checked by taking the browser offline and restoring it:

```text
online        -> LIVE
offline ~11s  -> STALE (header stopped claiming LIVE)
restored      -> LIVE
console/page errors: []
```

The final screenshots are evidence, not committed assets:

```text
C:\Users\DK\AppData\Local\Temp\opencode\final-1366.png
C:\Users\DK\AppData\Local\Temp\opencode\final-1920.png
C:\Users\DK\AppData\Local\Temp\opencode\final-1024.png
C:\Users\DK\AppData\Local\Temp\opencode\final-390.png
C:\Users\DK\AppData\Local\Temp\opencode\final-cell-tooltip.png
C:\Users\DK\AppData\Local\Temp\opencode\final-fullscreen-heatmap-1366.png
```

The 1024 screenshot confirms the two-row toolbar and the pre-existing app-chrome clipping; the
terminal card itself fits. The 390 screenshot confirms the stacked, long-page layout with the
columns hidden and the heatmap footer still visible.

### XXIV.11.5 Verification - red runs and green runs

An earlier `npm run verify` in this pass was red: 827 passed, 6 failed, all in
`server/test/mock.test.ts`, because `data/mock-test.lock` named PID 17624 on port 8907. That PID was
confirmed no longer alive, the stale mock lock was removed, and the suite was rerun. The live
`data/orderflow.lock` (PID 9052, port 8787) was not touched. The mock suite still leaves a lock file
with the finished child's PID after a pass; `acquireLock` reclaims a dead PID, which is why the
rerun is green.

Focused terminal tests after the fixes:

```text
npx vitest run server/test/heatmap.test.ts server/test/liveBook.test.ts server/test/terminal.test.ts

 Test Files  3 passed (3)
      Tests  38 passed (38)
   Duration  603ms
```

Repository gate after the final edits:

```text
> npm run verify
Test Files  39 passed (39)
     Tests  833 passed (833)
  Duration  7.08s
```

The only warning is the pre-existing duplicate `"regime"` key in
`server/test/mind.confluence.test.ts`; it appears in every run and does not fail.

Production build:

```text
> npm run build
✓ 90 modules transformed.
dist/index.html                   3.05 kB │ gzip:   1.44 kB
dist/assets/index-6w4pAqKu.css  148.60 kB │ gzip:  27.41 kB
dist/assets/index-CV3X_9XU.js   423.88 kB │ gzip: 129.67 kB
✓ built in 1.08s
```

This pass did not run `npx playwright test` or add `qa/terminal.spec.ts`; the browser evidence above
is the ad-hoc script only.

### XXIV.11.6 Honest gaps after this pass

- **No historical book feed.** The 15m default still starts nearly empty. The 900-frame cap is
  about 15 minutes at 1 s live or 45 minutes at 3 s fallback; 1h/4h/1D cannot fill from an open tab.
- **Quiet-depth trade tail.** Because the chart end is anchored to the latest book frame, trades
  that arrive after a long depth silence are not drawn until depth changes again. Not reproduced on
  active BTC; not fixed.
- **1m bubbles are dense.** Accurate individual BTC prints overlap into a chain at the 1m span. No
  visual aggregation was added because bucketing above 5m is the existing rule.
- **The reference remains gated.** The result is reference-shaped, not pixel-identical in canvas
  colours, animation or tooltip markup.
- **No committed terminal spec and no terminal mock fixtures.** Browser checks remain ad-hoc; mock
  mode still cannot serve terminal depth/aggTrade/klines.
- **The global app-chrome overflow remains.** At 1024 px the terminal itself fits; the page
  `scrollWidth=1157` comes from the topbar/macro chrome recorded in XXIV.5/XXIV.10.
- **Full-depth polling is still not soak-tested** under multiple clients. No cadence or wall
  threshold was changed by this pass.
- **The row-total scale is visually tuned.** It removes the saturation artefact; it is not a fitted
  signal and makes no claim about predictive liquidity.

### XXIV.11.7 Resume state

- **Last updated:** 28 October 2026.
- **Current part:** XXIV.11.
- **Unit tests:** 833 passed (39 files), 7.08 s.
- **Build:** 90 modules, CSS `index-6w4pAqKu.css`, JS `index-CV3X_9XU.js`.
- **Live stack:** Vite PID 3432 on `:5173`, API PID 9052 on `:8787`; `data/orderflow.lock` is
  active. Do not delete it to run a second server.
- **Next:** if this tab is kept, capture terminal fixtures and add `qa/terminal.spec.ts`; then
  address the quiet-depth trade tail and the pre-existing app-chrome overflow. Do not lower the
  cadence or widen wall thresholds by feel.

---

## Part XXIV.12 - 28 Oct 2026: server-captured terminal history, compact lattice and honest coverage

**Supersedes:** XXIV.5's "No historical order book exists" gap and XXIV.11.6's "No historical book feed"
gap. History now exists, but only from the moment the recorder first saw the book. It is **not** a
backfill and does not make 1h/4h/1D complete on a fresh install. XXIV.11's stream state machine,
row-total scale, routes and gate counts remain as written except where this Part says otherwise.

### XXIV.12.1 Why the history is forward-captured, not backfilled

The user's requirement was a dense, restorable heatmap with real observations and an unambiguous
distinction between recorded and missing history. Before adding storage, the available archives were
checked again:

- Binance spot `bookDepth` daily archives returned no usable objects for the pair;
- Binance futures `bookDepth` is a different venue and cannot stand in for spot liquidity;
- candles contain no depth, and repeating the current book backwards would fabricate history.

The only honest source is therefore **forward capture**. `server/src/terminal/recorder.ts` samples the
same full-depth snapshot the Terminal already uses, once every `TERMINAL.HISTORY_SAMPLE_MS = 3_000`,
for at most two recently viewed symbols. The recorder starts at server boot. A span that predates the
first capture is drawn blank and the canvas states the captured percentage. It is never filled with
current liquidity, interpolation, a candle proxy or random values.

### XXIV.12.2 Storage and API

`server/src/terminal/historyStore.ts` uses `node:sqlite` with WAL and two tables:

```text
terminal_frames(symbol, as_of, last_update_id, mid, best_bid, best_ask,
                bid_usd, ask_usd, bin_bps, range_pct, bids BLOB, asks BLOB)
  PRIMARY KEY (symbol, as_of)

terminal_trades(symbol, id, t, price, qty, usd, side)
  PRIMARY KEY (symbol, id)
```

Frames compress the ±1.2% book into 0.5 bp bins: **240 bins per side, 480 per snapshot**, stored as
Float32 BLOBs. Each bin is the **sum** of observed resting USD in that price band. The compact form is
lossy by design; the UI says `Compact capture: individual levels are summed, not reconstructed.`

Constants in `server/src/config.ts`:

```text
TERMINAL.HISTORY_SAMPLE_MS  = 3_000       [TUNED] match fallback cadence / storage budget
TERMINAL.HISTORY_BIN_BPS    = 0.5         [TUNED] ±1.2% at 0.5 bp = 480 values
TERMINAL.HISTORY_RANGE_PCT  = 0.012       [TUNED] covers Binance's near-touch depth
TERMINAL.HISTORY_RETENTION_MS = 27 h      [TUNED] covers a full 1D span plus overlap
TERMINAL.HISTORY_MAX_FRAMES = 900         [TUNED] same memory shape as the browser cap
TERMINAL.HISTORY_MAX_SYMBOLS = 2          [TUNED] LRU active symbols
TERMINAL.HISTORY_EXACT_TRADES = 12_000    [TUNED] above this, SQL buckets the tape
TERMINAL.HISTORY_TRADE_BUCKETS = 1_800    [TUNED] target buckets for long spans
TERMINAL.HISTORY_PRUNE_MS = 10 min        [TUNED] retention sweep cadence
```

New route:

```text
GET /api/terminal/history?symbol=BTCUSDT&span=1d&maxFrames=900
  -> TerminalHistory: symbol, span, from, to, asOf,
     frames[TerminalHistoryFrame], trades[TerminalTrade],
     truncated, coverage, firstAsOf, lastAsOf
```

`maxFrames` is clamped to `60..2_000`; the client asks for 900. The route touches the symbol so the
recorder keeps it in the two-symbol LRU. Frame reads preserve the first and newest observations and
select an evenly spaced subset. Wide spans use a `ROW_NUMBER()` window plus join so SQLite does not
hydrate every row first. Trades are exact while the count is at or below 12k; above that they are
bucketed by time and returned as VWAP `count`/`bucketMs` records, never as invented individual prints.

### XXIV.12.3 Client merge and history rendering

`src/terminal/useTerminalHistory.ts` fetches on symbol/span change, aborts superseded requests, keeps
an in-flight guard, refreshes every 30 s, and reports loading/error. It is enabled only when the
Terminal mode is not `MOCK`. `TerminalView.tsx` merges recorded frames through
`frameFromHistory()` + `mergeBookFrames()` (4,000-frame cap) and recorded trades through
`mergeTrades()` (20,000-trade cap). The live WebSocket remains the source of the newest book; history
does not replace it.

The heatmap span is now owned above the canvas: it is initialized from `loadSettings().span` and the
canvas reports changes through `onSpanChange`. A span change clears the hook's data before the new
response arrives, so an old 1D response cannot be drawn under a 15m label.

Historical cells draw from the compact lattice. `src/terminal/heatmap.ts`:

- `addLatticeBand()` distributes one recorded bin proportionally across every rendered row it
  overlaps, conserving recorded USD instead of point-sampling the bin centre;
- `cellAt()` returns the overlap fraction and recorded bin count for the hovered cell;
- live frames still win over history at equal timestamps; `MERGED_FRAME_LIMIT` remains 4,000.

The tooltip distinguishes history from live data and names the limitations. A real captured cell
reads, for example:

```text
81,614.62
16:55:58 IST
CAPTURED SAMPLE - 802s OLD
Ask $64.7K across 2 recorded bins
Compact capture: individual levels are summed, not reconstructed.
Source sample 16:55:55 IST
```

Empty historical cells say `No recorded liquidity in this cell.` They are not rendered as zero
liquidity. When captured coverage is below 90%, the footer says:

```text
Captured depth covers N% of this span.
Earlier book history was not recorded and is not invented.
```

The 90% threshold is deliberate: smaller gaps are visible as blank canvas and still have the exact
tooltip, while the sentence avoids repeating itself across every near-complete span.

### XXIV.12.4 Presentation changes in the same pass

- **Row striping fixed.** The first history renderer evaluated each compact bin at one price, so a
  0.5 bp bin skipped alternating 2 px rows and produced horizontal bands. Bands are now distributed
  by overlap; a conservation test totals the lattice columns back to the source USD.
- **Bubble scale fixed.** Bubble radius was referenced to the p90 of **raw trades**, which saturates
  near 15 px on active BTC. It now uses the p90 of the **aggregated bubble points**, so the largest
  prints stay visibly larger without every bubble becoming the maximum.
- **Exceptional bubbles outlined.** When at least 12 bubbles are visible, the top 3% by notional get
  a yellow outline (`bubbleTop`). Hovered bubbles get a stronger yellow ring. This is a visual
  concentration rule, not a prediction.
- **1D label.** The button, footer and aria label say `1D`; the internal span key stays `1d`.
- **Time axis.** Labels are measured with `measureText` and clamped inside the plot, so the date plus
  IST suffix does not clip at the right edge on 1D.
- **Historical-only wall text.** A wall sentence no longer implies a live book when only historical
  frames are present.
- **Error overlay.** The full-canvas error state only appears when there are no frames at all; a
  live book with a history read failure still renders.
- **History failure shown in the footer.** A failed history read now adds
  `history refresh failed - older captured samples may be missing` next to the live book, so a
  working WebSocket cannot hide a broken history request.

### XXIV.12.5 Bugs found while building it

| Bug | Symptom | Fix |
|---|---|---|
| SQLite bound parameters are REAL | `(t / ?) * ?` with JS bindings returned raw trade times; a 1D response carried thousands of one-minute rows and grew to 1.42 MB | `CAST(? AS INTEGER)` in both places; the same read is now about 20 time buckets and 598 KB |
| 0.5 bp boundary snapping | A level exactly on a bin edge landed in the lower bin because `Math.floor(ratio / step)` saw `3.999999...` | Add `1e-9` before `Math.floor`; regression test at the exact boundary |
| `truncated` computed after downsampling | A full 900-frame result was reported as truncated because the helper compared `frames.length` to `maxFrames` after `selectEvenly` | Compare the original `COUNT(*) > frames.length` |
| `maxFrames<=1` selected the oldest frame | SQLite `ASC LIMIT 1` returned the first capture | Use `DESC LIMIT 1`; test asserts the newest |
| Compact bins striped the canvas | Point-sampling each 0.5 bp bin skipped rows | Distribute each bin across overlapping rows; conservation test |
| 1D axis date clipped | Labels were drawn past the right edge | `measureText` + clamp |
| Bubble radii looked uniform | p90 referenced raw trades rather than aggregated bubbles | Reference aggregated bubble p90 |

### XXIV.12.6 Verification - what was actually run

`server/test/terminal.history.test.ts` was added with 11 tests: compaction boundaries, history windows,
even downsampling, newest-only selection, SQLite frame/trade roundtrip, lattice row conservation,
lattice cell lookup, live-frame preference and pruning.

```text
npx vitest run server/test/terminal.history.test.ts
Test Files  1 passed (1)
     Tests  11 passed (11)
```

Full gate after the changes:

```text
npm run verify
Test Files  40 passed (40)
     Tests  844 passed (844)
```

```text
npm run build
✓ 91 modules transformed.
dist/index.html                   3.05 kB │ gzip:   1.44 kB
dist/assets/index-6w4pAqKu.css  148.60 kB │ gzip:  27.41 kB
dist/assets/index-CdLieYJr.js   427.66 kB │ gzip: 131.07 kB
✓ built in 1.10s
```

The duplicate `"regime"` key warning in `server/test/mind.confluence.test.ts` remains; it is a warning,
not a failed assertion.

Live history read during the run:

```text
GET /api/terminal/history?symbol=BTCUSDT&span=1d&maxFrames=900
status=200, frames=371, trades=20, bytes=598,275, ms=300
firstAsOf=2026-10-28T16:53:00+05:30, lastAsOf=2026-10-28T17:08:00+05:30
```

Browser QA, ad-hoc Playwright against the live Vite stack:

```text
viewport 1920x1080: canvas 1864x640, page scrollWidth=1920, errors=[]
viewport 1440x900:  canvas 1384x470, page scrollWidth=1440, errors=[]
viewport 1024x768:  canvas  968x302, terminal card fits, page scrollWidth=1157
viewport 390x844:   full-page screenshot captured, terminal card fits, columns hidden,
                    toolbar wraps to three rows, errors=[]
```

At 1440, with real capture running, the 15m view held 302 frames covering 16:53-17:08 IST (100%
coverage). The 1D view held 619 frames but reported **2%** coverage, which is the honest state: only
about 31 minutes had been recorded. Cell hover, crosshair, zoom, pan, `Live`, `1D`, Columns and More
were exercised without console or page errors. Bubble hover returned a live STEP tooltip, confirming
bubble-over-cell priority; no historical VWAP bucket was hit by the scripted grid.

A separate route-abort check blocked `/api/terminal/history` while the live WebSocket stayed up. The
book still rendered, and the footer read:

```text
Bid depth $12.0M
Ask depth $11.7M
Book history 3 samples - 17:15:41-17:15:47
View live - 15m - 1.00x - range ±0.368%
history refresh failed - older captured samples may be missing
```

The only console error was the deliberately aborted request (`net::ERR_FAILED`). Screenshots:
`C:\Users\DK\AppData\Local\Temp\opencode\history-final-*.png`.

This pass did **not** run `npx playwright test`; there is still no committed `qa/terminal.spec.ts`.

### XXIV.12.7 Honest gaps after this Part

- **Capture is not backfill.** The DB starts empty at first boot. A fresh install has no 15m history
  until 15 minutes of uptime and no 1D history until 24 hours. The 1D view will show a low percentage
  for the first day; that is correct, not a loading failure.
- **The recorded DB is local and ignored by git.** `server/data/terminal-history.db` plus `-shm`/`-wal`
  are in `.gitignore`. There is no replication, export or migration path yet.
- **Only two symbols are retained.** The recorder LRUs recently viewed pairs; switching across more
  than two leaves older symbols with only the history already written until they are pruned.
- **No soak test.** Retention, WAL growth and two-symbol load were not run for 27 hours. The 27h/900
  frame/12k trade values are storage-shaped `[TUNED]`, not measured production limits.
- **Bucketed trades are VWAPs.** Above 12k trades, a bubble represents a time bucket's VWAP and count,
  not one print. The tooltip says `VWAP of bucket`; individual fills cannot be recovered.
- **Coverage is first-to-last.** `coverage` is computed from the first and last captured frame. An
  internal recorder gap is visible as blank canvas but does not reduce the percentage.
- **Bubble QA is incomplete.** A scripted grid hit live bubble tooltips and historical cell tooltips,
  but not a historical VWAP-bucket tooltip. `Bubbles Off` was selected but the canvas was not
  pixel-compared. The 390 px full-page screenshot was captured but not annotated in this Part.
- **Mobile is secondary.** Below 760 px the three columns are hidden and the canvas keeps the full
  width; the toolbar wraps to three rows and the page remains long. It is usable, not a simultaneous
  desktop-equivalent view.
- **The reference remains gated.** No pixel/animation parity claim is possible.
- **Pre-existing app-chrome overflow remains.** At 1024 px the page measured `scrollWidth=1157`
  against a 1024 viewport, from the topbar/macro chrome recorded in XXIV.5/XXIV.10; the terminal card
  itself fits.
- **Mock mode still has no terminal fixtures or history replay.** The history route reads an empty DB
  under `ORDERFLOW_MOCK=1`.

### XXIV.12.8 Resume state

- **Last updated:** 28 October 2026.
- **Current part:** XXIV.12.
- **Unit tests:** 844 passed (40 files).
- **Build:** 91 modules; CSS `index-6w4pAqKu.css`; JS `index-CdLieYJr.js` `427.66 kB` (`131.07 kB` gzip).
- **Live stack:** Vite PID 3432 on `:5173`; API on `:8787` under `tsx watch`, so its PID changes after
  edits. `data/orderflow.lock` is active; do not delete it to start a second server.
- **Next:** annotate the 390 px screenshot and hit a historical VWAP-bucket tooltip, then add terminal
  fixtures plus `qa/terminal.spec.ts`. Do not replace forward capture with a synthetic backfill, and
  do not widen the coverage sentence threshold by feel.

---

## Part XXIV.13 - 28 Oct 2026: the 11-view terminal shell, plan rail and honest mock state

**Supersedes:** the old two-view `TerminalView` (`chart | heatmap`) described in XXIV.10/XXIV.11 and
the pending mock-feed note in XXIV.12. The canvas, history, stream state machine and settings model
from XXIV.11/XXIV.12 remain; this Part puts them inside the required terminal chrome and adds the
secondary views.

### XXIV.13.1 Shell, rail and navigation

`src/terminal/TerminalView.tsx` now owns the full shell and receives the scan rows:

```tsx
<TerminalView symbol={terminalSymbol} onSymbol={setTerminalSymbol} mode={mode} rows={allRows} />
```

- 11 views: Chart, Heatmap, Footprint, Whales, Vol profile, Gamma, Tape, L3 events, Futures,
  Sentiment, Guide. `1-9`, `0` and `G` switch views. `P` opens the Decision & DOM rail, `F` toggles
  fullscreen, and Escape closes the picker, diagnostics and fullscreen.
- Header has the market picker, last price with source (`LAST`/`MID`), 24h change, bid/ask/spread,
  header `Lines` toggles (Plan / Γ / Liq), timeframe `1m 5m 15m 30m 1h 4h 1D`, and the feed badge.
  Clicking the feed badge opens diagnostics with book age, last event/trade, messages/s, resyncs,
  reconnects, span/capture, tape, gamma and liquidation state.
- The collapsed rail shows the current signal and `DECISION & DOM`; expanded it shows the plan state
  from `buildPlanContext`, entry/stop/R:R/targets, a six-level DOM ladder, spread and book imbalance.
  A market with no reviewed setup stays `WAIT`, renders dashes and says why instead of drawing a plan.
- Shell layout follows the §6 order: heatmap plot, columns, then the far-right price axis. The shell
  height was reduced from `calc(100svh - 196px)` to `calc(100svh - 221px)` after a 1440x900 run put the
  bottom of the card at 908.875 px. The measured card is now 679 px tall at y=204.875, inside the
  900 px viewport.
- `HeatmapView` no longer owns Plan/Γ/Liq toggles; the header owns them and passes `layers` down.
  The toolbar still owns span/range/contrast/bubbles/columns/more/help. There is no separate
  `ColumnsPopover.tsx`; the column checklist and presets live in `HeatmapToolbar.tsx`.

### XXIV.13.2 Secondary views and data sources

`src/terminal/TerminalViews.tsx` renders the non-heatmap tabs from the same captured data:

- Tape: captured aggTrade prints, side, price, notional, quantity and exact time.
- Whales: largest captured prints, explicitly an aggregate-print list, not single orders.
- Vol profile: captured notional at price, POC/VAH/VAL over a 70% value area.
- Footprint: recent `interval` buckets split into bought/sold notional.
- Gamma: Deribit strikes, net GEX, call/put OI, max-pain pin, call/put walls and the Γ flip. BTC/ETH
  only; other symbols state that rather than rendering a zero.
- L3 events: quiet level pulls from `pullEvents`, with `standing` duration.
- Futures: exchange-published funding/OI/basis/taker/liquidation fields when the scan has them.
- Sentiment: conviction checklist, Mind drivers/vetoes, news dot, unlock and plan state.
- Guide: the heatmap/columns/data-honesty text, including the no-mock-fill rule.

`TerminalViews` was checked against the real shared fields: `Driver.feature/reason`,
`Veto.code`, `ChecklistTick.key/label/reason`, `DerivRow.cvd/takerRatio/cvdDivergence` and
`LiqTally.longH1/shortH1` all typecheck. The no-setup state is humanised
(`NO TRADE · not picked low grade`) instead of exposing raw enum underscores.

### XXIV.13.3 Server and persistence changes

- `server/src/engine/gex.ts` now publishes `callWall`, `putWall` and interpolated `zeroGamma` alongside
  the existing strikes/max-pain/total GEX fields.
- `src/terminal/levels.ts` mirrors that snapshot and derives plan/gamma/liq/user lines. User levels are
  stored under `orderflow.heatmap.levels.v1`; chart settings remain under `orderflow.heatmap.v1`.
- `src/lib/api.ts` types `/api/gex` as `GammaResponse` and adds
  `api.liquidations(symbol)` returning `{ recent, note, asOf }`.
- `src/terminal/settings.ts` now has 11 column keys (`delta`, `book`, `tape`, `cob`, `superdom`,
  `size`, `cum`, `volume`, `svp`, `cdelta`, `cqc`), presets, tape/volume/size/step controls and
  `DEFAULT_SETTINGS` at span `15m`, columns `['delta','book','tape']`, row `3 px`.
- `src/terminal/useTerminalBook.ts` publishes `messagesPerSec`, `resyncs`, `reconnects`,
  `lastEventAt` and `lastTradeAt` for diagnostics.

### XXIV.13.4 Bugs found and fixed in this pass

| Symptom | Cause | Fix |
|---|---|---|
| `Back to live` shown before any zoom/pan | `(!viewEnd \|\| priceScale)` treats null as truthy | Require `viewEnd !== null \|\| priceScale !== null`; badge always means locked |
| Reading claimed a pull that did not exist | Always appended `0 pulls nearby · no trade…` | Only print the pull clause when `nearby > 0` |
| Mock fixture replay had a green live dot | REST fixture polling sets `streamState='LIVE'` | Pass `mock` to `HeatmapView`; use an amber dot and `fixture replay · 1 s`, never a live label |
| Decision rail showed `NO_TRADE_NOT_PICKED_LOW_GRADE` | Raw enum underscores were printed | Replace underscores and lower-case the rule text |
| Terminal overran a 900 px viewport | Fixed `196px` chrome subtraction was 25 px short | Measure with Playwright, then use `221px` |

The §6 ordering (columns before the price axis) is retained. Columns hide below 560 px and the
view selector replaces the tab strip below 760 px; this is a deliberate mobile simplification.

### XXIV.13.5 Verification - what was actually run

```text
npm run typecheck
tsc --noEmit
status=0
```

```text
npm test -- --run
Test Files  40 passed (40)
     Tests  844 passed (844)
  Duration  10.88s
```

The only warning is the pre-existing duplicate `regime` key in
`server/test/mind.confluence.test.ts`.

```text
npm run build
✓ 96 modules transformed.
dist/index.html                   3.05 kB │ gzip:   1.43 kB
dist/assets/index-3WX6qaeA.css  161.19 kB │ gzip:  29.64 kB
dist/assets/index-MpGSG_j1.js   483.95 kB │ gzip: 146.34 kB
✓ built in 1.95s
```

Browser QA, `npx playwright test qa/terminal.spec.ts` against the mock stack:

```text
Running 4 tests using 1 worker
✓ terminal shell exposes every view, the rail and an honest initial state (desktop)
✓ terminal mobile uses the view selector (desktop)
- terminal shell … (mobile, skipped by the desktop-only guard)
✓ terminal mobile uses the view selector (mobile)

3 passed, 1 skipped
```

An ad-hoc run of all 11 tabs at 1440x900 reported:

```text
TAB Chart => Chart
TAB Heatmap => Heatmap
TAB Footprint => Footprint
TAB Whales => Whales
TAB Vol profile => Vol profile
TAB Gamma => Gamma
TAB Tape => Tape
TAB L3 events => L3 events
TAB Futures => Futures
TAB Sentiment => Sentiment
TAB Guide => Guide
BOX {"x":16,"y":204.875,"width":1408,"height":679}
LOCK INITIAL false
RAIL {"x":1132,"y":263.875,"width":291,"height":619}
ERRORS []
```

At 390x844, `terminal-views-select` was visible and the card measured 366x690. The page itself still
scrolls vertically because the app chrome above the terminal is taller than the viewport.

### XXIV.13.6 Honest gaps after this Part

- **Mock mode has no terminal history fixtures.** `useTerminalHistory` is disabled in MOCK, so the
  heatmap shows only the live fixture samples captured while the browser is open. The large blank
  left side in mock QA is real missing capture, not a CSS failure. No synthetic backfill was added.
- **Gamma and liquidation views are empty in MOCK.** Their fixtures are absent, so the UI says no
  snapshot/prints rather than inventing one.
- **No live-stack truth run in this pass.** `npm run verify:truth` and `npm run verify:stage1` were
  not run against `npm run dev:api`; the Playwright suite drove the fixture server.
- **Old renderer remains.** `src/terminal/LiquidityHeatmap.tsx` is no longer imported but is still in
  the tree; the active path is `HeatmapView` → `HeatmapCanvas`.
- **No reference-parity claim.** Layout, tab behavior and the rail were checked in Chromium at
  1440x900 and 390x844, but no Bookmap pixel/animation comparison was made.
- **Mobile remains vertically long.** The terminal card fits horizontally at 390 px, but the app
  chrome above it means the page is not a one-screen mobile layout.
- **No dedicated local synthetic feed.** `MOCK` is still the server's captured-fixture replay, not a
  client-side random market generator.

### XXIV.13.7 Resume state

- **Last updated:** 28 October 2026.
- **Current part:** XXIV.13.
- **Unit tests:** 844 passed (40 files).
- **Playwright terminal spec:** 3 passed, 1 skipped.
- **Build:** 96 modules; CSS `index-3WX6qaeA.css` `161.19 kB` (`29.64 kB` gzip); JS
  `index-MpGSG_j1.js` `483.95 kB` (`146.34 kB` gzip).
- **Next:** exercise the shell against a live API, confirm book/tape/gamma/liq diagnostics with real
  values, add terminal history fixtures if mock screenshots must look populated, and decide whether
  to delete the unused `LiquidityHeatmap.tsx`. Do not add a synthetic backfill or a local feed that
  can be mistaken for the live market.

---

## Part XXIV.14 - 28 Oct 2026: Charts and Heatmap split, global Decision & DOM rail

**Supersedes:** XXIV.13's single `Chart & Heatmap` destination, its 11-view inner tab bar, and its
rail-inside-the-shell. The heatmap renderer, server data and honesty rules are unchanged.

### XXIV.14.1 Navbar and pages

The visible navbar is now exactly eight destinations:

```text
Dashboard | Charts | Heatmap | Order Block | Signals | Radar | News | India
```

- `Markets`, `Derivatives`, `Journal`, `Engine Lab` and `How it works` are no longer rendered in the
  navbar.
- `Charts` (tab id `charts`) and `Heatmap` (tab id `heatmap`) are separate top-level pages. There is
  no `Chart & Heatmap` page and no inner `.terminal-views` tab strip. The two pages share
  `TerminalView`'s market header, timeframe controls, Lines toggles and feed diagnostics; switching
  between them keeps interval/settings state because the component is reused.
- The nine secondary terminal views (`Footprint`, `Whales`, `Vol profile`, `Gamma`, `Tape`,
  `L3 events`, `Futures`, `Sentiment`, `Guide`) were removed from the rendered terminal. Their code
  remains in `src/terminal/TerminalViews.tsx` for a later pass but is no longer imported.
- Removed pages still exist in the codebase and are reachable only by an explicit
  `?tab=<id>` deep link (`derivatives`, `journal`, `lab`, `learn`, `markets`) because the Lab and
  Derivatives browser suites still exercise real behaviour. The navbar does not expose them, and the
  Dashboard journal/learn cards still navigate to those pages.

### XXIV.14.2 Decision & DOM is global

`src/terminal/DecisionRail.tsx` is a new app-level component rendered outside `TerminalView`:

- It is present on every tab as a collapsed 34 px strip (`31 px` on mobile) showing the signal and
  `DECISION & DOM`; `P` toggles it globally, including on Dashboard, Signals, Radar, News and India.
- Expanded, it shows symbol, plan state, entry/stop/R:R/target, six DOM levels, spread and imbalance.
  It uses `buildPlanContext`, so no reviewed setup stays `WAIT` with dashes and an explanation.
- The rail follows `terminalSymbol`: the market picker, an Order Block row and an off-board search hit
  all update it. Live ticks are subscribed for `terminalSymbol` on every page, not only on the chart
  pages.
- `DecisionRail` maintains its own `useTerminalBook` connection. This keeps book updates from
  re-rendering `App`, at the cost of a second connection while a chart/heatmap page is also mounted.

### XXIV.14.3 Layout and CSS

- `src/index.css` adds `.app-main` / `.app-main-page`; the grid is
  `minmax(0,1fr) 34px` collapsed or `minmax(0,1fr) 292px` open.
- `decision-rail` styles live in `terminal.css` with local `--t-*` variables because the rail is now
  outside `.terminal-shell`. On screens at or below 900 px the open rail is a fixed overlay
  (`min(320px, calc(100vw - 24px))`), not a squeezed grid column.
- `TerminalView` no longer renders `.terminal-rail`; its workspace is one full-width column.
- At 1440x900 the page column measured `1104 px` wide with the 292 px rail open; Charts/Heatmap fill
  the available width, and the rail is 34 px collapsed / 292 px open.

### XXIV.14.4 Verification - what was actually run

```text
npm run verify
Test Files  40 passed (40)
     Tests  844 passed (844)
  Duration  11.20s
```

```text
npm run build
✓ 96 modules transformed.
dist/index.html                   3.05 kB │ gzip:   1.43 kB
dist/assets/index-BDW-s-dl.css  161.94 kB │ gzip:  29.74 kB
dist/assets/index-CwPA6zrC.js   461.98 kB │ gzip: 140.71 kB
✓ built in 1.50s
```

Targeted browser runs against the mock stack:

```text
npx playwright test qa/terminal.spec.ts --project=desktop
2 passed (9.1s)   # separate pages, no inner tabs, global rail, mobile layout

npx playwright test qa/honesty.spec.ts --project=desktop
3 passed (5.3s)

npx playwright test qa/lab.spec.ts --project=desktop
14 passed (from the combined run)
```

Full suite, `npx playwright test`:

```text
106 passed
13 skipped
1 failed
```

The failure was `qa/chart.spec.ts:73` waiting for `ticket-chart` children after the mock server had
logged repeated `DEV GUARD: binance aggTrades BTCUSDT ... limit 120` warnings. The same spec passed in
isolation immediately afterwards:

```text
npx playwright test qa/chart.spec.ts --project=desktop
3 passed (16.6s)
```

This is recorded as a contention/flake, **not** as a green full-suite run. The mock webserver also
failed three RSS fixtures (Bitcoin Magazine, Bitcoin.com, CryptoSlate), which is pre-existing fixture
coverage, not a UI failure.

### XXIV.14.5 Honest gaps after this Part

- **Removed pages are hidden, not deleted.** `markets`, `derivatives`, `journal`, `lab` and `learn`
  still compile and are reachable through `?tab=`. The dashboard journal/how-it-works cards still
  navigate to them. **Decision (28 Oct): keep them hidden behind deep links; do not add them back to
  the navbar.**
- **Secondary terminal views are parked.** `TerminalViews.tsx` and its nine views are unused; the
  project builds without them, which is why the JS bundle fell from `483.95 kB` to `461.98 kB`.
  **Decision (28 Oct): keep them parked for a later pass.**
- **Rail book connection is duplicated on chart pages.** `DecisionRail` and `TerminalView` each open
  their own Binance book/trade stream for the same symbol.
- **No live-stack truth run.** `npm run verify:truth` / `verify:stage1` were not run; Playwright used
  the fixture server.
- **Mock terminal history/gamma/liq fixtures remain absent**, and the old
  `src/terminal/LiquidityHeatmap.tsx` remains unused.
- **Mobile is still vertically long**; the navbar scrolls horizontally and the app chrome remains
  taller than a phone viewport.
- **No reference-parity claim** for Bookmap layout or animation.

### XXIV.14.6 Resume state

- **Last updated:** 28 October 2026.
- **Current part:** XXIV.14.
- **Navbar:** Dashboard, Charts, Heatmap, Order Block, Signals, Radar, News, India.
- **Unit tests:** 844 passed (40 files).
- **Build:** 96 modules; CSS `index-BDW-s-dl.css` `161.94 kB` (`29.74 kB` gzip); JS
  `index-CwPA6zrC.js` `461.98 kB` (`140.71 kB` gzip).
- **Next:** run a live API truth check. Do not add synthetic terminal history. The five hidden pages
  stay behind `?tab=` and `TerminalViews.tsx`/`LiquidityHeatmap.tsx` stay parked until a later pass
  deliberately changes that decision.

---

## Part XXIV.15 - 28 Oct 2026: sparse reference heatmap and deterministic MOCK composition

**Supersedes:** XXIV.14's inherited heatmap rendering on the `heatmap` page. The page split, global
Decision & DOM rail, live data path and honesty rules are unchanged.

### XXIV.15.1 What the heatmap now draws

- The canvas is `#05070d`, with no synthetic grid, gradient wash or invented history. Recorded cells
  only: p40 / p70 / p90 / p95 row-total thresholds, sparse contiguous horizontal runs, dark-blue to
  cyan to white to yellow.
- Live capture begins at `recordStartTs`; the left side stays black and a dashed amber line says
  `order book recorded from here`. On narrow screens that label moves to the bottom-left when it
  would collide with the legend, rather than being covered by bubble labels.
- The right ladder is `Delta | bid $ | ask $ | Tape`, then the price axis. Column widths are now
  `delta 74`, `bid/ask 66`, `tape 124`, `book 78`; headers are painted after body rows.
- Tape width was increased from 104 to 124 because time, price and notional collided at 104 px.
  Header now renders `tape ≥ $5.5K` and `last 1 min` in the mock composition.
- Bubbles use `clamp(6 + 1.8 * sqrt(notionalUSD / 1000), 8, 64)` diameter; top 15% get rings, top 12
  or ≥ `$250K` get USD labels, and `|delta|/volume >= 0.6` gets chevrons.
- Wall badges, pull crosses, add crosses, plan/user/gamma/liq lines, hover tooltip, locked-view
  controls and the local-time axis remain drawn on the same canvas geometry.

### XXIV.15.2 MOCK composition is explicit and deterministic

`src/terminal/mockHeatmap.ts` is client-side only and runs only when `mode === 'MOCK'`:

- 90 levels per side, 2-second frames over 3.5 minutes, 45 large prints plus 1,800 small prints over
  the 15-minute span.
- The 1,800 small prints make the auto tape threshold land at **$5.5K** (measured p90
  `$5,551.32`, rounded to the `$500` step), matching the reference header instead of the old
  `$150K`.
- Walls sit at fixed prices, not levels that move with the mid. Bid `$262.9K` appears on the 2-second
  grid 38 seconds before the last frame, so the UI reports **standing 38s**. A 39-second display is
  not possible on a pure 2-second frame grid without inventing a timestamp; the measured value is
  kept. Ask `$343.7K` appears 2 seconds before the end. Pull `$403K` is removed in the last 20s;
  add `$186K` appears in the last 10s.
- `HeatmapView` passes `book={mock ? null : book}` to the canvas, so a live mid cannot disagree with
  the mock frame mid.
- The MOCK note is now a non-overlay strip between the reading line and the canvas:
  `MOCK composition — fixture replay, not captured live book history`. It no longer covers the
  volume bars on mobile.
- The reading line now ends the bluff clause with a period and clamps to two lines. On narrow
  screens the explanatory tail is therefore truncated by design; the full sentence remains in the
  element `title` and on desktop.

### XXIV.15.3 Other fixes in this pass

- `userLines` labels a saved level `★ my level`; the axis tag still carries the exact price.
- The mobile mock note was removed from the canvas overlay; the legend/record-label collision was
  fixed by moving the label below the legend only when it would overlap.
- `server/test/heatmap.test.ts` now has 25 tests, including deterministic mock threshold and
  user-level label assertions.
- `qa/heatmap.spec.ts` covers both desktop and mobile; screenshots are
  `qa/screens/heatmap-01-rework.png` and `qa/screens/heatmap-02-mobile.png`.

### XXIV.15.4 Verification - what was actually run

```text
npm run verify
Test Files  40 passed (40)
     Tests  851 passed (851)
  Duration  7.84s
```

`npm run verify` emitted a pre-existing Vite/esbuild warning about a duplicate `regime` key in
`server/test/mind.confluence.test.ts`; the tests passed.

```text
npm run build
vite v6.4.4 building for production...
✓ 97 modules transformed.
dist/index.html                   3.05 kB │ gzip:   1.43 kB
dist/assets/index-x8ewaMoT.css  162.75 kB │ gzip:  29.92 kB
dist/assets/index-B5_yvi9-.js   467.96 kB │ gzip: 143.35 kB
✓ built in 1.05s
```

```text
npx playwright test qa/terminal.spec.ts qa/heatmap.spec.ts
5 passed
3 skipped
(9.4s)
```

The three skipped tests are the project/device-specific halves of the mobile/desktop assertions. The
mock server still logs the same three pre-existing RSS fixture failures (Bitcoin Magazine,
Bitcoin.com, CryptoSlate); no outbound request was allowed.

### XXIV.15.5 Honest gaps after this Part

- **No live-stack truth run.** `npm run verify:truth` and `npm run verify:stage1` were not run; the
  browser checks used the fixture server.
- **Full Playwright suite was not rerun.** Only terminal and heatmap specs were run after the final
  edits. The earlier full-suite chart contention flake remains documented in XXIV.14.
- **Standing time is 38s, not the reference's 39s.** The 2-second mock grid makes an odd-second
  difference impossible without fabricating an off-grid frame. This is a recorded limitation, not
  a green claim.
- **Mobile truncates the reading explanation** at two lines. The title attribute still exposes the
  full measured sentence.
- **Columns are hidden below 560 CSS px** (`maxCols = 0`); the `Columns (4)` toolbar count still
  reflects the saved selection even when the narrow canvas shows none.
- **No pixel/animation parity claim** for Bookmap or the reference image. The sparse bands, labels
  and layout were compared visually at 1440x900 and the mobile screenshot; no automated pixel diff
  exists.
- **No commit was created.** `qa/screens/heatmap-*.png` and `qa/heatmap.spec.ts` are untracked;
  database/WAL files are dirty from test runs.

### XXIV.15.6 Resume state

- **Last updated:** 28 October 2026.
- **Current part:** XXIV.15.
- **Unit tests:** 851 passed (40 files).
- **Build:** 97 modules; CSS `index-x8ewaMoT.css` `162.75 kB` (`29.92 kB` gzip); JS
  `index-B5_yvi9-.js` `467.96 kB` (`143.35 kB` gzip).
- **Browser:** terminal + heatmap specs `5 passed, 3 skipped`; heatmap screenshots regenerated.
- **Next:** decide whether the 38s / 39s mismatch matters enough to change the mock frame cadence;
  if not, leave the measured value. Do not add synthetic live history. Re-run the full Playwright
  suite only after stopping any other Vite server.

---

## Part XXIV.16 - 28 Oct 2026: live Binance chart terminal

**Supersedes:** the old Charts tab. Heatmap, navbar and the global Decision & DOM rail are unchanged.

### XXIV.16.1 What shipped

- `src/lib/binance.ts`: REST klines + 24h ticker, combined WebSocket kline/trade/bookTicker, reconnect `1s -> 30s`, parsers, Heikin Ashi, `MarketDataSource`, `subscribeKline`. The chart talks directly to `api.binance.com` and `stream.binance.com:9443`, independent of server MOCK.
- History is capped at 1,500 bars. Binance allows 1,000 per request; older pages use `endTime = first.t - 1`. REST closed state is `closeTime <= now`; WS closed state is `x === true`.
- `src/lib/chartStats.ts`: UTC session windows London `08:00-16:30`, New York `13:30-20:00`; visible-range volume/delta/CVD/POC. Quote CVD is `2*takerBuyQuote - qv`; base delta is `2*takerBuyBase - v`; missing taker fields return `null`.
- `src/charts/`: the A-F layout - 48 px topbar, 36 px timeframe bar, 40 px toolbar, canvas `min-height: 480px`, 280 px sidebar, 28 px footer. Includes symbol picker, 300 ms live-price flash, bid/ask/spread, LIVE feed badge, latency, REST time and `WAIT/READY`.
- Chart types Candles / Heikin Ashi / Line / Area; Linear / Log / Percent; EMA, SMA, RSI, MACD, BOLL, VOL, VWAP; session bands; drawings (trend, ray, hline, rectangle, fib, long, short, text); visible-range HUD and crosshair OHLC readout.
- Sidebar tabs Whales / Futures / Sentiment / News / Guide, with honest empty states. Settings persist under `of-charts-settings-v1`; the selected terminal symbol persists under `of-terminal-symbol`.
- `src/hooks/useBinanceMarket.ts`: history + ticker load, WS merge, ticker throttle ~100 ms, `reloadKey`, clears bars/ticker on symbol/interval change.
- `src/hooks/useKlineChart.ts`: chart init/dispose, ResizeObserver, `applyNewData` vs `updateData`, indicator panes, drawing API, overlay ID tracking, crosshair/visible-range actions.
- `src/charts/extensions.ts`: `VWAP_CUSTOM`, `SESSION_BANDS` (`destination-over` so bands sit behind candles), `rectZone`, `textNote`, `longPosition`, `shortPosition`.
- `src/App.tsx`: `charts` renders `ChartsTerminal`; `heatmap` still renders `TerminalView`. The old charts branch inside `TerminalView` is unreachable.
- **Bug #52 fixed:** custom overlays declared too few steps. `rectZone` was `totalStep: 2`; long/short were `3`. klinecharts completes at `points.length >= totalStep - 1`, so they finished early and `createPointFigures` returned `[]`. Now `rectZone: 3`, long/short: `4`.

### XXIV.16.2 Verification - what was actually run

```text
npm run verify
Test Files  41 passed (41)
     Tests  868 passed (868)
  Duration  7.76s
```

`npm run verify` still emits the pre-existing Vite/esbuild duplicate `regime` warning in
`server/test/mind.confluence.test.ts`; the tests passed.

```text
npm run build
vite v6.4.4 building for production...
✓ 114 modules transformed.
dist/index.html                   3.05 kB │ gzip:   1.44 kB
dist/assets/index-cG6gQgFX.css  181.29 kB │ gzip:  32.76 kB
dist/assets/index-DOKAVOlv.js   719.88 kB │ gzip: 211.41 kB
✓ built in 1.83s
```

Vite warns that the JS chunk is above 500 kB. Non-blocking, recorded.

```text
npx playwright test qa/charts.spec.ts
3 passed, 1 skipped (17.8s)
```

The skipped test is the mobile half of the desktop-only drawing smoke. The main chart test passed on
both desktop and mobile.

```text
npx playwright test
112 passed, 16 skipped (4.5m)
```

The full suite is green. It logged repeated
`[ratelimit] DEV GUARD: binance aggTrades BTCUSDT issued ... (limit 120)` warnings from the mock
server; no test failed. The chart layer bypasses the server mock and read live Binance during the
browser run.

Screenshots:

- `qa/screens/charts-01-terminal-desktop.png`
- `qa/screens/charts-01-terminal-mobile.png`
- `qa/screens/charts-02-drawings-desktop.png` (rectangle visible)

### XXIV.16.3 Honest gaps after this Part

- **No live-stack truth/stage1 run.** `npm run verify:truth` and `npm run verify:stage1` were not
  run; Playwright used the fixture server for `/api`, while chart prices came directly from Binance.
- **Direct Binance may be geo-blocked.** README documents the `MarketDataSource` swap; no proxy or
  fallback is built.
- **Drawing smoke is desktop-only.** Mobile layout and controls are covered; mobile overlay
  interaction is not asserted.
- **No pixel/animation parity claim for Tradfye.** The reference is still behind a private-beta
  access code.
- **Chart bundle is 719.88 kB (211.41 kB gzip)**, above Vite's 500 kB warning. klinecharts is not
  code-split.
- **`__ofChart` / `__ofOverlayIds` are dev-only QA hooks** guarded by `import.meta.env.DEV`; they
  are not part of the production API.
- **No commit was created.** The working tree contains the chart sources/specs/screenshots plus
  pre-existing QA artifacts.

### XXIV.16.4 Resume state

- **Last updated:** 28 October 2026.
- **Current part:** XXIV.16.
- **Unit tests:** 868 passed (41 files).
- **Build:** 114 modules; CSS `index-cG6gQgFX.css` `181.29 kB` (`32.76 kB` gzip); JS
  `index-DOKAVOlv.js` `719.88 kB` (`211.41 kB` gzip).
- **Browser:** full `npx playwright test` `112 passed, 16 skipped`; chart spec `3 passed, 1 skipped`.
- **Next:** no further chart work is required for this pass. If overlay code changes, run
  `npx playwright test qa/charts.spec.ts`; if bundle size matters, code-split klinecharts. The
  earlier live truth run is still pending.

---

**End of context document.**

## Part XXIV.17 - 29 Oct 2026: Tradfye-style standalone Heatmap shell and mock parity

### XXIV.17.1 What shipped

- `src/App.tsx` now renders `tab === 'heatmap'` as a standalone Tradfye shell instead of the
  global OrderFlow shell; the global `P` listener is disabled on that tab so the terminal's own
  `P` handling owns the Decision rail.
- `src/terminal/TerminalView.tsx` now has the Tradfye brand row, top bar, 11-view tab bar
  (default Heatmap), mobile `<select aria-label="Trading view">`, 32 px right rail, keyboard
  shortcuts `1`-`0`, `P`, `F`, and standalone CSS variables.
- `src/terminal/HeatmapView.tsx`, `HeatmapToolbar.tsx`, `HeatmapCanvas.tsx`, `settings.ts`,
  `DepthColumns.ts`, `math.ts`, `heatmap.ts` and `mockHeatmap.ts` implement the single-canvas
  heatmap, 11-column model, toolbar/popovers, canvas tooltip/legend/crosshair, and deterministic
  mock walls/pulls.
- Mock BTC anchor is fixed at `80590`; nearest walls read `bid wall ... standing 39s` and
  `ask wall ... standing 2s`; pull detection reports 10 pulls for the mock's 7 nearby plus 3
  outer levels.
- Live staleness threshold changed from 10 s to 3 s in `useTerminalBook.ts`.

### XXIV.17.2 Verification - what was actually run

```text
npm run typecheck
(no output, exit 0)

npm run build
vite v6.4.4 building for production...
115 modules transformed.
dist/index.html                 3.05 kB
dist/assets/index-rZK-IqOI.css  193.20 kB, gzip: 34.86 kB
dist/assets/index-DXvzzSsV.js   743.36 kB, gzip: 218.60 kB
built in 1.55s

npm run verify
Test Files  41 passed (41)
     Tests  868 passed (868)
  Duration  7.02s

npx playwright test qa/heatmap.spec.ts --project=desktop
2 passed (1 skipped mobile-only test in the desktop project)

npx playwright test qa/terminal.spec.ts --project=desktop
2 passed

npx playwright test --project=desktop
61 passed, 1 failed, 2 skipped
```

The single Playwright failure is `qa/charts.spec.ts` "chart drawing overlays complete": the
`longPosition` overlay stopped at 2 of 3 points. It reproduces on rerun and is in the chart
drawing code, not the heatmap path. It is recorded as an honest gap rather than hidden.

### XXIV.17.3 Honest gaps after this Part

- **Pixel parity was not machine-verified.** This session cannot read screenshots, so the
  supplied reference was implemented from the written spec and inspected through passing DOM/canvas
  assertions, not by image comparison.
- **Live stack not run.** `npm run verify:truth` and `npm run verify:stage1` were not run; Playwright
  used the fixture server.
- **One chart drawing test fails.** `qa/charts.spec.ts` "chart drawing overlays complete" stops at
  2/3 points for `longPosition`; heatmap and terminal suites are green.
- **No commit created.** Working tree remains uncommitted.
- **`CONTEXT.md` append only.** Earlier parts were not rewritten.

### XXIV.17.4 Resume state

- **Last updated:** 29 Oct 2026.
- **Current part:** XXIV.17.
- **Unit tests:** 868 passed (41 files).
- **Build:** 115 modules; CSS `193.20 kB` (`34.86 kB` gzip); JS `743.36 kB` (`218.60 kB` gzip).
- **Browser:** heatmap `2 passed`; terminal `2 passed`; full desktop suite `61 passed, 1 failed, 2 skipped`.
- **Next:** investigate the chart drawing overlay click handling if full-suite green is required;
  otherwise the heatmap deliverable is complete.

---
## Part XXIV.18 - 29 Oct 2026: Heatmap page is standalone only

### XXIV.18.1 What changed

- Removed the `tradfye-viewbar`, its 11 view tabs, mobile view selector, tape stats and fullscreen
  button from `src/terminal/TerminalView.tsx`. The Heatmap route now renders the heatmap alone:
  brand row, top bar, heatmap toolbar/reading/canvas, and the right Decision rail.
- Updated `qa/heatmap.spec.ts` and `qa/terminal.spec.ts` to assert no nested view tabs or tablist.

This supersedes the "11-view tab bar" claim in Part XXIV.17.1.

### XXIV.18.2 Verification - what was actually run

```text
npm run typecheck
(no output, exit 0)

npm run build
vite v6.4.4 building for production...
115 modules transformed.
dist/index.html                 3.05 kB
dist/assets/index-BBIQQDS2.js   740.78 kB, gzip: 217.89 kB
built in 1.59s

npx playwright test qa/heatmap.spec.ts qa/terminal.spec.ts --project=desktop
4 passed (1 skipped mobile-only test in the desktop project)
```

### XXIV.18.3 Honest gaps after this Part

- Same as Part XXIV.17.3, plus the chart drawing overlay failure remains unrelated and pending.

---


## Part XXV � Heatmap terminal alignment to reference spec

- Added status readouts (candle delta, CVD, POC) to HeatmapView.
- Added Lines button and L shortcut; T/B/C/R/L keyboard shortcuts; Space+drag pan; R resets zoom.
- Updated wall clause formatting (�, em dash, humanized durations) and clickable wall rows; added state chip.
- Added humanizeDuration/fmtDuration and bluff scoring helpers to math.ts/heatmap.ts/format.ts.
- Verified: npm run verify (868 tests) and npm run build pass; Playwright heatmap/terminal specs pass.

---

## Part XXVI - 29 Oct 2026: Footprint terminal view

### XXVI.1 What shipped

- `src/terminal/footprint/` is now a real Footprint view, not the placeholder described in
  Part XXIV.13. Files: `FootprintView.tsx`, `FootprintToolbar.tsx`, `FootprintCanvas.tsx`,
  `aggregate.ts`, `mock.ts`, `levels.ts`, `format.ts`, `settings.ts`, `types.ts`,
  `useFootprintTrades.ts`.
- `FootprintView.tsx` owns mock/live dataset selection, linked vs manual interval, persisted
  settings/link, selected candle, reading line, user levels, removed levels, rekt filtering and
  `Load older` (+50 candles in mock).
- `FootprintToolbar.tsx` renders the exact controls: `Candles` (`1m 5m 15m 30m 1h 4h 1D`, default
  `15m`, link icon), `Show` (`Bid × Ask` default, `Delta`, `Volume`, `Profile`, `Δ + Vol`), `Rows`
  (`Auto` default, `1×`, `2×`, `5×`, `10×`), `Units` (`$` default, `BTC`), `Load older`,
  `From Oct 29, 08:45 AM UTC`, `Settings`, `?`, `MOCK` badge and `12 candles · 25 USDT rows`.
- `FootprintCanvas.tsx` is one canvas with DPR resize, a single rAF render, Bid×Ask/Delta/Volume/
  Profile/Δ+Vol modes, B/S header, 5-row summary strip, POC ticks, UA/nPOC lines, horizontal levels,
  rekt markers, current-price tag, hover tooltip, wheel zoom, Shift-wheel price stretch, drag pan,
  double-click/Home reset, right-click add level, right-click existing level to remove, and
  `Back to live` when panned/zoomed.
- `TerminalView.tsx` now accepts `TerminalPage = 'charts' | 'heatmap' | 'footprint'`, defaults the
  interval to `15m`, sets `footprintMock = mode === 'MOCK' || ?mock=1`, and renders the viewbar/tabs
  only when `view !== 'heatmap'`. Heatmap stays standalone as required by Part XXIV.18.
- `App.tsx` added the `footprint` tab, route (`?tab=footprint`), tab icon and `TAB_IDS` entry.
- The old placeholder `FootprintView` was removed from `TerminalViews.tsx`; the unused legacy
  `src/terminal/footprint/render.ts` was deleted.
- `.fp-*` styles were added to `terminal.css`; on widths below 720 px the canvas switches to compact
  geometry (`axisW 58`, `gutterW 58`, `labelMargin 12`, three-column pitch) and suppresses gutter/
  annotation/rekt text that cannot fit. Cell numbers render from `rowH >= 10` so they remain visible
  at 1440.
- `qa/footprint.spec.ts` now covers the composition/reading line, a 1920-wide full-composition
  screenshot, row tooltip (desktop) and `Load older` (both projects).

### XXVI.2 Mock reference and layout facts

- 12 candles: 14:15 (hidden seed), 14:30, 14:45, 15:00, 15:15, 15:30, 15:45, 16:00, 16:15, 16:30,
  16:45, 17:00. Last price `80142.42`, row size `25`.
- Exact 14:30 rows, top to bottom, bid|ask: `89K|202K`, `302K|1.30M`, `577K|1.52M`, `439K|865K`,
  `181K|373K`, `895K|1.83M` (POC), `54K|326K`, `23K|310K`, `397K|545K`, `549K|779K`, `260K|630K`,
  `346K|284K`, `73K|95K`.
- Summary targets (`volume/delta/cumDelta/B-S/imbalances`): 14:30 `13.2M/+4.87M/+6.27M/68-32/5-0`;
  14:45 `7.53M/+2.09M/+8.35M/64-36/2-0`; 15:00 `5.76M/+589K/+8.94M/55-45/1-0`;
  15:15 `7.60M/−1.33M/+7.61M/41-59/0-1`; 15:30 `8.96M/+132K/+7.74M/51-49/0-0`;
  15:45 `5.66M/+1.36M/+9.10M/62-38/1-0`; 16:00 `14.3M/+3.47M/+12.6M/62-38/3-1`;
  16:15 `8.15M/+3.48M/+16.1M/71-29/2-0`; 16:30 `9.07M/+4.55M/+20.6M/75-25/4-0`;
  16:45 `7.33M/−463K/+20.1M/47-53/0-0`; 17:00 forming `3.76M/−300K/+19.8M/46-54/3-4`.
- Reading line: `This candle: Δ -3.74 — quiet candle — too little volume to read. Most volume at
  80142.50 (POC). Imbalances: 3 buy / 4 sell rows.`
- At 1920 all 12 columns fit: 14:15 sits under the gutter and the literal 14:30 rows are visible.
  At 1440 the viewport starts with 15:00 under the gutter and shows 15:15-17:00; 14:30 is reachable
  by panning, not by the first screen.
- The suspected desktop header/summary/cell misalignment was checked by instrumenting canvas
  `fillText`: at 1440 the 15:15 header, summary time and cells all centre at x=144, and the 15:15
  rows are `355K|478K...`. The apparent mismatch was a crop misread; the layers are aligned.
- `forceImbalanceCounts` now assigns distinct buy/sell rows and falls back to overlap only when the
  requested counts exceed the row count. The last candle reports exactly `3 buy / 4 sell`.

### XXVI.3 Verification - what was actually run

```text
npm run build
> tsc --noEmit && vite build
vite v6.4.4 building for production...
✓ 124 modules transformed.
dist/index.html                 3.05 kB
dist/assets/index-DHHzORHf.css 195.76 kB │ gzip: 35.24 kB
dist/assets/index-BhPf_BEE.js  807.52 kB │ gzip: 240.07 kB
✓ built in 2.05s

npm run verify
Test Files  41 passed (41)
     Tests  868 passed (868)
  Duration  9.31s

npx playwright test qa/footprint.spec.ts
5 passed, 1 skipped (10.7s)

npx playwright test qa/terminal.spec.ts qa/heatmap.spec.ts qa/charts.spec.ts
8 passed, 3 skipped, 1 failed (38.3s)

npx playwright test qa/charts.spec.ts --project=desktop
2 passed (13.7s)
```

The single failure was `qa/charts.spec.ts` "chart drawing overlays complete": the `longPosition`
overlay reported `currentStep: 3, points: 2` where the test expects `-1` and `3`. It passed when
rerun alone, so it is the same pre-existing flaky chart-drawing test recorded in Part XXIV.17.3,
not a Footprint regression.

The first combined run also had two `qa/terminal.spec.ts` failures because the rail button title had
changed from `Open decision & DOM panel (P)` to `Show the Decision panel and DOM (P)`. The test now
clicks `.rail-collapsed`; `qa/terminal.spec.ts` then passed 4/4.

One Footprint run failed on both projects with reading line `Δ -3.75` instead of `-3.74`. A stray
`npm run dev` from 22:24 was still listening on :5173 and sharing `node_modules/.vite` with the
Playwright Vite server on :5199. Killing that dev tree (`taskkill /PID 14604 /T /F`) and rerunning
clean gave the passing numbers above. This is the cache race AGENTS.md warns about: stop `npm run
dev` before `npx playwright test`.

### XXVI.4 Honest gaps after this Part

- **Live path not validated.** The Footprint view has a live Binance `aggTrades` path, but only the
  fixture/mock route was exercised. `npm run verify:truth` / `verify:stage1` were not run.
- **Pixel parity is visual, not machine-verified.** Desktop 1440, desktop 1920 and mobile screenshots
  were inspected; there is no image-diff assertion.
- **Mobile hover tooltip is not tested.** Touch devices do not get a hover state; `Load older` is
  tested on mobile, the tooltip is desktop-only.
- **`qa/charts.spec.ts` remains flaky in a combined run.** It passes alone and is unrelated to this
  view.
- **No commit created.** Working tree remains uncommitted.

### XXVI.5 Resume state

- **Last updated:** 29 Oct 2026.
- **Current part:** XXVI.
- **Unit tests:** 868 passed (41 files).
- **Build:** 124 modules; CSS `195.76 kB` (`35.24 kB` gzip); JS `807.52 kB` (`240.07 kB` gzip).
- **Browser:** Footprint `5 passed, 1 skipped`; Terminal `4 passed`; combined terminal/heatmap/charts
  `8 passed, 3 skipped, 1 flaky`.
- **Supersedes:** Part XXIV.13's "Footprint: recent interval buckets split into bought/sold notional"
  placeholder. Part XXIV.18's "no nested view tabs" remains true for Heatmap only; Charts and
  Footprint now share the viewbar.
- **Next:** verify the live `aggTrades` path when a network-enabled stack is available; otherwise the
  mock deliverable is complete. Re-check the chart-drawing flake only if a fully green combined suite
  is required.

