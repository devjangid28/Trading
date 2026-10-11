/**
 * Constants the calendar needs, re-exported through their own module so the
 * calendar does not pull the whole config object into its import graph.
 */
import { DERIVATIVES, FUNDING_TIMES_UTC } from '../config.js';

export const DERIVATIVES_DERIBIT_SETTLE_UTC_H = DERIVATIVES.DERIBIT_SETTLE_UTC_H;
export { FUNDING_TIMES_UTC };
