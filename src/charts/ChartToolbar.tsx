import { useState } from 'react';
import {
  CHART_TYPES,
  DRAWING_TOOLS,
  INDICATOR_CATALOG,
  SCALE_TYPES,
  SESSION_LABEL,
  type ChartSettings,
  type ChartType,
  type DrawingTool,
  type IndicatorKind,
  type ScaleType,
  type SessionId,
} from './types';

const TOOL_PATHS: Record<DrawingTool, React.ReactNode> = {
  cursor: <path d="m5 3 6.5 17 2.2-6.4L20 11.4 5 3Z" />,
  trend: <path d="M4 19 20 5M15 5h5v5" />,
  ray: <path d="M4 12h16M15 7l5 5-5 5" />,
  hline: <path d="M3 12h18M7 8v8M17 8v8" />,
  rect: <rect x="4" y="6" width="16" height="12" rx="1" />,
  fib: <path d="M4 6h16M4 10h16M4 14h16M4 18h16" />,
  long: <><path d="M4 18 20 6" /><path d="M4 14h16M4 20h16" /></>,
  short: <><path d="M4 6 20 18" /><path d="M4 10h16M4 4h16" /></>,
  text: <><path d="M5 5h14M12 5v14M8 19h8" /></>,
};

function ToolIcon({ tool }: { tool: DrawingTool }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {TOOL_PATHS[tool]}
    </svg>
  );
}

interface ChartToolbarProps {
  settings: ChartSettings;
  activeTool: DrawingTool;
  fullscreen: boolean;
  onChartType: (type: ChartType) => void;
  onScale: (scale: ScaleType) => void;
  onToggleIndicator: (kind: IndicatorKind) => void;
  onRemoveIndicator: (kind: IndicatorKind) => void;
  onIndicatorParams: (kind: IndicatorKind, params: number[]) => void;
  onSession: (session: SessionId) => void;
  onTool: (tool: DrawingTool) => void;
  onClear: () => void;
  onFullscreen: () => void;
  onScrollToRealtime: () => void;
}

