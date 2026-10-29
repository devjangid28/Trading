import type { MarketPicture, SectorFlow, Side } from '../../shared/types';

interface Props {
  sectors: SectorFlow[];
  market: MarketPicture;
  breadthBias: Side | 'two-way';
}

/**
 * The crest — the animated band where the reference shows the leading sector
 * and the bullish/bearish depth shares. Rendered as a horizontal beam with a
 * sweep glint above the funnel.
 */
export function FlowCrest({ sectors, market, breadthBias }: Props) {
  const lead = sectors.find((s) => s.leading) ?? sectors[0] ?? null;
  const lag = sectors.find((s) => s.lagging) ?? null;
  const total = Math.max(1, market.bullishCount + market.bearishCount);
  const bullShare = Math.round((market.bullishCount / total) * 100);
  const bearShare = Math.round((market.bearishCount / total) * 100);
  const biasLabel =
    breadthBias === 'bullish' ? 'BULLISH BIAS' : breadthBias === 'bearish' ? 'BEARISH BIAS' : 'TWO-WAY MARKET';

  return (
    <div className="crest">
      <div className="crest-beam" />
      <div className="crest-sweep" />

      {lead && (
        <div className="crest-sector">
          <span className="crest-k">LEADING SECTOR</span>
          <span className="crest-sector-name">{lead.sector}</span>
          <span className="crest-sector-pct mono up">{lead.avgChange >= 0 ? '+' : ''}{lead.avgChange.toFixed(2)}%</span>
        </div>
      )}

      <div className="crest-share">
        <span className="crest-k">BULLISH</span>
        <span className="crest-n bull">{market.bullishCount}</span>
        <span className="crest-per">{bullShare}%</span>
      </div>

      <div className="crest-seam" />

      <div className="crest-share bear">
        <span className="crest-k">BEARISH</span>
        <span className="crest-n bear">{market.bearishCount}</span>
        <span className="crest-per">{bearShare}%</span>
      </div>

      {lag && (
        <div className="crest-lag">
          <span className="crest-k">LAGGING</span>
          <span className="crest-lag-name">{lag.sector}</span>
          <span className="crest-sector-pct mono down">{lag.avgChange.toFixed(2)}%</span>
        </div>
      )}

      <div className="crest-bias">
        <i className={breadthBias === 'bullish' ? 'dot bull' : breadthBias === 'bearish' ? 'dot bear' : 'dot flat'} />
        {biasLabel}
      </div>
    </div>
  );
}