import type { NewsCategory } from '../../../shared/types.js';

export interface UniverseEntry {
  base: string;
  name: string;
  sector: string;
  /** Base assets the news engine treats as the same beta family. */
  betaGroup: 'btc' | 'eth' | 'l1' | 'l2' | 'defi' | 'ai' | 'meme' | 'rwa' | 'exchange' | 'stable' | 'privacy' | 'gaming' | 'infra';
  tags: NewsCategory[];
}

/**
 * Hand-maintained universe. A live scan over every Binance USDT pair would be
 * dominated by micro-caps with no liquidity, so we track names with enough
 * depth to be tradeable and group them into the sector flow panel.
 */
export const UNIVERSE: UniverseEntry[] = [
  { base: 'BTC', name: 'Bitcoin', sector: 'Store of value', betaGroup: 'btc', tags: ['ETF', 'ADOPT', 'MACRO'] },
  { base: 'ETH', name: 'Ethereum', sector: 'Smart contract L1', betaGroup: 'eth', tags: ['ETF', 'TECH', 'ADOPT'] },
  { base: 'SOL', name: 'Solana', sector: 'Smart contract L1', betaGroup: 'l1', tags: ['ETF', 'TECH', 'ADOPT'] },
  { base: 'BNB', name: 'BNB', sector: 'Exchange token', betaGroup: 'exchange', tags: ['REG'] },
  { base: 'XRP', name: 'XRP', sector: 'Payments', betaGroup: 'l1', tags: ['REG', 'LIST'] },
  { base: 'ADA', name: 'Cardano', sector: 'Smart contract L1', betaGroup: 'l1', tags: ['TECH'] },
  { base: 'AVAX', name: 'Avalanche', sector: 'Smart contract L1', betaGroup: 'l1', tags: ['TECH', 'ADOPT'] },
  { base: 'DOT', name: 'Polkadot', sector: 'Interoperability', betaGroup: 'infra', tags: ['TECH'] },
  { base: 'LINK', name: 'Chainlink', sector: 'Oracle', betaGroup: 'infra', tags: ['ADOPT'] },
  { base: 'TRX', name: 'TRON', sector: 'Smart contract L1', betaGroup: 'l1', tags: ['TECH'] },
  { base: 'NEAR', name: 'NEAR Protocol', sector: 'Smart contract L1', betaGroup: 'l1', tags: ['TECH'] },
  { base: 'APT', name: 'Aptos', sector: 'Smart contract L1', betaGroup: 'l1', tags: ['TECH'] },
  { base: 'SUI', name: 'Sui', sector: 'Smart contract L1', betaGroup: 'l1', tags: ['TECH', 'LIST'] },
  { base: 'ATOM', name: 'Cosmos', sector: 'Interoperability', betaGroup: 'infra', tags: ['TECH'] },
  { base: 'KAIA', name: 'Kaia', sector: 'Smart contract L1', betaGroup: 'l1', tags: ['TECH'] },
  { base: 'LUMIA', name: 'Lumia', sector: 'Smart contract L1', betaGroup: 'l1', tags: ['TECH'] },
  { base: 'SEI', name: 'Sei', sector: 'Smart contract L1', betaGroup: 'l1', tags: ['TECH'] },

  { base: 'ARB', name: 'Arbitrum', sector: 'Layer 2', betaGroup: 'l2', tags: ['TECH'] },
  { base: 'OP', name: 'Optimism', sector: 'Layer 2', betaGroup: 'l2', tags: ['TECH'] },
  { base: 'STRK', name: 'Starknet', sector: 'Layer 2', betaGroup: 'l2', tags: ['TECH'] },
  { base: 'ZK', name: 'zkSync', sector: 'Layer 2', betaGroup: 'l2', tags: ['TECH'] },
  { base: 'MANTA', name: 'Manta Network', sector: 'Layer 2', betaGroup: 'l2', tags: ['TECH'] },

  { base: 'UNI', name: 'Uniswap', sector: 'DeFi', betaGroup: 'defi', tags: ['HACK', 'TECH'] },
  { base: 'AAVE', name: 'Aave', sector: 'DeFi lending', betaGroup: 'defi', tags: ['HACK'] },
  { base: 'LDO', name: 'Lido DAO', sector: 'DeFi staking', betaGroup: 'defi', tags: ['TECH'] },
  { base: 'CRV', name: 'Curve DAO', sector: 'DeFi', betaGroup: 'defi', tags: ['STABLE', 'HACK'] },
  { base: 'PENDLE', name: 'Pendle', sector: 'DeFi yield', betaGroup: 'defi', tags: ['ADOPT'] },
  { base: 'ENA', name: 'Ethena', sector: 'DeFi yield', betaGroup: 'defi', tags: ['STABLE', 'REG'] },
  { base: 'INJ', name: 'Injective', sector: 'DeFi / RWA', betaGroup: 'defi', tags: ['ADOPT'] },
  { base: 'JUP', name: 'Jupiter', sector: 'DeFi', betaGroup: 'defi', tags: ['ADOPT'] },

  { base: 'FET', name: 'Artificial Superintelligence', sector: 'AI', betaGroup: 'ai', tags: ['ADOPT'] },
  { base: 'RENDER', name: 'Render', sector: 'AI / DePIN', betaGroup: 'ai', tags: ['ADOPT'] },
  { base: 'TAO', name: 'Bittensor', sector: 'AI', betaGroup: 'ai', tags: ['ADOPT'] },
  { base: 'WLD', name: 'Worldcoin', sector: 'AI / Identity', betaGroup: 'ai', tags: ['ADOPT', 'REG'] },
  { base: 'RLC', name: 'iExec RLC', sector: 'Oracle', betaGroup: 'infra', tags: ['ADOPT'] },
  { base: 'AR', name: 'Arweave', sector: 'Storage / DePIN', betaGroup: 'infra', tags: ['ADOPT'] },
  { base: 'BAT', name: 'Basic Attention', sector: 'Storage / DePIN', betaGroup: 'infra', tags: ['ADOPT'] },

  { base: 'DOGE', name: 'Dogecoin', sector: 'Meme', betaGroup: 'meme', tags: ['ADOPT'] },
  { base: 'SHIB', name: 'Shiba Inu', sector: 'Meme', betaGroup: 'meme', tags: ['LIST'] },
  { base: 'PEPE', name: 'Pepe', sector: 'Meme', betaGroup: 'meme', tags: ['LIST'] },
  { base: 'WIF', name: 'dogwifhat', sector: 'Meme', betaGroup: 'meme', tags: ['LIST'] },
  { base: 'BONK', name: 'Bonk', sector: 'Meme', betaGroup: 'meme', tags: ['LIST'] },
  { base: 'PENGU', name: 'Pudgy Penguins', sector: 'Meme', betaGroup: 'meme', tags: ['LIST'] },
  { base: 'TRUMP', name: 'OFFICIAL TRUMP', sector: 'Meme', betaGroup: 'meme', tags: ['LIST'] },
  { base: 'VIRTUAL', name: 'Virtuals Protocol', sector: 'AI agents', betaGroup: 'ai', tags: ['LIST'] },

  { base: 'ONDO', name: 'Ondo', sector: 'RWA / Tokenised assets', betaGroup: 'rwa', tags: ['ADOPT', 'REG'] },
  { base: 'CFG', name: 'Centrifuge', sector: 'RWA / Tokenised assets', betaGroup: 'rwa', tags: ['ADOPT'] },

  { base: 'ZEC', name: 'Zcash', sector: 'Privacy', betaGroup: 'privacy', tags: ['REG'] },

  { base: 'IMX', name: 'Immutable', sector: 'Gaming', betaGroup: 'gaming', tags: ['ADOPT'] },
  { base: 'SAND', name: 'The Sandbox', sector: 'Gaming', betaGroup: 'gaming', tags: ['ADOPT'] },
  { base: 'AXS', name: 'Axie Infinity', sector: 'Gaming', betaGroup: 'gaming', tags: ['ADOPT'] },
  { base: 'MAGIC', name: 'Magic', sector: 'Gaming', betaGroup: 'gaming', tags: ['ADOPT'] },

  { base: 'FIL', name: 'Filecoin', sector: 'Storage / DePIN', betaGroup: 'infra', tags: ['ADOPT'] },
  { base: 'ICP', name: 'Internet Computer', sector: 'Compute / DePIN', betaGroup: 'infra', tags: ['ADOPT'] },
  { base: 'TIA', name: 'Celestia', sector: 'Modular / DA', betaGroup: 'infra', tags: ['TECH'] },
  { base: 'PYTH', name: 'Pyth Network', sector: 'Oracle', betaGroup: 'infra', tags: ['ADOPT'] },
];