export function ChartToolbar({
  settings,
  activeTool,
  fullscreen,
  onChartType,
  onScale,
  onToggleIndicator,
  onRemoveIndicator,
  onIndicatorParams,
  onSession,
  onTool,
  onClear,
  onFullscreen,
  onScrollToRealtime,
}: ChartToolbarProps) {
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<IndicatorKind | null>(null);
  const activeKinds = new Set(settings.indicators.map((indicator) => indicator.kind));
  const available = INDICATOR_CATALOG.filter((entry) => !activeKinds.has(entry.kind));

  return (
    <div className="charts-toolbar">
      <div className="charts-toolbar-group charts-chart-types" role="group" aria-label="Chart type">
        {CHART_TYPES.map((type) => (
          <button
            key={type.id}
            type="button"
            className={`charts-tool-button${settings.chartType === type.id ? ' is-active' : ''}`}
            aria-pressed={settings.chartType === type.id}
            onClick={() => onChartType(type.id)}
          >
            {type.id === 'heikin' ? 'Heikin' : type.label}
          </button>
        ))}
      </div>

      <label className="charts-scale">
        <span>Scale</span>
        <select
          value={settings.scale}
          onChange={(event) => onScale(event.target.value as ScaleType)}
          aria-label="Chart scale"
        >
          {SCALE_TYPES.map((scale) => (
            <option key={scale.id} value={scale.id}>{scale.label}</option>
          ))}
        </select>
      </label>

      <span className="charts-toolbar-divider" aria-hidden="true" />

      <div className="charts-indicators">
        {settings.indicators.map((indicator) => {
          const entry = INDICATOR_CATALOG.find((item) => item.kind === indicator.kind);
          if (!entry) return null;
          return (
            <div className={`charts-indicator${indicator.visible ? '' : ' is-off'}`} key={indicator.id}>
              <button
                type="button"
                className="charts-indicator-main"
                title={`${indicator.visible ? 'Hide' : 'Show'} ${entry.label}`}
                onClick={() => onToggleIndicator(indicator.kind)}
              >
                <span className="charts-indicator-dot" style={{ background: entry.color }} aria-hidden="true" />
                <span>{entry.label}</span>
                {indicator.params.length > 0 && (
                  <span className="charts-indicator-params">({indicator.params.join(',')})</span>
                )}
              </button>
              {indicator.params.length > 0 && (
                <button
                  type="button"
                  className="charts-indicator-icon"
                  aria-label={`Edit ${entry.label} parameters`}
                  title="Edit parameters"
                  onClick={() => setEditing((value) => value === indicator.kind ? null : indicator.kind)}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
                  </svg>
                </button>
              )}
              <button
                type="button"
                className="charts-indicator-icon"
                aria-label={`Remove ${entry.label}`}
                title="Remove indicator"
                onClick={() => onRemoveIndicator(indicator.kind)}
              >
                ×
              </button>
              {editing === indicator.kind && (
                <div className="charts-indicator-editor">
                  {indicator.params.map((param, index) => (
                    <label key={`${indicator.id}-${index}`}>
                      <span>{entry.kind === 'BOLL' && index === 1 ? 'Dev' : entry.kind === 'MACD' ? ['Fast', 'Slow', 'Signal'][index] ?? `P${index + 1}` : `Period ${index + 1}`}</span>
                      <input
                        type="number"
                        min={1}
                        max={500}
                        value={param}
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          if (!Number.isFinite(value) || value < 1) return;
                          const next = [...indicator.params];
                          next[index] = Math.round(value);
                          onIndicatorParams(indicator.kind, next);
                        }}
                      />
                    </label>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        <div className="charts-add-indicator">
          <button
            type="button"
            className="charts-tool-button"
            aria-expanded={addOpen}
            onClick={() => setAddOpen((value) => !value)}
          >
            + Indicator
          </button>
          {addOpen && (
            <div className="charts-add-menu">
              {available.length === 0 ? (
                <p>All indicators are on the chart.</p>
              ) : available.map((entry) => (
                <button
                  key={entry.kind}
                  type="button"
                  onClick={() => {
                    onToggleIndicator(entry.kind);
                    setAddOpen(false);
                  }}
                >
                  <span className="charts-indicator-dot" style={{ background: entry.color }} aria-hidden="true" />
                  <span>
                    <b>{entry.label}</b>
                    <small>{entry.description}</small>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <span className="charts-toolbar-divider" aria-hidden="true" />

      <div className="charts-draw-tools" role="group" aria-label="Drawing tools">
        {DRAWING_TOOLS.map((tool) => (
          <button
            key={tool.id}
            type="button"
            className={`charts-draw-button${activeTool === tool.id ? ' is-active' : ''}`}
            aria-pressed={activeTool === tool.id}
            aria-label={tool.label}
            title={`${tool.label} — ${tool.hint}`}
            onClick={() => onTool(tool.id)}
          >
            <ToolIcon tool={tool.id} />
          </button>
        ))}
        <button
          type="button"
          className="charts-tool-button charts-clear-drawings"
          onClick={onClear}
          title="Remove every drawing from this chart"
        >
          Clear
        </button>
      </div>

      <div className="charts-toolbar-spacer" />

      <div className="charts-sessions" role="group" aria-label="Market sessions">
        {(['london', 'newyork'] as SessionId[]).map((session) => (
          <button
            key={session}
            type="button"
            className={`charts-session${settings.sessions[session] ? ' is-active' : ''}`}
            aria-pressed={settings.sessions[session]}
            onClick={() => onSession(session)}
          >
            {SESSION_LABEL[session]}
          </button>
        ))}
      </div>

      <button
        type="button"
        className="charts-tool-button"
        onClick={onScrollToRealtime}
        title="Scroll to the newest candle"
      >
        Latest
      </button>
      <button
        type="button"
        className="charts-tool-button"
        onClick={onFullscreen}
        title={fullscreen ? 'Exit fullscreen' : 'Fullscreen chart'}
      >
        {fullscreen ? 'Exit' : 'Full'}
      </button>
    </div>
  );
}
