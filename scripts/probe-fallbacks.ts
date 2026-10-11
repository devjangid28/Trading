/** Probe alternatives for the four recoverable Phase 0 failures. */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const CANDIDATES: { label: string; url: string; headers?: Record<string, string> }[] = [
  // Deribit DVOL — correct index name and endpoint
  { label: 'Deribit index btc_dvol', url: 'https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_dvol' },
  { label: 'Deribit ticker BTC-DVOL?', url: 'https://www.deribit.com/api/v2/public/ticker?instrument_name=BTC-DVOL' },
  { label: 'Deribit index list', url: 'https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_usd' },
  { label: 'Deribit vol idx BTC 3600 (recent)', url: 'https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=1758000000000&end_timestamp=1758100000000&resolution=3600' },

  // BLS schedule — correct URL shape
  { label: 'BLS 2026 home', url: 'https://www.bls.gov/schedule/2026/home.htm' },
  { label: 'BLS current_year', url: 'https://www.bls.gov/schedule/news_release/current_year.asp' },
  { label: 'BLS CPI release page', url: 'https://www.bls.gov/schedule/news_release/cpi.htm' },
  { label: 'BLS 10_2026 sched', url: 'https://www.bls.gov/schedule/2026/10_sched.htm' },

  // ETF flows — Farside blocked. Alternatives?
  { label: 'SoSoValue ETF page', url: 'https://sosovalue.com/assets/etf/us-btc-spot' },
  { label: 'Farside all-data', url: 'https://farside.co.uk/bitcoin-etf-flow-all-data/', headers: { Referer: 'https://farside.co.uk/', 'Accept-Language': 'en-US,en;q=0.9' } },
  { label: 'Farside via textise', url: 'https://r.jina.ai/https://farside.co.uk/btc/' },
  { label: 'iShares IBIT holdings', url: 'https://www.ishares.com/us/products/333011/ishares-bitcoin-trust-etf' },

  // GDELT — is the 429 sticky or per-request?
  { label: 'GDELT retry (same query)', url: 'https://api.gdeltproject.org/api/v2/doc/doc?query=bitcoin&mode=TimelineVol&format=json&timespan=1d&maxrecords=10' },

  // CoinDCX returned an odd shape — inspect it
  { label: 'CoinDCX ticker raw', url: 'https://api.coindcx.com/exchange/ticker' },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function probe(label: string, url: string, headers?: Record<string, string>) {
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
      redirect: 'follow',
    });
    const text = await res.text();
    const ms = Date.now() - t0;
    const flat = text.replace(/\s+/g, ' ').slice(0, 150);
    console.log(`${res.ok ? 'OK  ' : 'FAIL'} ${label.padEnd(34)} ${String(ms).padStart(5)}ms  ${res.ok ? flat : `HTTP ${res.status}`}`);
    if (res.ok) return text;
  } catch (e) {
    const ms = Date.now() - t0;
    const err = e as Error;
    console.log(`FAIL ${label.padEnd(34)} ${String(ms).padStart(5)}ms  ${err.name === 'AbortError' ? 'timeout' : err.message}`);
  } finally {
    clearTimeout(timer);
  }
  return null;
}

console.log('');
for (const c of CANDIDATES) {
  if (c.label.includes('GDELT')) await sleep(6000); // respect 1 req / 5s
  await probe(c.label, c.url, c.headers);
  console.log('');
}