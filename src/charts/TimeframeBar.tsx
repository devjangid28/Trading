import { CHART_INTERVALS, INTERVAL_LABEL, type ChartInterval } from './types';

interface TimeframeBarProps {
  interval: ChartInterval;
  onInterval: (interval: ChartInterval) => void;
}

export function TimeframeBar({ interval, onInterval }: TimeframeBarProps) {
  return (
    <div className="charts-timeframes">
      <div className="charts-timeframes-group" role="group" aria-label="Chart timeframe">
        {CHART_INTERVALS.map((value) => (
          <button
            key={value}
            type="button"
            className={`charts-timeframe${value === interval ? ' is-active' : ''}`}
            aria-pressed={value === interval}
            onClick={() => onInterval(value)}
          >
            {INTERVAL_LABEL[value]}
          </button>
        ))}
      </div>
      <div className="charts-timeframes-note">
        <span>SPOT</span>
        <span className="charts-timeframes-sep" aria-hidden="true">·</span>
        <span>UTC</span>
        <span className="charts-timeframes-sep" aria-hidden="true">·</span>
        <span>closed candles only</span>
      </div>
    </div>
  );
}
