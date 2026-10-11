# DATA_SOURCES.md

**Probed:** 10 October 2026, 15:35 UTC, from this machine (Windows, Indian network).
**Reproduce:** `npm run probe` → writes `server/data/probe-results.json`.

Every source below was hit live. **Nothing is built against a source that is not `OK` here.**
Sources that failed are marked `Unavailable` in the UI with the reason, never faked.

---

## Verdict summary

40 probes · **34 OK** · 1 BLOCKED · 5 FAIL → 3 of the 5 failures resolved by finding a correct
URL, leaving 2 genuinely unavailable.

| Category | Result |
|---|---|
| Spot | all OK |
| **Futures** | **all OK — Binance futures is reachable from India** |
| WebSocket | all OK — **both spot and futures** |
| Venue | 5/6 OK (Deribit DVOL endpoint corrected) |
| Market | 5/7 OK (unlocks are Pro-only, one path corrected) |
| Official | 6/7 OK (BLS URL corrected) |
| India | CoinDCX OK, response shape is a bare array |
| ETF | **ALL BLOCKED (HTTP 403)** |
| News (GDELT) | **BLOCKED (HTTP 429, persistent)** |

---

## The two answers that mattered most

### 1. Binance futures is NOT blocked — use it as primary

This was the biggest open risk in the spec. It works completely:

```
OK  Binance F premiumIndex          mark=82995.90 funding=0.00000072 next=2026-10-10T16:00:00Z
OK  Binance F openInterest          92497.683
OK  Binance F fundingInfo           805 symbols  (per-symbol funding interval)
OK  Binance F openInterestHist      OK
OK  Binance F globalLongShortAccountRatio   OK
OK  Binance F topLongShortPositionRatio     OK
OK  Binance F takerlongshortRatio           OK
OK  Binance F 24h ticker            OK
OK  WS  fstream.binance.com/market/stream   delivered markPriceUpdate in 1036ms
```

**The `/market` route question is answered yes.** `markPrice` and `forceOrder` are delivered on
`wss://fstream.binance.com/market/stream?streams=...`. An un-routed URL silently delivers nothing —
we used the routed form.

Hyperliquid (234 perps) and Bybit stay wired as **cross-venue comparison** sources, which is what
Phase 2 needs them for anyway.

### 2. Token unlocks have no free source — confirmed, not guessed

```
FAIL  api.llama.fi/emissions              HTTP 402  (Payment Required = Pro tier)
FAIL  api.llama.fi/emission/breakdown     HTTP 402
```

**HTTP 402 is a billing wall, not a bug.** Per the spec's rule 1, unlocks ship as a user-editable
`server/data/unlocks.json`. **Unlock dates are never invented.**

---

## Corrected URLs (3 failures were my own bad URLs)

| What I tried | Result | Correct URL |
|---|---|---|
| `deribit.com/api/v2/public/get_index_price?index_name=btc_dvol` | 400 | **not a valid index** — DVOL comes from `get_volatility_index_data` |
| `deribit.com/api/v2/public/ticker?instrument_name=BTC-DVOL` | 400 | DVOL is an index, not an instrument |
| `bls.gov/schedule/news_release/2026_sched.htm` | 404 | **`https://www.bls.gov/schedule/2026/home.htm`** (also `/schedule/news_release/cpi.htm` for per-series) |

Working Deribit calls:

```
OK  get_book_summary_by_currency?currency=BTC&kind=option      938 rows
OK  get_volatility_index_data?currency=BTC&resolution=3600     full DVOL series
OK  get_index_price?index_name=btc_usd                         spot index
```

---

## Full table

