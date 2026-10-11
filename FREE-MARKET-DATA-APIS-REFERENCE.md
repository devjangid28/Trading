# Free No-Cost Market Data APIs — Technical Reference

**Compiled:** 10 Oct 2026 · **For:** Node.js backend, caller located in India

---

## 0. Test Environment & Verification Legend

**All live tests in this document were executed from a confirmed Indian IP address:**

```
IP:       152.59.39.221
Location: Ahmedabad, Gujarat, IN
ASN:      AS55836 Reliance Jio Infocomm Limited
```

Confirmed twice: via `ipinfo.io/json`, and independently when a Cloudflare block page disclosed the egress IP. Binance's own response came back through CloudFront POP `BOM78-P9` (Mumbai). **This matters enormously** — the geoblock findings below are real observations from India, not second-hand guesses.

| Marker | Meaning |
|---|---|
| ✅ **VERIFIED** | I fetched a live 200 response and am quoting real field names/values |
| ⚠️ **PARTIAL** | Endpoint reachable but something is blocked/limited — details given |
| ❌ **BLOCKED** | Confirmed failing from India |
| 📄 **DOC-ONLY** | From official documentation; could not confirm with a live call |

---

## 1. Binance Spot Public REST API

### 1.1 Base URLs — which one for India?

| Base URL | India result | Use for |
|---|---|---|
| `https://api.binance.com` | ✅ **VERIFIED — works from India (HTTP 200)** | Main host |
| `https://data-api.binance.vision` | ✅ **VERIFIED — works from India (HTTP 200)** | Public market data only |

**Both hosts returned byte-identical prices from India** (`82983.85000000` for BTCUSDT), confirming no geo-divergence in payloads.

**Answer to "which base URL for India":** `api.binance.com` works. Binance completed FIU-IND registration on **19 Aug 2024** after an ₹18.82 crore penalty, and the MeitY URL block was lifted in **Sept 2024**. India is therefore **not** on Binance's prohibited-country list for market data.

**Recommendation:** Still prefer `data-api.binance.vision`. It is the officially designated market-data-only host (mirror of `/api/v3/`), has no account endpoints to accidentally hit, and third-party testing shows it is served identically regardless of exit country. Fall back to `api.binance.com` only if you need endpoints not in the mirror's list.

**Endpoints available on `data-api.binance.vision`** (from official docs):
```
GET /api/v3/aggTrades      GET /api/v3/klines       GET /api/v3/ticker
GET /api/v3/avgPrice       GET /api/v3/ping         GET /api/v3/ticker/24hr
GET /api/v3/depth          GET /api/v3/ticker/bookTicker
GET /api/v3/exchangeInfo   GET /api/v3/time        GET /api/v3/ticker/price
GET /api/v3/trades         GET /api/v3/uiKlines
```
WebSocket market streams: `wss://data-stream.binance.vision`
**Not available on the mirror:** User Data Streams, any `SIGNED`/`USER_DATA` endpoint.

**Other Binance hosts** (📄 DOC-ONLY): `fapi.binance.com` (USD-M futures), `dapi.binance.com` (COIN-M), `fapi.binance.com/fapi/v1/*` for futures klines.

### 1.2 Authentication

✅ **VERIFIED: None required.** Zero API key, zero signature, zero headers beyond a User-Agent. All four endpoints returned 200 with a bare `curl`.

### 1.3 Rate Limits — read from a live `exchangeInfo` response

✅ **VERIFIED — actual returned `rateLimits` array:**

```json
{"rateLimits":[
  {"rateLimitType":"REQUEST_WEIGHT","interval":"MINUTE","intervalNum":1,"limit":6000},
  {"rateLimitType":"ORDERS","interval":"SECOND","intervalNum":10,"limit":100},
  {"rateLimitType":"ORDORS","interval":"DAY","intervalNum":1,"limit":200000},
  {"rateLimitType":"RAW_REQUESTS","interval":"MINUTE","intervalNum":5,"limit":300000}
]}
```
(The third is `ORDERS` / DAY — verify by parsing rather than hardcoding.)

**Budget for a read-only backend: 6000 request-weight per minute.** This is very generous.

**Live response headers** ✅ VERIFIED:
```
x-mbx-used-weight: 2
x-mbx-used-weight-1m: 2
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, HEAD, OPTIONS
```

`x-mbx-used-weight-1m` is the single most useful thing to poll in your code — it is a live countdown of your 6000/min budget.

### 1.4 `GET /api/v3/klines`

```
GET https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=2
```

| Param | Required | Notes |
|---|---|---|
| `symbol` | yes | e.g. `BTCUSDT` |
| `interval` | yes | see table below |
| `startTime` / `endTime` | no | **milliseconds** |
| `limit` | no | default 500, **max 1000** |

**✅ VERIFIED limit behaviour — silent clamping, no error:**

| Requested `limit` | HTTP | Rows returned |
|---|---|---|
| 1000 | 200 | 1000 |
| 1001 | 200 | **1000** |
| 1500 | 200 | **1000** |

> ⚠️ **Critical:** exceeding 1000 does **not** error. It silently truncates. If you depend on getting N rows, assert `rows.length === N` client-side or you will silently get short history.

**✅ VERIFIED interval values** (I tested each one; HTTP 200 = valid):

| Valid | Invalid (HTTP 400 `-1120 Invalid interval.`) |
|---|---|
| `1s` `1m` `3m` `5m` `15m` `30m` `1h` `2h` `4h` `6h` `8h` `12h` `1d` `3d` `1w` `1M` | `60s` `2s` `5M` |

All of your proposed values — `1m, 3m, 5m, 15m, 1h, 1d, 1w` — are valid. Note `1M` (month) is **uppercase** and `1m` (minute) is **lowercase**: `5M` and `60s` are rejected.

**✅ VERIFIED response — array of arrays, NOT objects:**
```json
[
["1791637200000","82808.01000000","82860.00000000","82781.81000000","82830.26000000","239.58563000",
 "1791640799999","19843919.99134130",20442,"109.67379000","9083681.45328350","0"],
["1791640800000","82830.25000000","82983.86000000","82778.00000000","82983.86000000","216.82205000",
 "1791644399999","17963460.04954570",26454,"102.80474000","8519371.06457750","0"]
]
```

Index map (all values are **strings** except index 0 and 8 — coerce with `Number()`/`parseFloat()`):

| # | Field | Type | Meaning |
|---|---|---|---|
| 0 | open time | **number** | ms epoch, candle **open** time |
| 1 | open | string | |
| 2 | high | string | |
| 3 | low | string | |
| 4 | close | string | |
| 5 | volume | string | base asset volume |
| 6 | close time | string | ms epoch (still a string!) |
| 7 | quote asset volume | string | e.g. USDT volume |
| 8 | number of trades | **number** | |
| 9 | taker buy base volume | string | |
| 10 | taker buy quote volume | string | |
| 11 | ignore | string | always `"0"` |

- Array is **oldest → newest** (ascending).
- The last candle is the **in-progress, uncommitted** candle.
- Request weight scales with `limit`: ≤100 → 1, ≤500 → 2, ≤1000 → 5, >1000 → 10.

### 1.5 `GET /api/v3/ticker/price`

