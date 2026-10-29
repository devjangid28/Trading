import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  BubbleFloor, BubbleMode, BubbleSize, ColumnKey, Contrast, HeatmapSettings, RangeKey,
  SizeUnit, StepMode, TapeMin, VolumeOver,
} from './settings';
import {
  BUBBLE_FLOOR_KEYS, BUBBLE_FLOOR_LABEL, BUBBLE_KEYS, BUBBLE_SIZE_KEYS, BUBBLE_SIZE_LABEL,
  COLUMN_DESCRIPTION, COLUMN_KEYS, COLUMN_NAME, COLUMN_PRESETS, CONTRAST_KEYS,
  DEFAULT_SETTINGS, RANGE_KEYS, SIZE_UNIT_KEYS, STEP_KEYS, TAPE_MIN_KEYS, TAPE_MIN_LABEL,
  VOLUME_OVER_KEYS,
} from './settings';

type Popover = 'columns' | 'help' | null;

const SPAN_OPTIONS = ['1m', '2m', '5m', '12m', '15m', '30m', '1h', '4h', '1d'] as const;

function spanLabel(span: string): string {
  return span === '1d' ? '1D' : span;
}

function rangeLabel(key: RangeKey): string {
  return key === 'auto' ? 'Auto' : `\u00b1${key}%`;
}

function contrastLabel(key: Contrast): string {
  return key === 'low' ? 'Low' : key === 'med' ? 'Med' : 'High';
}

function bubbleLabel(key: BubbleMode): string {
  return key === 'auto' ? 'Auto' : key === 'trades' ? 'Trades' : key === 'steps' ? 'Steps' : 'Off';
}

function stepLabel(key: StepMode): string {
  return key === 'auto' ? 'Auto' : key;
}

function PopoverShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="toolbar-popover" role="dialog" aria-label={title}>
      <div className="toolbar-popover__title">{title}</div>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  label, title, value, options, labels, onChange,
}: {
  label: string;
  title: string;
  value: T;
  options: readonly T[];
  labels: (value: T) => string;
  onChange: (value: T) => void;
}) {
  return (
    <div className="toolbar-group" title={title}>
      <span className="toolbar-kicker">{label}</span>
      <div className="segmented" role="group" aria-label={title}>
        {options.map((option) => (
          <button
            key={option}
            type="button"
            className={`segmented__btn${option === value ? ' is-on' : ''}`}
            aria-pressed={option === value}
            onClick={() => onChange(option)}
          >
            {labels(option)}
          </button>
        ))}
      </div>
    </div>
  );
}

export interface HeatmapToolbarProps {
  settings: HeatmapSettings;
  onChange: (patch: Partial<HeatmapSettings>) => void;
  library: boolean;
  history: boolean;
}

