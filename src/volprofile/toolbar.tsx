import { useEffect, useRef, useState } from 'react';
import type { AtScaleMode, DeltaMode, ProfilesMode, VolumeMode, VolSettings } from './types';

const PROFILES_OPTIONS: Array<{ value: ProfilesMode; label: string }> = [
  { value: 'timeframe', label: 'Timeframe' },
  { value: 'session', label: 'Session' },
  { value: 'custom', label: 'Custom' },
];

const MODE_OPTIONS: Array<{ value: VolumeMode; label: string }> = [
  { value: 'volume', label: 'Volume' },
  { value: 'bidask', label: 'Bid x Ask' },
];

const DELTA_OPTIONS: Array<{ value: DeltaMode; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'beside', label: 'Beside' },
  { value: 'colour', label: 'Colour' },
];

const ATSCALE_OPTIONS: Array<{ value: AtScaleMode; label: string }> = [
  { value: 'current', label: 'Current period' },
  { value: 'each', label: 'Each profile' },
  { value: 'all', label: 'All profiles' },
];

interface SegProps<T extends string> {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}

function Seg<T extends string>({ label, value, options, onChange }: SegProps<T>) {
  return (
    <div className="vp-seg">
      <span className="vp-seg-label">{label}</span>
      <div className="vp-pills" role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className={value === o.value ? 'is-on' : ''}
            aria-pressed={value === o.value}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function useCloseOnOutside(open: boolean, onClose: () => void): React.RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);
  return ref;
}

interface ToolbarProps {
  settings: VolSettings;
  onSettings: (patch: Partial<VolSettings>) => void;
  mock: boolean;
}

export function VolToolbar({ settings, onSettings, mock }: ToolbarProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const settingsRef = useCloseOnOutside(settingsOpen, () => setSettingsOpen(false));
  const helpRef = useCloseOnOutside(helpOpen, () => setHelpOpen(false));

  const manualBin = typeof settings.binSize === 'number';

  return (
    <header className="vp-toolbar" aria-label="Volume profile tools">
      <Seg
        label="Profiles"
        value={settings.profiles}
        options={PROFILES_OPTIONS}
        onChange={(v) => onSettings({ profiles: v })}
      />
      {settings.profiles === 'custom' && (
        <span className="vp-hint">Shift+drag across the chart to add a range</span>
      )}

      <Seg
        label="Mode"
        value={settings.mode}
        options={MODE_OPTIONS}
        onChange={(v) => onSettings({ mode: v })}
      />
      <Seg
        label="Delta"
        value={settings.delta}
        options={DELTA_OPTIONS}
        onChange={(v) => onSettings({ delta: v })}
      />

      <div className="vp-seg vp-seg--drop">
        <span className="vp-seg-label">At scale</span>
        <div className="vp-drop" ref={settingsRef}>
          <select
            className="vp-drop-select"
            value={settings.atScale}
            aria-label="At scale"
            onChange={(e) => onSettings({ atScale: e.target.value as AtScaleMode })}
          >
            {ATSCALE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <span className="vp-drop-chevron" aria-hidden>▾</span>
        </div>
      </div>

      <div className="vp-seg" ref={settingsRef}>
        <button
          type="button"
          className={`vp-gear${settingsOpen ? ' is-on' : ''}`}
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((v) => !v)}
          title="Profile settings"
        >
          ⚙ Settings
        </button>
        {settingsOpen && (
          <div className="vp-popover" role="dialog" aria-label="Volume profile settings">
            <div className="vp-popover-head"><strong>Settings</strong></div>
            <div className="vp-popover-body">
              <label className="vp-field">
                <span>Bin size</span>
                <span className="vp-row">
                  <button
                    type="button"
                    className={`vp-mini${!manualBin ? ' is-on' : ''}`}
                    onClick={() => onSettings({ binSize: 'auto' })}
                  >
                    Auto
                  </button>
                  <button
                    type="button"
                    className={`vp-mini${manualBin ? ' is-on' : ''}`}
                    onClick={() => onSettings({ binSize: 25 })}
                  >
                    Manual
                  </button>
                  {manualBin && (
                    <input
                      type="number"
                      min={0.01}
                      step={0.01}
                      value={settings.binSize}
                      onChange={(e) => onSettings({ binSize: Math.max(0.01, Number(e.target.value) || 25) })}
                      aria-label="Manual bin size"
                    />
                  )}
                </span>
              </label>

              <label className="vp-field">
                <span>Value area %</span>
                <input
                  type="number"
                  min={5}
                  max={100}
                  value={settings.valueAreaPct}
                  onChange={(e) => onSettings({ valueAreaPct: Math.max(5, Math.min(100, Number(e.target.value) || 70)) })}
                />
              </label>

              <label className="vp-field">
                <span>Bar opacity</span>
                <input
                  type="range"
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={settings.barOpacity}
                  onChange={(e) => onSettings({ barOpacity: Number(e.target.value) })}
                />
                <em>{Math.round(settings.barOpacity * 100)}%</em>
              </label>

              <div className="vp-field vp-checks">
                <label><input type="checkbox" checked={settings.showVwapBands} onChange={(e) => onSettings({ showVwapBands: e.target.checked })} />VWAP bands</label>
                <label><input type="checkbox" checked={settings.showPoc} onChange={(e) => onSettings({ showPoc: e.target.checked })} />POC / VAH / VAL</label>
              </div>

              <div className="vp-field">
                <span>Colors</span>
                <span className="vp-row vp-swatches">
                  <label title="Row"><input type="color" value={settings.colorRow} onChange={(e) => onSettings({ colorRow: e.target.value })} /></label>
                  <label title="Ask / buy"><input type="color" value={settings.colorAsk} onChange={(e) => onSettings({ colorAsk: e.target.value })} /></label>
                  <label title="Bid / sell"><input type="color" value={settings.colorBid} onChange={(e) => onSettings({ colorBid: e.target.value })} /></label>
                  <label title="POC"><input type="color" value={settings.colorPoc} onChange={(e) => onSettings({ colorPoc: e.target.value })} /></label>
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="vp-seg" ref={helpRef}>
        <button
          type="button"
          className="vp-help"
          aria-expanded={helpOpen}
          aria-label="Help"
          onClick={() => setHelpOpen((v) => !v)}
        >
          ?
        </button>
        {helpOpen && (
          <div className="vp-popover vp-popover--help" role="dialog" aria-label="Volume profile help">
            <div className="vp-popover-head"><strong>Vol profile — how to read it</strong></div>
            <div className="vp-popover-body">
              <p><b>Profiles Custom</b>: hold <b>Shift</b> and drag across the chart to pick a time range — a volume profile is built for it. Drag the edges to resize, click <b>×</b> to delete.</p>
              <p><b>Session / Timeframe</b>: one profile per UTC day, or per bar of the header timeframe. Drawn automatically.</p>
              <p><b>Mode</b>: Volume = single-colour rows. Bid x Ask = green buy / red sell segments.</p>
              <p><b>Delta</b>: Beside adds a per-row delta bar; Colour shades the row green/red by delta.</p>
              <p><b>At scale</b>: how bar lengths are normalized — Current period (selected/rightmost profile), Each profile, or All profiles.</p>
              <p>White VWAP segments reset at 00:00 UTC; dashed ±1σ and dotted ±2σ bands widen as the session develops.</p>
            </div>
          </div>
        )}
      </div>

      {mock && <span className="vp-mock">MOCK</span>}
    </header>
  );
}