```
GET https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT
GET https://api.binance.com/api/v3/ticker/price?symbols=["BTCUSDT","ETHUSDT"]
```
✅ **VERIFIED response:**
```json
{"symbol":"BTCUSDT","price":"82983.85000000"}
```
With `symbols=[...]` it returns an array of those objects. Omitting both params returns **every** symbol (~2400+ rows, weight 4).

### 1.6 `GET /api/v3/ticker/24hr`

```
GET https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT
```
✅ **VERIFIED exact field names:**
```json
{
  "symbol":"BTCUSDT",
  "priceChange":"-230.15000000",
  "priceChangePercent":"-0.277",
  "weightedAvgPrice":"82723.29898305",
  "prevClosePrice":"83214.00000000",
  "lastPrice":"82983.86000000",
  "lastQty":"0.00602000",
  "bidPrice":"82983.85000000",
  "bidQty":"5.16368000",
  "askPrice":"82983.86000000",
  "askQty":"9.53453400",
  "openPrice":"83214.01000000",
  "highPrice":"83236.01000000",
  "lowPrice":"82285.71000000",
  "volume":"9256.98545000",
  "quoteVolume":"765768375.06209530",
  "openTime":1791556563007,
  "closeTime":1791642963007,
  "firstId":6751285205,
  "lastId":6752265993,
  "count":980789
}
```
**Watch out:** `openTime`, `closeTime`, `firstId`, `lastId`, `count` are **numbers**; every price/volume field is a **string**. Rolling 24h window, not UTC calendar day. Omitting `symbol` returns an array of all symbols.

### 1.7 `GET /api/v3/exchangeInfo`

```
GET https://api.binance.com/api/v3/exchangeInfo?symbol=BTCUSDT
```
✅ **VERIFIED** — top-level keys: `timezone` (`"UTC"`), `serverTime`, `rateLimits`, `exchangeFilters`, `symbols`. Each symbol object includes `symbol`, `status`, `baseAsset`, `baseAssetPrecision`, `quoteAsset`, `quotePrecision`, `orderTypes`, `icebergAllowed`, `ocoAllowed`, `otoAllowed`, `opoAllowed`, `quoteOrderQtyMarketAllowed`, `allowTrailingStop`, `cancelReplaceAllowed`, `amendAllowed`, `pegInstructionsAllowed`, `isSpotTradingAllowed`, `isMarginTradingAllowed`, `filters[]`, `permissions[]`, `permissionSets[][]`.

The `filters[]` array is where tick size and step size live, e.g.:
```json
{"filterType":"PRICE_FILTER","minPrice":"0.01000000","maxPrice":"1000000.00000000","tickSize":"0.01000000"}
{"filterType":"LOT_SIZE","minQty":"0.00001000","maxQty":"9000.00000000","stepSize":"0.00001000"}
{"filterType":"NOTIONAL","minNotional":"5.00000000","applyMinToMarket":true,"maxNotional":"9000000.00000000"}
```
**Filter types confirmed present:** `PRICE_FILTER`, `LOT_SIZE`, `ICEBERG_PARTS`, `MARKET_LOT_SIZE`, `TRAILING_DELTA`, `PERCENT_PRICE_BY_SIDE`, `NOTIONAL`, `MAX_NUM_ORDERS`, `MAX_NUM_ORDER_LISTS`, `MAX_NUM_ALGO_ORDERS`, `MAX_NUM_ORDER_AMENDS`.

> ⚠️ Weight is **20** for a single symbol — 25× a klines call. Cache it hard (it changes on listings); do not poll per request.

`GET /api/v3/ping` → `{}` ✅ verified. `GET /api/v3/time` → `{"serverTime":...}`.

### 1.8 CORS

✅ **VERIFIED:** `Access-Control-Allow-Origin: *`. Irrelevant for your Node backend, but confirms browser-direct calls are viable if you ever want them.

---

## 2. Exchange Alternatives

### Summary matrix

| Exchange | Base URL | Key? | Rate limit (IP) | From India | Best for |
|---|---|---|---|---|---|
| **Binance** | `api.binance.com` | No | 6000 weight/min | ✅ 200 | Deepest liquidity, spot |
| **Bybit** | `api.bybit.com` | No | **600 req / 5 s** | ✅ 200 | Spot + derivatives, most generous |
| **Kraken** | `api.kraken.com` | No | Counter-based | ✅ 200 | Long-tail pairs, legacy reliability |
| **Coinbase Ex.** | `api.exchange.coinbase.com` | No | ~10 req/s public | ✅ 200 | US/EU pairs, clean REST |
| **OKX** | `www.okx.com` | No | 20–40 req / 2 s | ❌ **unreachable** | — do not use from India |

### 2.1 Bybit V5 — ✅ VERIFIED from India

```
GET https://api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=60&limit=2
GET https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT
```
No API key required. ✅ `/v5/market/tickers?category=spot` (no symbol) returned **528 tickers** successfully.

**✅ VERIFIED kline response — note `list` is NEWEST-FIRST (descending):**
```json
{"retCode":0,"retMsg":"OK",
 "result":{"category":"spot","symbol":"BTCUSDT","list":[
   ["1791640800000","82823.2","82987.4","82771.9","82983.3","108.707471","9009284.0764693"],
   ["1791637200000","82803.5","82861.8","82780","82823.2","76.087788","6302014.486644"]]},
 "retExtInfo":{},"time":1791642968574}
```
Array index: `[start, open, high, low, close, volume, turnover]` — **7 elements**, vs Binance's 12. Bybit has no trades count and no taker-buy split.

> ⚠️ **Order inversion bug waiting to happen:** Bybit descending, Binance ascending. Normalise with `.reverse()`.

**✅ VERIFIED ticker response:**
```json
{"retCode":0,"retMsg":"OK","result":{"category":"spot","list":[{
  "symbol":"BTCUSDT","bid1Price":"82983.2","bid1Size":"0.369756",
  "ask1Price":"82983.3","ask1Size":"1.121896","lastPrice":"82983.3",
  "prevPrice24h":"83220.5","price24hPcnt":"-0.0029",
  "highPrice24h":"83242.9","lowPrice24h":"82274",
  "turnover24h":"338601913.52111639","volume24h":"4093.685733"}]},
 "retExtInfo":{},"time":1791642968576}
```
Note `price24hPcnt` is a **decimal fraction** (`-0.0029` = −0.29%), not a percent.

**Rate limits** 📄 DOC-ONLY: **600 requests per 5 seconds per IP** by default, shared across `api.bybit.com` / `api.bybick.com` / `api.bybit.kz`. Exceeding it returns **HTTP 403** with body `"...visits!"`, and Bybit instructs you to stop all HTTP sessions and **wait ≥10 minutes** — the ban lifts automatically. Build in a client-side 600/5s token bucket. Error code `10006` also signals this.

**Geo** 📄 DOC-ONLY: US and mainland-China IPs get 403. **India is not restricted** — and Bybit **registered with FIU-IND in Feb 2025**. Confirmed working from my Indian IP.

Intervals (📄 DOC-ONLY): `1,3,5,15,30,60,120,240,360,480,720,D,W,M` — integers are **minutes**.

### 2.2 OKX V5 — ❌ UNREACHABLE FROM INDIA

```
GET https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=1H&limit=2
GET https://www.okx.com/api/v5/market/tickers?instType=SPOT
```

