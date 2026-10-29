import { useMemo } from 'react';
import type { AssetRow, Setup } from '../../shared/types';
import { fmtPct, fmtPrice } from '../lib/format';
import type { LivePrice } from '../lib/liveContext';

type TileSize = 'c4' | 'c3' | 'c2' | 'c1';

const SIZE_MAP: Record<TileSize, { width: number; height: number }> = {
  c4: { width: 94, height: 94 },
  c3: { width: 114, height: 114 },
  c2: { width: 132, height: 132 },
  c1: { width: 172, height: 172 },
};

const BULLISH_COLOR = '#16a34a';
const BEARISH_COLOR = '#dc2626';

interface TileData extends AssetRow {
  tileSize: TileSize;
}

interface Props {
  rows: AssetRow[];
  onSelect: (row: AssetRow) => void;
  selected?: string | null;
  prices?: Record<string, LivePrice>;
  bridgeRowId?: string;
}

function assignTileSizes(rows: AssetRow[]): TileData[] {
  const picks = rows.filter((r) => r.isPick);
  const nonPicks = rows.filter((r) => !r.isPick);

  const sized: TileData[] = [];

  picks.forEach((r, i) => {
    let size: TileSize;
    if (i === 0) size = 'c1';
    else if (i <= 2) size = 'c2';
    else if (i <= 5) size = 'c3';
    else size = 'c4';
    sized.push({ ...r, tileSize: size });
  });

  nonPicks.forEach((r, i) => {
    let size: TileSize;
    const idx = i + picks.length;
    if (idx < 3) size = 'c2';
    else if (idx < 8) size = 'c3';
    else size = 'c4';
    sized.push({ ...r, tileSize: size });
  });

  return sized;
}

function TileMiniChart({
  data,
  setup,
  color,
  width,
  height,
}: { data: number[]; setup: Setup | null; color: string; width: number; height: number }) {
  if (!data.length) return <svg width={width} height={height} />;

  let min = Math.min(...data);
  let max = Math.max(...data);

  if (setup) {
    [setup.obLow, setup.obHigh, setup.z, setup.invalidation, ...setup.targets.map((t) => t.price)].forEach((v) => {
      if (v < min) min = v;
      if (v > max) max = v;
    });
  }

  const pad = (max - min) * 0.08;
  const minP = min - pad;
  const maxP = max + pad;
  const n = data.length;

  const points = data.map((v, i) => `${(i / (n - 1)) * width},${height - ((v - minP) / (maxP - minP)) * height}`).join(' ');

  return (
    <svg width={width} height={height} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id="tileObFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.2" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>

      {setup && (() => {
        const obIdx = Math.floor(n * 0.15);
        const left = (obIdx / (n - 1)) * width;
        const right = width;
        const top = height - ((setup.obHigh - minP) / (maxP - minP)) * height;
        const bot = height - ((setup.obLow - minP) / (maxP - minP)) * height;
        return (
          <g>
            <rect x={left} y={top} width={right - left} height={Math.max(1, bot - top)} fill="url(#tileObFill)" />
            <rect x={left} y={top} width={right - left} height={Math.max(1, bot - top)} fill="none" stroke={color} strokeWidth={1} rx={1} />
          </g>
        );
      })()}

      <polyline
        fill="none"
        stroke={color}
        strokeWidth={1.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
        opacity={0.8}
      />

      {setup && setup.z >= minP && setup.z <= maxP && (
        <line
          x1={0}
          x2={width}
          y1={height - ((setup.z - minP) / (maxP - minP)) * height}
          y2={height - ((setup.z - minP) / (maxP - minP)) * height}
          stroke={color}
          strokeWidth={1}
          strokeDasharray="3 2"
        />
      )}

      {setup?.targets.slice(0, 1).map((t) =>
        t.price >= minP && t.price <= maxP ? (
          <line
            key={t.label}
            x1={0}
            x2={width}
            y1={height - ((t.price - minP) / (maxP - minP)) * height}
            y2={height - ((t.price - minP) / (maxP - minP)) * height}
            stroke="#2563eb"
            strokeWidth={0.8}
            strokeDasharray="3 2"
          />
        ) : null
      )}

      <line
        x1={0}
        x2={width}
        y1={height - ((data[n - 1] - minP) / (maxP - minP)) * height}
        y2={height - ((data[n - 1] - minP) / (maxP - minP)) * height}
        stroke="var(--faint)"
        strokeWidth={0.5}
        strokeDasharray="1 3"
      />
    </svg>
  );
}

function TileContent({
  row,
  live,
}: { row: TileData; live?: LivePrice }) {
  const { tileSize } = row;
  const bullish = row.side === 'bullish';
  const color = bullish ? BULLISH_COLOR : BEARISH_COLOR;
  const dims = SIZE_MAP[tileSize];
  const setup = row.setup;

  return (
    <div className="tile" style={{ width: dims.width, height: dims.height }}>
      <div className="tile-header">
        <span className="tile-rank" style={{ color }}>{String(row.rank).padStart(2, '0')}</span>
        <span className="tile-symbol">{row.base}</span>
        {row.eventRisk && <span className="tile-event-risk" title="Event risk">⚠</span>}
      </div>

      <div className="tile-chart">
        <TileMiniChart
          data={row.spark}
          setup={setup}
          color={color}
          width={dims.width - 8}
          height={dims.height - 36}
        />
      </div>

      <div className="tile-footer">
        <span className="tile-price mono">{fmtPrice(live?.price ?? row.price)}</span>
        <span className={`tile-change mono ${(live?.changePct ?? row.changePct) >= 0 ? 'up' : 'down'}`}>
          {fmtPct(live?.changePct ?? row.changePct)}
        </span>
      </div>

      {setup && row.isPick && (
        <div className="tile-levels">
          <span className="tile-level z" style={{ color }}>Z {fmtPrice(setup.z).slice(-4)}</span>
          <span className="tile-level inv" style={{ color: bullish ? BEARISH_COLOR : BULLISH_COLOR }}>
            {bullish ? 'S1' : 'R1'} {fmtPrice(setup.invalidation).slice(-4)}
          </span>
        </div>
      )}
    </div>
  );
}

export function TileGrid({ rows, onSelect, selected, prices, bridgeRowId }: Props) {
  const sizedRows = useMemo(() => assignTileSizes(rows), [rows]);

  return (
    <div className="tile-grid" role="list">
      {sizedRows.map((r) => {
        const live = prices?.[`${r.base}USDT`];
        const isSel = selected === r.id;
        const tileBg = isSel ? 'var(--panel-2)' : 'var(--panel)';
        const tileBorder = isSel ? (r.side === 'bullish' ? BULLISH_COLOR : BEARISH_COLOR) : 'var(--border)';
        return (
          <div
            key={r.id}
            role="listitem"
            onClick={() => onSelect(r)}
            className={`tile-wrapper ${isSel ? 'selected' : ''}`}
            data-bridge-tile={r.id === bridgeRowId ? r.id : undefined}
            style={{
              background: tileBg,
              borderColor: tileBorder,
            }}
          >
            <TileContent row={r} live={live} />
          </div>
        );
      })}
    </div>
  );
}