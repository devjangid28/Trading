import type { MarketPicture } from '../../shared/types';

interface Props {
  picture: MarketPicture;
  boardRows: number;
  pickCount: number;
}

interface NodeDef {
  key: string;
  label: string;
  sub: string;
  count: number;
  note?: string;
}

/**
 * The funnel — the reference's `#nodes` row. Every asset on the picture wins a
 * dot; strength gates it onto a board; the pick rules reduce that to a short
 * shortlist. Counts come from the live scan, and motes drift along the rail
 * between the stages.
 */
export function NodeFunnel({ picture, boardRows, pickCount }: Props) {
  const nodes: NodeDef[] = [
    {
      key: 'picture',
      label: 'MARKET PICTURE',
      sub: 'every tracked pair',
      count: picture.total,
      note: `${picture.choppyCount} choppy excluded`,
    },
    {
      key: 'board',
      label: 'THE BOARD',
      sub: 'one-directional, ranked',
      count: boardRows,
      note: 'strength > 0',
    },
    {
      key: 'picks',
      label: 'THE PICKS',
      sub: pickCount > 0 ? 'cleanest of the clean' : 'none cleared today',
      count: pickCount,
      note: 'top 3 · max 2 per sector',
    },
  ];

  return (
    <div className="funnel">
      {nodes.map((n, i) => (
        <div key={n.key} className="funnel-stage">
          <div className="funnel-node">
            <span className="funnel-count mono">{n.count}</span>
            <span className="funnel-label">{n.label}</span>
            <span className="funnel-sub">{n.sub}</span>
          </div>
          {i < nodes.length - 1 && (
            <div className="funnel-rail">
              <span className="funnel-mote m1" />
              <span className="funnel-mote m2" />
              <span className="funnel-mote m3" />
              <span className="funnel-note">{n.note}</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}