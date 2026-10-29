import type { MacroState } from '../../shared/types';
import { fmtPct, fmtPrice, fmtUsd } from '../lib/format';
import { useLivePrice } from '../lib/priceStore';

function fgColor(v: number | null | undefined): string | undefined {
  if (v === null || v === undefined || v === 0) return undefined;
  return v > 0 ? 'var(--color-up)' : 'var(--color-down)';
}

function Tile({
  label,
  value,
  sub,
  color,
  title,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
  title?: string;
}) {
  return (
    <div className="macro-tile" title={title}>
      <div className="macro-tile-label">{label}</div>
      <div className="macro-tile-value" style={color ? { color } : undefined}>
        {value}
      </div>
      {sub && <div className="macro-tile-sub">{sub}</div>}
    </div>
  );
}

export function MacroStrip({ macro, tracked = 0 }: { macro: MacroState | null; tracked?: number }) {
  // Live header prices from the SAME WebSocket tick stream the rows use. The
  // macro REST snapshot is up to a minute old; the header must not be. Hooks
  // run before the early return so the subscription order is stable.
  const liveBtc = useLivePrice('BTCUSDT');
  const liveEth = useLivePrice('ETHUSDT');

  if (!macro) {
    return (
      <div className="macro-tile" style={{ color: 'var(--muted)', justifyContent: 'center' }}>
        Loading macro state…
      </div>
    );
  }

  const fg = macro.fearGreed;
  const fgColorValue = fg ? (fg.value >= 55 ? 'var(--color-up)' : fg.value <= 45 ? 'var(--color-down)' : 'var(--color-amber)') : undefined;
  const sc = macro.stablecoins;
  const gm = macro.globalMarket;
  const ind = macro.india;

  // Prefer the live tick; fall back to the REST snapshot until the first tick.
  const btcPrice = liveBtc?.price ?? macro.btc?.price ?? null;
  const btcChange = liveBtc?.changePct ?? macro.btc?.changePct ?? null;
  const ethPrice = liveEth?.price ?? null;
  const ethChange = liveEth?.changePct ?? null;
  const venue = liveBtc ? 'Binance spot · live tick' : 'Binance REST snapshot (≤60s)';

  return (
    <>
        {btcPrice !== null && (
          <Tile
            label="BTC"
            value={fmtPrice(btcPrice)}
            sub={btcChange !== null ? fmtPct(btcChange) : undefined}
            color={btcChange !== null ? fgColor(btcChange) : undefined}
            title={`BTC/USDT ${liveBtc ? 'live' : 'snapshot'}`}
          />
        )}
        {ethPrice !== null && (
          <Tile
            label="ETH"
            value={fmtPrice(ethPrice)}
            sub={ethChange !== null ? fmtPct(ethChange) : undefined}
            color={ethChange !== null ? fgColor(ethChange) : undefined}
            title={`ETH/USDT ${liveEth ? 'live' : 'snapshot'}`}
          />
        )}
        <Tile label="Venue" value="Binance" sub={venue} />

        {fg && (
          <Tile
            label="Fear & Greed"
            value={`${fg.value} · ${fg.label}`}
            sub={fg.change7d !== null ? `${fg.change7d > 0 ? '+' : ''}${fg.change7d} vs 7d` : undefined}
            color={fgColorValue}
            title="Contrarian at the extremes. Daily index from alternative.me."
          />
        )}

        {gm ? (
          <>
            <Tile
              label="Total mcap"
              value={fmtUsd(gm.totalMarketCapUsd)}
              sub={fmtPct(gm.marketCapChange24h)}
              color={fgColor(gm.marketCapChange24h)}
            />
            <Tile label="BTC dom" value={`${gm.btcDominance}%`} sub={`ETH ${gm.ethDominance}%`} />
            <Tile label="24h volume" value={fmtUsd(gm.totalVolumeUsd)} />
          </>
        ) : (
          <Tile
            label="Global market"
            value="Unavailable"
            sub="CoinGecko rate limit / outage"
            title="CoinGecko /global returned no data. The rest of the strip is unaffected; no market-cap or dominance number is invented."
          />
        )}

        {sc && (
          <Tile
            label="Stablecoin float"
            value={fmtUsd(sc.totalUsd)}
            sub={
              sc.change7dPct !== null
                ? `${sc.change7dPct > 0 ? '+' : ''}${sc.change7dPct.toFixed(2)}% 7d`
                : undefined
            }
            color={fgColor(sc.change7dPct)}
            title="Dry powder for the whole market. Growth is a 1–3 month leading indicator of BTC."
          />
        )}

        {ind.vix !== null && (
          <Tile
            label="India VIX"
            value={ind.vix.toFixed(2)}
            color={ind.vix > 15 ? 'var(--color-down)' : undefined}
            title="Indian volatility gauge. A spike means Indian crypto risk appetite is compressing."
          />
        )}
        {ind.sensex !== null && (
          <Tile
            label="Sensex"
            value={ind.sensex.toFixed(0)}
            sub={ind.sensexChangePct !== null ? fmtPct(ind.sensexChangePct) : undefined}
            color={fgColor(ind.sensexChangePct)}
          />
        )}

        {/*
          A8: a bare dash is not an answer. `activeCoins` is CoinGecko's count of
          ALL coins — a different question from "how many does this terminal
          track" — and it is null whenever the aggregator rate limits us. So the
          strip reports the count we can actually vouch for (the scan's own
          universe) and otherwise says "Unavailable" with the reason.
        */}
        <Tile
          label="Tracked assets"
          value={tracked > 0 ? String(tracked) : 'Unavailable'}
          sub={tracked > 0 ? 'order flow universe' : 'no scan universe reported'}
          title={
            tracked > 0
              ? `${tracked} pairs scanned on the last scan`
              : 'Unavailable — no scan has reported a universe size yet. CoinGecko activeCoins is a different measure and was rate limited.'
          }
        />
    </>
  );
}
