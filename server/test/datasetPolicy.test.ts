import { describe, expect, it } from 'vitest';

import {
  assertSingleDatasetPopulation,
  DATASET_POLICY,
  legacyExclusionMessage,
  normalizeDatasetPopulation,
} from '../src/ledger/datasetPolicy.js';

describe('dataset policy', () => {
  it('exposes the declared population boundary', () => {
    expect(DATASET_POLICY.MEASURED.population).toBe('MEASURED');
    expect(DATASET_POLICY.LEGACY_UNMEASURED.population).toBe('LEGACY_UNMEASURED');
    expect(DATASET_POLICY.RECONSTRUCTED.population).toBe('RECONSTRUCTED');
    expect(DATASET_POLICY.VETOED.population).toBe('VETOED');
    expect(DATASET_POLICY.BLOCKED.population).toBe('BLOCKED');
  });

  it('normalizes the population name and blocks mixed reports', () => {
    expect(normalizeDatasetPopulation('measured')).toBe('MEASURED');
    expect(() => assertSingleDatasetPopulation(['MEASURED', 'LEGACY_UNMEASURED'])).toThrow(
      /Population mix defect: cannot mix MEASURED, LEGACY_UNMEASURED/i,
    );
    expect(() => assertSingleDatasetPopulation(['RECONSTRUCTED', 'MEASURED'])).toThrow(/Population mix defect/i);
  });

  it('prints the legacy exclusion message in the required wording', () => {
    const message = legacyExclusionMessage(527);
    expect(message).toBe('527 legacy signals excluded because costs and outcome rows were not frozen at decision time.');
  });

  it('accepts a single permitted population', () => {
    expect(assertSingleDatasetPopulation(['MEASURED'])).toBe('MEASURED');
    expect(assertSingleDatasetPopulation(['LEGACY_UNMEASURED'])).toBe('LEGACY_UNMEASURED');
    expect(assertSingleDatasetPopulation(['RECONSTRUCTED'])).toBe('RECONSTRUCTED');
  });
});