**❌ Both failed from India with `HTTP:000` — a TCP connection failure, not an HTTP error.** No status code was returned at all. I also tried the alternate AWS host `aws.okx.com/api/v5/public/time` — also `000`, failing in 1.3 s.

This is TCP-level blocking, consistent with the well-documented position that **OKX never completed FIU-IND PMLA registration and remains blocked for Indian IPs**, alongside Bitstamp, Bitfinex, Bittrex and Gate.io.

> **Recommendation: do not build against OKX from an Indian-hosted backend.** It will not return data regardless of headers or keys.

For reference (📄 DOC-ONLY, from non-Indian vantage points): public unauthenticated REST limits are per-endpoint per-IP in requests/2 s — tickers 20/2 s, order book and candles 40/2 s, trades 100/2 s, `history-candles` 20/2 s. Rejection returns error code `50011`. Responses wrap as `{"code":"0","msg":"","data":[...]}` — note `data` nests under an envelope and `candles` returns only the most recent ~1,440 entries (use `/market/history-candles` for older).

### 2.3 Kraken — ✅ VERIFIED, no key CONFIRMED

```
GET https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=60
GET https://api.kraken.com/0/public/Time
```
✅ **No API key — confirmed.** Returned HTTP 200 from India.

⚠️ **Legacy symbol naming:** Bitcoin is `XBT`, not `BTC`. Pair `XBTUSD`; USD is `ZUSD`/`USD`.

**✅ VERIFIED OHLC response:**
```json
{"error":[],"result":{"XXBTZUSD":[
  [1791640800,"82692.01","82909.54","82755.21","82864.13","34.93302738"],
  ...more rows...
],"last":1791488001}}
```
Format — **8 elements**, oldest → newest:
| # | Field |
|---|---|
| 0 | time (**seconds**, number) |
| 1 | open |
| 2 | high |
| 3 | low |
| 4 | close |
| 5 | **vwap** |
| 6 | volume |
| 7 | count (number) |

> ⚠️ Index 5 is **VWAP**, not volume. Volume is index 6. Easy off-by-one.

📄 DOC-ONLY constraints:
- **Max 720 entries**, and *older data cannot be retrieved at all regardless of `since`*. This is a hard truncation ceiling — a serious limitation for historical work. Binance (1000/request, unlimited depth) is far better.
- `interval` is **integer minutes**, enum: `1, 5, 15, 30, 60, 240, 1440, 10080, 21600`.
- `result.last` is the ID to pass as `since` for incremental polling.
- `assetVersion=1` switches keys from legacy `XXBTZUSD` to display `BTC/USD`.
- **CORS:** ✅ verified — `access-control-allow-credentials: true`, `vary: Accept-Encoding, origin`. Slightly stricter than a bare `*`.
- Rate limits are counter-based per endpoint, with a `Backoff` header on 429.

### 2.4 Coinbase Exchange — ✅ VERIFIED, no key CONFIRMED

**Legacy/Exchange API (spot) — confirmed no key:**
```
GET https://api.exchange.coinbase.com/products
GET https://api.exchange.coinbase.com/products/BTC-USD/ticker
GET https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600
GET https://api.exchange.coinbase.com/time
```
✅ `/products` → 200. ✅ `/time` → `{"iso":"2026-10-10T14:40:37.999Z","epoch":1791643237.999}`.

✅ **VERIFIED ticker:**
```json
{"ask":"82905.82","bid":"82905.81","volume":"2518.39622855","trade_id":1104522697,
 "price":"82905.81","size":"0.01532045","time":"2026-10-10T14:36:32.538912459Z",
 "rfq_volume":"138.868812"}
```
✅ **VERIFIED candles — newest-first, 6 elements:**
```json
[[1791640800,82692.01,82909.54,82755.21,82864.13,34.93302738], ...]
```
`[time(sec), low, open, high, close, volume]` — ⚠️ **low/open**, not open/high. Note also `volume` is the **last** element here (vs Kraken where index 6 is volume and 5 is vwap).

`granularity` is an **integer number of seconds** — valid: `60, 180, 300, 900, 1800, 3600, 21600, 86400`.

**Advanced Trade API (`api.coinbase.com/api/v3/brokerage/...`) — ALSO no-key, verified twice:**
```
GET https://api.coinbase.com/api/v3/brokerage/market/products/BTC-USD/ticker
GET https://api.coinbase.com/api/v3/brokerage/market/products/BTC-USD/candles?granularity=ONE_HOUR&start=1791460800&end=1791547200
```
✅ **VERIFIED 200 with completely empty headers** — no `api_key`, no `CB-ACCESS-SIGN`. Public market data on the newer API is currently unauthenticated.

✅ **VERIFIED response** — note this shape is **totally different** from the Exchange API:
```json
{"candles":[{"start":"1791547200","low":"82854.64","high":"83354.99","open":"83169.38",
  "close":"82954.05","volume":"336.77103348"}, ...],
 "best_bid":"82906.29","best_ask":"82906.3"}
```
- `granularity` uses **SCREAMING enum strings**: `ONE_MINUTE, FIVE_MINUTE, FIFTEEN_MINUTE, THIRTY_MINUTE, ONE_HOUR, TWO_HOUR, SIX_HOUR, ONE_DAY, ONE_WEEK`.
- `start`/`end` must be **Unix seconds as strings** (I confirmed `start=2026-10-09T00:00:00Z` is **rejected**: `{"error":"INVALID_ARGUMENT","error_details":"Invalid start timestamp"}`).
- `/ticker` returns `{"trades":[...],"best_bid":"...","best_ask":"..."}` — last ~100 trades, newest-first.
- ⚠️ The response is a **top-level JSON object, not an array** — easy to mis-parse.

✅ **CORS on Exchange API:** `access-control-allow-origin: *`, `access-control-expose-headers: cb-before, cb-after, cb-gdpr`, `access-control-max-age: 7200`.

📄 DOC-ONLY rate limit: public endpoints ~**10 requests/second** per IP.

### 2.5 Best free rate limits — ranking

1. **Bybit — 600 req / 5 s per IP** (= 120 req/s). Best by a wide margin, no key needed.
2. **Binance — 6000 weight/min** (≈100 req/s if using cheap endpoints). Practically equivalent, and deeper liquidity.
3. **Coinbase — ~10 req/s.**
4. **Kraken — counter-based, lowest.**
5. **OKX — unreachable from India.**

---

## 3. CoinGecko API

**Base URL:** `https://api.coingecko.com/api/v3/` · **Pro:** `https://pro-api.coingecko.com/api/v3/`

### 3.1 Does the no-key public API still work in 2026? — ✅ YES, VERIFIED

```bash
curl https://api.coingecko.com/api/v3/ping
# → 200 {"gecko_says":"(V3) To the Moon!"}
```
✅ `/coins/markets`, `/global`, `/search/trending`, `/simple/price` all returned 200 from India with no key, no headers.

### 3.2 Rate limits — your "30 calls/min" figure is outdated

⚠️ **CORRECTION — two distinct tiers exist and the commonly cited number is stale:**

| Tier | Rate limit | Auth |
|---|---|---|
| **Keyless** (no account) | **~10–30 calls/min, dynamic** — varies by server load worldwide | none |
| **Demo** (free account) | **100 calls/min** + **10,000 calls/month** | `x-cg-demo-api-key` header |

