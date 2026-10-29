import type { Candle, LiqEvent } from '../../../shared/types';
import type { PlanContext } from '../levels';
import { liqClusters } from '../levels';
import type {
  FootprintAnnotation, FootprintLevel, FootprintLiqEvent, FootprintSettings,
} from './types';
import { fpPrice } from './format';

const DAY_MS = 86_400_000;

function utcDayStart(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export interface PrevDayProfile {
  dayStart: number;
  high: number;
  low: number;
  poc: number;
  val: number;
  vah: number;
  lastT: number;
}

/**
 * [EST] Previous UTC-day profile from the candles the terminal already holds.
 * Each 15m candle contributes its typical price and quote volume; this is an
 * estimate, which is why every label carries "(est.)".
 */
export function prevDayProfile(candles: readonly Candle[], rowSize = 0): PrevDayProfile | null {
  if (!candles.length) return null;
  const lastT = candles[candles.length - 1].t;
  const currentDay = utcDayStart(lastT);
  const dayStart = currentDay - DAY_MS;
  const session = candles.filter((candle) => candle.t >= dayStart && candle.t < currentDay);
  if (!session.length) return null;

  const points = session
    .map((candle) => {
      const weight = candle.qv && candle.qv > 0 ? candle.qv : (candle.v ?? 0) * candle.c;
      return { price: (candle.h + candle.l + candle.c) / 3, weight };
    })
    .filter((point) => Number.isFinite(point.price) && point.weight > 0);
  if (!points.length) return null;

  const sorted = [...points].sort((a, b) => a.price - b.price);
  const total = sorted.reduce((sum, point) => sum + point.weight, 0);
  let pocIndex = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].weight > sorted[pocIndex].weight) pocIndex = i;
  }
  let lowIndex = pocIndex;
  let highIndex = pocIndex;
  let area = sorted[pocIndex].weight;
  const target = total * 0.7;
  while (area < target && (lowIndex > 0 || highIndex < sorted.length - 1)) {
    const below = lowIndex > 0 ? sorted[lowIndex - 1].weight : -1;
    const above = highIndex < sorted.length - 1 ? sorted[highIndex + 1].weight : -1;
    if (above >= below) {
      highIndex += 1;
      area += above;
    } else {
      lowIndex -= 1;
      area += below;
    }
  }

  const rawPoc = sorted[pocIndex].price;
  return {
    dayStart,
    high: Math.max(...session.map((candle) => candle.h)),
    low: Math.min(...session.map((candle) => candle.l)),
    poc: rowSize > 0 ? Math.round(rawPoc / rowSize) * rowSize : rawPoc,
    val: sorted[lowIndex].price,
    vah: sorted[highIndex].price,
    lastT: session[session.length - 1].t,
  };
}

const prevStyle = {
  color: 'rgba(45,212,191,0.65)',
  textColor: '#2dd4bf',
  dash: [6, 4],
  width: 1,
};

export function prevDayFootprintLevels(profile: PrevDayProfile | null): FootprintLevel[] {
  if (!profile) return [];
  return [
    {
      id: 'prev-val', price: profile.val, label: `prev day VAL (est.) ${fpPrice(profile.val)}`,
      kind: 'prev-val', ...prevStyle, axisTag: true,
    },
    {
      id: 'prev-vah', price: profile.vah, label: `prev day VAH (est.) ${fpPrice(profile.vah)}`,
      kind: 'prev-vah', ...prevStyle, axisTag: false,
    },
    {
      id: 'prev-high', price: profile.high, label: `prev day high ${fpPrice(profile.high)}`,
      kind: 'prev-high', ...prevStyle, axisTag: false,
    },
    {
      id: 'prev-low', price: profile.low, label: `prev day low ${fpPrice(profile.low)}`,
      kind: 'prev-low', ...prevStyle, axisTag: true,
    },
  ];
}

export function nakedPocAnnotation(
  profile: PrevDayProfile | null,
  candles: readonly Candle[],
  rowSize: number,
): FootprintAnnotation | null {
  if (!profile || !candles.length) return null;
  const currentDay = utcDayStart(candles[candles.length - 1].t);
  const tolerance = Math.max(1e-9, rowSize / 2);
  const touched = candles.some((candle) => (
    candle.t >= currentDay
    && profile.poc >= candle.l - tolerance
    && profile.poc <= candle.h + tolerance
  ));
  if (touched) return null;
  return {
    id: 'npoc-live',
    kind: 'npoc',
    price: profile.poc,
    label: `nPOC ${fpPrice(profile.poc)}`,
    fromT: profile.lastT,
    color: '#facc15',
  };
}