/** Stablecoins are tracked by the macro panel, not the order-block board. */
export const EXCLUDE_FROM_BOARD = new Set(['USDT', 'USDC', 'DAI', 'FDUSD', 'TUSD']);

/**
 * Fiat-pegged tokens. These have a 24h quote volume in the billions and would
 * otherwise dominate the volume cap, so they are dropped before the board is
 * built. Kept deliberately broader than EXCLUDE_FROM_BOARD.
 */
export const STABLECOIN_BASES = new Set([
  'USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'USDP', 'DAI', 'USDD', 'USDE', 'USD1',
  'PYUSD', 'GUSD', 'FRAX', 'USDS', 'USDA', 'USDL', 'SUSD', 'MIM', 'LUSD', 'CUSD',
  'USTC', 'UST', 'VAI', 'USDF', 'USDB', 'USDX', 'USX', 'USDG', 'USDR', 'USDTB',
  'RLUSD', 'USDY', 'BSCUSD', 'USDL', 'XUSD',
  'EURI', 'AEUR', 'EURT', 'EURS', 'EUR', 'JPYC', 'GYEN', 'XSGD', 'XIDR',
  'TRY', 'BIDR', 'IDRT', 'BRL', 'RUB', 'UAH', 'ZAR', 'GBP', 'AUD',
]);

/** Wrapped / bridged representations of an asset that already trades natively. */
export const WRAPPED_BASES = new Set([
  'WBTC', 'WETH', 'WBNB', 'WSTETH', 'WSOL', 'WAVAX', 'WMATIC', 'WPOL', 'BTCB',
  'WFTM', 'WONE', 'WCRO', 'WHT', 'WROSE', 'WTRX', 'BETH', 'CBBTC', 'WETH_E',
  'WBTC_E', 'SOLVBTC',
]);

export const UNIVERSE_BY_BASE = new Map(UNIVERSE.map((u) => [u.base, u]));

export const SECTORS = [
  'Store of value',
  'Smart contract L1',
  'Layer 2',
  'DeFi',
  'DeFi lending',
  'DeFi staking',
  'DeFi yield',
  'AI',
  'AI agents',
  'AI / DePIN',
  'AI / Identity',
  'Meme',
  'RWA / Tokenised assets',
  'Exchange token',
  'Privacy',
  'Gaming',
  'Storage / DePIN',
  'Compute / DePIN',
  'Oracle',
  'Interoperability',
  'Modular / DA',
  'Payments',
];
