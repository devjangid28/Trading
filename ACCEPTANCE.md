# OrderFlow v2 — Acceptance Checklist

This file replaces `ORDERFLOW_V2_MASTER_PROMPT.md` §14, which was never saved into
the repo. It is the checklist used to decide whether a stage is done.

**Rule: no stage is marked done unless its check below ran against live data.**
A unit test that exercises a pure function is necessary but not sufficient — it
does not prove the feed works, the timestamp advances, or the number matches the
exchange.

---

## The 10 checks

1. **Probe table complete; every source has a chosen fallback.**
   Every row in `DATA_SOURCES.md` carries a verdict and a named fallback or an
   explicit "no fallback — shows Unavailable". A blocked source with no decision
   attached is a failure.

2. **A price change shows in a row within 2s; the board re-ranks on 5m candle
   close; a killed socket shows DELAYED then recovers with no candle gap.**
   Verified by `scripts/verify-stage1.ts`, which opens two concurrent SSE clients
   and measures tick latency, throttle rate, and survival of one client when the
   other is killed.

3. **At least one A/B pick shows a full trade plan with real R:R (or "-" when
   there is no liquidity target). If no A/B pick exists, show a graded C with the
   same plan fields.**
   The pick panel must never be empty just because nothing graded A — the
   fallback is the highest-scoring C with its full plan.

4. **Derivatives tab populated for at least 40 perps from a working provider.**

5. **Liquidation tape live and labelled as a sample.**
   `!forceOrder@arr` is a lower bound on liquidations, not a census. Every surface
   showing it must say so.

6. **Event countdown correct for FOMC 27 Oct 2026 14:00 ET (23:30 IST); blackout
   veto triggers in a simulated-clock test.**
   Also: all five BLS dates must convert correctly across the 1 Nov 2026 DST
   change (EDT → EST), because a fixed offset places every post-DST release an
   hour early.

7. **Ledger freezes a snapshot on a new A/B signal and resolves it on a replayed
   candle series; resolver treats same-candle stop+target as STOP.**

8. **Every panel degrades to "Unavailable" with a reason when its source is
   blocked (test by blocking one host).**

9. **No panel shows a number without an asOf.**

10. **README, DATA_SOURCES.md and ORDERFLOW-CONTEXT.md match what was built.**

---

## Standing rules these checks enforce

- Never fabricate data. Unavailable sources show `Unavailable` + reason + last-good age.
- Every number carries source + `asOf`; the UI shows LIVE / DELAYED / STALE.
- Components with no input are `null` (missing), never `0`. A/B require zero missing.
- Score weights are **not** changed. No fitting until the ledger has 200+ resolved signals.
- Database changes are migrations only; tables are never dropped or recreated.
- Existing `/api` routes keep working.
- Every new pure function has tests; fixtures are captured from live responses.

---

## Status

Filled in at close-out (Stage 10) with pass/fail and evidence for each item.