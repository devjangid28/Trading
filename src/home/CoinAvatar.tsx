import { useState } from 'react';
import type { Side } from '../../shared/types';
import { monogramColor, monogramFontSize, monogramFor } from '../../shared/identity';

/**
 * The coin avatar: a real logo when we have one, a 4-letter monogram when we
 * do not.
 *
 * WHY NOT A TWO-LETTER TICKER
 *
 * The old board rendered `base.slice(0, 2)` here, which turned STRK into "ST"
 * and KAIA into "KA". That is not a style choice, it is a truncation of the
 * only identifying label on the row. The monogram is now up to FOUR characters
 * of the real ticker, and it exists only as a placeholder for a missing image —
 * never as a substitute for the ticker, which is always rendered in full
 * beside it.
 *
 * Logo URLs point at /static/logos (downloaded server-side), so the browser
 * never hotlinks an aggregator and we are never exposed to its rate limit.
 * A broken or missing image falls back to the monogram silently rather than
 * showing a broken-image glyph.
 */
export function CoinAvatar({
  ticker,
  logoUrl,
  size = 50,
  side,
}: {
  ticker: string;
  logoUrl?: string | null;
  size?: number;
  side?: Side;
}) {
  const [failed, setFailed] = useState(false);
  const text = monogramFor(ticker);
  const accent =
    side === 'bearish' ? 'var(--color-down)' : side === 'bullish' ? 'var(--color-up)' : 'var(--border)';
  const showLogo = Boolean(logoUrl) && !failed;

  return (
    <span
      className="of-avatar"
      data-testid="coin-avatar"
      data-ticker={ticker}
      data-has-logo={showLogo ? 'true' : 'false'}
      style={{
        width: size,
        height: size,
        borderColor: accent,
        background: showLogo ? 'var(--panel-2)' : monogramColor(ticker),
      }}
    >
      {showLogo ? (
        <img
          src={logoUrl as string}
          alt=""
          width={Math.round(size * 0.68)}
          height={Math.round(size * 0.68)}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <span
          className="of-monogram"
          style={{
            fontSize: monogramFontSize(text),
            color: '#fff',
            textShadow: '0 1px 2px rgba(0,0,0,.45)',
          }}
        >
          {text}
        </span>
      )}
    </span>
  );
}