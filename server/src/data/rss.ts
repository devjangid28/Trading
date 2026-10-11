import { fetchText } from '../lib/http.js';
import { cached } from '../lib/cache.js';
import type { RawArticle } from '../engine/news/score.js';

export interface Feed {
  name: string;
  domain: string;
  tier: number;
  url: string;
}

/**
 * All six feeds verified reachable with no key. RSS is the right answer for
 * crypto news: no quota, no CORS, no signing. CryptoPanic removed its free
 * tier in April 2026 and now starts at $50/week, so it is not an option.
 */
export const FEEDS: Feed[] = [
  { name: 'CoinDesk', domain: 'coindesk.com', tier: 12, url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { name: 'Cointelegraph', domain: 'cointelegraph.com', tier: 10, url: 'https://cointelegraph.com/rss' },
  { name: 'Decrypt', domain: 'decrypt.co', tier: 10, url: 'https://decrypt.co/feed' },
  { name: 'Bitcoin Magazine', domain: 'bitcoinmagazine.com', tier: 10, url: 'https://bitcoinmagazine.com/.rss/full/' },
  { name: 'Bitcoin.com', domain: 'news.bitcoin.com', tier: 10, url: 'https://news.bitcoin.com/feed/' },
  { name: 'CryptoSlate', domain: 'cryptoslate.com', tier: 8, url: 'https://cryptoslate.com/feed/' },
];

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    // Numeric entities first — feeds use &#8217; and &#038; heavily.
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 9 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

function stripTags(html: string): string {
  return decodeEntities(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTracking(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (/^utm_/i.test(k) || k === 's' || k === 'cmpid' || k === 'ref') u.searchParams.delete(k);
    }
    return u.toString();
  } catch {
    return url;
  }
}

function pickTag(block: string, tag: string): string {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return m ? m[1] : '';
}

/** RSS 2.0 uses RFC-822 pubDate; both Date parsers handle the numeric offset. */
function parseDate(raw: string): number {
  if (!raw) return Date.now();
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : Date.now();
}

function parseFeed(xml: string, feed: Feed): RawArticle[] {
  const items: RawArticle[] = [];
  const itemRe = /<item[\s>][\s\S]*?<\/item>/gi;
  let m: RegExpExecArray | null;

  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[0];
    const title = stripTags(pickTag(block, 'title'));
    if (!title) continue;

    let link = stripTags(pickTag(block, 'link'));
    if (!link) {
      const guid = pickTag(block, 'guid');
      link = stripTags(guid);
    }
    link = stripTracking(link);

    const description = stripTags(pickTag(block, 'description'));
    const content = stripTags(pickTag(block, 'content:encoded'));
    const body = (content || description).slice(0, 600);

    const updated = pickTag(block, 'atom:updated');
    const publishedAt = parseDate(stripTags(updated) || pickTag(block, 'pubDate'));

    items.push({
      id: `${feed.domain}:${link || title}`,
      headline: title,
      url: link || feed.url,
      source: feed.name,
      tier: feed.tier,
      publishedAt,
      body,
    });
  }
  return items;
}

export async function fetchAllNews(ttlMs = 5 * 60_000): Promise<RawArticle[]> {
  return cached('news:all', ttlMs, async () => {
    const results = await Promise.allSettled(
      FEEDS.map(async (feed) => {
        const xml = await fetchText(feed.url, {
          label: `rss ${feed.name}`,
          retries: 1,
          timeoutMs: 10_000,
        });
        return parseFeed(xml, feed);
      }),
    );

    const seen = new Set<string>();
    const out: RawArticle[] = [];
    results.forEach((r, i) => {
      if (r.status !== 'fulfilled') {
        console.warn(`[rss] ${FEEDS[i].name} failed:`, (r.reason as Error)?.message);
        return;
      }
      for (const a of r.value) {
        if (seen.has(a.id)) continue;
        seen.add(a.id);
        out.push(a);
      }
    });
    return out;
  });
}
