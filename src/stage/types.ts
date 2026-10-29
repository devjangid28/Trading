import type { ScanResult } from '../../shared/types';

export interface LivePrice {
  price: number;
  changePct: number;
  dir: 'up' | 'down' | 'flat';
  at: number;
}

export type LivePriceMap = Record<string, LivePrice>;

export interface StageProps {
  data: ScanResult;
  prices?: LivePriceMap;
  selected: string | null;
  onSelect: (symbol: string) => void;
  onHero: (symbol: string) => void;
  /** Clear the pinned selection (empty click / Escape). */
  onClear: () => void;
}