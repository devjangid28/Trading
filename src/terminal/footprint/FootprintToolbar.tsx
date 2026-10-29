import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { TerminalInterval } from '../../../shared/types';
import { TERMINAL_INTERVALS } from '../../../shared/types';
import {
  COLOR_SCALE_KEYS, IMBALANCE_MODE_KEYS, IMBALANCE_RATIO_KEYS, MIN_VOLUME_KEYS, ROW_KEYS,
  ROW_LABEL, SHOW_KEYS, SHOW_LABEL, UNIT_KEYS, VALUE_AREA_KEYS,
} from './settings';
import type { FootprintSettings } from './types';
import { fpRowSizeText, fpUtcStamp } from './format';

type Popover = 'settings' | 'help' | null;

function intervalLabel(interval: TerminalInterval): string {
  return interval === '1d' ? '1D' : interval;
}

function unitLabel(units: FootprintSettings['units']): string {
  return units === 'usd' ? '$' : 'BTC';
}

function Toggle({
  label, checked, onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="check-row">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function PopoverShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="toolbar-popover" role="dialog" aria-label={title}>
      <div className="toolbar-popover__title">{title}</div>
      {children}
    </div>
  );
}

export interface FootprintToolbarProps {
  settings: FootprintSettings;
  onChange: (patch: Partial<FootprintSettings>) => void;
  interval: TerminalInterval;
  onInterval: (interval: TerminalInterval) => void;
  linked: boolean;
  onLink: (linked: boolean) => void;
  from: number | null;
  rowSize: number;
  candleCount: number;
  mock: boolean;
  olderLoading: boolean;
  canLoadOlder: boolean;
  onLoadOlder: () => void;
}

