import { istStamp } from '../lib/format';

interface Props {
  updatedAt: number;
  bull: number;
  bear: number;
  total: number;
  nextRefreshIn: number;
  stale: boolean;
  reason?: string;
}

/**
 * The slim status line above the stage — the `#topRail` of the reference
 * layout. Crypto never closes, so instead of "Closed · opens Mon" it reports
 * the live clock, when the market-depth picture was last built, and the totals.
 */
export function TopRail({ updatedAt, bull, bear, total, nextRefreshIn, stale, reason }: Props) {
  return (
    <div className="toprail">
      <span className="toprail-live">
        <i className="live-dot" /> LIVE · 24/7
      </span>
      <span className="toprail-sep" />
      <span className="toprail-lab">
        MARKET DEPTH AS OF <b className="mono">{istStamp(updatedAt)} IST</b>
      </span>
      <span className="toprail-sep" />
      <span className="toprail-counts">
        <b className="rail-bull">{bull}</b> bull · <b className="rail-bear">{bear}</b> bear · {total} tracked
      </span>
      <span className="toprail-right" title={reason ?? undefined}>
        {stale ? 'refreshing…' : `next scan ${Math.max(0, Math.ceil(nextRefreshIn / 1000))}s`}
      </span>
    </div>
  );
}