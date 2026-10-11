import type { MacroState } from '../../shared/types';
import { fmtPct, fmtPrice, fmtUsd } from '../lib/format';

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
    <div className="px-3 py-1.5 min-w-0 border-r last:border-0 shrink-0" style={{ borderColor: 'var(--border)' }} title={title}>
      <div className="text-[9.5px] uppercase tracking-wider whitespace-nowrap" style={{ color: 'var(--faint)' }}>
        {label}
      </div>
      <div className="mono text-[12.5px] font-semibold leading-tight whitespace-nowrap" style={color ? { color } : undefined}>
        {value}
      </div>
      {sub && (
        <div className="text-[9.5px] whitespace-nowrap" style={{ color: 'var(--muted)' }}>
          {sub}
        </div>
      )}
    </div>
  );
}

export function MacroStrip({ macro }: { macro: MacroState | null }) {
  if (!macro) {
    return (
      <div className="flex items-center px-3 h-[52px] text-[12px]" style={{ color: 'var(--muted)' }}>
        Loading macro state…
      </div>
    );
  }

  const fg = macro.fearGreed;
  const fgColorValue = fg ? (fg.value >= 55 ? 'var(--color-up)' : fg.value <= 45 ? 'var(--color-down)' : 'var(--color-amber)') : undefined;
  const sc = macro.stablecoins;
  const gm = macro.globalMarket;
  const ind = macro.india;

  return (
    <div className="overflow-x-auto">
      <div className="flex items-stretch min-w-max">
        {macro.btc && (
          <Tile
            label="BTC"
            value={fmtPrice(macro.btc.price)}
            sub={fmtPct(macro.btc.changePct)}
            color={fgColor(macro.btc.changePct)}
          />
        )}

        {fg && (
          <Tile
            label="Fear & Greed"
            value={`${fg.value} · ${fg.label}`}
            sub={fg.change7d !== null ? `${fg.change7d > 0 ? '+' : ''}${fg.change7d} vs 7d` : undefined}
            color={fgColorValue}
            title="Contrarian at the extremes. Daily index from alternative.me."
          />
        )}

        {gm && (
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

        <Tile label="Tracked assets" value={String(gm?.activeCoins ?? '—')} sub="coinGecko" />
      </div>
    </div>
  );
}