📄 DOC-ONLY both figures. The 100/min figure is from CoinGecko's current pricing table (Demo: 10k credits/mo, 100 calls/min, 1 key, data from 60 s). The older support article still says "30 calls/min" — that is stale.

> **Recommendation: create the free Demo account.** It is genuinely free, requires only an email, takes ~1 minute, and triples your ceiling to 100/min plus gives you a stable limit. Do it from a server IP so the shared-IP keyless pool doesn't throttle you.

**Keyless caution** 📄 DOC-ONLY: the limit is **IP-based and shared across every anonymous user on that IP**. If you deploy on a shared NAT/VPS you will be throttled by strangers. Also explicitly documented as *"not suitable for production workloads, scheduled polling, or high-frequency updates."*

**Auth header if you take a Demo key:**
```
x-cg-demo-api-key: YOUR_KEY      # recommended
x_cg_demo_api_key=YOUR_KEY       # query string — avoid in prod
```
Base URL stays `api.coingecko.com` for Demo keys; `pro-api.coingecko.com` for Pro (using the wrong host → error `10010`/`10011`).

**⚠️ Rate-limit headers are absent.** ✅ VERIFIED — neither `/ping` nor `/simple/price` returned any `x-ratelimit-remaining` / `x-ratelimit-limit` header. You **cannot** read your remaining budget from headers on the free tier; you must self-throttle and handle `429`.

📄 DOC-ONLY: **all requests count toward the limit, including 4xx and 5xx errors.** Guard against retrying errors in a tight loop.

### 3.3 Endpoints

**`GET /coins/markets`** — ✅ VERIFIED live response (exact field names):
```json
[{
  "id":"bitcoin","symbol":"btc","name":"Bitcoin",
  "image":"https://coin-images.coingecko.com/coins/images/1/large/bitcoin.png?1696501400",
  "current_price":82894,"market_cap":1665605542126,"market_cap_rank":1,
  "fully_diluted_valuation":1665607614177,"total_volume":18172836237,
  "high_24h":83003,"low_24h":82229,
  "price_change_24h":-235.67313165674568,"price_change_percentage_24h":-0.2835,
  "market_cap_change_24h":-4937935340.933105,"market_cap_change_percentage_24h":-0.29559,
  "circulating_supply":20096093.0,"total_supply":20096150.0,"max_supply":21000000.0,
  "ath":126080,"ath_change_percentage":-34.25272,"ath_date":"2025-10-06T10:57:42.000Z",
  "atl":67.81,"atl_change_percentage":122146.44309,"atl_date":"2013-07-05T16:00:00.000Z",
  "roi":null,"last_updated":"2026-10-10T14:36:55.000Z"
}]
```
Unlike Binance/Bybit, **CoinGecko returns typed numbers, not strings** — no coercion needed.

Params: `vs_currency` (required, e.g. `usd`, `inr`), `order=market_cap_desc`, `per_page` (max 250), `page`, `sparkline` (`true`/`false` — **omit entirely rather than `false`**, it is a heavy field), `price_change_percentage=1h,24h,7d,14d,30d,200d,1y`.

**`GET /global`** — ✅ VERIFIED. Wrapped: `{"data":{...}}` — note the extra level.
```json
{"data":{
  "active_cryptocurrencies":22125,"markets":1507,
  "total_market_cap":{"usd":2816852447948.6416,"inr":272602371680912.53,"btc":34018814.76, ...},
  "total_volume":{"usd":54873307545.55,...},
  "market_cap_percentage":{"btc":59.07,"eth":10.85,"usdt":6.53,...},
  "market_cap_change_percentage_24h_usd":-2.12,
  "updated_at":1791642978}}
```
`updated_at` is **Unix seconds**. `total_market_cap` and `total_volume` are keyed by ~60 currency codes including **`inr`**.

**`GET /search/trending`** — ✅ VERIFIED. Shape has **expanded** — it is no longer just `{coins:[...]}`. Top-level keys now:
```json
{"coins":[...], "nfts":[...], "rwas":[...], "categories":[...]}
```
`rwas` (real-world assets: NVDA, XAU/gold, SPY, SpaceX…) is **new** — code written against the old `{coins}` contract will not break but will silently miss data. `categories` entries are extremely heavy: each contains a `market_cap_change_percentage_24h` object with **hundreds of currency keys**.

Other useful: `/coins/{id}` (has `market_data`, `community_data`, `developer_data`), `/coins/{id}/market_chart`, `/simple/price?ids=bitcoin&vs_currencies=usd,eur` ✅ verified 200, `/coins/list`.

### 3.4 CORS

✅ **VERIFIED** — full permissive header set on every response:
```
access-control-allow-origin: *
access-control-allow-methods: POST, PUT, DELETE, GET, OPTIONS
access-control-allow-headers: Origin, X-Requested-With, Content-Type, Accept, Authorization
access-control-expose-headers: link, per-page, total
```
Also `vary: Accept-Encoding, Origin`, `etag`, `x-request-id` (useful for support), `x-runtime`, Cloudflare-fronted. A dedicated CORS error code is documented — 📄 DOC-ONLY — telling you to proxy through a backend, which is what you're doing anyway.

---

## 4. Crypto News

### 4.1 CryptoPanic — ❌ NO LONGER FREE. Plan this accordingly.

**⚠️ MAJOR CORRECTION — your brief assumes a free tier that no longer exists.**

📄 DOC-ONLY, from the official plans page: *"Notice: the free Developer API plan is discontinued and will be removed on **April 1st, 2026**. Please upgrade to a paid plan to continue using the API."*

| Plan | Price | Rate limit | Quota | History |
|---|---|---|---|---|
| ~~Developer~~ | **discontinued Apr 2026** | — | — | — |
| Growth weekly | **$50/week** | 10 req/s | 600 req/week | 1 month |
| Growth | $199/mo ($179/mo annual) | — | 3,000 req/mo | 1 year |
| Enterprise | from $899/mo | custom | custom | 1 year |

> **Minimum realistic spend is now $50/week (~$200/month).** There is no free tier. If the budget is genuinely $0, CryptoPanic is off the table — use RSS (§4.2).

**Additionally ❌ BLOCKED from India:** my request to `cryptopanic.com/api/v1/posts/?auth_token=DEMO` returned **HTTP 403** behind a Cloudflare "Sorry, you have been blocked" interstitial. Note the block hit an obviously bogus token, so this may be generic bot-scoring rather than geo — but combined with the paid requirement, it is doubly unattractive from India.

**API shape for reference** (📄 DOC-ONLY — note the **v2** path, not v1 as in your brief):
```
https://cryptopanic.com/api/<plan>/v2/posts/
```
- Auth: `auth_token` **query parameter** (required on every request).
- `posts/` fields: `id`, `title`, `url`, `source`, `author`, `published_at`, `currencies`, `domain_id`, `sentiment` (`positive`/`negative`/`neutral`), `kind` (`news`/`media`/`poll`), `panic_score`.
- Query params: `currencies` (comma-separated), `kind` (`news`/`media`/`all`), `filter` (`rising`,`hot`,`bullish`,`bearish`,`important`,`saved`,`lol`), `regions`, `page` (1–50), `size` (1–50, Enterprise only), `format=rss` (capped at 20 items).
- There is **no `/news` JSON endpoint** — `news/rss/` is RSS only. `sources/`, `version/`, `portfolio/` also exist (`portfolio` is Growth/Enterprise only).
- Response envelope has `results`, plus `next` and `previous` URLs for pagination.

