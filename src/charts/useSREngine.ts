import { useEffect, useMemo, useState } from 'react';
import type { Candle, TerminalHistory } from '../../shared/types';
import { fetchLiquidityWalls, type LiquidityWall } from './liquidity';
import {
  DEFAULT_SR_CONFIG,
  runSREngine,
  type HeatmapHealth,
  type SREngineConfig,
  type SREngineOutput,
} from './srEngine';
import { fetchTerminalHistoryForCharts } from './terminalHistory';

export type HeatmapFetchStatus = 'loading' | 'live' | 'fallback' | 'offline';

/**
 * Owns the live inputs of the S/R engine for one symbol/interval:
 *   - live order-book walls (polled every 15 s),
 *   - the server-recorded depth heatmap history (polled every 60 s).
 *
 * The engine output is recomputed once per render from these inputs, so the
 * chart overlay and the sidebar table always show the same answer.
 */
export function useSREngine(
  symbol: string,
  interval: string,
  data: Candle[],
  opts: { config?: Partial<SREngineConfig> } = {},
): { output: SREngineOutput; heatmapStatus: HeatmapFetchStatus } {
  const [walls, setWalls] = useState<LiquidityWall[]>([]);
  const [history, setHistory] = useState<TerminalHistory | null>(null);
  const [heatmapStatus, setHeatmapStatus] = useState<HeatmapFetchStatus>('loading');

  useEffect(() => {
    if (!symbol) return;
    let alive = true;
    const poll = async () => {
      try {
        const next = await fetchLiquidityWalls(symbol);
        if (alive) setWalls(next);
      } catch {
        if (alive) setWalls([]);
      }
    };
    poll();
    const timer = setInterval(poll, 15_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [symbol]);

  useEffect(() => {
    if (!symbol) return;
    let alive = true;
    const controller = new AbortController();
    setHeatmapStatus('loading');
    const load = async () => {
      try {
        const next = await fetchTerminalHistoryForCharts(symbol, interval, controller.signal);
        if (!alive) return;
        setHistory(next);
        setHeatmapStatus(next && next.frames.length > 0 ? 'live' : 'fallback');
      } catch {
        if (alive) setHeatmapStatus('offline');
      }
    };
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      alive = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [symbol, interval]);

  const config = useMemo(() => ({ ...DEFAULT_SR_CONFIG, ...opts.config }), [opts.config]);

  const engineHeatmap: HeatmapHealth =
    heatmapStatus === 'live' ? 'live' : heatmapStatus === 'offline' ? 'offline' : 'fallback';

  const output = useMemo(
    () => runSREngine(data, interval, walls, config, history, false, 'UNKNOWN', engineHeatmap),
    [data, interval, walls, config, history, engineHeatmap],
  );

  return { output, heatmapStatus };
}
