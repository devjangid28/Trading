import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Shown in the fallback so you know which panel died rather than a blank page. */
  label?: string;
  onReset?: () => void;
}

interface State {
  error: Error | null;
  info: string | null;
}

/**
 * Keeps one broken panel from blanking the whole terminal. Without this a single
 * render throw in (say) the home butterfly takes the boards down with it, which
 * reads as "no coins" rather than as the bug it actually is.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error(`[${this.props.label ?? 'panel'}] render failed`, error, info.componentStack);
    this.setState({ info: info.componentStack ?? null });
  }

  reset = (): void => {
    this.setState({ error: null, info: null });
    this.props.onReset?.();
  };

  render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        style={{
          border: '1px solid var(--color-down)',
          borderRadius: 12,
          padding: 14,
          background: 'var(--panel)',
          color: 'var(--text)',
          fontSize: 12,
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: 6 }}>
          {this.props.label ?? 'This panel'} failed to render
        </div>
        <div style={{ color: 'var(--muted)', marginBottom: 8 }}>
          {error.message}
        </div>
        {info && (
          <pre
            style={{
              margin: 0,
              maxHeight: 160,
              overflow: 'auto',
              fontSize: 10,
              color: 'var(--faint)',
              whiteSpace: 'pre-wrap',
            }}
          >
            {info.trim().split('\n').slice(0, 8).join('\n')}
          </pre>
        )}
        <button
          type="button"
          onClick={this.reset}
          className="mt-3 px-2 py-1 rounded text-[11px]"
          style={{ background: 'var(--panel-2)', color: 'var(--text)' }}
        >
          Retry
        </button>
      </div>
    );
  }
}