**Recommendation: skip CryptoPanic.** RSS gives you the same headlines for free.

### 4.2 RSS feeds — ✅ ALL SIX VERIFIED LIVE FROM INDIA

RSS is the right answer here: no key, no quota, no CORS, no signing, and it is what actually stays up.

| Source | URL | Status | Content-Type |
|---|---|---|---|
| CoinDesk | `https://www.coindesk.com/arc/outboundfeeds/rss/` | ✅ 200, 30 KB | `application/xml` |
| CoinTelegraph | `https://cointelegraph.com/rss` | ✅ 200, 53 KB | `application/xml; charset=utf-8` |
| Cointelegraph (BTC tag) | `https://cointelegraph.com/rss/tag/bitcoin` | ✅ 200, 53 KB | `application/xml; charset=utf-8` |
| Decrypt | `https://decrypt.co/feed` | ✅ 200, 42 KB | `application/xml` |
| Bitcoin Magazine | `https://bitcoinmagazine.com/.rss/full/` | ✅ 200, 59 KB | `application/rss+xml; charset=UTF-8` |
| Bitcoin.com News | `https://news.bitcoin.com/feed/` | ✅ 200, 29 KB | `application/rss+xml; charset=UTF-8` |

All fetched with a browser User-Agent and followed redirects (`-L`). None required authentication.

**✅ VERIFIED item structure** (CoinTelegraph — note standard RSS 2.0 plus extras):
```xml
<item>
  <title>Here's what happened in crypto today</title>
  <pubDate>Sat, 10 Oct 2026 12:30:00 +0000</pubDate>
  <atom:updated>Sat, 10 Oct 2026 12:41:11 +0000</atom:updated>
  <guid isPermaLink="true">https://cointelegraph.com/news/what-happened-in-crypto-today</guid>
  <link><![CDATA[https://cointelegraph.com/news/...?utm_source=rss_feed&utm_medium=rss&utm_campaign=rss_partner_inbound]]></link>
  <description><![CDATA[<p style="..."><img src="..." class="type:primaryImage"></p><p>Need to know...</p>]]></description>
  <dc:creator>Cointelegraph by Michael Millard</dc:creator>
  <media:content url="https://s3-images.ctmedia.io/media/article-covers/..." />
</item>
```

Practical notes for a Node parser:
- `<description>` is **HTML**, not plain text. Strip tags before display. Same for CoinDesk's `<content:encoded>`.
- `<link>` is wrapped in `CDATA` **and** carries `utm_*` tracking parameters — strip them.
- `pubDate` is **RFC-822 with numeric-offset** (`+0000`), not ISO-8601. `new Date()` parses it fine; `new Date(x).toISOString()` after.
- CoinTelegraph adds `<atom:updated>` alongside `<pubDate>` — prefer `<atom:updated>` if you want edit time.
- `<dc:creator>` and `<media:content>` are namespaced; enable namespace handling in your XML parser.
- Polling every 5–15 min is polite. Cache aggressively — this data is not high-frequency.

### 4.3 Other no-key news options

📄 DOC-ONLY (not fetched): Google News RSS supports a crypto query with no key —
`https://news.google.com/rss/search?q=bitcoin+when:1h&hl=en-US&gl=US&ceid=US:en`.
The `when:` operator gives you recency control. Useful as a broad-net fallback when the curated feeds are quiet. Be aware of the ToS posture around automated Google News consumption.

---

## 5. Indian Equity & F&O Market Data

### 5.1 NSE India public endpoints — ⚠️ PARTIAL: only some work without auth

**❌ No API key exists for any of these.** Access control is **Akamai/WAF + session-cookie based**, and I found the endpoints fall into three distinct groups.

✅ **Group A — works with a bare User-Agent + Referer, no cookie bootstrap (VERIFIED, repeated):**

| Endpoint | Result | Payload |
|---|---|---|
| `https://www.nseindia.com/api/marketStatus` | ✅ 200, 2,087 B | market state |
| `https://www.nseindia.com/api/allIndices` | ✅ 200, 113,871 B | **139 indices** |
| `https://www.nseindia.com/api/holiday-master?type=trading` | ✅ 200, 34,022 B | **holiday calendar** |
| `https://www.nseindia.com/api/live-analysis-variations?index=gainers&type=FOSec&market=capital` | ✅ 200, 38,968 B | gainers/losers |

❌ **Group B — blocked from plain server requests (VERIFIED, 5+ retries each):**

| Endpoint | Result |
|---|---|
| `https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%2050` | ❌ **404** (386 B "Resource not found") |
| `https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY` | ❌ **404** |
| `https://www.nseindia.com/api/quote-equity?symbol=RELIANCE` | ❌ **403** |

⚠️ **Group C — the cookie bootstrap itself is blocked:** `GET https://www.nseindia.com/` → **HTTP 403**.

**What this means practically.** The two endpoints most people actually want — **stock constituents and the F&O option chain — are exactly the two that fail.** And you cannot work around it with the documented cookie-priming flow, because the homepage that mints the cookie returns 403 to a non-browser client. I tried `NIFTY%2050`, `NIFTY+50`, `NIFTY%20F%26O`, `NIFTY%20BANK`, `\NIFTY` and symbols `NIFTY`/`nifty`/`BANKNIFTY`/`FINNIFTY` — **all** 404. This is deliberate WAF behaviour keyed to TLS/header fingerprinting, not a URL-encoding mistake.

**Minimum working headers** (verified sufficient for Group A):
```
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36
            (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36
Accept: */*
Referer: https://www.nseindia.com/
```

> **Recommendation: do not build your F&O option chain on NSE's site directly.** It is unstable and deliberately hostile to servers. Use **Yahoo Finance** (§5.2) for equities/indices, and for the option chain either find a permitted data vendor or accept that a browser-automation layer is required. NSE explicitly sells this data commercially — the blocks are licensing enforcement.

### 5.2 `GET /api/marketStatus` — ✅ VERIFIED response

```json
{"marketState":[
  {"market":"Capital Market","marketStatus":"Close","tradeDate":"09-Oct-2026 15:30",
   "index":"NIFTY 50","last":22520.45,"variation":288.65000000000146,
   "percentChange":1.3,"marketStatusMessage":"Market is Closed"},
  {"market":"Currency","marketStatus":"Close","tradeDate":"09-Oct-2026", ...},
  {"market":"Commodity","marketStatus":"Close", ...},
  {"market":"Debt","marketStatus":"Close", ...}],
 "marketcap":{"timeStamp":"09-Oct-2026","marketCapinTRDollars":4.77,
   "marketCapinLACCRRupees":461.32,"marketCapinCRRupees":46132368.59,
   "underlying":"Market Cap"},
 "indicativenifty50":{"change":288.65,"closingValue":22520.45,
   "dateTime":"09-Oct-2026 15:30","finalClosingValue":22520.45,
   "indexName":"NIFTY 50","perChange":1.3,"status":"CLOSE"},
 "giftnifty":{"CONTRACTSTRADED":68954,"DAYCHANGE":-27,"EXPIRYDATE":"27-Oct-2026",
   "INSTRUMENTTYPE":"FUTIDX","LASTPRICE":22575.5,"PERCHANGE":-0.12,
   "STRIKEPRICE":0,"SYMBOL":"NIFTY","TIMESTMP":"10-Oct-2026 02:30",
   "id":"0/NIFTYFUTIDX27-Oct-2026--"},
 "niftyusd":{"index":"NIFTY50 USD","last":8068.1,"percentChange":1.36}}
```

