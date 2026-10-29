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

export function registerChartExtensions(): void {
  if (registered) return;
  registered = true;
  registerVwap();
  registerSessionBands();
  registerRectZone();
  registerTextNote();
  positionOverlay('longPosition', true);
  positionOverlay('shortPosition', false);
}
