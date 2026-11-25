// The ranked board: every rankable pre-token protocol, scored by the fitted radar-3 model,
// sorted, and validated the way the gate will check it. The board is the watchlist plus the
// whole early radar below the floor, never a hand-picked slice of either.
//
// implied = launch value x launch odds, where the launch value is the fitted size curve and the
// odds are the logistic fit over the snapshot's stand-alone peers. The range around it comes
// from the leave-one-out residuals of the size curve, so a row's P25–P75 and P10–P90 are the
// model's own held-out errors, not a guess.

import {
  ageDays,
  bySlug,
  finalModel,
  fitOdds,
  fitSizeCurve,
  isRankable,
  launchOdds,
  launchValue,
  ledger,
  looResiduals,
  rangeTable,
  type FinalModel,
  type LedgerGroup,
  type OddsModel,
  type RangeTable,
  type SizeCurve,
  type Snapshot,
  type TermTest,
} from './model.ts';
import { FARM_PARAMS, farmEconomics, farmSteps, stepText, type FarmEconomics } from './farm.ts';

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  launch_value_usd: number;
  launch_odds: number;
  implied_value_usd: number;
  range_lo_usd: number;
  range_hi_usd: number;
  range_p10_usd: number;
  range_p90_usd: number;
  farm: FarmEconomics;
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with the farm economics inline. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  launch_value_usd: number;
  launch_odds: number;
  implied_value_usd: number;
  range_lo_usd: number;
  range_hi_usd: number;
  range_p10_usd: number;
  range_p90_usd: number;
  verdict: FarmEconomics['verdict'];
  net_usd: number;
  usd_per_hour: number;
  plan_size_usd: number;
  hold_days: number;
  gas_usd: number;
  capital_charge_usd: number;
  expected_drop_usd: number;
  hours: number;
  watchlist: boolean;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the fitted model behind it. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  curve: SizeCurve;
  terms: TermTest[];
  control: TermTest;
  odds: OddsModel;
  range: RangeTable;
  ledger: LedgerGroup[];
  ledger_total: number;
  farm_params: typeof FARM_PARAMS;
  verdict_counts: { FARM: number; MARGINAL: number; SKIP: number };
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  board_sha256: string;
  rows: RadarRow[];
  live: LiveRow[];
}

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 30;

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, final: FinalModel, odds: OddsModel, range: RangeTable): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, (typeof snapshot.protocols)[number]>();
  // The watchlist is the floor: every slug on it, in full — even the one the rankable rule
  // would set aside (Saturn, a Stablecoin Wrapper), because the gate requires full coverage.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other rankable pre-token protocol, not a slice by TVL. A protocol the
  // watchlist leaves out is no worse a subject, so the board carries the whole pre-token universe
  // the snapshot can rank.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => {
    const age = ageDays(snapshot.as_of, p.listed_at);
    const launch = launchValue(p, snapshot.as_of, final);
    const oddsValue = launchOdds(p, snapshot.as_of, odds);
    const implied = Math.max(1, Math.round(launch * oddsValue));
    const econ = farmEconomics(p, implied, age);
    return {
      p,
      age,
      launch: Math.max(1, Math.round(launch)),
      oddsValue,
      implied,
      econ,
    };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token' as const,
    age_days: s.age,
    launch_value_usd: s.launch,
    launch_odds: Math.round(s.oddsValue * 1000) / 1000,
    implied_value_usd: s.implied,
    range_lo_usd: Math.max(1, Math.round(s.implied * Math.exp(range.p25))),
    range_hi_usd: Math.max(1, Math.round(s.implied * Math.exp(range.p75))),
    range_p10_usd: Math.max(1, Math.round(s.implied * Math.exp(range.p10))),
    range_p90_usd: Math.max(1, Math.round(s.implied * Math.exp(range.p90))),
    farm: s.econ,
    farm_steps: farmSteps(s.p, s.age, s.econ).map(stepText),
  }));
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !(p.mcap_usd === null && p.gecko_id === null && p.symbol === null) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js: the same farm plan board.json carries, word for word. */
export function radarRow(row: BoardRow, watchlist: Set<string>): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    listed_at: row.listed_at,
    age_days: row.age_days,
    launch_value_usd: row.launch_value_usd,
    launch_odds: row.launch_odds,
    implied_value_usd: row.implied_value_usd,
    range_lo_usd: row.range_lo_usd,
    range_hi_usd: row.range_hi_usd,
    range_p10_usd: row.range_p10_usd,
    range_p90_usd: row.range_p90_usd,
    verdict: row.farm.verdict,
    net_usd: row.farm.net_usd,
    usd_per_hour: row.farm.usd_per_hour,
    plan_size_usd: row.farm.plan_size_usd,
    hold_days: row.farm.hold_days,
    gas_usd: row.farm.gas_usd,
    capital_charge_usd: row.farm.capital_charge_usd,
    expected_drop_usd: row.farm.expected_drop_usd,
    hours: row.farm.hours,
    watchlist: watchlist.has(row.slug),
    farm_steps: row.farm_steps,
  };
}

/** Fit the model, score the board, and assemble everything the dashboard renders. */
export function buildRadar(
  snapshot: Snapshot,
): { board: BoardRow[]; radar: RadarData; curve: SizeCurve; terms: TermTest[]; odds: OddsModel; range: RangeTable } {
  const { curve, terms, control } = fitSizeCurve(snapshot);
  const final = finalModel(snapshot, terms);
  const odds = fitOdds(snapshot);
  const range = rangeTable(looResiduals(snapshot, curve));
  const board = buildBoard(snapshot, final, odds, range);
  const live = liveRows(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const early = board.filter((r) => !watchlist.has(r.slug)).length;
  const rankedSlugs = new Set(board.map((r) => r.slug));
  const ledgerGroups = ledger(snapshot, rankedSlugs);
  const ledgerTotal = ledgerGroups.reduce((s, g) => s + g.count, 0);
  const verdictCounts = { FARM: 0, MARGINAL: 0, SKIP: 0 };
  for (const r of board) verdictCounts[r.farm.verdict]++;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: 'radar-3',
    curve,
    terms,
    control,
    odds,
    range,
    ledger: ledgerGroups,
    ledger_total: ledgerTotal,
    farm_params: FARM_PARAMS,
    verdict_counts: verdictCounts,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    board_sha256: '', // filled in by main.ts with the sha256 of the board.json bytes it writes
    rows: board.map((r) => radarRow(r, watchlist)),
    live,
  };
  return { board, radar, curve, terms, odds, range };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const seen = new Set<string>();
  for (const r of board) {
    if (seen.has(r.slug)) return `slug ${r.slug} appears twice`;
    seen.add(r.slug);
  }
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.implied_value_usd > 1e14) return `${r.slug} has implied value over the cap`;
    if (r.range_lo_usd > r.implied_value_usd || r.implied_value_usd > r.range_hi_usd) return `${r.slug} has its implied value outside its P25–P75 range`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