| Category | Source | Endpoint | Verdict | Latency | Sample | Fallback chosen |
|---|---|---|---|---|---|---|
| Spot | Binance | `data-api.binance.vision/api/v3/klines` | **OK** | 748ms | rows=2 lastClose=83030.01 | none needed |
| Spot | Binance | `/api/v3/ticker/24hr` | **OK** | 706ms | lastPrice=83030.01 | none needed |
| Spot | Binance | `/api/v3/depth` | **OK** | 705ms | bids=20 | none needed |
| Spot | Binance | `/api/v3/exchangeInfo` | **OK** | 1461ms | 3684 symbols | cached 1h |
| Futures | Binance F | `/fapi/v1/premiumIndex` | **OK** | 327ms | mark+funding+nextFunding | **PRIMARY** |
| Futures | Binance F | `/fapi/v1/openInterest` | **OK** | 383ms | 92497.683 | Binance premiumIndex bulk |
| Futures | Binance F | `/fapi/v1/fundingRate` | **OK** | 336ms | history | — |
| Futures | Binance F | `/fapi/v1/fundingInfo` | **OK** | 337ms | 805 symbols | needed for interval |
| Futures | Binance F | `/futures/data/openInterestHist` | **OK** | 181ms | OK | — |
| Futures | Binance F | `/futures/data/globalLongShortAccountRatio` | **OK** | 193ms | OK | — |
| Futures | Binance F | `/futures/data/topLongShortPositionRatio` | **OK** | 175ms | OK | — |
| Futures | Binance F | `/futures/data/takerlongshortRatio` | **OK** | 185ms | OK | — |
| Futures | Binance F | `/fapi/v1/ticker/24hr` | **OK** | 181ms | OK | — |
| Venue | Hyperliquid | `POST api.hyperliquid.xyz/info metaAndAssetCtxs` | **OK** | 809ms | **234 perps** | cross-venue check |
| Venue | Bybit | `/v5/market/tickers?category=linear` | **OK** | 695ms | funding+OI | cross-venue check |
| Venue | Deribit | `get_book_summary_by_currency?kind=option` | **OK** | 1344ms | 938 rows | BTC+ETH only |
| Venue | Deribit | `get_volatility_index_data` | **OK** | 559ms | DVOL series | **DVOL source** |
| Venue | Coinbase | `/products/BTC-USD/ticker` | **OK** | 531ms | 82959.76 | Coinbase premium |
| Market | CoinGecko | `/coins/markets?per_page=30` | **OK** | 461ms | 30 coins | — |
| Market | CoinGecko | `/global` | **OK** | 332ms | $2814B | — |
| Market | DefiLlama | `stablecoins.llama.fi/stablecoins` | **OK** | 926ms | 430 assets | — |
| Market | DefiLlama | `stablecoins.llama.fi/stablecoincharts/all` | **OK** | 229ms | 3238 rows | — |
| Market | alternative.me | `/fng/?limit=31` | **OK** | 1017ms | 31 points | — |
| Market | DefiLlama | `/emissions` | **FAIL 402** | 173ms | Pro tier | **`unlocks.json`, manual** |
| ETF | Farside | `farside.co.uk/btc/` | **BLOCKED 403** | 198ms | — | **`etf-flows.json`, manual** |
| ETF | Farside | `/bitcoin-etf-flow-all-data/` (alt headers) | **BLOCKED 403** | 1211ms | — | — |
| ETF | SoSoValue | `sosovalue.com/assets/etf/us-btc-spot` | **BLOCKED 403** | 997ms | — | — |
| DEX | GeckoTerminal | `/networks/eth/trending_pools` | **OK** | 682ms | 20 pools | throttle to 10/min |
| DEX | DexScreener | `/token-boosts/top/v1` | **OK** | 293ms | 30 tokens | throttle 1/min |
| India | CoinDCX | `/exchange/ticker` | **OK** | 164ms | **bare array** | INR premium |
| India | Yahoo | `INR=X` | **OK** (v1) | — | crumb handshake | working |
| India | NSE | `/api/allIndices` | **OK** | 1342ms | 139 indices | working |
| Official | Fed | `/newsevents/pressreleases/2026-press-fomc.htm` | **OK** | 1880ms | HTML | tier-0 news |
| Official | Fed | `/newsevents/speeches.htm` | **OK** | 1129ms | HTML | tier-0 news |
| Official | SEC | `/news/pressreleases.rss` | **OK** | 507ms | RSS XML | tier-0 news |
| Official | BLS | `/schedule/2026/home.htm` | **OK** | 608ms | HTML | CPI/NFP calendar |
| Official | RBI | `website.rbi.org.in/.../press-releases` | **OK** | 2088ms | HTML | IN_* news |
| Official | Binance | `/en/support/announcement` | **OK** | 244ms | JS shell | exchange status |
| News | GDELT | `/api/v2/doc/doc` | **BLOCKED 429** | 10870ms | rate-limited | RSS already covers |
| **WS** | Binance spot | `wss://data-stream.binance.vision/stream` | **OK** | 2063ms | `!miniTicker@arr` delivered | — |
| **WS** | Binance futures | `wss://fstream.binance.com/market/stream` | **OK** | 1036ms | `markPriceUpdate` delivered | — |

---

## CoinDCX response shape (discovered, not documented)

`GET https://api.coindcx.com/exchange/ticker` returns a **bare JSON array**, not the
`{status, data}` wrapper the docs suggest:

```json
[{"market":"0GUSDT","change_24_hour":"-3.462","high":"0.27540000","low":"0.25040000",
  "volume":"2643998.63201500","last_price":"0.26490000","bid":"0.26...","ask":"...",
  "timestamp":"..."}]
```

Every field is a **string**. Markets are `BASEUSDT`; `USDT` is the INR quote. This is a usable INR
price source for the Phase 8 premium calculation. No API key needed.

---

## Consequences for the build

| Spec assumption | Reality | Change made |
|---|---|---|
| "If `fapi.binance.com` is unreachable, swap to Hyperliquid + Bybit" | **It is reachable** | Binance futures is primary; Hyperliquid + Bybit are cross-venue checks |
| Unlocks via DefiLlama | **402 Pro-only, confirmed** | `server/data/unlocks.json`, user-editable, never invented |
| ETF flows via Farside | **403 from this IP, all paths** | `server/data/etf-flows.json` + `Unavailable` UI state with the 403 as the reason |
| GDELT as breaking-news detector | **429, persistent** | 5-second request queue still implemented; degrades to the 6 RSS feeds |
| CoinDCX ticker | Works, but bare array | Parsed accordingly |
| BLS schedule | Wrong URL | `/schedule/2026/home.htm` |

**Degradation discipline:** ETF flows and unlocks show `Unavailable` with the reason and the
last-good age. They never show a zero, because a zero reads as "no flow" and that is a lie.

---

## Rate limits to respect

| Source | Limit | Enforcement |
|---|---|---|
| Binance spot+futures | 6000 weight/min | track `X-MBX-USED-WEIGHT-1M`, back off above 70% |
| Binance spot WS | 1024 streams/conn, dies at 24h, 5 msg/s | proactive reconnect ~23h |
| Binance futures WS | same, **must use `/market` route** | probed and confirmed |
| Hyperliquid | POST `/info` | cached 60s, all symbols in one call |
| Bybit | 600 req/5s | cross-venue only, low frequency |
| Deribit | ~20 req/s public | BTC+ETH options only |
| CoinGecko | ~30/min keyless, 100/min with demo key | cached hard |
| GeckoTerminal | 10–30/min | throttle to 10/min |
| GDELT | **1 req / 5s, 250 records max** | queue implemented (still 429 here) |

---

**Next:** `ORDERFLOW-CONTEXT.md` must be renamed from `CONTEXT.md` and updated to match v2 as it
is built.