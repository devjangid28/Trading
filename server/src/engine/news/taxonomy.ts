import type { NewsCategory } from '../../../../shared/types.js';

export interface EventTag {
  tag: string;
  category: NewsCategory;
  /** Step 1 of NIS: severity, 0-40. */
  severity: number;
  /** Default direction when the lexicon has no opinion. */
  dir: -1 | 0 | 1;
  /** Words that trigger this tag. Matched with word boundaries. */
  patterns: RegExp;
  /** Half-life for the recency decay, in minutes. */
  halfLife: number;
  /** Hard expiry: stop showing the item after this many minutes. */
  expiry: number;
}

const W = (s: string) => new RegExp(`\\b(?:${s})\\b`, 'i');

export const EVENT_TAGS: EventTag[] = [
  // ---- ETF ----------------------------------------------------------
  { tag: 'ETF_APPROVAL', category: 'ETF', severity: 28, dir: 1, halfLife: 240, expiry: 1440, patterns: W('approved|approval|approves|greenlit|greenlight|cleared to launch|winning|winner') },
  { tag: 'ETF_DENIAL', category: 'ETF', severity: 35, dir: -1, halfLife: 300, expiry: 1440, patterns: W('denied|denial|rejects?|rejection|refused|turns down') },
  { tag: 'ETF_APPROVAL_DELAY', category: 'ETF', severity: 35, dir: -1, halfLife: 300, expiry: 1440, patterns: W('delay|delays|postponed|indefinitely|deadline extended') },
  { tag: 'ETF_FLOW_PRINT', category: 'ETF', severity: 12, dir: 0, halfLife: 1440, expiry: 4320, patterns: W('net inflow|net outflow|inflows|outflows|etf flows') },
  { tag: 'ETF_FILING', category: 'ETF', severity: 10, dir: 1, halfLife: 2880, expiry: 10080, patterns: W('19b-4|s-1|files? for|filing|filed|petitions? for') },
  { tag: 'ETF_LISTING_DECISION', category: 'ETF', severity: 26, dir: 0, halfLife: 300, expiry: 1440, patterns: W('listing decision|launch date|trading debut') },
  { tag: 'ETF_FEE_CUT', category: 'ETF', severity: 9, dir: 1, halfLife: 2880, expiry: 10080, patterns: W('fee cut|lowers? fees|cuts? fees|expense ratio') },
  { tag: 'ETF_INFLOW_THRESHOLD', category: 'ETF', severity: 18, dir: 1, halfLife: 720, expiry: 4320, patterns: W('inflow streak|outflow streak|largest inflow|biggest outflow|record inflow') },

  // ---- Security -----------------------------------------------------
  { tag: 'HACK_EXCHANGE_MAJOR', category: 'HACK', severity: 40, dir: -1, halfLife: 45, expiry: 360, patterns: W('hacked|hack of|exploit(?:ed)?|breach(?:ed)?|compromised|stolen funds|heist|security incident') },
  { tag: 'HACK_BRIDGE', category: 'HACK', severity: 34, dir: -1, halfLife: 45, expiry: 360, patterns: W('bridge attack|bridge hack|cross-chain bridge|bridge exploit') },
  { tag: 'HACK_DEFI_PROTOCOL', category: 'HACK', severity: 28, dir: -1, halfLife: 45, expiry: 360, patterns: W('rug pull|rugpull|drainer|reentrancy|flash loan attack|protocol exploit') },
  { tag: 'HACK_RANSOMWARE', category: 'HACK', severity: 30, dir: -1, halfLife: 90, expiry: 720, patterns: W('ransomware|ransom note') },
  { tag: 'HACK_STATE_ACTOR', category: 'HACK', severity: 38, dir: -1, halfLife: 90, expiry: 720, patterns: W('state actor|north korea|north korean|apt\\d*|slowmist|certi[kc]|chainalysis|TRM Labs') },
  { tag: 'HACK_WITHDRAWAL_HALT', category: 'HACK', severity: 24, dir: -1, halfLife: 90, expiry: 720, patterns: W('suspends? withdrawals|halt(?:s|ed)? trading|withdrawals? paused|frozen withdrawals') },

  // ---- Stablecoin ---------------------------------------------------
  { tag: 'DEPEG_MAJOR', category: 'STABLE', severity: 38, dir: -1, halfLife: 45, expiry: 360, patterns: W('depeg(?:ged)?|loses? peg|breaks? the peg|unpeg(?:ged)?|below peg|peg break') },
  { tag: 'RESERVE_ATTESTATION_MISSED', category: 'STABLE', severity: 26, dir: -1, halfLife: 720, expiry: 4320, patterns: W('attestation|proof of reserve|reserve report|failed to attest') },
  { tag: 'ISSUER_BANKRUPTCY', category: 'STABLE', severity: 32, dir: -1, halfLife: 240, expiry: 2880, patterns: W('issuer bankrupt|stablecoin issuer|insolvency|chapter 11') },
  { tag: 'REDEMPTION_SUSPENDED', category: 'STABLE', severity: 34, dir: -1, halfLife: 90, expiry: 720, patterns: W('redemptions? (?:suspended|halted|paused)|cannot redeem') },
  { tag: 'STABLE_REGULATORY', category: 'STABLE', severity: 24, dir: -1, halfLife: 1440, expiry: 10080, patterns: W('mica|usdt|usdc|usde|usds|pyusd|stablecoin (?:rule|regulat|act|guidance)|genius act') },

  // ---- Regulation ---------------------------------------------------
  { tag: 'ENFORCEMENT_CHARGES', category: 'REG', severity: 35, dir: -1, halfLife: 180, expiry: 1440, patterns: W('charges?|indict(?:ed|ment)|lawsuit|sues?|prosecut(?:or|ed)|subpoena|probe|investigation') },
  { tag: 'ENFORCEMENT_SETTLEMENT', category: 'REG', severity: 25, dir: -1, halfLife: 720, expiry: 4320, patterns: W('settlement|settles? with|consent decree|fined?|penalty|ordered to pay') },
  { tag: 'INJUNCTION', category: 'REG', severity: 32, dir: -1, halfLife: 240, expiry: 2880, patterns: W('injunction|restraining order|court (?:rules|orders)|temporarily blocked') },
  { tag: 'BANNED', category: 'REG', severity: 38, dir: -1, halfLife: 300, expiry: 2880, patterns: W('banned?|bans?|prohibit(?:s|ed|ion)?|crackdown|clampdown|outlaw') },
  { tag: 'LEGISLATION_INTRODUCED', category: 'REG', severity: 22, dir: 0, halfLife: 1440, expiry: 10080, patterns: W('bill|legislation|introduced in|proposed framework|draft law|motion') },
  { tag: 'BILL_PASSED', category: 'REG', severity: 30, dir: 0, halfLife: 720, expiry: 4320, patterns: W('passed the|becomes law|signed into law|ratified|enacted') },
  { tag: 'GUIDANCE_ISSUED', category: 'REG', severity: 20, dir: 0, halfLife: 720, expiry: 4320, patterns: W('guidance|consultation paper|white paper|framework|directive|advisory') },
  { tag: 'SANCTIONS', category: 'REG', severity: 33, dir: -1, halfLife: 480, expiry: 4320, patterns: W('sanction(?:s|ed)?|blacklist|designated as|entity list|OFAC') },

  // ---- India specific ----------------------------------------------
  { tag: 'IN_FIU_IND', category: 'REG', severity: 32, dir: -1, halfLife: 720, expiry: 4320, patterns: W('FIU-IND|Financial Intelligence Unit|VDASP|virtual digital asset service provider') },
  { tag: 'IN_RBI_POLICY', category: 'REG', severity: 28, dir: -1, halfLife: 720, expiry: 4320, patterns: W('RBI|Reserve Bank of India|monetary policy committee|MPC') },
  { tag: 'IN_SEBI', category: 'REG', severity: 24, dir: 0, halfLife: 720, expiry: 4320, patterns: W('SEBI|Securities and Exchange Board|GIFT City|IFSCA') },
  { tag: 'IN_TAX_CHANGE', category: 'REG', severity: 30, dir: -1, halfLife: 2880, expiry: 10080, patterns: W('income[- ]tax act|tax (?:rules|regime|slab|bracket)|30% tax|crypto tax') },

  // ---- Tech ---------------------------------------------------------
  { tag: 'CHAIN_HALT_CONFIRMED', category: 'TECH', severity: 26, dir: -1, halfLife: 90, expiry: 720, patterns: W('chain halt|network halt|consensus (?:halt|failure)|fork stopped') },
  { tag: 'UPGRADE_LIVE_SUCCESS', category: 'TECH', severity: 18, dir: 1, halfLife: 720, expiry: 4320, patterns: W('upgrad(?:e|ed|ing) (?:is )?(?:live|complete|successful)|successfully upgraded') },
  { tag: 'UPGRADE_FAILED', category: 'TECH', severity: 32, dir: -1, halfLife: 180, expiry: 1440, patterns: W('upgrad(?:e|ing) (?:failed|halted|aborted|cancelled)|failed to upgrade') },
  { tag: 'FORK_ANNOUNCED', category: 'TECH', severity: 22, dir: 0, halfLife: 1440, expiry: 7200, patterns: W('hard ?fork|fork announced|network upgrade') },
  { tag: 'AIRDROP_SNAPSHOT', category: 'TECH', severity: 16, dir: 1, halfLife: 720, expiry: 4320, patterns: W('airdrop|snapshot|claim period') },
  { tag: 'HALVING', category: 'TECH', severity: 30, dir: 1, halfLife: 4320, expiry: 20160, patterns: W('halving') },
  { tag: 'OUTAGE_MAJOR', category: 'TECH', severity: 24, dir: -1, halfLife: 90, expiry: 720, patterns: W('outage|downtime|unavailable|offline for|site is down') },

  // ---- Listing ------------------------------------------------------
  { tag: 'DELISTING_MAJOR_EXCHANGE', category: 'LIST', severity: 24, dir: -1, halfLife: 360, expiry: 2880, patterns: W('delist(?:ing|ed)|removes? from trading') },
  { tag: 'LISTING_TIER1', category: 'LIST', severity: 18, dir: 1, halfLife: 360, expiry: 2880, patterns: W('lists? on|announces listing|will list|upcoming listing|spot pair') },
  { tag: 'TRADING_HALT', category: 'LIST', severity: 28, dir: -1, halfLife: 90, expiry: 720, patterns: W('trading halt|halt(?:s|ed) trading|suspend(?:s|ed) trading') },
  { tag: 'NEW_VENUE_LISTING', category: 'LIST', severity: 8, dir: 1, halfLife: 720, expiry: 4320, patterns: W('newly listed|launch(?:es)? on|now available on') },

  // ---- Whale --------------------------------------------------------
  { tag: 'WHALE_EXCHANGE_DEPOSIT', category: 'WHALE', severity: 26, dir: -1, halfLife: 60, expiry: 360, patterns: W('whale (?:deposit|transfer|sends|moves)|transfer(?:s|red)? .*(?:to )?(?:an? )?exchange') },
  { tag: 'WHALE_EXCHANGE_WITHDRAWAL', category: 'WHALE', severity: 24, dir: 1, halfLife: 60, expiry: 360, patterns: W('withdraws? .*(?:from )?exchange|coined off|moves to (?:self-)?custody|leaves the exchange') },
  { tag: 'WHALE_ALERT', category: 'WHALE', severity: 22, dir: -1, halfLife: 60, expiry: 360, patterns: W('whale alert|sleeping whale|whale wallet|mystery whale|anonymous whale') },
  { tag: 'SOV_ENTITY_BUY', category: 'WHALE', severity: 34, dir: 1, halfLife: 720, expiry: 4320, patterns: W('sovereign wealth|sovereign fund|nation[- ]state|national treasury|government (?:fund|reserve) buys') },

  // ---- Adoption -----------------------------------------------------
  { tag: 'TREASURY_ADOPTION_LARGE', category: 'ADOPT', severity: 28, dir: 1, halfLife: 720, expiry: 4320, patterns: W('microstrategy|strategy inc|bitcoin treasury|digital asset reserve|treasury (?:buys|purchases|allocation)') },
  { tag: 'PENSION_SOVEREIGN_ALLOCATION', category: 'ADOPT', severity: 30, dir: 1, halfLife: 1440, expiry: 10080, patterns: W('pension fund|sovereign wealth fund|endowment|allocation to bitcoin') },
  { tag: 'BANK_PARTNERSHIP', category: 'ADOPT', severity: 22, dir: 1, halfLife: 1440, expiry: 10080, patterns: W('(?:bank|brokerage|fiat onramp) (?:partnership|partners|launches)|custody|tokeni[sz]ed (?:stock|equity|treasury)') },
  { tag: 'IN_INSTITUTIONAL_PRODUCT', category: 'ADOPT', severity: 26, dir: 1, halfLife: 720, expiry: 4320, patterns: W('(?:launches|introduces) (?:a )?(?:product|fund|note|etp)|institutional product') },
  { tag: 'PARTNERSHIP_GENERIC', category: 'ADOPT', severity: 15, dir: 1, halfLife: 1440, expiry: 10080, patterns: W('partner(?:s|ship|ed)|integrat(?:es|ion)|teams? up|collaboration') },

  // ---- Distress -----------------------------------------------------
  { tag: 'BANKRUPTCY_FILING', category: 'DISTRESS', severity: 30, dir: -1, halfLife: 720, expiry: 4320, patterns: W('bankrupt(?:cy)?|chapter 11|filed for insolvency|creditor protection') },
  { tag: 'RESTRUCTURING_FILING', category: 'DISTRESS', severity: 24, dir: -1, halfLife: 720, expiry: 4320, patterns: W('restructur(?:e|ing)|judicial management|haircut') },
  { tag: 'PROOF_OF_RESERVE_FAILURE', category: 'DISTRESS', severity: 36, dir: -1, halfLife: 240, expiry: 2880, patterns: W('proof of reserve fail|reserve shortfall|reserves (?:do not|don.t) cover|missing reserves') },
  { tag: 'FORCED_LIQUIDATION_CASCADE', category: 'LIQ', severity: 32, dir: -1, halfLife: 30, expiry: 240, patterns: W('liquidations?|liquidated|forced selling|cascade|wipeout|long liquidations') },
  { tag: 'LIQ_SHORT_SQUEEZE', category: 'LIQ', severity: 28, dir: 1, halfLife: 30, expiry: 240, patterns: W('short squeeze|squeeze|shorts liquidated') },
  { tag: 'FUNDING_EXTREME', category: 'LIQ', severity: 20, dir: -1, halfLife: 120, expiry: 720, patterns: W('funding rate|negative funding|funding flips') },
  { tag: 'OI_SHOCK', category: 'LIQ', severity: 18, dir: 0, halfLife: 120, expiry: 720, patterns: W('open interest|oi (?:spike|surge|record)') },

  // ---- Macro --------------------------------------------------------
  { tag: 'MACRO_FOMC', category: 'MACRO', severity: 36, dir: 0, halfLife: 240, expiry: 1440, patterns: W('FOMC|federal (?:open market|reserve)|fed (?:decision|rate decision|holds?|cuts? rates|hikes?)|interest rate decision|dot plot|powell|warsh') },
  { tag: 'MACRO_CPI', category: 'MACRO', severity: 32, dir: 0, halfLife: 240, expiry: 1440, patterns: W('\\bCPI\\b|consumer price index|inflation (?:data|print|report|reading|sprint)|core inflation') },
  { tag: 'MACRO_PCE', category: 'MACRO', severity: 28, dir: 0, halfLife: 240, expiry: 1440, patterns: W('\\bPCE\\b|personal consumption') },
  { tag: 'MACRO_NFP', category: 'MACRO', severity: 26, dir: 0, halfLife: 240, expiry: 1440, patterns: W('nonfarm payrolls|non-farm payrolls|\\bNFP\\b|jobs report|employment situation|unemployment rate') },
  { tag: 'MACRO_PPI', category: 'MACRO', severity: 20, dir: 0, halfLife: 240, expiry: 1440, patterns: W('\\bPPI\\b|producer price') },
  { tag: 'MACRO_YIELDS', category: 'MACRO', severity: 24, dir: 0, halfLife: 240, expiry: 1440, patterns: W('10[- ]year yield|2[- ]year yield|treasury yields?|bond yields?|real yield|\\bDXY\\b|dollar index|dollar strengthens?') },
  { tag: 'MACRO_SPEECH', category: 'MACRO', severity: 26, dir: 0, halfLife: 120, expiry: 720, patterns: W('jackson hole|keynote|testif(?:y|ies)|speech|remarks') },
];

