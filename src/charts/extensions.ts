import {
  LineType,
  PolygonType,
  registerIndicator,
  registerOverlay,
  type IndicatorTemplate,
  type OverlayTemplate,
} from 'klinecharts';
import { sessionOpen } from '../lib/chartStats';
import type { SessionId } from './types';
import { breakStrengthLabel, fmtUsdCompact, type SREngineOutput, type SRLevel, type OrderBlock, type WickSignal } from './srEngine';

interface VwapPoint {
  vwap: number | null;
}

interface SessionPoint {
  london: boolean;
  newyork: boolean;
}

let registered = false;

function registerVwap(): void {
  const template: IndicatorTemplate<VwapPoint> = {
    name: 'VWAP_CUSTOM',
    shortName: 'VWAP',
    calcParams: [],
    figures: [{ key: 'vwap', title: 'VWAP: ', type: 'line' }],
    calc: (dataList) => {
      let cumulativePriceVolume = 0;
      let cumulativeVolume = 0;
      return dataList.map((data) => {
        const typical = (data.high + data.low + data.close) / 3;
        const volume = typeof data.volume === 'number' ? data.volume : 0;
        cumulativePriceVolume += typical * volume;
        cumulativeVolume += volume;
        return { vwap: cumulativeVolume > 0 ? cumulativePriceVolume / cumulativeVolume : null };
      });
    },
    styles: {
      lines: [{
        style: LineType.Dashed,
        size: 1.2,
        color: '#f0b90b',
        dashedValue: [5, 4],
        smooth: false,
      }],
    },
  };
  registerIndicator(template);
}

function registerSessionBands(): void {
  const template: IndicatorTemplate<SessionPoint> = {
    name: 'SESSION_BANDS',
    shortName: 'Sessions',
    calcParams: [],
    figures: [],
    calc: (dataList) => dataList.map((data) => ({
      london: sessionOpen(data.timestamp, 'london'),
      newyork: sessionOpen(data.timestamp, 'newyork'),
    })),
    draw: ({ ctx, indicator, visibleRange, barSpace, bounding, xAxis }) => {
      const result = indicator.result as SessionPoint[];
      const show = (indicator.extendData ?? { london: true, newyork: true }) as Record<SessionId, boolean>;
      const from = Math.max(0, Math.floor(visibleRange.from));
      const to = Math.min(result.length - 1, Math.ceil(visibleRange.to));
      if (to < from) return true;
      ctx.save();
      ctx.globalCompositeOperation = 'destination-over';
      for (let index = from; index <= to; index += 1) {
        const point = result[index];
        if (!point) continue;
        const x = xAxis.convertToPixel(index) - barSpace.halfBar;
        if (show.london && point.london) {
          ctx.fillStyle = 'rgba(85, 200, 238, 0.045)';
          ctx.fillRect(x, bounding.top, barSpace.bar, bounding.height);
        }
        if (show.newyork && point.newyork) {
          ctx.fillStyle = 'rgba(244, 184, 96, 0.04)';
          ctx.fillRect(x, bounding.top, barSpace.bar, bounding.height);
        }
      }
      ctx.restore();
      return true;
    },
  };
  registerIndicator(template);
}

function registerRectZone(): void {
  const template: OverlayTemplate = {
    name: 'rectZone',
    totalStep: 3,
    createPointFigures: ({ coordinates }) => {
      if (coordinates.length < 2) return [];
      const first = coordinates[0];
      const second = coordinates[1];
      const x = Math.min(first.x, second.x);
      const y = Math.min(first.y, second.y);
      return [{
        type: 'rect',
        attrs: { x, y, width: Math.abs(second.x - first.x), height: Math.abs(second.y - first.y) },
        styles: {
          style: PolygonType.StrokeFill,
          color: 'rgba(85, 200, 238, 0.08)',
          borderColor: '#55c8ee',
          borderSize: 1,
          borderStyle: LineType.Solid,
          borderRadius: 2,
        },
      }];
    },
  };
  registerOverlay(template);
}