**`marketState` values:** `"Open"`, `"Close"`, `"Pre Open"` — this is your primary market-is-open check.

⚠️ **Note the GIFT Nifty timestamp is in IST (`02:30`) while every other field is in a different frame — `TIMESTMP":"10-Oct-2026 02:30"` is 10 Oct 02:30 IST, i.e. GIFT Nifty (GIFT City) trades 24×7 and is on a different clock.** Do not naively parse all timestamps as one timezone.

⚠️ **Type inconsistency:** `variation`/`percentChange` are **numbers** on `Capital Market` but **empty strings** `""` on Currency/Commodity/Debt. Handle both.

### 5.3 `GET /api/allIndices` — ✅ VERIFIED (best NSE endpoint available)

Top-level keys: `data`, `timestamp`, `advances`, `declines`, `unchanged`, `dates`. **139 entries.**

```json
{"data":[{
  "key":"INDICES ELIGIBLE IN DERIVATIVES","index":"NIFTY 50","indexSymbol":"NIFTY 50",
  "last":22520.45,"variation":288.65,"percentChange":1.3,
  "open":22314.95,"high":22580.75,"low":22294.75,"previousClose":22231.8,
  "yearHigh":26373.2,"yearLow":22179.9,"indicativeClose":0,
  "pe":"19.27","pb":"2.77","dy":"1.52",
  "declines":"4","advances":"46","unchanged":"0",
  "perChange365d":-10.57,"perChange30d":-3.89,
  "date365dAgo":"09-Oct-2025","date30dAgo":"09-Sep-2026",
  "previousDay":"09-Oct-2026","oneWeekAgo":"01-Oct-2026",
  "oneMonthAgoVal":23431.5,"oneWeekAgoVal":22421.95,"oneYearAgoVal":25181.8,
  "previousDayVal":22520.45,
  "chart365dPath":"https://nsearchives.nseindia.com/365d/NIFTY-50.svg",
  "chart30dPath":"https://nsearchives.nseindia.com/30d/NIFTY-50.svg",
  "chartTodayPath":"https://nsearchives.nseindia.com/today/NIFTY-50.svg"}],
 "timestamp":"09-Oct-2026 15:30","advances":"...","declines":"...","unchanged":"..."}
```

> 💡 **`chartTodayPath` / `chart30dPath` / `chart365dPath`** — these are free intraday/30-day/1-year intraday chart **SVG** URLs. Undocumented as an API and untested by me, but they are a plausible zero-cost route to intraday index history. Worth probing before you build anything else.

⚠️ **`pe`, `pb`, `dy`, `declines`, `advances`, `unchanged` are strings;** `last`, `variation`, `percentChange`, `open`, `high`, `low`, `previousClose` are numbers. Mixed types within one object.

⚠️ `timestamp` format is `"09-Oct-2026 15:30"` — non-ISO. Parse manually with `"DD-Mon-YYYY HH:mm"`; JS `Date` will read `Oct` but is unreliable here.

### 5.4 `GET /api/holiday-master?type=trading` — ✅ VERIFIED **this is the holiday API you asked about**

**It exists and it works with no auth.** ✅

Top-level keys (12 segment buckets):
```
CBM  CD  CM  CMOT  COM  EGR  FO  IRD  MF  NDM  NTRP  SLBS
```
| Key | Segment |
|---|---|
| `CM` | Capital Market (equity) — 20 holidays |
| `FO` | **F&O / Equity Derivatives** — 20 holidays |
| `CD` | Currency Derivatives — 24 |
| `COM` | Commodity — 21 |
| `IRD` | Interest Rate Derivatives — 24 |
| `MF`, `SLBS`, `NDM`, `EGR`, `CBM`, `CMOT`, `NTRP` | Mutual funds, SLB, NDM, EGR, currency futures / corporate bond MO, currency opt, trade reporting |

> ⚠️ **The F&O bucket is `FO`, not `FNO`.** This is the single easiest mistake here — `o.FNO` is `undefined` and will throw. Use `o.FO`.

**✅ VERIFIED element shape:**
```json
{"tradingDate":"26-Jan-2026","weekDay":"Monday","description":"Republic Day",
 "morning_session":null,"evening_session":null,"Sr_no":2}
```

- `tradingDate` format: `"DD-Mon-YYYY"` (e.g. `"15-Jan-2026"`).
- `description` is free text (e.g. `"Municipal Corporation Election - Maharashtra"`).
- `morning_session` / `evening_session` carry `"Open"`/`"Closed"` **only for the commodity segment**, where sessions can be partially open. For `CM`/`FO`/`CD` they are always `null`.
- `Sr_no` is 1-based and matches the printed order.

Verified 2026 samples: 15-Jan (Municipal Corporation Election – Maharashtra), 26-Jan Republic Day, 15-Feb Mahashivratri, 03-Mar Holi, 21-Mar Id-Ul-Fitr.

**Usage:** build a `Set` of `tradingDate` strings per segment and skip signal generation on matches. Note this returns the **full calendar year**, so filter to the current year client-side.

📄 DOC-ONLY: NSE also maintains a human-readable list at `https://www.nseindia.com/resources/exchange-communication-holidays`, which notes that **8 Nov 2026 (Diwali Laxmi Pujan)** is a trading holiday **with Muhurat Trading conducted** — timings notified later by circular.

### 5.5 Yahoo Finance — ✅ VERIFIED, and the best free Indian-equity source

**⚠️ IMPORTANT CHANGE vs. common lore: Yahoo now requires a cookie + crumb.** My first call succeeded by luck; every subsequent bare call returned `{"chart":{"result":null,"error":{"code":"Not Found","description":"No data found, symbol may be delisted"}}}`. That misleading "delisted" message means **auth failure, not a bad ticker** — it is the most common confusion with this API.

**Verified 3-step handshake from Node:**
```
1)  GET  https://fc.yahoo.com/                          → seeds A1/A3 cookies into a jar
2)  GET  https://query1.finance.yahoo.com/v1/test/getcrumb   → returns e.g. npi4X.LYHXg
3)  GET  https://query1.finance.yahoo.com/v8/finance/chart/<SYMBOL>?range=1d&interval=1d&crumb=<CRUMB>
```
With a browser `User-Agent` on all three. ✅ Verified — step 2 returned `npi4X.LYHXg` and step 3 then returned full data.

**No API key. No account. No payment.** Still the best option in this whole document for Indian equities.

**✅ VERIFIED symbol coverage:**

| Symbol | Result |
|---|---|
| `RELIANCE.NS` | ✅ INR 1170.30 — `EQUITY` / `NSE` |
| `TCS.NS` | ✅ INR 2156.00 — `EQUITY` / `NSE` |
| `%5ENSEI` (i.e. `^NSEI`) | ✅ INR 22520.45 — `INDEX` / `NSE` |
| `%5EBSESN` (i.e. `^BSESN`) | ✅ INR 72472.33 — `INDEX` / `BSE` |
| `INR=X` | ✅ INR 96.73 — `CURRENCY` / `CCY` |
| `BTC-USD` | ✅ USD 82946.42 — **`CRYPTOCURRENCY` / `CCC`** |
| `NIFTY_FUTURES.NS` | ❌ Not Found |
| `NIFTY26OCTFUT.NS` | ❌ Not Found |
| `NSEI.NS` | ❌ Not Found |

