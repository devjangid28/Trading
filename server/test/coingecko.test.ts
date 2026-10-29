import { afterEach, describe, expect, it } from 'vitest';
import { setTransport } from '../src/lib/http.js';
import { geckoMarkets } from '../src/data/coingecko.js';

/**
 * The 429 fix is mostly a call-count fix: identity and altseason must share one
 * `/coins/markets` response instead of each opening their own request.
 */
describe('CoinGecko shared cache', () => {
  afterEach(() => setTransport(null));

  it('serves repeated markets calls from one upstream request', async () => {
    let calls = 0;
    setTransport(async () => {
      calls++;
      return new Response(JSON.stringify([
        { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', market_cap: 1, price_change_percentage_30d: 1 },
      ]), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const first = await geckoMarkets();
    const second = await geckoMarkets();

    expect(calls).toBe(1);
    expect(second).toBe(first);
    expect(first[0]?.symbol).toBe('btc');
  });
});