function registerTextNote(): void {
  const template: OverlayTemplate = {
    name: 'textNote',
    totalStep: 1,
    createPointFigures: ({ coordinates, overlay }) => {
      if (coordinates.length === 0) return [];
      const point = coordinates[0];
      const text = typeof overlay.extendData?.text === 'string' ? overlay.extendData.text : 'Note';
      return [{
        type: 'text',
        attrs: { x: point.x + 4, y: point.y - 6, text, align: 'left', baseline: 'bottom' },
        styles: {
          color: '#e5eef7',
          size: 11,
          family: 'ui-sans-serif, system-ui, sans-serif',
          weight: 600,
          backgroundColor: 'rgba(11, 18, 26, 0.88)',
          paddingLeft: 5,
          paddingRight: 5,
          paddingTop: 3,
          paddingBottom: 3,
          borderRadius: 3,
        },
      }];
    },
  };
  registerOverlay(template);
}

function positionOverlay(name: 'longPosition' | 'shortPosition', long: boolean): void {
  const template: OverlayTemplate = {
    name,
    totalStep: 4,
    createPointFigures: ({ coordinates, overlay }) => {
      if (coordinates.length < 3) return [];
      const entry = coordinates[0];
      const target = coordinates[1];
      const stop = coordinates[2];
      const right = Math.max(entry.x, target.x, stop.x) + 28;
      const left = Math.min(entry.x, target.x, stop.x) - 4;
      const rewardColor = long ? 'rgba(14, 203, 129, 0.12)' : 'rgba(246, 70, 93, 0.12)';
      const riskColor = long ? 'rgba(246, 70, 93, 0.12)' : 'rgba(14, 203, 129, 0.12)';
      const rewardBorder = long ? '#0ecb81' : '#f6465d';
      const riskBorder = long ? '#f6465d' : '#0ecb81';
      const rewardTop = Math.min(entry.y, target.y);
      const riskTop = Math.min(entry.y, stop.y);
      const points = overlay.points;
      const entryValue = points[0]?.value ?? 0;
      const targetValue = points[1]?.value ?? 0;
      const stopValue = points[2]?.value ?? 0;
      const risk = Math.abs(entryValue - stopValue);
      const reward = Math.abs(targetValue - entryValue);
      const rr = risk > 0 ? reward / risk : null;
      return [
        {
          type: 'rect',
          attrs: { x: left, y: rewardTop, width: right - left, height: Math.abs(entry.y - target.y) },
          styles: { style: PolygonType.StrokeFill, color: rewardColor, borderColor: rewardBorder, borderSize: 1, borderStyle: LineType.Solid },
        },
        {
          type: 'rect',
          attrs: { x: left, y: riskTop, width: right - left, height: Math.abs(entry.y - stop.y) },
          styles: { style: PolygonType.StrokeFill, color: riskColor, borderColor: riskBorder, borderSize: 1, borderStyle: LineType.Solid },
        },
        {
          type: 'line',
          attrs: { coordinates: [{ x: left, y: entry.y }, { x: right, y: entry.y }] },
          styles: { color: '#e5eef7', size: 1.2, style: LineType.Solid },
        },
        {
          type: 'text',
          attrs: { x: left + 4, y: entry.y - 5, text: `${long ? 'LONG' : 'SHORT'}${rr === null ? '' : ` · R:R ${rr.toFixed(2)}`}`, align: 'left', baseline: 'bottom' },
          styles: { color: rewardBorder, size: 10, family: 'ui-monospace, SFMono-Regular, Menlo, monospace', weight: 700 },
        },
      ];
    },
  };
  registerOverlay(template);
}

