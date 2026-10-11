import { UNIVERSE } from '../../data/universe.js';

export const ASSET_ALIASES: Record<string, string[]> = {
  BTC: ['bitcoin', 'btc', 'xbt', 'satoshi'],
  ETH: ['ethereum', 'ether', 'eth'],
  SOL: ['solana', 'sol'],
  BNB: ['bnb', 'binance coin', 'bnb chain'],
  XRP: ['xrp', 'ripple'],
  ADA: ['cardano', 'ada'],
  AVAX: ['avalanche', 'avax'],
  DOT: ['polkadot', 'dot'],
  LINK: ['chainlink', 'link'],
  TRX: ['tron', 'trx'],
  TON: ['toncoin', 'the open network', 'ton'],
  NEAR: ['near protocol', 'near'],
  APT: ['aptos', 'apt'],
  SUI: ['sui'],
  ARB: ['arbitrum', 'arb'],
  OP: ['optimism', 'op mainnet'],
  MNT: ['mantle'],
  STRK: ['starknet'],
  ZK: ['zksync'],
  MANTA: ['manta network', 'manta'],
  UNI: ['uniswap', 'uni'],
  AAVE: ['aave'],
  MKR: ['maker', 'sky dao'],
  LDO: ['lido'],
  CRV: ['curve dao', 'curve'],
  PENDLE: ['pendle'],
  FET: ['artificial superintelligence', 'fetch.ai', 'fet'],
  RENDER: ['render network', 'render'],
  TAO: ['bittensor'],
  WLD: ['worldcoin', 'world coin'],
  AR: ['arweave'],
  DOGE: ['dogecoin', 'doge'],
  SHIB: ['shiba inu', 'shib'],
  PEPE: ['pepe'],
  WIF: ['dogwifhat', 'wif'],
  BONK: ['bonk'],
  USDT: ['tether', 'usdt'],
  USDC: ['usd coin', 'usdc'],
  DAI: ['dai', 'makerdao'],
  ONDO: ['ondo finance', 'ondo'],
  CFG: ['centrifuge'],
  OKB: ['okb', 'okx'],
  CRO: ['cronos'],
  KCS: ['kucoin'],
  XMR: ['monero', 'xmr'],
  ZEC: ['zcash', 'zec'],
  IMX: ['immutable', 'imx'],
  SAND: ['the sandbox', 'sandbox'],
  AXS: ['axie infinity', 'axs'],
  FIL: ['filecoin', 'fil'],
  ICP: ['internet computer', 'dfinity'],
  INJ: ['injective'],
  TIA: ['celestia', 'tia'],
  SEI: ['sei network', 'sei'],
};

const MACRO_ENTITIES: Record<string, string[]> = {
  FOMC: ['fomc', 'federal open market committee', 'fed decision', 'federal reserve', 'dot plot', 'interest rate decision'],
  CHAIR: ['powell', 'warsh', 'fed chair', 'jackson hole'],
  CPI: ['cpi', 'consumer price index', 'inflation print', 'inflation data', 'core inflation'],
  PCE: ['pce', 'personal consumption', 'personal income and outlays'],
  NFP: ['nonfarm payrolls', 'non-farm payrolls', 'nfp', 'jobs report', 'employment situation', 'unemployment rate'],
  PPI: ['ppi', 'producer price'],
  YIELDS: ['10-year yield', '2-year yield', 'treasury yield', 'bond yield', 'real yield', 'tips', 'dxy', 'dollar index'],
  ETF: ['etf', 'spot bitcoin etf', 'ibit', 'fbtc', 'bitb', 'arkb', 'etp'],
};

const INDIA_TERMS = ['sebi', 'rbi', 'fiu-ind', 'fiu ind', 'fiuit', 'pml', 'income tax act', 'gift city', 'ifsca', 'indian', 'india', 'rupee', 'inr', 'delhi', 'mumbai', 'bombay', 'nse', 'bse'];

const EU_TERMS = ['esma', 'mica', 'european union', 'brussels', 'europe', 'uk', 'fca', 'genius act'];

export interface EntityMatch {
  assets: string[];
  macroEntity: string | null;
  jurisdiction: 'US' | 'IN' | 'EU' | 'GLOBAL';
  /** RavenPack-style position relevance proxy: hit in the first 16 chars = 100. */
  headlineRelevance: number;
  sectorHint: string | null;
}

const ASSET_TO_SECTOR = new Map(UNIVERSE.map((u) => [u.base, u.sector]));

export function extractEntities(headline: string, body: string): EntityMatch {
  const text = `${headline} ${body}`;
  const lower = text.toLowerCase();
  const headLower = headline.toLowerCase();

  const assets: string[] = [];
  let firstHitPos = -1;

  for (const [base, aliases] of Object.entries(ASSET_ALIASES)) {
    let hitIndex = -1;
    for (const alias of aliases) {
      const idx = lower.indexOf(alias);
      if (idx === -1) continue;
      // Require a word boundary for short tickers to avoid substring noise.
      const boundary = new RegExp(`(^|[^a-z])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i');
      if (!boundary.test(lower)) continue;
      if (hitIndex === -1 || idx < hitIndex) hitIndex = idx;
    }
    if (hitIndex >= 0) {
      assets.push(base);
      // Only measure headline position for assets that appear in the headline.
      const headIdx = headLower.search(
        new RegExp(`(^|[^a-z])(${aliases.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})([^a-z]|$)`, 'i'),
      );
      if (headIdx >= 0 && (firstHitPos === -1 || headIdx < firstHitPos)) firstHitPos = headIdx;
    }
  }

  let macroEntity: string | null = null;
  for (const [name, terms] of Object.entries(MACRO_ENTITIES)) {
    if (terms.some((t) => lower.includes(t))) {
      macroEntity = name;
      break;
    }
  }

  let jurisdiction: 'US' | 'IN' | 'EU' | 'GLOBAL' = 'GLOBAL';
  if (INDIA_TERMS.some((t) => lower.includes(t))) jurisdiction = 'IN';
  else if (EU_TERMS.some((t) => lower.includes(t))) jurisdiction = 'EU';
  else if (['sec', 'cftc', 'doj', 'white house', 'congress', 'treasury department', 'federal'].some((t) => lower.includes(t))) jurisdiction = 'US';

  const headlineRelevance =
    firstHitPos < 0 ? 0 : Math.max(0, Math.round(100 - 6.25 * firstHitPos));

  const sectorHint =
    assets.length > 0 ? (ASSET_TO_SECTOR.get(assets[0]) ?? null) : null;

  return { assets, macroEntity, jurisdiction, headlineRelevance, sectorHint };
}
