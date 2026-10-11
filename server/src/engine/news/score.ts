import type { NewsCategory, NewsItem, SeverityClass } from '../../../../shared/types.js';
import { EVENT_TAGS, EVENT_TAG_BY_NAME, isRoutine, macroMultiplier } from './taxonomy.js';
import { extractEntities } from './entities.js';
import { scoreSentiment } from './lexicon.js';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export interface RawArticle {
  id: string;
  headline: string;
  url: string;
  source: string;
  tier: number;
  publishedAt: number;
  body: string;
}

/** Credibility tiers from primary sources down to anonymous social chatter. */
const TIER_MAX = 15;

function severityClassOf(nis: number): SeverityClass {
  if (nis >= 70) return 'CRITICAL';
  if (nis >= 55) return 'HIGH';
  if (nis >= 30) return 'MEDIUM';
  if (nis >= 15) return 'LOW';
  return 'NOISE';
}

/**
 * Measured macro betas: BTC moves roughly -3.2% per +1pp CPI surprise over
 * the first hour. Convert an expected move back into basis points for display.
 */
function expectedBpsFromSeverity(severity: number, sentiment: number): number {
  if (sentiment === 0) return 0;
  const base = severity * 6; // a max-severity event implies a few percent
  return Math.round(clamp(sentiment * base * 4, -450, 450));
}

/** Internal scoring inputs that buildFeed needs to recompute after novelty. */
interface Classified {
  item: NewsItem;
  urgency: number;
  halfLife: number;
  macroMult: number;
  routine: boolean;
}

export function classify(article: RawArticle, now: number): Classified {
  let ageMinutes = (now - article.publishedAt) / 60_000;
  if (ageMinutes < -5) ageMinutes = 0;

  // ---- Event tags --------------------------------------------------
  const haystack = `${article.headline} ${article.body}`;
  const matched: typeof EVENT_TAGS = [];
  for (const tag of EVENT_TAGS) {
    if (tag.patterns.test(haystack)) matched.push(tag);
  }
  // De-duplicate by category: keep the highest-severity tag per category.
  const bestByCategory = new Map<string, (typeof EVENT_TAGS)[number]>();
  for (const t of matched) {
    const cur = bestByCategory.get(t.category);
    if (!cur || t.severity > cur.severity) bestByCategory.set(t.category, t);
  }
  const activeTags = [...bestByCategory.values()];
  const categories = activeTags.map((t) => t.category) as NewsCategory[];
  const tags = activeTags.map((t) => t.tag);

  // Commentary about price that already happened is not a catalyst.
  const routine = isRoutine(article.headline);

  // ---- STEP 1: severity --------------------------------------------
  let severity = activeTags.length ? Math.max(...activeTags.map((t) => t.severity)) : 4;
  if (routine) severity = Math.min(severity, 4);

  // ---- STEP 2: relevance -------------------------------------------
  const ents = extractEntities(article.headline, article.body);
  const baseRel = ents.headlineRelevance >= 80 ? 20 : ents.headlineRelevance >= 40 ? 14 : ents.assets.length ? 8 : ents.macroEntity ? 4 : 2;
  const relevance = clamp(baseRel, 0, 20);

  // ---- STEP 3: sentiment -------------------------------------------
  const { norm } = scoreSentiment(article.headline, article.body);
  let sentiment = clamp(5.0 * norm, -15, 15);

  // ---- STEP 4: source ----------------------------------------------
  const source = clamp(article.tier, 1, TIER_MAX);

  // ---- STEP 5: urgency ---------------------------------------------
  let urgency: number;
  if (routine) urgency = 1;
  else if (ageMinutes <= 5 && article.tier <= 12) urgency = 10;
  else if (ageMinutes <= 15 && article.tier <= 14) urgency = 8;
  else if (ageMinutes <= 60) urgency = 5;
  else if (ageMinutes <= 180) urgency = 3;
  else urgency = 2;

  // Macro multipliers -------------------------------------------------
  const macro = macroMultiplier(categories, tags);
  const isMacro = categories.includes('MACRO');

  const base = severity + relevance + Math.max(0, sentiment) + source + urgency;

  // Novelty is filled in by buildFeed once we can see the rest of the feed.
  const novelty = 1.0;
  const corroboration = 1.0;

  const conf = clamp(1.2 + 0.2 * (Math.abs(sentiment) / 15), 0.5, 1.3);

  // Recency decay with a per-class half-life.
  const halfLife = activeTags.length
    ? Math.min(...activeTags.map((t) => t.halfLife))
    : 1440;
  const decay = Math.pow(2, -ageMinutes / halfLife);

  const nis = clamp(
    base * novelty * corroboration * conf * decay * macro,
    0,
    100,
  );

  // ---- Direction -----------------------------------------------------
  let direction: -1 | 0 | 1 = 0;
  if (source <= 4) {
    // Rumours and unverified chatter score high on impact but carry no direction.
    direction = 0;
  } else if (sentiment !== 0) {
    direction = sentiment > 0 ? 1 : -1;
  } else if (activeTags.length) {
    direction = (activeTags.sort((a, b) => b.severity - a.severity)[0].dir ?? 0) as -1 | 0 | 1;
  }

  // Reversal risk: scheduled macro reversals over 4h historically.
  let reversalRisk = 0.3;
  if (isMacro) {
    if (tags.includes('MACRO_FOMC') || tags.includes('MACRO_CPI')) reversalRisk = 0.7;
    else if (tags.includes('MACRO_PCE') || tags.includes('MACRO_SPEECH')) reversalRisk = 0.4;
  }
  if (categories.includes('WHALE') && direction === -1) reversalRisk = 0.6;

  const severityClass = severityClassOf(nis);

  const label: NewsItem['noveltyLabel'] =
    ageMinutes <= 60 * 24 ? 'NEW' : ageMinutes <= 60 * 48 ? 'RECENT' : ageMinutes <= 60 * 168 ? 'SEEN' : 'STALE';

  void EVENT_TAG_BY_NAME;

  return {
    urgency,
    halfLife,
    macroMult: macro,
    routine,
    item: {
      id: article.id,
      headline: article.headline,
      url: article.url,
      source: article.source,
      tier: article.tier,
      publishedAt: article.publishedAt,
      ageMinutes: Math.max(0, Math.round(ageMinutes)),
      assets: ents.assets,
      sectorHint: ents.sectorHint,
      macroEntity: ents.macroEntity,
      jurisdiction: ents.jurisdiction,
      categories,
      tags,
      nis: Math.round(nis * 10) / 10,
      severity,
      relevance,
      sentiment: Math.round(sentiment * 10) / 10,
      direction,
      severityClass,
      expectedBps: expectedBpsFromSeverity(severity, direction),
      reversalRisk,
      corroboration,
      sources: 1,
      novelty,
      noveltyLabel: label,
      isMacro,
      routine,
      reactions: [],
      clusterId: null,
      surpriseBp: null,
      summary: article.body.slice(0, 220).replace(/\s+/g, ' ').trim(),
    },
  };
}