function registerSREngine(): void {
  interface SRPoint {
    support: SRLevel[];
    resistance: SRLevel[];
    orderBlocks: OrderBlock[];
    wickSignals: WickSignal[];
    currentPrice: number;
  }

  const levelRgb = (isResistance: boolean) => isResistance ? '246, 70, 93' : '14, 203, 129';
  const levelLabel = (level: SRLevel, isResistance: boolean) => {
    const flip = level.flipped ? ' ↺' : '';
    const wall = level.wallUsd > 0 ? ` · ${fmtUsdCompact(level.wallUsd)} wall` : '';
    return `${isResistance ? 'R' : 'S'} ${level.price.toFixed(level.price >= 1000 ? 1 : level.price >= 1 ? 2 : 4)}${flip}${wall}`;
  };

  const template: IndicatorTemplate<SRPoint> = {
    name: 'SR_ENGINE',
    shortName: 'S/R Engine',
    calcParams: [],
    figures: [],
    calc: (dataList) => dataList.map(() => ({
      support: [],
      resistance: [],
      orderBlocks: [],
      wickSignals: [],
      currentPrice: 0,
    })),
    draw: ({ ctx, indicator, barSpace, bounding, xAxis, yAxis }) => {
      const extendData = indicator.extendData as { output?: SREngineOutput } | undefined;
      const output = extendData?.output;
      if (!output) return true;

      const { orderBlocks, wickSignals, bigMoves, currentPrice, liquidityWalls, nearestSupport, nearestResistance } = output;

      ctx.save();
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textBaseline = 'middle';

      const drawLevel = (level: SRLevel, isResistance: boolean) => {
        const y = yAxis.convertToPixel(level.price);
        if (y < bounding.top || y > bounding.top + bounding.height) return;

        const rgb = levelRgb(isResistance);
        const alpha = level.strength === 'major' ? 0.9 : level.strength === 'strong' ? 0.7 : level.strength === 'moderate' ? 0.5 : 0.3;
        const width = level.strength === 'major' ? 2 : level.strength === 'strong' ? 1.5 : 1;

        ctx.strokeStyle = `rgba(${rgb}, ${alpha})`;
        ctx.lineWidth = width;
        ctx.setLineDash(level.flipped ? [12, 3, 3, 3] : [8, 4]);
        ctx.beginPath();
        ctx.moveTo(bounding.left, y);
        ctx.lineTo(bounding.left + bounding.width, y);
        ctx.stroke();
        ctx.setLineDash([]);

        const zoneTop = yAxis.convertToPixel(level.zoneTop);
        const zoneBottom = yAxis.convertToPixel(level.zoneBottom);
        ctx.fillStyle = `rgba(${rgb}, ${alpha * 0.08})`;
        ctx.fillRect(bounding.left, zoneTop, bounding.width, zoneBottom - zoneTop);

        const label = levelLabel(level, isResistance);
        const probLabel = `${breakStrengthLabel(level.breakProbability)} · ${Math.round(level.breakProbability * 100)}% break`;
        const metrics = `touches: ${level.touches} · vol: ${fmtUsdCompact(level.volumeAtLevel)} · ${level.source} · heuristic`;

        const textX = bounding.left + bounding.width - 185;
        ctx.fillStyle = `rgba(${rgb}, ${alpha})`;
        ctx.fillText(label, textX, y - 16);
        ctx.fillStyle = 'rgba(229, 238, 247, 0.8)';
        ctx.fillText(probLabel, textX, y);
        ctx.fillStyle = 'rgba(107, 122, 144, 0.8)';
        ctx.fillText(metrics, textX, y + 16);
      };

      if (nearestResistance) drawLevel(nearestResistance, true);
      if (nearestSupport) drawLevel(nearestSupport, false);

      for (const wall of liquidityWalls) {
        const y = yAxis.convertToPixel(wall.price);
        if (y < bounding.top || y > bounding.top + bounding.height) continue;
        const isAsk = wall.side === 'ask';
        ctx.strokeStyle = isAsk ? 'rgba(240, 185, 11, 0.55)' : 'rgba(240, 185, 11, 0.55)';
        ctx.lineWidth = 1.4;
        ctx.setLineDash([2, 5]);
        ctx.beginPath();
        ctx.moveTo(bounding.left, y);
        ctx.lineTo(bounding.left + bounding.width, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(250, 204, 21, 0.85)';
        ctx.fillText(
          `${isAsk ? '▲' : '▼'} LIQ ${fmtUsdCompact(wall.usd)} · ${wall.levels} lv`,
          bounding.left + 8,
          y - 9,
        );
      }

      for (const block of orderBlocks) {
        if (!block.isTested && block.timestamp > Date.now() - 30 * 24 * 60 * 60 * 1000) {
          const topY = yAxis.convertToPixel(block.top);
          const bottomY = yAxis.convertToPixel(block.bottom);
          if (topY > bounding.top + bounding.height || bottomY < bounding.top) continue;

          const isBullish = block.type === 'bullish';
          ctx.fillStyle = isBullish ? 'rgba(14, 203, 129, 0.14)' : 'rgba(246, 70, 93, 0.14)';
          ctx.fillRect(bounding.left, bottomY, bounding.width, topY - bottomY);

          ctx.strokeStyle = isBullish ? '#0ecb81' : '#f6465d';
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.strokeRect(bounding.left, bottomY, bounding.width, topY - bottomY);
          ctx.setLineDash([]);

          const label = `${block.type.toUpperCase()} OB · ${fmtUsdCompact(block.volume)} · ${block.breakProbability ? Math.round(block.breakProbability * 100) + '% break' : 'untested'}`;
          ctx.fillStyle = isBullish ? '#0ecb81' : '#f6465d';
          ctx.fillText(label, bounding.left + 8, (topY + bottomY) / 2);
        }
      }

      for (const signal of wickSignals.slice(-10)) {
        const y = yAxis.convertToPixel(signal.price);
        if (y < bounding.top || y > bounding.top + bounding.height) continue;

        const color = signal.direction === 'rejection'
          ? (signal.type === 'lower' ? 'rgba(14, 203, 129, 0.9)' : 'rgba(246, 70, 93, 0.9)')
          : 'rgba(240, 185, 11, 0.9)';

        const x = xAxis.convertToPixel(signal.candleIndex) - barSpace.halfBar;
        const wickHeight = Math.abs(yAxis.convertToPixel(signal.price - signal.wickSize) - y);

        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        if (signal.type === 'upper' || signal.type === 'both') {
          ctx.moveTo(x, y);
          ctx.lineTo(x, y - wickHeight);
        }
        if (signal.type === 'lower' || signal.type === 'both') {
          ctx.moveTo(x, y);
          ctx.lineTo(x, y + wickHeight);
        }
        ctx.stroke();

        const label = `${signal.direction === 'rejection' ? '⚡' : '◆'} ${signal.strength.toUpperCase()} ${signal.type.toUpperCase()} WICK`;
        ctx.fillStyle = color;
        ctx.fillText(label, x + 4, y - 8);
      }

      for (const move of bigMoves.slice(-6)) {
        const x = xAxis.convertToPixel(move.candleIndex) - barSpace.halfBar;
        const topY = yAxis.convertToPixel(move.price + (move.type === 'bullish' ? 1 : -1) * 0);
        const isBullish = move.type === 'bullish';
        const color = isBullish ? 'rgba(14, 203, 129, 0.9)' : 'rgba(246, 70, 93, 0.9)';

        ctx.strokeStyle = color;
        ctx.lineWidth = 1.6;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(x, topY - 10);
        ctx.lineTo(x, topY + 10);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = color;
        ctx.fillText(
          `${isBullish ? '▲' : '▼'} BIG MOVE ${(move.bodyPct * 100).toFixed(0)}% body · ${move.volumeMultiple.toFixed(1)}x vol`,
          x + 4,
          topY - 10,
        );
      }

      const nearestR = nearestResistance;
      const nearestS = nearestSupport;

      if (nearestR) {
        const dist = ((nearestR.price - currentPrice) / currentPrice * 100).toFixed(2);
        ctx.fillStyle = 'rgba(246, 70, 93, 0.9)';
        ctx.fillText(`↑ RESISTANCE ${dist}% away · ${Math.round(nearestR.breakProbability * 100)}% break`, bounding.left + 8, bounding.top + 20);
      }
      if (nearestS) {
        const dist = ((currentPrice - nearestS.price) / currentPrice * 100).toFixed(2);
        ctx.fillStyle = 'rgba(14, 203, 129, 0.9)';
        ctx.fillText(`↓ SUPPORT ${dist}% away · ${Math.round(nearestS.breakProbability * 100)}% break`, bounding.left + 8, bounding.top + 38);
      }

      ctx.restore();
      return true;
    },
  };
  registerIndicator(template);
}

export function registerChartExtensions(): void {
  if (registered) return;
  registered = true;
  registerVwap();
  registerSessionBands();
  registerRectZone();
  registerTextNote();
  positionOverlay('longPosition', true);
  positionOverlay('shortPosition', false);
  registerSREngine();
}
