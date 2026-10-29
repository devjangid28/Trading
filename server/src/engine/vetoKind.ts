/**
 * Veto kinds — the M1.6 fix.
 *
 * ## The problem this solves
 *
 * The ledger used to group its shadow signals by `vetoReason.slice(0, 44)` —
 * the RENDERED string. That string embeds the number that triggered the veto:
 *
 *   "already moved 14.2% today — event risk"
 *   "already moved 16.8% today — event risk"
 *   "already moved 30.2% today — event risk"
 *
 * So one policy decision — "do not buy a coin that has already run 14% today" —
 * became **102 separate categories** on this ledger, each with 2 to 11
 * samples, every one of them below the 30-sample floor where a rate may be
 * quoted at all. The group-by could not answer the only question it exists to
 * answer: *was the veto right?*
 *
 * The number in the message is the SUBJECT of the veto, not its identity. The
 * identity is the rule.
 *
 * ## What a kind is
 *
 * A stable, machine-readable code for WHICH rule fired. The rendered string
 * stays exactly as it was — it is the human-readable reason, and it is frozen
 * on the signal row, so nothing that has already been recorded is rewritten.
 *
 * The kinds are produced by `evaluateVetoes()` in `conviction.ts` and consumed
 * by `ledgerStats()`. The classification below is the *only* place that knows
 * how a message maps to a kind, and `conviction.test.ts` pins it against the
 * messages the real engine produces — so the two cannot drift apart.
 */

/** The stable code for a rule that blocked (or shadowed) a signal. */
export type VetoKind =
  /** A tier-1 macro release inside the blackout window. */
  | 'MACRO_BLACKOUT'
  /** The asset has already moved an extreme amount today. */
  | 'EVENT_RISK_MOVE'
  /** A hack, depeg, delisting or redemption suspension on this asset. */
  | 'SECURITY_EVENT'
  /** A material token unlock inside the look-ahead window. */
  | 'TOKEN_UNLOCK'
  /** Order-book depth below the tradable minimum. */
  | 'DEPTH'
  /** Spread above the tradable maximum. */
  | 'SPREAD'
  /** Funding is crowded our way while open interest is falling. */
  | 'FUNDING_UNWIND'
  /** The data-integrity gate blocked or degraded the setup. */
  | 'DATA_HEALTH'
  /** Shadow for a reason that is not a veto: the grade was C. */
  | 'GRADE_C'
  /** A message this classifier does not recognise. Counted, never hidden. */
  | 'UNKNOWN';

/** Every kind, so a table can iterate them all. */
export const VETO_KINDS: readonly VetoKind[] = [
  'MACRO_BLACKOUT',
  'EVENT_RISK_MOVE',
  'SECURITY_EVENT',
  'TOKEN_UNLOCK',
  'DEPTH',
  'SPREAD',
  'FUNDING_UNWIND',
  'DATA_HEALTH',
  'GRADE_C',
  'UNKNOWN',
];

/** A human label for each kind. The UI shows this, never the raw code. */
export const VETO_KIND_LABEL: Record<VetoKind, string> = {
  MACRO_BLACKOUT: 'Macro blackout',
  EVENT_RISK_MOVE: 'Event risk (already moved)',
  SECURITY_EVENT: 'Security event',
  TOKEN_UNLOCK: 'Token unlock',
  DEPTH: 'Book depth',
  SPREAD: 'Spread',
  FUNDING_UNWIND: 'Funding unwinding',
  DATA_HEALTH: 'Data integrity',
  GRADE_C: 'Grade C (no veto)',
  UNKNOWN: 'Unclassified',
};

/**
 * Markers of a data-integrity reason.
 *
 * The health gate's reasons are written in prose by `dataHealth.ts`, and a
 * blocked row can carry several of them joined with "; ". Any one of these
 * markers means the row was blocked by the DATA-INTEGRITY GATE, not by a
 * market rule — which is the distinction that matters, because a data block
 * says nothing about whether the market setup was good.
 */
const HEALTH_MARKERS = [
  'price stream is ',
  'macro calendar is ',
  'news feed ',
  'derivatives ',
  'MOCK DATA',
  'data integrity:',
  'degraded:',
] as const;

/**
 * The kind of veto a rendered reason belongs to.
 *
 * `null` or an empty string means the signal was shadowed WITHOUT a veto —
 * a grade-C setup. That is a real category and it is not `UNKNOWN`: "the
 * engine's score was not enough" is a different claim from "we could not
 * classify this".
 */
export function vetoKindOf(message: string | null | undefined): VetoKind {
  if (message === null || message === undefined) return 'GRADE_C';
  const m = message.trim();
  if (m === '') return 'GRADE_C';

  // Order matters. The unlock message also ends with "within 48h", so it has
  // to be recognised before the generic security-event rule.
  if (/^\d+(\.\d+)?% unlock/.test(m)) return 'TOKEN_UNLOCK';
  if (m.startsWith('inside ') && m.includes('blackout around ')) return 'MACRO_BLACKOUT';
  if (m.startsWith('already moved ') && m.includes('event risk')) return 'EVENT_RISK_MOVE';
  if (m === 'order book depth below tradable minimum') return 'DEPTH';
  if (m.startsWith('spread ') && m.includes('bps above limit')) return 'SPREAD';
  if (m.startsWith('funding crowded our way while OI falls')) return 'FUNDING_UNWIND';
  if (/ within \d+h$/.test(m)) return 'SECURITY_EVENT';
  if (HEALTH_MARKERS.some((marker) => m.includes(marker))) return 'DATA_HEALTH';
  return 'UNKNOWN';
}