**✅ Yes, Yahoo covers crypto — CONFIRMED.** `BTC-USD` returns:
```json
{"chart":{"result":[{"meta":{"currency":"USD","symbol":"BTC-USD",
  "exchangeName":"CCC","fullExchangeName":"CCC","instrumentType":"CRYPTOCURRENCY",
  "firstTradeDate":1410912000,"regularMarketTime":1791643202,
  "timezone":"UTC","exchangeTimezoneName":"UTC",
  "regularMarketPrice":82946.42,"regularMarketChangePercent":-0.007,
  "fiftyTwoWeekHigh":116273.31,"fiftyTwoWeekLow":57747.766, ...}}],"error":null}}
```
This is the single best zero-cost crypto fallback: `BTC-USD`, `ETH-USD`, and thousands of other `-USD` pairs.

**✅ VERIFIED Indian equity response shape:**
```json
{"chart":{"result":[{
  "meta":{"currency":"INR","symbol":"RELIANCE.NS","exchangeName":"NSI",
    "fullExchangeName":"NSE","instrumentType":"EQUITY","firstTradeDate":820467900,
    "regularMarketTime":1791539100,"hasPrePostMarketData":false,
    "gmtoffset":19800,"timezone":"IST","exchangeTimezoneName":"Asia/Kolkata",
    "regularMarketPrice":1170.3,"regularMarketChangePercent":-0.654,
    "fulldayPrice":1170.3,"fulldayChange":-7.7,"fulldayChangePercent":-0.654,
    "fiftyTwoWeekHigh":1611.8,"fiftyTwoWeekLow":1160.2,
    "regularMarketDayHigh":1179.0,"regularMarketDayLow":1160.2,
    "regularMarketVolume":12081697,
    "longName":"Reliance Industries Limited","shortName":"RELIANCE INDUSTRIES LTD",
    "chartPreviousClose":1178.0,"priceHint":2,
    "currentTradingPeriod":{"pre":{"timezone":"IST","start":1791517500,"end":1791517500,"gmtoffset":19800},
      "regular":{"timezone":"IST","start":1791517500,"end":1791540000,"gmtoffset":19800},
      "post":{"timezone":"IST","start":1791540000,"end":1791540000,"gmtoffset":19800}},
    "dataGranularity":"1d","range":"1d",
    "validRanges":["1d","5d","1mo","3mo","6mo","1y","2y","5y","10y","ytd","max"]},
  "timestamp":[1791517500],
  "indicators":{"quote":[{"low":[1160.199951171875],"open":[1179.0],"high":[1179.0],
    "close":[1170.300048828125],"volume":[12086708]}],
    "adjclose":[{"adjclose":[1170.300048828125]}]}}],"error":null}}
```

**Critical structural points — Yahoo is parallel-array based:**
- `meta` = the quote/summary block.
- `timestamp` = array of Unix **seconds**.
- `indicators.quote[0]` = object with `open[]`, `high[]`, `low[]`, `close[]`, `volume[]` — **each a separate array, index-aligned with `timestamp`**. Yahoo does **not** return per-candle objects.
- `indicators.adjclose[0].adjclose[]` = split/dividend-adjusted closes. Use for backtests, `quote.close` for live marks.
- ⚠️ Arrays can contain **`null`** for non-trading intervals. Always null-check before `toFixed()`.
- ⚠️ Values come back with float noise (`1160.199951171875`) because of the float32 wire encoding. Round explicitly before display.

**✅ `currentTradingPeriod.regular` is the authoritative timing source.** For RELIANCE.NS: `1791517500` → `1791540000`, a span of **22,500 s = 6h15m = exactly 09:15–15:30 IST**. This independently confirms the equity session and is machine-readable, which NSE's own HTML is not.

**Params:** `range` (`1d,5d,1mo,3mo,6mo,1y,2y,5y,10y,ytd,max`) or `period1`/`period2` (Unix seconds). `interval`: `1m,2m,5m,15m,30m,60m,90m,1h,1d,5d,1wk,1mo,3mo`. Add `includePrePost=false`, `events=div,split`, `interval=1m&range=1d` for intraday.

⚠️ **Yahoo intraday limits are real:** ~30 days for `1m`, ~60 days for `5m`, `1h` capped near 730 days. And per your note that CORS matters less — ✅ **confirmed Yahoo sends `vary: Accept-Encoding, origin` and is browser-callable**, though you are correctly routing through Node anyway.

### 5.6 Recommended Indian data stack

```
Index levels + market status  →  NSE /api/allIndices  +  /api/marketStatus   (both ✅ free, no key)
Holiday calendar             →  NSE /api/holiday-master?type=trading  (bucket "FO" not "FNO")
Individual equity OHLCV      →  Yahoo ^NSEI / SYMBOL.NS   (cookie + crumb required)
Crypto fallback              →  Yahoo BTC-USD            (no exchange dependency)
Option chain                 →  ⚠️ NO FREE RELIABLE SOURCE — see note
```

⚠️ **On the F&O option chain specifically:** every free avenue I tested is closed — NSE's `/api/option-chain-indices` is WAF-blocked (404), Yahoo has **no** NSE futures/options symbols (verified 3 candidates, all Not Found), and the exchange licenses this data commercially. If live option chain is a hard requirement, budget for a paid feed or a browser-automation layer, and treat anything else as unverified. Do not assume it is solvable for $0.

---

## 6. India Trading Hours (2026)

### ⚠️ Your F&O figure needs correcting

**Equity Derivatives now close at 15:40, not 15:30.**

✅ **VERIFIED against the official NSE Market Timings page** (`https://www.nseindia.com/static/market-data/market-timings`), and independently corroborated by **exchange circular NSE/FAOP/74467** (issued 29 May 2026, **effective 3 August 2026**), referenced alongside NSE/CMTR/73362 (18 Mar 2026) and NSE/CMTR/72394 (19 Jan 2026) which introduced a Closing Auction Session in the equity cash segment:

> *"Normal Market Close Time — 15:40 hrs — **Change in time**"*

The 10-minute extension aligns equity derivatives with the new equity cash CAS window. Trade modification end time stays 16:15. The VWAP window for close-price computation moves from 15:10–15:30 to **15:10–15:40**. Close-price *logic* is unchanged. Applies to **both index and stock** futures and options.

### Current timings (all IST, ✅ VERIFIED from official NSE page)

**Equities (cash):**
| Session | Time |
|---|---|
| Block Deal session 1 | 08:45 – 09:00 |
| Pre-open session (Regular) | 09:00 – 09:08 *(random closure in final minute)* |
| Normal / Odd lot market | **09:15 – 15:30** |
| T+0 market | 09:15 – 13:30 (trade modification to 13:45) |
| Call Auction Illiquid | 6 × 1-hour sessions from 09:30 |
| SPOS close | 09:45 |
| Auction market | 14:00 – 14:30 |
| Block Deal session 2 | 14:05 – 14:20 |
| Closing session (CAS) | 15:40 – 16:00 |
| **Trade Modification cut-off** | **16:15** |