export function HeatmapToolbar({ settings, onChange, library, history }: HeatmapToolbarProps) {
  const [open, setOpen] = useState<Popover>(null);
  const [more, setMore] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const columns = settings.columns;

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

  const toggle = (next: Popover) => setOpen((current) => (current === next ? null : next));
  const orderedColumns: ColumnKey[] = [
    ...columns,
    ...COLUMN_KEYS.filter((key) => !columns.includes(key)),
  ];

  const toggleColumn = (key: ColumnKey) => {
    const next = columns.includes(key) ? columns.filter((column) => column !== key) : [...columns, key];
    onChange({ columns: next });
  };

  const moveColumn = (key: ColumnKey, direction: -1 | 1) => {
    const index = orderedColumns.indexOf(key);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= orderedColumns.length) return;
    const swapped = [...orderedColumns];
    swapped[index] = orderedColumns[target];
    swapped[target] = key;
    onChange({ columns: swapped.filter((column) => columns.includes(column)) });
  };

  return (
    <div className="chart-toolbar" ref={rootRef}>
      <div className="toolbar-row">
        <Segmented
          label="Span"
          title="How much time the chart shows"
          value={settings.span}
          options={SPAN_OPTIONS}
          labels={spanLabel}
          onChange={(span) => onChange({ span })}
        />
        <Segmented
          label="Price range"
          title="How much price area fits around the last price"
          value={settings.range}
          options={RANGE_KEYS}
          labels={rangeLabel}
          onChange={(range) => onChange({ range })}
        />
        <Segmented
          label="Contrast"
          title="How strongly rare liquidity stands out"
          value={settings.contrast}
          options={CONTRAST_KEYS}
          labels={contrastLabel}
          onChange={(contrast) => onChange({ contrast })}
        />
        <Segmented
          label="Bubbles"
          title="How executed volume is grouped"
          value={settings.bubbles}
          options={BUBBLE_KEYS}
          labels={bubbleLabel}
          onChange={(bubbles) => onChange({ bubbles })}
        />

        <div className="toolbar-group toolbar-group--wide">
          <button
            type="button"
            className={`toolbar-btn${open === 'columns' ? ' is-open' : ''}`}
            aria-expanded={open === 'columns'}
            onClick={() => toggle('columns')}
            title="Show or hide columns beside the heatmap"
          >
            <span aria-hidden>{'\u25a5'}</span> Columns ({columns.length})
          </button>
          <button
            type="button"
            className={`toolbar-btn${more ? ' is-open' : ''}`}
            aria-expanded={more}
            onClick={() => setMore((value) => !value)}
            title="More chart settings"
          >
            <span aria-hidden>{more ? '\u25be' : '\u25b8'}</span> {more ? 'Less' : 'More'}
          </button>
          <button
            type="button"
            className={`toolbar-btn toolbar-btn--icon${open === 'help' ? ' is-open' : ''}`}
            aria-label="How to read the heatmap"
            aria-expanded={open === 'help'}
            onClick={() => toggle('help')}
          >
            ?
          </button>

          {open === 'columns' && (
            <PopoverShell title="Columns">
              <div className="popover-section-label">Presets</div>
              <div className="preset-list">
                {COLUMN_PRESETS.map((preset) => (
                  <button
                    key={preset.name}
                    type="button"
                    className="preset-row"
                    onClick={() => onChange({ columns: preset.columns })}
                  >
                    <span>{preset.name}</span>
                    <span className="preset-count">{preset.columns.length}</span>
                  </button>
                ))}
              </div>

              <div className="popover-section-label">Show columns</div>
              <div className="column-checklist">
                {orderedColumns.map((key) => {
                  const on = columns.includes(key);
                  return (
                    <div key={key} className="column-check">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggleColumn(key)}
                        aria-label={`Show ${COLUMN_NAME[key]} column`}
                      />
                      <span className="column-check__copy">
                        <b>{COLUMN_NAME[key]}</b>
                        <small>{COLUMN_DESCRIPTION[key]}</small>
                      </span>
                      <span className="column-check__move">
                        <button type="button" aria-label={`Move ${COLUMN_NAME[key]} up`} onClick={() => moveColumn(key, -1)}>{'\u2191'}</button>
                        <button type="button" aria-label={`Move ${COLUMN_NAME[key]} down`} onClick={() => moveColumn(key, 1)}>{'\u2193'}</button>
                      </span>
                    </div>
                  );
                })}
              </div>

              <label className="check-row">
                <input type="checkbox" checked={settings.cvdStrip} onChange={(e) => onChange({ cvdStrip: e.target.checked })} />
                <span>CVD strip</span>
              </label>
              <div className="setting-row">
                <label htmlFor="set-volume-over">Volume &amp; delta over</label>
                <select id="set-volume-over" value={settings.volumeOver} onChange={(e) => onChange({ volumeOver: e.target.value as VolumeOver })}>
                  {VOLUME_OVER_KEYS.map((key) => <option key={key} value={key}>{key === 'span' ? 'Chart span' : 'Session'}</option>)}
                </select>
              </div>
              <div className="setting-row">
                <label htmlFor="set-unit">SuperDOM / COB sizes in</label>
                <select id="set-unit" value={settings.sizeUnit} onChange={(e) => onChange({ sizeUnit: e.target.value as SizeUnit })}>
                  {SIZE_UNIT_KEYS.map((key) => <option key={key} value={key}>{key === 'usd' ? '$' : 'Coin'}</option>)}
                </select>
              </div>
              <div className="setting-row">
                <label htmlFor="set-tape">Tape {'\u2265'}</label>
                <select id="set-tape" value={settings.tapeMin} onChange={(e) => onChange({ tapeMin: e.target.value as TapeMin })}>
                  {TAPE_MIN_KEYS.map((key) => <option key={key} value={key}>{TAPE_MIN_LABEL[key]}</option>)}
                </select>
              </div>
            </PopoverShell>
          )}

          {open === 'help' && (
            <PopoverShell title="How to read the heatmap">
              <div className="help-block">
                <b>Resting liquidity</b>
                <p>Each row is that order-book price over time. Cells are total resting bid and ask notional; hotter and yellower means more size. Empty means no recorded level, not zero.</p>
                <b>Bubbles</b>
                <p>Each bubble is executed volume. Green bought, red sold, a split bubble is both. Bigger means more notional, never more time.</p>
                <b>Yellow ring</b>
                <p>Marks a print among the largest visible. The dollar label on the largest prints is the print&rsquo;s own notional.</p>
                <b>{'\u203a\u203a / \u2039\u2039'}</b>
                <p>Double chevrons sit above a one-sided buy or below a one-sided sell that had little price impact.</p>
                <b>{'\u2715'}</b>
                <p>A resting level disappeared without a trade at that price. It was a cancel, not a fill. Hover it for the size and how long it stood.</p>
              </div>
              <p className="popover-note">Hover any cell for the recorded levels. Wheel zooms time, Shift+wheel or drag on the price axis stretches price, drag pans time, double-click resets to live. Right-click a price to add or remove a level.</p>
            </PopoverShell>
          )}
        </div>

        <div className="toolbar-meta" title="Measured from this browser's live book and the server's captured history">
          <span className={`toolbar-dot${library || history ? ' is-on' : ''}`} />
          <span>{history ? 'server history + live' : library ? 'live book' : 'waiting for book'}</span>
        </div>
      </div>

      {more && (
        <div className="toolbar-row toolbar-row--more">
          <div className="toolbar-group">
            <span className="toolbar-kicker">Bubble size</span>
            <div className="segmented" role="group" aria-label="Bubble size">
              {BUBBLE_SIZE_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`segmented__btn${settings.bubbleSize === key ? ' is-on' : ''}`}
                  aria-pressed={settings.bubbleSize === key}
                  onClick={() => onChange({ bubbleSize: key as BubbleSize })}
                >
                  {BUBBLE_SIZE_LABEL[key]}
                </button>
              ))}
            </div>
          </div>
          <div className="toolbar-group">
            <span className="toolbar-kicker">Bubbles {'\u2265'}</span>
            <div className="segmented" role="group" aria-label="Bubble floor">
              {BUBBLE_FLOOR_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`segmented__btn${settings.bubbleFloor === key ? ' is-on' : ''}`}
                  aria-pressed={settings.bubbleFloor === key}
                  onClick={() => onChange({ bubbleFloor: key as BubbleFloor })}
                >
                  {BUBBLE_FLOOR_LABEL[key]}
                </button>
              ))}
            </div>
          </div>
          <div className="toolbar-group">
            <span className="toolbar-kicker">Step</span>
            <div className="segmented" role="group" aria-label="Step length">
              {STEP_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`segmented__btn${settings.stepMode === key ? ' is-on' : ''}`}
                  aria-pressed={settings.stepMode === key}
                  onClick={() => onChange({ stepMode: key })}
                >
                  {stepLabel(key)}
                </button>
              ))}
            </div>
          </div>
          <div className="toolbar-group">
            <span className="toolbar-kicker">Candles</span>
            <button
              type="button"
              className={`toolbar-btn${settings.showCandles ? ' is-on' : ''}`}
              aria-pressed={settings.showCandles}
              onClick={() => onChange({ showCandles: !settings.showCandles })}
            >
              {'\u25cb'} Candles
            </button>
          </div>
          <button type="button" className="toolbar-btn toolbar-btn--ghost" onClick={() => onChange({ ...DEFAULT_SETTINGS })}>
            Reset
          </button>
        </div>
      )}
    </div>
  );
}
