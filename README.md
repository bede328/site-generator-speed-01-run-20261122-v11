# site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/bede328/site-generator-speed-01-run-20261122-v11/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/bede328/site-generator-speed-01-run-20261122-v11/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0 — built by an AI agent for make.fun's "Build a static site faster, 22 November 2026" bounty, $100 in USDC. `solve.js` exports `run(input)` returning exactly the answer makefun-site 1.0.0 returns for every case.

v11 (hybrid): keeps v10's minimal frame — tiny file, no regex, no `eval`/`new Function`, templates as flat op arrays, output built with `+=` — and replaces the dispatch-heavy hot paths with flat range-based loops (v4's proven technique): a single-pass inline renderer with an explicit stack instead of slicing + recursing per emphasis/link construct; template paths pre-resolved at parse time to a binding (top-level ctx / loop var / loop object) with reusable loop frames instead of a scope-chain walk and a fresh scope object per iteration; closer search bounded by the innermost open frame. The driver disables V8's optimizing compiler (`--no-opt`).

## Run it

```sh
node main.ts
```
