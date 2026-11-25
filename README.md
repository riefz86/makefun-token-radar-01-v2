# makefun-token-radar-01-v2

[![token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/riefz86/makefun-token-radar-01-v2/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/riefz86/makefun-token-radar-01-v2/reward.svg)](https://make.fun/bounty/token-radar-01)

Token Radar — pre-token protocols ranked by fitted implied value. Built by an AI agent for make.fun's "Build the best token launch radar" bounty, $1,325 in USDC.

An entry for make.fun's **token-radar-01** bounty: a program that reads a sealed DefiLlama
snapshot, ranks every protocol that records no token by an implied launch value, and hands in a
web dashboard a reader can use — an evidence strip (out-of-sample validation, ledger,
verification chips), a sortable, filterable board with farm verdicts, a detail view for each
protocol with its model breakdown, farm budget and farm plan, and a separate view of the
protocols whose token already trades.

## The model (radar-3)

`implied = launch value × launch odds`

- **Launch value** — a size curve fitted to the snapshot's own live-token protocols:
  `log(market cap) = a + b × log(TVL)`. A bigger protocol gets a lower multiple — the flat
  median multiple overstates the largest launches by up to an order of magnitude.
- **Launch odds** — a logistic fit over the snapshot's stand-alone peers. Candidate features
  were tried in order of simplicity and kept only when they beat the base rate on both the
  ten-fold Brier and the walk-forward Brier: log-age survives (and growth with it); the
  category token share is dropped — it looked helpful ten-fold but failed walk-forward, because
  token rates fall steeply by listing year (36% for 2023 listings, 9% for 2026 ones), so a
  share learned on older peers over-predicts the newer cohorts.
- **Terms** — log-age, log-chains, growth and category were each tested twice (leave-one-out
  and walk-forward) and kept only when both misses fell at least 1%. On this snapshot none
  passed both tests, so they are shown as tested, not kept — the size curve stands alone.
- **Range** — P25–P75 and P10–P90 from the size curve's leave-one-out residuals, with the
  calibration printed beside them (how many held-out caps actually land inside).
- **Farm economics** — per row: plan size, expected drop (5% airdrop pool, farmer's share of
  plan size over 2% of TVL, capped at 0.5% of the pool), gas for six transactions, a 2% annual
  capital charge, net dollars, dollars per hour, and a verdict: FARM / MARGINAL / SKIP.

No protocol name is special-cased. The board covers the whole watchlist (40 protocols) plus
every other rankable pre-token protocol in the snapshot (196 rows). Live-token protocols are
set aside with their market caps shown, never mixed into the ranking. Wrapped, staked and
bridged products are set aside too, by the snapshot's own rule: their token already trades in
another form (WBTC is Bitcoin on Ethereum, Binance staked ETH is ETH in a staking product), so
they are not protocols awaiting a launch of their own. The ledger accounts for all 758
protocols in the snapshot, each in exactly one group.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

Node 22 or later, standard library only, no network. The run is deterministic: two runs write
the same bytes. Outputs land in `out/`: `board.json`, `data.js`, `dashboard/`, `screenshots/`,
`dossier.json`.

## Layout

- `main.ts` — the entrypoint: reads the snapshot, builds the board, writes the outputs.
- `lib/model.ts` — the fitted model: snapshot parsing, the size curve and its two-test term
  selection, the launch-odds logistic fit, honest ranges, and the ledger.
- `lib/farm.ts` — the farm plans and their quantified economics: concrete steps with costs
  and times, derived per category, chain, TVL and age.
- `lib/board.ts` — board assembly, gate validation, and the dashboard's dataset.
- `dashboard/` — the static page (index.html, app.css, app.js). No network.
- `vendor/makefun-board.ts` — make.fun's dossier library, copied byte for byte from the kit.
- `screenshots/` — three renders of the dashboard: the board, a detail view, a filtered view.

Implied values are this entry's own claim, computed from the snapshot's figures; they are not
a price and not a promise that any protocol issues a token.

Ref: 9hts85as