> Note the equity cash *normal* session is 09:15–**15:30**, and the closing auction is a **separate** 15:40–16:00 session. So "market is open" is genuinely three-valued: pre-open (09:00–09:15), normal (09:15–15:30), closing/CAS (15:40–16:00) — with a dead gap 15:30–15:40.

**Equity Derivatives (F&O):**
| Session | Time |
|---|---|
| Pre-open | 09:00 – 09:08 |
| Normal Market | **09:15 – 15:40** ⬅ *changed 3 Aug 2026* |
| Trade Modification End | 16:15 |

**Currency Derivatives:**
| Segment | Open | Close |
|---|---|---|
| USDINR, EURINR, GBPINR, JPYINR; T-Bills & IR futures/options | 09:00 | **17:00** |
| Cross-currency (EURUSD, GBPUSD, USDJPY) | 09:00 | 19:030 |

Trade modification: 17:30 (standard) / 19:45 (cross-currency). No pre-open or closing call auction. Opens Mon–Sat, closed Sundays and declared holidays.

**Securities Lending & Borrowing:** 09:15 – 17:00.

**Commodity Derivatives:** morning **09:00 – 17:00**, evening **17:00 – 23:30** (23:55 when US DST is in effect). Trade modification ends 11:45 PM / 11:59 PM. ⚠️ Note this is **MCX on NSE**, and it now runs to **23:30 / 23:55** — your "9:15–23:30" is wrong on both ends; the commodity morning session opens at **09:00**, not 09:15.

**Corporate Bonds (NDS-OM):** 09:00 – 17:00, collateral cut-off 17:20.

### ⏱ Hard-coding these is a mistake

```js
const IST_OFFSET_MIN = 330;           // +05:30
const SESSIONS = {
  equity:  { open:'09:15', close:'15:30', casClose:'16:00' },  // CAS 15:40-16:00
  fnf:     { open:'09:15', close:'15:40' },                    // changed Aug 2026
  currency:{ open:'09:00', close:'17:00' },
  commodity:{ open:'09:00', close:'23:30' },                  // 23:55 in US DST
};
```
Convert using `Date.UTC(y,m,d,hh,mm) - 330*60000` — **not** naive local time, and not a fixed UTC offset, since **IST observes no DST**. That absence of DST is a genuine convenience for Indian scheduling.

Better still, derive them at runtime from:
1. `marketStatus[].marketStatus` (`"Open"`/`"Close"`/`"Pre Open"`) — per-segment truth from NSE;
2. Yahoo `meta.currentTradingPeriod.regular` ✅ verified — machine-readable epoch bounds;
3. `/api/holiday-master` `CM`/`FO`/`CD`/`COM` buckets — skip holidays entirely.

Use those as runtime truth and keep the table only as a fallback.

**Muhurat Trading** 📄 DOC-ONLY: special evening session on Diwali. **8 Nov 2026 (Sunday)** will have Muhurat Trading with timings notified by a later circular — your holiday logic must not simply black out that date, or you will miss the one session where retail volume spikes.

---

## 7. Implementation Notes

### CORS summary

| Source | CORS | Irrelevant for Node? |
|---|---|---|
| Binance | ✅ `Access-Control-Allow-Origin: *` | Yes |
| Bybit | ✅ permissive | Yes |
| CoinGecko | ✅ `*` + exposed headers | Yes |
| Coinbase Exchange | ✅ `*`, `max-age: 7200` | Yes |
| Kraken | ✅ `allow-credentials: true`, `vary: origin` | Yes |
| Yahoo | ✅ `vary: origin` | Yes |
| NSE | ⚠️ partial/unreliable | Yes |
| RSS feeds | ✅ plain XML | Yes |

Your instinct is right — none of these are a blocker for a Node backend. The one real exception: **Yahoo's cookie+crumb is mandatory**, which is *authentication*, not CORS, and is the main reason to do this server-side.

### Gotchas to code against

1. **Order of candle arrays is not consistent.** Binance & Kraken = oldest→newest. **Bybit, Coinbase Exchange, Coinbase Advanced = newest→first.** Normalise once, centrally.
2. **Kraken's index 5 is VWAP, not volume.** Volume is 6.
3. **Coinbase Exchange candles are `[time, low, open, high, close, volume]`** — low before open.
4. **Yahoo returns parallel arrays with `null` holes**, not per-candle objects.
5. **Binance `limit` > 1000 silently truncates** — assert length.
6. **`api.binance.com` has more non-string numerics than you'd expect**: `openTime`, `closeTime`, `firstId`, `lastId`, `count` on the 24h ticker; indices 0 and 8 on klines. CoinGecko, by contrast, is fully typed.
7. **CoinGecko `/global` wraps in `{data:{…}}`**; `/search/trending` now has `coins`/`nfts`/`rwas`/`categories`.
8. **`/api/holiday-master` F&O bucket is `FO`.**
9. **Yahoo's "delisted" error means auth failure**, not a missing ticker.
10. **NSE's 404s are WAF rejections**, not missing endpoints.
11. **Non-ISO date strings** from NSE: `"09-Oct-2026 15:30"` and `"15-Jan-2026"`. Parse explicitly.
12. **GIFT Nifty runs 24×7** on its own clock — do not treat it as an IST session.
13. **RSS `<description>` is HTML**, and CoinDesk uses a separate `<content:encoded>`.

### Recommended primary stack

```
Crypto OHLCV   →  Binance data-api.binance.vision /api/v3/klines     (6000 wgt/min, 1000 rows)
Crypto backup  →  Bybit api.bybit.com/v5/market/kline                 (600 req/5s)
Crypto fallback→  Yahoo BTC-USD                                       (crumb needed)
Market cap/rank→  CoinGecko /coins/markets + /global                  (take free Demo key)
Indian indices →  NSE /api/allIndices                                 (139 indices, no key)
Indian equities→  Yahoo ^NSEI / SYMBOL.NS                             (crumb needed)
Market status  →  NSE /api/marketStatus
Holidays       →  NSE /api/holiday-master?type=trading  →  .FO / .CM / .CD / .COM
News           →  the six RSS feeds                                    (fully free)
News API       →  ❌ CryptoPanic is $50/week minimum; not free
```

All of the above returned **HTTP 200 from an Indian IP** with no paid plan and no account, except Yahoo (which needs a free cookie+crumb) and CryptoPanic (which is not free and is Cloudflare-blocked here).

### Gaps I could not verify

| Item | Status |
|---|---|
| OKX response shapes / rate limits | ❌ Unreachable from India — docs only |
| NSE `equity-stockIndices` & `option-chain-indices` | ❌ WAF-blocked from India — shapes unverified |
| NSE `chartTodayPath`/`chart30dPath` SVG data | 📄 Found in a live response but never fetched/parsed |
| NSE F&O option chain from **any** free source | ❌ No working free source found |
| Yahoo NSE index/stock futures | ❌ 3 candidate symbols tested, all Not Found |
| Binance account/futures/WS endpoints | Not tested (out of scope — public REST only) |
| Kraken, Coinbase counter-based rate limits | 📄 Docs only; no `X-RateLimit-*` headers seen live |
| Google News RSS | 📄 Docs only, not fetched |
| Binance prohibited-country list page | ⚠️ JS-rendered, returned empty; India confirmed working empirically instead |