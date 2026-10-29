/**
 * Version registry — Phase XVI step 0.
 *
 * Every artefact that reaches the ledger carries the version of the code, the
 * feature schema, the configuration and the calibration that produced it. Without
 * this, a row frozen in March is silently reinterpreted by November's calibration
 * model, and the ledger quietly becomes a mixture of two systems that nobody
 * agreed to compare.
 *
 * Three rules make this more than bookkeeping:
 *
 * 1. **The config version is a HASH of the real config, not a hand-written
 *    string.** A human bumping `1.2.0` while the numbers change would defeat the
 *    entire mechanism. If a threshold moves, the version moves, automatically.
 *
 * 2. **Every version has a rollback target.** Phase XVI requirement: "Preserve
 *    the previous working version when a new idea fails." A version you cannot
 *    return to is not a version, it is an edit.
 *
 * 3. **The feature-schema version is separate from the engine version.** Adding a
 *    column is not the same as changing what a column means. The Phase XIV→XV
 *    history contains a real instance of that: `resolution` was renamed in
 *    meaning while the field name stayed the same, which silently invalidated
 *    every stored decomposition.
 *
 * Pure and dependency-free so it can be imported by tests, the report scripts and
 * the server without any of them pulling in `node:sqlite`.
 */

import { config } from './config.js';
import { createHash } from 'node:crypto';

/**
 * Bump when the ENGINE's behaviour changes in a way that alters what a signal
 * means: a new veto, a changed gate order, a changed resolver.
 *
 * Not for cosmetic edits, comments, or added reporting fields.
 */
export const ENGINE_VERSION = 'orderflow-mind-1.0.0';

/**
 * Bump when the SHAPE or the SEMANTIC of the frozen feature record changes.
 *
 * The semantics half is the one that bites. Renaming a field is cosmetic;
 * redefining what a field measures requires a bump even if the name survives.
 */
export const FEATURE_SCHEMA_VERSION = 'features-1.0.0';

/**
 * Bump when the calibration model changes. Separate from the engine version on
 * purpose: the probability is a model output, and a reader needs to know which
 * model produced it independently of which code computed the features.
 */
export const CALIBRATION_VERSION = 'calib-1.0.0';

/** The Mind probability model identity. Currently shipped `[TUNED]` weights. */
export const MODEL_ID = 'mind-logistic-anchored';

/**
 * Deterministic hash of the entire config object.
 *
 * This is the honest config version: it changes when — and only when — a number
 * actually changed. `Object.keys` is sorted recursively so key order cannot make
 * an identical config look different, and functions are stringified so a changed
 * comparator is caught too.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' ? `fn:${value.toString()}` : JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

/** First 12 hex chars of the config digest — enough to detect change, short enough to print. */
export const CONFIG_VERSION: string = createHash('sha256')
  .update(stableStringify(config))
  .digest('hex')
  .slice(0, 12);

export interface VersionSet {
  engine: string;
  featureSchema: string;
  calibration: string;
  config: string;
  model: string;
}

export function currentVersions(): VersionSet {
  return {
    engine: ENGINE_VERSION,
    featureSchema: FEATURE_SCHEMA_VERSION,
    calibration: CALIBRATION_VERSION,
    config: CONFIG_VERSION,
    model: MODEL_ID,
  };
}

/**
 * Rollback targets.
 *
 * Every version names what to go back to. `null` means "there is no previous
 * version" — which is true today, because the Mind layer shipped in one step. The
 * field exists so that the FIRST learning update has somewhere to return to, and
 * so the absence of a rollback target is a visible fact rather than an oversight.
 */
export const ROLLBACK_TARGETS: Record<string, VersionSet | null> = {
  [ENGINE_VERSION]: null,
  [FEATURE_SCHEMA_VERSION]: null,
  [CALIBRATION_VERSION]: null,
};

/** Single-line identity for logs and for the frozen record. */
export function versionStamp(): string {
  const v = currentVersions();
  return `${v.engine}+${v.featureSchema}+${v.calibration}+cfg${v.config}`;
}