export const EVENT_TAG_BY_NAME = new Map(EVENT_TAGS.map((t) => [t.tag, t]));

export const CATEGORY_LABELS: Record<NewsCategory, string> = {
  ETF: 'ETF',
  HACK: 'Security',
  STABLE: 'Stablecoin',
  REG: 'Regulation',
  TECH: 'Protocol',
  LIST: 'Listing',
  WHALE: 'On-chain',
  ADOPT: 'Adoption',
  DISTRESS: 'Distress',
  LIQ: 'Derivatives',
  MACRO: 'Macro',
  GENERAL: 'General',
};

/** Scheduled macro multiplier applied last to the NIS. */
export function macroMultiplier(categories: NewsCategory[], tags: string[]): number {
  const has = (t: string) => tags.includes(t);
  if (has('MACRO_FOMC')) return 1.5;
  if (has('MACRO_CPI')) return 1.4;
  if (has('MACRO_PCE') || has('MACRO_SPEECH')) return 1.2;
  if (has('MACRO_NFP')) return 1.1;
  void categories;
  return 1.0;
}

/**
 * Routine market commentary. These headlines describe price that already
 * happened and carry no forward information, so they must not outrank an
 * actual catalyst. Without this, "BTC holds $82K" scores as critical purely
 * because it names the asset early and comes from a decent source.
 */
export const ROUTINE_PATTERNS: RegExp[] = [
  W('holds?|held|clings?|sticks?|range-?bound|consolidat|sideways|fades?|pulls? back|retreats?|stalls?|struggles?'),
  W('price analysis|technical analysis|market analysis|what to know|here.s why|explained?|explainer|breakdown|primer|guide to|forecast|outlook|opinion|editorial|comment|q&a|interview|profile|recap|roundup|daily recap|weekly recap|best \w+ to buy|top \w+ to buy'),
  W('chart pattern|support and resistance|moving average|rsi|macd|golden cross|death cross'),
];

export function isRoutine(text: string): boolean {
  return ROUTINE_PATTERNS.some((p) => p.test(text));
}