export function userFootprintLevels(levels: readonly number[]): FootprintLevel[] {
  return levels.map((price, index) => ({
    id: `user-${price.toFixed(2)}-${index}`,
    kind: 'user',
    price,
    label: `\u2605 my level ${fpPrice(price)}`,
    color: 'rgba(229,231,235,0.75)',
    textColor: '#e5e7eb',
    dash: [12, 6],
    width: 1.5,
    axisTag: true,
    removable: true,
  }));
}

export function planFootprintLevels(plan: PlanContext): FootprintLevel[] {
  if (!plan.hasSetup) return [];
  const out: FootprintLevel[] = [];
  if (plan.buyAbove !== null) {
    out.push({
      id: 'plan-buy',
      kind: 'plan-buy',
      price: plan.buyAbove,
      label: `buy above ${fpPrice(plan.buyAbove)}`,
      color: 'rgba(74,222,128,0.55)',
      textColor: '#4ade80',
      dash: [2, 5],
      width: 1,
      axisTag: true,
    });
  }
  if (plan.sellBelow !== null) {
    out.push({
      id: 'plan-sell',
      kind: 'plan-sell',
      price: plan.sellBelow,
      label: `sell below ${fpPrice(plan.sellBelow)}`,
      color: 'rgba(248,113,113,0.55)',
      textColor: '#f87171',
      dash: [2, 5],
      width: 1,
      axisTag: true,
    });
  }
  for (const [index, target] of plan.targets.slice(0, 3).entries()) {
    out.push({
      id: `plan-target-${index}`,
      kind: 'plan',
      price: target,
      label: `target ${fpPrice(target)}`,
      color: 'rgba(74,222,128,0.45)',
      textColor: '#86efac',
      dash: [1, 7],
      width: 1,
      axisTag: false,
    });
  }
  if (plan.stop !== null) {
    out.push({
      id: 'plan-stop',
      kind: 'plan',
      price: plan.stop,
      label: `stop ${fpPrice(plan.stop)}`,
      color: 'rgba(248,113,113,0.45)',
      textColor: '#fca5a5',
      dash: [1, 7],
      width: 1,
      axisTag: false,
    });
  }
  return out;
}

export function liqFootprintLevels(events: readonly LiqEvent[]): FootprintLevel[] {
  return liqClusters(events, null, 0.0004).slice(0, 3).map((cluster, index) => ({
    id: `liq-${index}`,
    kind: 'liq',
    price: cluster.price,
    label: `\u26a1 ${cluster.side === 'long' ? 'longs' : 'shorts'} liquidate ${fpPrice(cluster.price)}`,
    color: 'rgba(192,132,252,0.6)',
    textColor: '#c084fc',
    dash: [4, 4],
    width: 1,
    axisTag: true,
  }));
}

export function filterFootprintLevels(
  levels: readonly FootprintLevel[],
  settings: FootprintSettings,
): FootprintLevel[] {
  return levels.filter((level) => {
    if (!settings.showPrevDay && (
      level.kind === 'prev-day' || level.kind === 'prev-val' || level.kind === 'prev-vah'
      || level.kind === 'prev-high' || level.kind === 'prev-low'
    )) return false;
    if (level.kind === 'ua' && !settings.showUaLines) return false;
    if (level.kind === 'npoc' && !settings.showNpoc) return false;
    if (level.kind === 'liq' && !settings.showRekt) return false;
    return true;
  });
}

export function liveFootprintEvents(events: readonly LiqEvent[]): FootprintLiqEvent[] {
  return events
    .filter((event) => event.usd >= 200 && Number.isFinite(event.price) && Number.isFinite(event.t))
    .map((event, index) => {
      const side = event.side === 'SELL' ? 'long' : 'short';
      return {
        id: `liq-${event.t}-${index}`,
        t: event.t,
        price: event.price,
        side,
        usd: event.usd,
      };
    });
}