/** Significant words for headline similarity, stripped of stopwords. */
function keywords(text: string): Set<string> {
  const STOP = new Set([
    'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'was', 'were',
    'be', 'been', 'as', 'at', 'by', 'with', 'from', 'that', 'this', 'it', 'its', 'has', 'have',
    'had', 'will', 'would', 'could', 'but', 'not', 'you', 'your', 'we', 'they', 'he', 'she',
  ]);
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Two passes over the feed.
 *
 * Pass 1 scores each item in isolation. Pass 2 adds the two things that can
 * only be known once you see the whole set: novelty (days since a similar
 * event on the same asset) and corroboration (how many credible outlets carry
 * it). Both are multipliers with a 1.0 floor â€” RavenPack's finding is that
 * aggressive novelty gating destroys information ratio, so nothing is ever
 * filtered out for being familiar.
 */
export function buildFeed(articles: RawArticle[], now: number): NewsItem[] {
  const classified = articles.map((a) => classify(a, now));
  const scored = classified.map((c) => c.item);
  const metaById = new Map(classified.map((c) => [c.item.id, c]));
  const byNewest = [...classified].sort((a, b) => b.item.publishedAt - a.item.publishedAt);

  for (const item of scored) {
    const meta = metaById.get(item.id);
    if (!meta) continue;
    const itemKw = keywords(item.headline);

    // ---- Novelty ----------------------------------------------------
    let noveltyDays = Infinity;
    const sources = new Set<string>();

    for (const other of byNewest) {
      if (other.item.id === item.id) continue;
      if (other.item.publishedAt >= item.publishedAt) continue;

      const overlap = jaccard(itemKw, keywords(other.item.headline));
      const sameAsset =
        item.assets.length > 0 && item.assets.some((a) => other.item.assets.includes(a));
      const sameCategory = item.categories.some((c) => other.item.categories.includes(c));

      if (overlap > 0.45 || (sameAsset && sameCategory && overlap > 0.2)) {
        const days = (item.publishedAt - other.item.publishedAt) / 86_400_000;
        if (days < noveltyDays) noveltyDays = days;
        if (other.item.tier <= 12) sources.add(other.item.source);
      }
    }
    sources.add(item.source);

    const novelty =
      noveltyDays === Infinity ? 1.5
        : noveltyDays <= 1 ? 1.5
          : noveltyDays <= 7 ? 1.3
            : noveltyDays <= 30 ? 1.15
              : 1.0;

    // Corroboration rewards breadth across credible outlets.
    const credible = sources.size;
    const corroboration = 1 + 0.1 * Math.min(Math.max(credible - 1, 0), 3);

    const decay = Math.pow(2, -(item.ageMinutes / meta.halfLife));
    const conf = 1 + 0.2 * clamp(Math.abs(item.sentiment) / 15, 0, 1);
    const base =
      item.severity + item.relevance + Math.max(0, item.sentiment) + item.tier + meta.urgency;

    item.nis = Math.round(
      clamp(base * novelty * corroboration * conf * decay * meta.macroMult, 0, 100) * 10,
    ) / 10;
    item.severityClass = severityClassOf(item.nis);
    item.novelty = novelty;
    item.noveltyLabel =
      item.ageMinutes <= 60 * 24 ? 'NEW'
        : item.ageMinutes <= 60 * 48 ? 'RECENT'
          : item.ageMinutes <= 60 * 168 ? 'SEEN'
            : 'STALE';
    item.corroboration = Math.round(corroboration * 100) / 100;
    item.sources = credible;
    if (meta.routine) item.reversalRisk = Math.min(item.reversalRisk, 0.2);
  }

  // Hard expiry so the panel never fills with week-old items.
  return scored
    .filter((i) => i.ageMinutes <= 7 * 24 * 60 && i.severityClass !== 'NOISE')
    .sort((a, b) => b.nis - a.nis || a.ageMinutes - b.ageMinutes);
}
