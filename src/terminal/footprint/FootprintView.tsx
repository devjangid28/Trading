import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Candle, LiqEvent, TerminalInterval, TerminalTrade } from '../../../shared/types';
import { INTERVAL_MS } from '../math';
import { loadUserLevels, saveUserLevels, type PlanContext } from '../levels';
import { averageVolume, aggregateTrades, baseTickFor, rowLadder } from './aggregate';
import { fpPrice } from './format';
import { buildMockFootprint, MOCK_ROW_SIZE } from './mock';
import {
  filterFootprintLevels, liqFootprintLevels, liveFootprintEvents, nakedPocAnnotation,
  planFootprintLevels, prevDayFootprintLevels, prevDayProfile, userFootprintLevels,
} from './levels';
import { FootprintCanvas } from './FootprintCanvas';
import { FootprintToolbar } from './FootprintToolbar';
import {
  loadFootprintLink, loadFootprintSettings, saveFootprintLink, saveFootprintSettings,
} from './settings';
import type {
  FootprintCandle, FootprintCandleMeta, FootprintDataset, FootprintSettings,
} from './types';
import { useFootprintTrades } from './useFootprintTrades';

const DASH = '\u2014';

function storage(): Storage | null {
  return typeof window === 'undefined' ? null : window.localStorage;
}

function signedQty(value: number): string {
  if (!Number.isFinite(value)) return DASH;
  if (Math.abs(value) < 0.005) return '0.00';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
}

function readingFor(dataset: FootprintDataset, candle: FootprintCandle | null): string {
  if (!candle) return `This candle: ${DASH} No trades captured yet.`;
  const index = dataset.candles.findIndex((item) => item.t === candle.t);
  const average = averageVolume(dataset.candles.slice(0, Math.max(1, index + 1)));
  const deltaShare = candle.volumeUsd > 0 ? Math.abs(candle.deltaUsd) / candle.volumeUsd : 0;

  let verdict = 'no trades';
  if (candle.volumeUsd > 0) {
    if (candle.forceQuiet === true || (average > 0 && candle.volumeUsd < average * 0.25)) {
      verdict = 'quiet candle \u2014 too little volume to read';
    } else if (deltaShare < 0.15) {
      verdict = 'no clear winner inside this candle yet (delta under 15% of volume)';
    } else if (candle.deltaUsd > 0) {
      verdict = `buyers in control (delta +${Math.round(deltaShare * 100)}% of volume)`;
    } else {
      verdict = `sellers in control (delta \u2212${Math.round(deltaShare * 100)}% of volume)`;
    }
  }

  if (candle.volumeUsd > 0 && verdict !== 'quiet candle \u2014 too little volume to read') {
    const range = candle.h - candle.l;
    if (range > 0 && candle.c >= candle.h - range * 0.2) verdict += ' \u2014 closing near the high';
    else if (range > 0 && candle.c <= candle.l + range * 0.2) verdict += ' \u2014 closing near the low';
  }

  const poc = candle.pocPrice > 0 ? fpPrice(candle.pocPrice) : DASH;
  return `This candle: \u0394 ${signedQty(candle.deltaQty)} \u2014 ${verdict}. Most volume at ${poc} (POC). Imbalances: ${candle.imbalanceBuy} buy / ${candle.imbalanceSell} sell rows.`;
}

export interface FootprintViewProps {
  symbol: string;
  interval: TerminalInterval;
  onInterval: (interval: TerminalInterval) => void;
  trades: TerminalTrade[];
  candles?: Candle[];
  price: number | null;
  plan: PlanContext;
  liqEvents?: readonly LiqEvent[];
  mock: boolean;
}

