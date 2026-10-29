export const DATASET_POPULATIONS = [
  'MEASURED',
  'LEGACY_UNMEASURED',
  'RECONSTRUCTED',
  'VETOED',
  'BLOCKED',
] as const;

export type DatasetPopulation = (typeof DATASET_POPULATIONS)[number];

export interface DatasetPolicyDefinition {
  population: DatasetPopulation;
  description: string;
  populationDefinition: string;
}

export const DATASET_POLICY: Record<DatasetPopulation, DatasetPolicyDefinition> = {
  MEASURED: {
    population: 'MEASURED',
    description: 'Signals created after the outcome store existed, with complete frozen features and outcome rows.',
    populationDefinition: 'MEASURED: signals created after the outcome store existed, with complete frozen features and outcome rows.',
  },
  LEGACY_UNMEASURED: {
    population: 'LEGACY_UNMEASURED',
    description: 'The 527 pre-outcome-store resolved signals that were not frozen with costs and outcome rows at decision time.',
    populationDefinition: 'LEGACY_UNMEASURED: pre-outcome-store resolved signals excluded from measured performance because costs and outcome rows were not frozen at decision time.',
  },
  RECONSTRUCTED: {
    population: 'RECONSTRUCTED',
    description: 'Historical signals rebuilt from candles, news archives, or inferred state and explicitly marked with reconstruction confidence.',
    populationDefinition: 'RECONSTRUCTED: historical signals rebuilt from candles, news archives, or inferred state; they carry a reconstruction_confidence field and never mix with MEASURED headline metrics.',
  },
  VETOED: {
    population: 'VETOED',
    description: 'Setups considered but not traded.',
    populationDefinition: 'VETOED: setups considered but not traded.',
  },
  BLOCKED: {
    population: 'BLOCKED',
    description: 'Setups withheld by data-integrity, macro blackout, or risk rules.',
    populationDefinition: 'BLOCKED: setups withheld by data-integrity, macro blackout, or risk rules.',
  },
} as const;

export function normalizeDatasetPopulation(value: string): DatasetPopulation {
  const normalized = String(value).trim().toUpperCase();
  if ((DATASET_POPULATIONS as readonly string[]).includes(normalized)) {
    return normalized as DatasetPopulation;
  }
  throw new Error(`Unknown dataset population: ${value}`);
}

export function legacyExclusionMessage(count: number): string {
  return `${count} legacy signals excluded because costs and outcome rows were not frozen at decision time.`;
}

export function assertSingleDatasetPopulation(populations: readonly string[]): DatasetPopulation {
  const unique = [...new Set(populations.map((p) => normalizeDatasetPopulation(p)))];
  if (unique.length === 0) {
    throw new Error('No dataset population supplied.');
  }
  if (unique.length > 1) {
    throw new Error(
      `Population mix defect: cannot mix ${unique.join(', ')} in a single report or headline metric. ` +
        'Use one dataset population per chart, table, or API response.',
    );
  }
  return unique[0];
}

export function describeDatasetPopulation(population: DatasetPopulation): string {
  return DATASET_POLICY[population].populationDefinition;
}
