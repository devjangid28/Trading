# AGENTS.md — working rules for this repo

## The context file is the memory

**`CONTEXT.md` is the project's source of truth. Keep it updated in the same pass as any change.**

Read it before touching the engine. Update it before you finish. If you change something and the
context file does not mention it, the next session will work from a lie.

### When to update `CONTEXT.md`

| Trigger | What to write |
|---|---|
| Engine behaviour changed (threshold, formula, route, constant) | Update the section **and** the API table / constant reference in the same pass |
| A bug is found | Add it to the bug table with symptom and fix. A bug not written down gets re-introduced |
| A session's worth of work lands | Append a dated Part. Do **not** silently rewrite an older Part — the history is the point. Later parts supersede earlier ones; say so explicitly |
| A verification script was run | Paste the **real** output, failures included. Never record a run as green that was not |
| Something is knowingly unbuilt | Say so under honest gaps. An undocumented gap reads as a bug |
| A claim was falsified | Correct it in place and say what replaced it. Do not quietly delete it |

### Rules of writing it

- **Never record an aspiration as a fact.** Every "✅ complete" was verified by running something —
  `npm run verify`, `npm run verify:truth`, `npm run verify:stage1`, or a Playwright spec — and that
  output is quoted in the part making the claim.
- **Quote real numbers, never paraphrases.** "p50 1294 ms", not "low latency".
- **Record failures with the same care as passes.** The 12 Oct truth check failed twice; both
  failures are written down because that is what makes the passing checks mean anything.

## Before you claim anything works

```bash
npm run verify          # typecheck + 377 vitest tests
npm run build           # typecheck + production bundle
```

Against a live stack:

```bash
npm run dev:api         # then, in another shell:
npm run verify:truth    # wire prices vs Binance REST, timestamps, latency
npm run verify:stage1   # two clients, throttle, receive latency p50/p95
```

Browser behaviour lives in `qa/` (Playwright) because there is no DOM environment in the vitest setup.
**Stop `npm run dev` before running `npx playwright test`** — two Vite dev servers share one
`node_modules/.vite` cache and the second wedges.

## House rules that keep holding

1. **Closed candles only.** A zone never repaints from a candle that is still forming.
2. **Never invent a number.** No liquidity target ⇒ `rr = 0` and the UI shows `—`. No tick yet ⇒ a
   dash. Suppressed statistics ⇒ a sentence saying why, not a made-up rate.
3. **`STALE` is never rendered as `LIVE`.** `MOCK` is never rendered as a live market.
4. **Hand-tuned weights stay labelled `[TUNED]`** until the ledger has enough resolved outcomes to fit
   them. Do not improve them by feel.
5. **Do not use PowerShell `-replace` to edit source files.** It mangles regexes and template
   literals. Use the Edit tool.
6. **Any threshold lives in `server/src/config.ts`** with a provenance tag: `[V]` verified in
   documentation, `[PROBED]` measured live, `[TUNED]` hand-tuned. Nothing hard-codes a number.