export function FootprintView({
  symbol, interval: terminalInterval, onInterval, trades, candles = [], price, plan,
  liqEvents = [], mock,
}: FootprintViewProps) {
  const [settings, setSettings] = useState<FootprintSettings>(() => loadFootprintSettings(storage()));
  const [linked, setLinked] = useState(() => loadFootprintLink(storage()));
  const [manualInterval, setManualInterval] = useState<TerminalInterval>(terminalInterval);
  const [olderCount, setOlderCount] = useState(0);
  const [selectedT, setSelectedT] = useState<number | null>(null);
  const [removedLevels, setRemovedLevels] = useState<Set<string>>(() => new Set());
  const [userLevels, setUserLevels] = useState<number[]>(() => loadUserLevels(symbol, storage()));
  const [autoRowSize, setAutoRowSize] = useState<number>(() => {
    const ladder = rowLadder(baseTickFor(symbol, price ?? 0));
    return ladder[Math.min(5, ladder.length - 1)];
  });

  const interval = linked ? terminalInterval : manualInterval;
  const baseTick = useMemo(() => baseTickFor(symbol, price ?? 0), [symbol, price]);
  const rowSize = settings.rows === 'auto'
    ? (mock ? MOCK_ROW_SIZE : autoRowSize)
    : Math.max(baseTick, Number(settings.rows) * baseTick);

  const feed = useFootprintTrades(symbol, interval, !mock, trades);

  useEffect(() => {
    saveFootprintSettings(settings, storage());
  }, [settings]);

  useEffect(() => {
    saveFootprintLink(linked, storage());
  }, [linked]);

  useEffect(() => {
    setUserLevels(loadUserLevels(symbol, storage()));
    setRemovedLevels(new Set());
    setSelectedT(null);
    setOlderCount(0);
  }, [symbol]);

  useEffect(() => {
    setSelectedT(null);
  }, [interval, mock]);

  useEffect(() => {
    const ladder = rowLadder(baseTickFor(symbol, price ?? 0));
    setAutoRowSize(ladder[Math.min(5, ladder.length - 1)]);
  }, [symbol]);

  const mockDataset = useMemo(
    () => (mock ? buildMockFootprint(symbol, interval, olderCount) : null),
    [mock, symbol, interval, olderCount],
  );

  const step = INTERVAL_MS[interval];
  const liveMeta = useMemo(() => {
    const out = new Map<number, FootprintCandleMeta>();
    for (const candle of candles) {
      const t = Math.floor(candle.t / step) * step;
      out.set(t, {
        open: candle.o,
        high: candle.h,
        low: candle.l,
        close: candle.c,
        forming: !candle.closed,
      });
    }
    return out;
  }, [candles, step]);

  const liveAggregate = useMemo(() => {
    if (mock) return null;
    return aggregateTrades(feed.trades, {
      symbol,
      interval,
      rowSize,
      baseTick,
      imbalanceRatio: settings.imbalanceRatio,
      minVolumeUsd: settings.minVolumeUsd,
      imbalanceMode: settings.imbalanceMode,
      valueAreaPct: settings.valueAreaPct,
      meta: liveMeta,
      source: 'live',
    });
  }, [
    mock, feed.trades, symbol, interval, rowSize, baseTick, settings.imbalanceRatio,
    settings.minVolumeUsd, settings.imbalanceMode, settings.valueAreaPct, liveMeta,
  ]);

  const prevProfile = useMemo(
    () => (mock ? null : prevDayProfile(candles, rowSize)),
    [mock, candles, rowSize],
  );

  const levels = useMemo(() => {
    const base = mockDataset
      ? [...mockDataset.levels, ...userFootprintLevels(userLevels)]
      : [
        ...userFootprintLevels(userLevels),
        ...prevDayFootprintLevels(prevProfile),
        ...planFootprintLevels(plan),
        ...(settings.showRekt ? liqFootprintLevels(liqEvents) : []),
      ];
    return filterFootprintLevels(base, settings).filter((level) => !removedLevels.has(level.id));
  }, [mockDataset, userLevels, prevProfile, plan, liqEvents, settings, removedLevels]);

  const annotations = useMemo(() => {
    if (mockDataset) {
      return mockDataset.annotations.filter((annotation) => (
        annotation.kind === 'npoc' ? settings.showNpoc : settings.showUaLines
      ));
    }
    if (!settings.showNpoc) return [];
    const naked = nakedPocAnnotation(prevProfile, candles, rowSize);
    return naked ? [naked] : [];
  }, [mockDataset, settings.showNpoc, settings.showUaLines, prevProfile, candles, rowSize]);

  const liquidationEvents = useMemo(() => {
    if (!settings.showRekt) return [];
    if (mockDataset) return mockDataset.liqEvents;
    return liveFootprintEvents(liqEvents);
  }, [mockDataset, liqEvents, settings.showRekt]);

  const dataset = useMemo<FootprintDataset>(() => {
    if (mockDataset) {
      return {
        ...mockDataset,
        rowSize,
        levels,
        annotations,
        liqEvents: liquidationEvents,
        lastPrice: mockDataset.lastPrice,
        source: 'mock',
        mock: true,
      };
    }
    if (liveAggregate) {
      return {
        ...liveAggregate,
        lastPrice: price ?? liveAggregate.lastPrice,
        levels,
        annotations,
        liqEvents: liquidationEvents,
        recordStart: null,
        source: 'live',
        mock: false,
      };
    }
    return {
      symbol,
      interval,
      rowSize,
      baseTick,
      candles: [],
      from: null,
      to: null,
      lastPrice: price ?? 0,
      levels,
      annotations,
      liqEvents: liquidationEvents,
      recordStart: null,
      source: 'live',
      mock: false,
    };
  }, [
    mockDataset, liveAggregate, rowSize, levels, annotations, liquidationEvents, price,
    symbol, interval, baseTick,
  ]);

  const selected = useMemo(() => {
    if (!dataset.candles.length) return null;
    return dataset.candles.find((candle) => candle.t === selectedT)
      ?? dataset.candles[dataset.candles.length - 1];
  }, [dataset, selectedT]);

  const reading = useMemo(() => readingFor(dataset, selected), [dataset, selected]);

  const updateSettings = useCallback((patch: Partial<FootprintSettings>) => {
    setSettings((previous) => ({ ...previous, ...patch }));
  }, []);

  const handleInterval = useCallback((next: TerminalInterval) => {
    setManualInterval(next);
    if (linked) onInterval(next);
  }, [linked, onInterval]);

  const handleLink = useCallback((next: boolean) => {
    setLinked(next);
    if (next) {
      setManualInterval(terminalInterval);
    } else {
      setManualInterval(interval);
    }
  }, [interval, terminalInterval]);

  const handleAddLevel = useCallback((levelPrice: number) => {
    setUserLevels((previous) => {
      const quantum = levelPrice >= 1_000 ? 0.01 : levelPrice >= 1 ? 0.0001 : 1e-6;
      const snapped = Math.round(levelPrice / quantum) * quantum;
      const exists = previous.some((value) => Math.abs(value - snapped) < quantum / 2);
      const next = exists
        ? previous.filter((value) => Math.abs(value - snapped) >= quantum / 2)
        : [...previous, snapped].sort((a, b) => a - b);
      saveUserLevels(symbol, next, storage());
      return next;
    });
  }, [symbol]);

  const handleRemoveLevel = useCallback((id: string) => {
    const target = levels.find((level) => level.id === id);
    setRemovedLevels((previous) => {
      const next = new Set(previous);
      next.add(id);
      return next;
    });
    if (target && target.kind === 'user') {
      setUserLevels((previous) => {
        const next = previous.filter((value) => Math.abs(value - target.price) >= 0.005);
        if (next.length !== previous.length) saveUserLevels(symbol, next, storage());
        return next;
      });
    }
  }, [levels, symbol]);

  const handleLoadOlder = useCallback(() => {
    if (mock) setOlderCount((count) => count + 50);
    else feed.loadOlder();
  }, [mock, feed]);

  const loading = !mock && feed.loading && feed.trades.length === 0 && dataset.candles.length === 0;
  const error = mock ? null : feed.error && dataset.candles.length === 0 ? feed.error : null;
  const canLoadOlder = mock || feed.canLoadOlder;
  const olderLoading = !mock && feed.olderLoading;

  return (
    <section className="fp-view" aria-label="Footprint chart">
      <FootprintToolbar
        settings={settings}
        onChange={updateSettings}
        interval={interval}
        onInterval={handleInterval}
        linked={linked}
        onLink={handleLink}
        from={dataset.from}
        rowSize={rowSize}
        candleCount={dataset.candles.length}
        mock={mock}
        olderLoading={olderLoading}
        canLoadOlder={canLoadOlder}
        onLoadOlder={handleLoadOlder}
      />

      {mock && (
        <div className="fp-mock-note">
          {'MOCK COMPOSITION \u2014 fixture replay, not the live market. Every cell comes from a fixed trade list.'}
        </div>
      )}

      <div className={`fp-reading${selected?.forceQuiet ? ' is-quiet' : ''}`} role="status" aria-live="polite">
        {reading}
      </div>

      <FootprintCanvas
        symbol={symbol}
        dataset={dataset}
        settings={settings}
        interval={interval}
        rowSize={rowSize}
        selectedT={selectedT}
        mock={mock}
        loading={loading}
        error={error}
        onSelect={setSelectedT}
        onAddLevel={handleAddLevel}
        onRemoveLevel={handleRemoveLevel}
        onAutoRowSize={setAutoRowSize}
      />

      <footer className="fp-foot">
        <span>Wheel zooms time · Shift+wheel stretches price · drag pans · right-click adds a level</span>
        <span>
          {linked ? 'linked timeframe' : 'independent timeframe'} · {settings.imbalanceRatio}:1{' '}
          {settings.imbalanceMode} imbalances · {settings.valueAreaPct}% value area
        </span>
      </footer>
    </section>
  );
}
