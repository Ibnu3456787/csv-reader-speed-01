# csv-reader-speed-01 — a faster drop-in for csv-reader 1.0.0

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/Ibnu3456787/csv-reader-speed-01/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/Ibnu3456787/csv-reader-speed-01/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

Entry for make.fun's **csv-reader-speed-01** ("Read broken CSV files faster"),
21 November 2026 run. `run(input)` returns exactly csv-reader 1.0.0's answer
`{columns, rows, errors}` for every `{text, header}` input, with the reference
program's full broken-row policy (BOM, stray CRs, quoted fields with doubled
quotes and multi-line values, quote junk, unterminated quotes, short/long
rows) — only faster.

## Files

- `solve.js` — the parser. Plain JavaScript, no dependencies, no WASM, no
  native code.
- `main.ts` — the driver the harness runs: reads `/input/cases.json`, answers
  every case with `run()`, writes `/output/answers.json`.
- `package.json`, `LICENSE` (MIT).

## How it is fast

Every choice below won a head-to-head benchmark on the practice set
(6 cases, 10.19 MB), measured in fresh processes as the heat runs:

- **Unquoted fields via `indexOf`, not a character loop.** The next comma or
  the line end is found by C++ scans. A per-line cache (next LF, line end,
  whether the line holds a stray CR) is refreshed once per line and reused by
  every field on it; lines holding a stray CR fall back to a character loop.
- **Quoted fields in one tight scan** that finds the closing quote, counts
  the line breaks inside, and notes doubled quotes and CRs in a single pass;
  the value is then a plain slice, or at most two regex replacements.
- **One content test per record** instead of one per field.
- **V8 flags** (`--no-incremental-marking --single-threaded`), set before
  `solve.js` is imported.
- **A JIT warm-up** before the real cases: each heat run is a fresh process
  and `run()` is called only six times per process, too few for the
  optimizing compiler to learn the code. Parsing a small branch-complete set
  of synthetic inputs first lets it optimize up front. The warm-up answers
  are discarded; every case is still answered alone by a fresh `run()` call.

Ideas that were measured and **rejected**: a record-level `split(',')` fast
path (check overhead beat the savings), single-pair slice-and-concat instead
of regex `""` replacement (no gain), a single-comparison quoted scan (slower),
per-field CR checks instead of the line cache (a wash), larger semi-space
sizes (64 MB neutral, 128 MB slower).

## Correctness evidence

- **Practice set: 6/6 exact** (scorer's canonical JSON comparison).
- **Differential fuzz vs the real reference program** (the kit's
  `vendor/csv-reader/index.js`): 19,000+ random inputs across 7 seeds, zero
  mismatches — including two divergences found and fixed by reading the
  reference (quote_junk is recorded only when junk characters were actually
  kept; header=true with zero records gives `columns: []`, not `null`).
- **80 targeted edge cases** (empty inputs, BOM positions, lone CRs,
  unterminated quotes, junk variants, short/long rows, multi-line quoted
  fields, 100 KB fields, 1,000-field rows): all agree with the reference.

## Speed (this box, practice set, trimmed means)

| Implementation | `run()` only | Full `main.ts` (fresh process, CPU) |
|---|---|---|
| csv-reader 1.0.0 (baseline) | 373 ms | ~2,400 ms |
| d3-dsv 3.0.2 (fewer semantics) | 93 ms | — |
| papaparse 5.7.1 (fewer semantics) | 170 ms | — |
| **This entry** | **~79 ms** | **~1,310 ms** |

`run()` is ~4.7× faster than the baseline on this box (and faster than
d3-dsv while implementing the full broken-row policy). End to end, the entry
is ~1.8× faster than the baseline; the rest of the time is JSON parsing and
stringifying, which is identical for every entry and largely netted out by
the heat's do-nothing control. House-box ratios will differ (the house box
penalizes allocation-heavy code more), but the entry beats the baseline by a
wide, measured margin on every metric.
