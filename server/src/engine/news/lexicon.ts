/**
 * Context-aware finance sentiment lexicon. Weights are signed points on a
 * rough -1..+1 scale per term; position decay and negation are applied at
 * scoring time, so a term's effective weight depends on where it appears.
 */
export const POSITIVE: Record<string, number> = {
  approval: 0.9, approved: 0.9, approves: 0.9,
  greenlit: 1.0, clears: 0.6, cleared: 0.6,
  win: 0.7, wins: 0.7, victory: 0.8,
  adopt: 0.6, adopted: 0.6, adoption: 0.7,
  upgrade: 0.4, upgraded: 0.4, upgrades: 0.4,
  partnership: 0.4, partnered: 0.4, integrates: 0.3, integration: 0.3,
  launch: 0.3, launches: 0.3, launched: 0.3,
  inflow: 0.7, inflows: 0.7, accumulation: 0.7, accumulates: 0.7, accumulating: 0.7,
  buyback: 0.6, buybacks: 0.6, breakout: 0.8, rally: 0.7, rallies: 0.7,
  surge: 0.8, surges: 0.8, soar: 0.9, soars: 0.9, jump: 0.5, jumps: 0.5,
  gain: 0.3, gains: 0.3, bullish: 0.8, optimism: 0.5, optimistic: 0.5,
  outperform: 0.6, outperformance: 0.6,
  'rate cut': 0.8, 'rate cuts': 0.8, dovish: 0.7,
  easing: 0.6, stimulus: 0.6,
  cooling: 0.4, cooler: 0.5, softer: 0.4, beat: 0.6, beats: 0.6,
  legalization: 0.8, legalised: 0.7, legalized: 0.7,
  clarity: 0.4, institutionalize: 0.6, institutionalisation: 0.6,
  record: 0.4, ath: 0.8,
};

export const NEGATIVE: Record<string, number> = {
  hack: 1.0, hacked: 1.0, exploits: 0.9, exploited: 0.9, exploit: 0.9,
  breach: 1.0, breached: 1.0, compromised: 0.9, drained: 1.0, drainer: 0.9,
  'rug pull': 1.0, scam: 0.9, scams: 0.9, theft: 1.0, stolen: 0.8, phishing: 0.7,
  depeg: 1.0, depegged: 1.0, unpeg: 0.9, 'breaks the peg': 1.0,
  insolvency: 0.9, insolvent: 0.9, bankruptcy: 0.9, bankrupt: 0.9, 'chapter 11': 0.9,
  liquidation: 0.8, liquidated: 0.8, liquidations: 0.8, cascade: 0.9, wipeout: 1.0,
  halt: 0.7, halts: 0.7, halted: 0.7, suspended: 0.7, suspends: 0.7, suspend: 0.7,
  frozen: 0.6, freezes: 0.6, freeze: 0.6,
  delisting: 0.7, delisted: 0.7, fraud: 1.0, fraudulent: 1.0,
  charges: 0.7, charged: 0.7, indicted: 0.9, indictment: 0.9, indictments: 0.9,
  lawsuit: 0.6, sues: 0.6, sued: 0.6, probe: 0.6, probes: 0.6,
  investigation: 0.6, investigations: 0.6, enforcement: 0.7, subpoena: 0.7,
  penalty: 0.6, penalties: 0.6, fined: 0.6, fine: 0.4, injunction: 0.8,
  ban: 0.9, bans: 0.9, banned: 0.9, prohibits: 0.9, prohibited: 0.9, crackdown: 0.9,
  restrict: 0.7, restricts: 0.7, restricted: 0.7, restriction: 0.7, restrictions: 0.7,
  warn: 0.5, warns: 0.5, warning: 0.5, risk: 0.4, risks: 0.4, risky: 0.5,
  outflow: 0.7, outflows: 0.7, 'rate hike': 0.8, hawkish: 0.7, hike: 0.6, hikes: 0.6,
  hotter: 0.5, inflation: 0.4, 'sticky inflation': 0.7,
  'sell-off': 0.7, selloff: 0.7, dump: 0.8, dumps: 0.8, crash: 1.0, crashes: 1.0,
  plummet: 0.9, plummets: 0.9, plunge: 0.8, plunges: 0.8,
  slump: 0.7, slumps: 0.7, tumble: 0.7, tumbles: 0.7,
  bearish: 0.8, pessimism: 0.5, pessimistic: 0.5,
  contagion: 0.8, capitulation: 0.7, fud: 0.5, fomo: 0.3,
  zero: 0.4, worthless: 0.9, collapse: 0.9, collapses: 0.9,
  turmoil: 0.8, worry: 0.4, worries: 0.4, fears: 0.5,
};

const NEGATORS = new Set([
  'not', 'no', 'never', 'without', 'fails', 'fail', 'failed',
  'denies', 'denied', 'deny', 'rejects', 'rejected', 'reject',
  'blocks', 'blocked', 'halts', 'halted', 'unlikely', 'avoid', 'avoids',
  'stops', 'stopped', 'won', 'will', 'cannot', 'cant',
]);

export interface LexiconHit {
  term: string;
  weight: number;
  inHeadline: boolean;
}

export function scoreSentiment(
  headline: string,
  body: string,
): { norm: number; hits: LexiconHit[] } {
  const h = headline.toLowerCase();
  const b = body.toLowerCase();
  const hTokens = h.split(/\s+/);

  const hits: LexiconHit[] = [];
  const seen = new Set<string>();
  let raw = 0;

  for (const [dict, sign] of [
    [POSITIVE, 1],
    [NEGATIVE, -1],
  ] as const) {
    for (const [term, weight] of Object.entries(dict)) {
      const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      const inH = re.test(h);
      const inB = re.test(b);
      if (!inH && !inB) continue;
      if (seen.has(term)) continue;
      seen.add(term);

      let w = weight * sign;

      // Negation window: flip the sign if a negator appears within 3 tokens
      // before the first occurrence.
      const firstIdx = hTokens.findIndex((t) => re.test(t));
      if (firstIdx > 0) {
        for (let k = Math.max(0, firstIdx - 3); k < firstIdx; k++) {
          if (NEGATORS.has(hTokens[k].replace(/[^\w]/g, ''))) {
            w = -w;
            break;
          }
        }
      }

      // Position decay: headline terms carry ~10x the information of body terms.
      const decay = inH ? 1.0 : 0.4;
      raw += w * decay;
      hits.push({ term, weight: w * decay, inHeadline: inH });
    }
  }

  const count = Math.max(1, hits.length);
  const norm = Math.max(-3, Math.min(3, raw / Math.max(3.0, 0.6 * count)));
  return { norm, hits };
}