export function FootprintToolbar({
  settings, onChange, interval, onInterval, linked, onLink, from, rowSize, candleCount,
  mock, olderLoading, canLoadOlder, onLoadOlder,
}: FootprintToolbarProps) {
  const [open, setOpen] = useState<Popover>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(null);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="chart-toolbar fp-toolbar" ref={rootRef}>
      <div className="toolbar-row">
        <div className="toolbar-group">
          <span className="toolbar-kicker">Candles</span>
          <div className="segmented" role="group" aria-label="Footprint timeframe">
            {TERMINAL_INTERVALS.map((option) => (
              <button
                key={option}
                type="button"
                className={`segmented__btn${option === interval ? ' is-on' : ''}`}
                aria-pressed={option === interval}
                onClick={() => onInterval(option)}
              >
                {intervalLabel(option)}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={`toolbar-btn toolbar-btn--icon${linked ? ' is-on' : ''}`}
            aria-pressed={linked}
            title={linked ? 'Linked to the shared Timeframe \u2014 click to unlink' : 'Independent timeframe \u2014 click to link'}
            aria-label={linked ? 'Unlink footprint timeframe' : 'Link footprint timeframe to terminal'}
            onClick={() => onLink(!linked)}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          </button>
        </div>

        <div className="toolbar-group">
          <span className="toolbar-kicker">Show</span>
          <div className="segmented" role="group" aria-label="Footprint cell content">
            {SHOW_KEYS.map((option) => (
              <button
                key={option}
                type="button"
                className={`segmented__btn${option === settings.show ? ' is-on' : ''}`}
                aria-pressed={option === settings.show}
                onClick={() => onChange({ show: option })}
              >
                {SHOW_LABEL[option]}
              </button>
            ))}
          </div>
        </div>

        <div className="toolbar-group">
          <span className="toolbar-kicker">Rows</span>
          <div className="segmented" role="group" aria-label="Footprint row size">
            {ROW_KEYS.map((option) => (
              <button
                key={option}
                type="button"
                className={`segmented__btn${option === settings.rows ? ' is-on' : ''}`}
                aria-pressed={option === settings.rows}
                onClick={() => onChange({ rows: option })}
              >
                {ROW_LABEL[option]}
              </button>
            ))}
          </div>
        </div>

        <div className="toolbar-group">
          <span className="toolbar-kicker">Units</span>
          <div className="segmented" role="group" aria-label="Footprint units">
            {UNIT_KEYS.map((option) => (
              <button
                key={option}
                type="button"
                className={`segmented__btn${option === settings.units ? ' is-on' : ''}`}
                aria-pressed={option === settings.units}
                onClick={() => onChange({ units: option })}
              >
                {unitLabel(option)}
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          className="toolbar-btn fp-load-older"
          onClick={onLoadOlder}
          disabled={!canLoadOlder || olderLoading}
          title={canLoadOlder ? 'Load the previous 50 candles' : 'No older trades are available yet'}
        >
          {olderLoading ? (
            <span className="fp-spinner" aria-hidden />
          ) : (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
              <path d="M3 3v5h5" />
              <path d="M12 7v5l3 2" />
            </svg>
          )}
          <span>{olderLoading ? 'Loading\u2026' : 'Load older'}</span>
        </button>

        <span className="fp-from" title="Oldest candle currently loaded">
          {fpUtcStamp(from)}
        </span>

        <div className="toolbar-group toolbar-group--wide">
          <button
            type="button"
            className={`toolbar-btn${open === 'settings' ? ' is-open' : ''}`}
            aria-expanded={open === 'settings'}
            onClick={() => setOpen((value) => (value === 'settings' ? null : 'settings'))}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.1.37.33.7.65.94.3.22.67.34 1.05.34H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51.72Z" />
            </svg>
            Settings
          </button>
          <button
            type="button"
            className={`toolbar-btn toolbar-btn--icon${open === 'help' ? ' is-open' : ''}`}
            aria-label="How to read the footprint"
            aria-expanded={open === 'help'}
            onClick={() => setOpen((value) => (value === 'help' ? null : 'help'))}
          >
            ?
          </button>

          {open === 'settings' && (
            <PopoverShell title="Footprint settings">
              <div className="setting-row">
                <label htmlFor="fp-setting-ratio">Imbalance ratio</label>
                <select
                  id="fp-setting-ratio"
                  value={settings.imbalanceRatio}
                  onChange={(event) => onChange({ imbalanceRatio: Number(event.target.value) })}
                >
                  {IMBALANCE_RATIO_KEYS.map((value) => <option key={value} value={value}>{value}×</option>)}
                </select>
              </div>
              <div className="setting-row">
                <label htmlFor="fp-setting-mode">Imbalance compare</label>
                <select
                  id="fp-setting-mode"
                  value={settings.imbalanceMode}
                  onChange={(event) => onChange({ imbalanceMode: event.target.value as FootprintSettings['imbalanceMode'] })}
                >
                  {IMBALANCE_MODE_KEYS.map((value) => (
                    <option key={value} value={value}>{value === 'diagonal' ? 'Diagonal rows' : 'Same row'}</option>
                  ))}
                </select>
              </div>
              <div className="setting-row">
                <label htmlFor="fp-setting-min">Minimum row volume</label>
                <select
                  id="fp-setting-min"
                  value={settings.minVolumeUsd}
                  onChange={(event) => onChange({ minVolumeUsd: Number(event.target.value) })}
                >
                  {MIN_VOLUME_KEYS.map((value) => <option key={value} value={value}>${value.toLocaleString('en-US')}</option>)}
                </select>
              </div>
              <div className="setting-row">
                <label htmlFor="fp-setting-va">Value area</label>
                <select
                  id="fp-setting-va"
                  value={settings.valueAreaPct}
                  onChange={(event) => onChange({ valueAreaPct: Number(event.target.value) })}
                >
                  {VALUE_AREA_KEYS.map((value) => <option key={value} value={value}>{value}%</option>)}
                </select>
              </div>
              <div className="setting-row">
                <label htmlFor="fp-setting-scale">Colour scale</label>
                <select
                  id="fp-setting-scale"
                  value={settings.colorScale}
                  onChange={(event) => onChange({ colorScale: event.target.value as FootprintSettings['colorScale'] })}
                >
                  {COLOR_SCALE_KEYS.map((value) => (
                    <option key={value} value={value}>{value === 'linear' ? 'Linear' : value === 'sqrt' ? 'Square root' : 'Logarithmic'}</option>
                  ))}
                </select>
              </div>
              <div className="popover-section-label">Display</div>
              <Toggle label="B/S header" checked={settings.showBuySellPct} onChange={(value) => onChange({ showBuySellPct: value })} />
              <Toggle label="Summary strip" checked={settings.showSummary} onChange={(value) => onChange({ showSummary: value })} />
              <Toggle label="POC ticks" checked={settings.showPocTicks} onChange={(value) => onChange({ showPocTicks: value })} />
              <Toggle label="UA high / low lines" checked={settings.showUaLines} onChange={(value) => onChange({ showUaLines: value })} />
              <Toggle label="nPOC annotations" checked={settings.showNpoc} onChange={(value) => onChange({ showNpoc: value })} />
              <Toggle label="Previous-day levels" checked={settings.showPrevDay} onChange={(value) => onChange({ showPrevDay: value })} />
              <Toggle label="Liquidation labels" checked={settings.showRekt} onChange={(value) => onChange({ showRekt: value })} />
              <Toggle label="Cell bars" checked={settings.showCellBars} onChange={(value) => onChange({ showCellBars: value })} />
              <div className="popover-footer">
                <button type="button" className="toolbar-btn" onClick={() => setOpen(null)}>Done</button>
              </div>
            </PopoverShell>
          )}

          {open === 'help' && (
            <PopoverShell title="Footprint — what's inside each candle">
              <div className="help-block">
                <b>Bid × Ask</b>
                <p>Each row is one price step. The left number is volume sold at the bid; the right number is volume bought at the ask. Brighter text marks the larger side.</p>
                <b>POC</b>
                <p>The yellow tick and row border mark the price with the most traded volume in that candle. It is the volume point of control, not a forecast.</p>
                <b>Imbalance</b>
                <p>A row is bold when one side is at least the chosen ratio larger than the opposite side on the row below (diagonal) or on its own row. The footer counts the marked rows.</p>
                <b>Delta and summary</b>
                <p>Δ is aggressive buys minus aggressive sells. The strip repeats volume, delta, delta as a share of volume, cumulative delta and the candle time for every visible candle.</p>
                <b>Rekt markers</b>
                <p>Liquidation labels come from Binance forceOrder samples. The feed sends at most one print per symbol per second, so the totals are a lower bound.</p>
              </div>
              <p className="popover-note">
                Wheel zooms time, Shift+wheel stretches price, drag pans, double-click or Home returns to live.
                Right-click a price to add or remove a level. Every cell is built from recorded aggTrades; nothing is estimated.
              </p>
            </PopoverShell>
          )}
        </div>

        {mock && <span className="fp-mock-badge">MOCK</span>}
        <span className="fp-toolbar-meta" title="Visible candles and row size">
          {candleCount} candles · {fpRowSizeText(rowSize)} USDT rows
        </span>
      </div>
    </div>
  );
}
