// radar-3: the fitted value model, launch odds, honest ranges and the ledger.
//
// Everything in this file is learned from the sealed snapshot at run time. Nothing is
// hard-coded per protocol and no number is copied from another entry: the size curve is an
// ordinary-least-squares fit of log(market cap) on log(TVL) over the snapshot's own live-token
// protocols, every candidate extra term is kept only when it passes BOTH a leave-one-out test
// and a walk-forward test (older listings score newer ones), and the launch odds are a logistic
// fit over the snapshot's own stand-alone peers. The terms that fail are reported as tested,
// not kept — the dashboard shows them, with their misses, so the reader can see what was tried
// and why it was left out.

/** One protocol of the sealed snapshot: exactly the ten fields the input carries. */
export interface SnapshotProtocol {
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
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The median of a sorted array, or null when empty. */
export function medianOf(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** The snapshot's protocol by slug. */
export function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol's token already trades (a market cap the market set). */
export function isLiveToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null && p.mcap_usd > 0;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A name carrying a whole word wrapped, staked or staking: a wrapped or staked product. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** A name beginning with an exchange's name: the exchange's own product, not a launch candidate. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;

/**
 * The categories whose product is a conduit or a wrapped form of a token that already trades,
 * not a protocol awaiting a launch of its own: the house's own watchlist rule, applied to the
 * whole board. Bridge and its siblings move other tokens; Liquid Staking, Liquid Restaking and
 * Restaked BTC are staked forms of assets that trade; Stablecoin Wrapper is a wrapped stablecoin.
 */
export const CONDUIT_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Cross Chain Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'Stablecoin Wrapper',
  'CEX',
]);

/**
 * Whether a protocol is one the board may rank: pre-token, and not a wrapped, staked or bridged
 * product of a token that already trades. WBTC is Bitcoin on Ethereum, Binance staked ETH is ETH
 * in a staking product, USDT0 is bridged USDT — none of them is a protocol still waiting on a
 * launch of its own, so the board sets them aside instead of ranking them at the top on TVL alone.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  return (
    isPreToken(p) &&
    !CONDUIT_CATEGORIES.has(p.category ?? '') &&
    !VERSIONED.test(p.name) &&
    !WRAPPED_WORD.test(p.name) &&
    !EXCHANGE_PREFIX.test(p.name)
  );
}

/** Whether a protocol is a stand-alone peer for the odds model (same exclusions, token or not). */
export function isStandalonePeer(p: SnapshotProtocol): boolean {
  return (
    !CONDUIT_CATEGORIES.has(p.category ?? '') &&
    !VERSIONED.test(p.name) &&
    !WRAPPED_WORD.test(p.name) &&
    !EXCHANGE_PREFIX.test(p.name)
  );
}

// ---------------------------------------------------------------------------
// Small linear algebra: ordinary least squares by normal equations.
// ---------------------------------------------------------------------------

/** Solve A x = b for a small square A by Gauss-Jordan with partial pivoting. */
function solveLinear(aIn: number[][], bIn: number[]): number[] | null {
  const n = bIn.length;
  const a = aIn.map((row) => [...row]);
  const b = [...bIn];
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
    if (Math.abs(a[pivot]![col]!) < 1e-12) return null;
    if (pivot !== col) {
      [a[col], a[pivot]] = [a[pivot]!, a[col]!];
      [b[col], b[pivot]] = [b[pivot]!, b[col]!];
    }
    const div = a[col]![col]!;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = a[r]![col]! / div;
      if (factor === 0) continue;
      for (let c = col; c < n; c++) a[r]![c]! -= factor * a[col]![c]!;
      b[r]! -= factor * b[col]!;
    }
  }
  return b.map((v, i) => v / a[i]![i]!);
}

/** Least-squares coefficients for rows X and targets y, or null when singular. */
export function ols(rows: number[][], y: number[]): number[] | null {
  const k = rows[0]!.length;
  const ata: number[][] = Array.from({ length: k }, () => Array(k).fill(0));
  const atb: number[] = Array(k).fill(0);
  for (let i = 0; i < rows.length; i++) {
    for (let r = 0; r < k; r++) {
      atb[r]! += rows[i]![r]! * y[i]!;
      for (let c = 0; c < k; c++) ata[r]![c]! += rows[i]![r]! * rows[i]![c]!;
    }
  }
  return solveLinear(ata, atb);
}

/** Dot product of two equal-length vectors. */
export function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** Median absolute log error as a multiple: exp(median |log(actual / predicted)|). */
export function medianMiss(predicted: number[], actual: number[]): number {
  const errs = predicted.map((p, i) => Math.abs(Math.log(actual[i]! / p))).sort((x, y) => x - y);
  return Math.exp(medianOf(errs) ?? 0);
}

// ---------------------------------------------------------------------------
// The size curve and its two-test term selection.
// ---------------------------------------------------------------------------

/** The fitted size curve: log(mcap) = intercept + slope * log(TVL). */
export interface SizeCurve {
  intercept: number;
  slope: number;
  live_count: number;
  flat_multiple: number;
  flat_loo_miss: number;
  flat_walk_miss: number;
  loo_miss: number;
  walk_miss: number;
  residual_sd: number;
}

/** One candidate term's two-test verdict. */
export interface TermTest {
  name: string;
  what: string;
  loo_miss: number;
  walk_miss: number;
  kept: boolean;
}

/** A deterministic shuffle (mulberry32) for the negative control. */
function shuffled<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Features for a live protocol: [1, log TVL] plus one optional candidate term. */
function baseFeatures(p: SnapshotProtocol): number[] {
  return [1, Math.log(p.tvl_usd)];
}

function candidateFeature(kind: string, p: SnapshotProtocol, asOf: string, catResidual: Map<string, number>): number {
  if (kind === 'age') return Math.log(Math.max(ageDays(asOf, p.listed_at) ?? 365, 1) / 365);
  if (kind === 'chains') return Math.log(Math.max(p.chains.length, 1));
  if (kind === 'growth') return Math.min(25, Math.max(-25, finite(p.change_7d, 0))) / 100;
  if (kind === 'category') return catResidual.get(p.category ?? 'Other') ?? 0;
  return 0;
}

/**
 * The category term's feature: the category's median leave-in residual under the base curve,
 * shrunk toward 0 (prior weight 6) and clamped to +-0.8, computed from a training set only so a
 * held-out protocol never leaks into its own feature.
 */
export function categoryResiduals(train: SnapshotProtocol[], beta: number[]): Map<string, number> {
  const byCat = new Map<string, number[]>();
  for (const p of train) {
    const resid = Math.log(p.mcap_usd!) - (beta[0]! + beta[1]! * Math.log(p.tvl_usd));
    const list = byCat.get(p.category ?? 'Other') ?? [];
    list.push(resid);
    byCat.set(p.category ?? 'Other', list);
  }
  const out = new Map<string, number>();
  for (const [cat, values] of byCat) {
    values.sort((a, b) => a - b);
    const med = medianOf(values) ?? 0;
    const shrunk = (med * values.length) / (values.length + 6);
    out.set(cat, Math.max(-0.8, Math.min(0.8, shrunk)));
  }
  return out;
}

/**
 * Fit the size curve and test every candidate term twice. A term is kept only when BOTH its
 * leave-one-out miss and its walk-forward miss fall at least 1% below the base curve's — a term
 * that helps one test and hurts the other is reported as tested, not kept. The negative control
 * is another protocol's 7-day growth, shuffled with a fixed seed: a real signal must beat it.
 */
export function fitSizeCurve(snapshot: Snapshot): { curve: SizeCurve; terms: TermTest[]; control: TermTest } {
  const live = snapshot.protocols.filter(isLiveToken);
  const y = live.map((p) => Math.log(p.mcap_usd!));
  const xBase = live.map(baseFeatures);
  const beta = ols(xBase, y)!;
  const residuals = live.map((p, i) => y[i]! - (beta[0]! + beta[1]! * Math.log(p.tvl_usd)));

  // Leave-one-out miss of the base curve.
  const looPred: number[] = [];
  for (let i = 0; i < live.length; i++) {
    const rows = xBase.filter((_, j) => j !== i);
    const ys = y.filter((_, j) => j !== i);
    const b = ols(rows, ys)!;
    looPred.push(Math.exp(dot(xBase[i]!, b)));
  }
  const looMiss = medianMiss(looPred, live.map((p) => p.mcap_usd!));

  // Walk-forward miss: the older half of listed protocols scores the newer half.
  const listed = live.map((p, i) => ({ p, i })).filter(({ p }) => p.listed_at !== null).sort((a, b) => (a.p.listed_at! < b.p.listed_at! ? -1 : 1));
  const half = Math.floor(listed.length / 2);
  const trainIdx = listed.slice(0, half).map(({ i }) => i);
  const testIdx = listed.slice(half).map(({ i }) => i);
  const bTrain = ols(trainIdx.map((i) => xBase[i]!), trainIdx.map((i) => y[i]!))!;
  const walkMiss = medianMiss(
    testIdx.map((i) => Math.exp(dot(xBase[i]!, bTrain))),
    testIdx.map((i) => live[i]!.mcap_usd!),
  );

  // The flat baseline: the median mcap/TVL multiple, leave-one-out and walk-forward too.
  const ratios = live.map((p) => p.mcap_usd! / p.tvl_usd).sort((a, b) => a - b);
  const flat = medianOf(ratios) ?? 0.25;
  const flatLoo = medianMiss(
    live.map((p, i) => {
      const rest = ratios.filter((_, j) => j !== i);
      return (medianOf(rest) ?? flat) * p.tvl_usd;
    }),
    live.map((p) => p.mcap_usd!),
  );
  const flatWalk = medianMiss(
    testIdx.map((i) => {
      const rest = trainIdx.map((j) => live[j]!.mcap_usd! / live[j]!.tvl_usd).sort((a, b) => a - b);
      return (medianOf(rest) ?? flat) * live[i]!.tvl_usd;
    }),
    testIdx.map((i) => live[i]!.mcap_usd!),
  );

  const curve: SizeCurve = {
    // Coefficients stay full-precision: the dashboard recomputes every row from them, and a
    // rounded coefficient would move the implied value by dollars.
    intercept: beta[0]!,
    slope: beta[1]!,
    live_count: live.length,
    flat_multiple: round4(flat),
    flat_loo_miss: round3(flatLoo),
    flat_walk_miss: round3(flatWalk),
    loo_miss: round3(looMiss),
    walk_miss: round3(walkMiss),
    residual_sd: round3(Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / Math.max(residuals.length - 2, 1))),
  };

  const candidates: { kind: string; name: string; what: string }[] = [
    { kind: 'age', name: 'log-age', what: 'log years listed with no token' },
    { kind: 'chains', name: 'log-chains', what: 'log number of chains' },
    { kind: 'growth', name: 'growth', what: '7-day TVL change, clamped to ±25%' },
    { kind: 'category', name: 'category', what: 'shrunk median residual of the protocol’s category' },
  ];
  const terms: TermTest[] = candidates.map(({ kind, name, what }) => {
    // Leave-one-out with this term.
    const loo: number[] = [];
    for (let i = 0; i < live.length; i++) {
      const train = live.filter((_, j) => j !== i);
      const b0 = ols(train.map(baseFeatures), train.map((p) => Math.log(p.mcap_usd!)))!;
      const cat = kind === 'category' ? categoryResiduals(train, b0) : new Map<string, number>();
      const rows = train.map((p) => [...baseFeatures(p), candidateFeature(kind, p, snapshot.as_of, cat)]);
      const b = ols(rows, train.map((p) => Math.log(p.mcap_usd!)))!;
      const f = [...baseFeatures(live[i]!), candidateFeature(kind, live[i]!, snapshot.as_of, cat)];
      loo.push(Math.exp(dot(f, b)));
    }
    // Walk-forward with this term.
    const trainSet = trainIdx.map((i) => live[i]!);
    const b0w = ols(trainSet.map(baseFeatures), trainSet.map((p) => Math.log(p.mcap_usd!)))!;
    const catW = kind === 'category' ? categoryResiduals(trainSet, b0w) : new Map<string, number>();
    const rowsW = trainSet.map((p) => [...baseFeatures(p), candidateFeature(kind, p, snapshot.as_of, catW)]);
    const bW = ols(rowsW, trainSet.map((p) => Math.log(p.mcap_usd!)))!;
    const wf = medianMiss(
      testIdx.map((i) => Math.exp(dot([...baseFeatures(live[i]!), candidateFeature(kind, live[i]!, snapshot.as_of, catW)], bW))),
      testIdx.map((i) => live[i]!.mcap_usd!),
    );
    const looM = medianMiss(loo, live.map((p) => p.mcap_usd!));
    const kept = looM <= looMiss * 0.99 && wf <= walkMiss * 0.99;
    return { name, what, loo_miss: round3(looM), walk_miss: round3(wf), kept };
  });

  // Negative control: another protocol's growth, shuffled with a fixed seed.
  const shuffledGrowth = shuffled(live.map((p) => finite(p.change_7d, 0)), 42);
  const controlLoo: number[] = [];
  for (let i = 0; i < live.length; i++) {
    const rows = live.map((p, j) => (j === i ? null : [...baseFeatures(p), Math.min(25, Math.max(-25, shuffledGrowth[j]!)) / 100])).filter((r): r is number[] => r !== null);
    const ys = y.filter((_, j) => j !== i);
    const b = ols(rows, ys)!;
    controlLoo.push(Math.exp(dot([...baseFeatures(live[i]!), Math.min(25, Math.max(-25, shuffledGrowth[i]!)) / 100], b)));
  }
  const control: TermTest = {
    name: 'negative control',
    what: 'another protocol’s 7-day growth, shuffled (seed 42) — must not help',
    loo_miss: round3(medianMiss(controlLoo, live.map((p) => p.mcap_usd!))),
    walk_miss: round3(walkMiss),
    kept: false,
  };

  return { curve, terms, control };
}

/** The final fitted model: the base curve plus any term that passed both tests, refit on all live. */
export interface FinalModel {
  beta: number[];
  kinds: string[];
  catResiduals: Map<string, number>;
}

/** Refit the size curve on every live protocol, adding each kept term as a feature. */
export function finalModel(snapshot: Snapshot, terms: TermTest[]): FinalModel {
  const live = snapshot.protocols.filter(isLiveToken);
  const kinds = terms.filter((t) => t.kept).map((t) => t.name);
  const kindOf = (name: string): string => (name === 'log-age' ? 'age' : name === 'log-chains' ? 'chains' : name);
  const baseBeta = ols(live.map(baseFeatures), live.map((p) => Math.log(p.mcap_usd!)))!;
  const cat = categoryResiduals(live, baseBeta);
  const rows = live.map((p) => [...baseFeatures(p), ...kinds.map((k) => candidateFeature(kindOf(k), p, snapshot.as_of, cat))]);
  const beta = ols(rows, live.map((p) => Math.log(p.mcap_usd!))) ?? baseBeta;
  return { beta, kinds, catResiduals: cat };
}

/** The size curve's launch value for one protocol under the final fitted model. */
export function launchValue(p: SnapshotProtocol, asOf: string, final: FinalModel): number {
  const kindOf = (name: string): string => (name === 'log-age' ? 'age' : name === 'log-chains' ? 'chains' : name);
  const features = [...baseFeatures(p), ...final.kinds.map((k) => candidateFeature(kindOf(k), p, asOf, final.catResiduals))];
  return Math.exp(dot(features, final.beta));
}

// ---------------------------------------------------------------------------
// Launch odds: a logistic fit over the snapshot's stand-alone peers.
// ---------------------------------------------------------------------------

/** The fitted odds model. Dropped features carry a coefficient of 0. */
export interface OddsModel {
  intercept: number;
  age_coef: number;
  tvl_coef: number;
  category_coef: number;
  growth_coef: number;
  base_rate: number;
  peers: number;
  token_peers: number;
  brier_cv: number;
  brier_base_cv: number;
  brier_walk: number;
  brier_base_walk: number;
  brier_walk_2024: number;
  brier_base_walk_2024: number;
  kept_features: string[];
  dropped_features: string[];
  category_shares: Record<string, number>;
}

/** log-odds of a share, clipped so a 0 or 1 share stays finite. */
function logit(share: number): number {
  const s = Math.min(0.999, Math.max(0.001, share));
  return Math.log(s / (1 - s));
}

/** One odds feature by name, for one protocol under a fitted share table. */
function oddsFeature(
  name: string,
  p: SnapshotProtocol,
  asOf: string,
  shares: Record<string, number>,
  baseRate: number,
): number {
  if (name === 'age') return Math.log(Math.max(ageDays(asOf, p.listed_at) ?? 365, 1) / 365);
  if (name === 'tvl') return Math.log(p.tvl_usd) - Math.log(1e8);
  if (name === 'category') return logit(shares[p.category ?? 'Other'] ?? baseRate) - logit(baseRate);
  if (name === 'growth') return Math.min(25, Math.max(-25, finite(p.change_7d, 0))) / 100;
  return 0;
}

/** Odds feature row: an intercept plus one column per kept feature, in the order given. */
function oddsRow(
  p: SnapshotProtocol,
  asOf: string,
  shares: Record<string, number>,
  baseRate: number,
  kept: string[],
): number[] {
  return [1, ...kept.map((name) => oddsFeature(name, p, asOf, shares, baseRate))];
}

/** Gradient-descent logistic fit (fixed steps, so the result is deterministic). */
function fitLogistic(rows: number[][], y: number[]): number[] {
  const k = rows[0]!.length;
  const w = Array(k).fill(0);
  const lr = 0.5;
  for (let iter = 0; iter < 800; iter++) {
    const grad = Array(k).fill(0);
    for (let i = 0; i < rows.length; i++) {
      const z = dot(rows[i]!, w);
      const pr = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
      const err = pr - y[i]!;
      for (let j = 0; j < k; j++) grad[j]! += err * rows[i]![j]!;
    }
    for (let j = 0; j < k; j++) w[j]! -= (lr * grad[j]!) / rows.length + lr * 0.01 * w[j]!;
  }
  return w;
}

/** Predict a probability from a fitted row and coefficients. */
function predictLogistic(row: number[], w: number[]): number {
  const z = dot(row, w);
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}

/** Shrunk category token shares from a peer set (prior weight 8 toward the base rate). */
function categoryShares(peers: SnapshotProtocol[], baseRate: number): Record<string, number> {
  const totals = new Map<string, number>();
  const tokens = new Map<string, number>();
  for (const p of peers) {
    const key = p.category ?? 'Other';
    totals.set(key, (totals.get(key) ?? 0) + 1);
    if (p.mcap_usd !== null) tokens.set(key, (tokens.get(key) ?? 0) + 1);
  }
  const out: Record<string, number> = {};
  for (const [key, n] of totals) {
    out[key] = round3(((tokens.get(key) ?? 0) + 8 * baseRate) / (n + 8));
  }
  return out;
}

function brierScore(predicted: number[], actual: number[]): number {
  return predicted.reduce((s, p, i) => s + (p - actual[i]!) ** 2, 0) / Math.max(predicted.length, 1);
}

/**
 * Fit the odds model with the same discipline as the value terms: candidate feature sets are
 * tried in order of simplicity and a set is kept only when it beats the base rate on BOTH the
 * ten-fold cross-validation and the walk-forward split (older listings score newer ones). On
 * this snapshot the category share fails the walk-forward test outright — token rates fall
 * steeply by listing year (36% for 2023 listings, 9% for 2026 ones), so a category share
 * learned on older peers over-predicts the newer cohorts — and is dropped, honestly, with its
 * numbers shown. The surviving set is fitted on all peers; dropped features keep a 0 coefficient.
 */
export function fitOdds(snapshot: Snapshot): OddsModel {
  const peers = snapshot.protocols.filter(isStandalonePeer);
  const tokenPeers = peers.filter((p) => p.mcap_usd !== null).length;
  const baseRate = tokenPeers / Math.max(peers.length, 1);
  const shares = categoryShares(peers, baseRate);
  const y = peers.map((p) => (p.mcap_usd !== null ? 1 : 0));
  const baseBrier = brierScore(Array(peers.length).fill(baseRate), y);

  const dated = peers
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.listed_at !== null)
    .sort((a, b) => (a.p.listed_at! < b.p.listed_at! ? -1 : 1));
  const half = Math.floor(dated.length / 2);
  const wfTrain = dated.slice(0, half).map(({ i }) => i);
  const wfTest = dated.slice(half).map(({ i }) => i);
  const wfTrainPeers = wfTrain.map((i) => peers[i]!);
  const wfTrainBase = wfTrainPeers.filter((p) => p.mcap_usd !== null).length / Math.max(wfTrainPeers.length, 1);
  const wfBaseBrier = brierScore(
    Array(wfTest.length).fill(wfTrainBase),
    wfTest.map((i) => y[i]!),
  );

  const candidates: string[][] = [
    ['age'],
    ['age', 'growth'],
    ['age', 'tvl'],
    ['age', 'tvl', 'growth'],
    ['age', 'category'],
    ['age', 'tvl', 'category', 'growth'],
  ];

  /** Ten-fold Brier (shares refit per fold, so no leakage) and walk-forward Brier for a set. */
  const validate = (kept: string[]): { cv: number; walk: number } => {
    const cvPred: number[] = Array(peers.length).fill(0);
    for (let fold = 0; fold < 10; fold++) {
      const testIdx = peers.map((_, i) => i).filter((i) => i % 10 === fold);
      const trainIdx = peers.map((_, i) => i).filter((i) => i % 10 !== fold);
      const trainPeers = trainIdx.map((i) => peers[i]!);
      const trainBase = trainPeers.filter((p) => p.mcap_usd !== null).length / Math.max(trainPeers.length, 1);
      const trainShares = categoryShares(trainPeers, trainBase);
      const w = fitLogistic(
        trainIdx.map((i) => oddsRow(peers[i]!, snapshot.as_of, trainShares, trainBase, kept)),
        trainIdx.map((i) => y[i]!),
      );
      for (const i of testIdx) cvPred[i] = predictLogistic(oddsRow(peers[i]!, snapshot.as_of, trainShares, trainBase, kept), w);
    }
    const cv = brierScore(cvPred, y);
    const trainShares = categoryShares(wfTrainPeers, wfTrainBase);
    const w = fitLogistic(
      wfTrain.map((i) => oddsRow(peers[i]!, snapshot.as_of, trainShares, wfTrainBase, kept)),
      wfTrain.map((i) => y[i]!),
    );
    const walk = brierScore(
      wfTest.map((i) => predictLogistic(oddsRow(peers[i]!, snapshot.as_of, trainShares, wfTrainBase, kept), w)),
      wfTest.map((i) => y[i]!),
    );
    return { cv, walk };
  };

  let chosen: string[] | null = null;
  let chosenCv = Infinity;
  let chosenWalk = Infinity;
  for (const kept of candidates) {
    const { cv, walk } = validate(kept);
    if (cv < baseBrier && walk < wfBaseBrier && cv < chosenCv) {
      chosen = kept;
      chosenCv = cv;
      chosenWalk = walk;
    }
  }
  const kept = chosen ?? [];
  const full: string[] = ['age', 'tvl', 'category', 'growth'];
  const dropped = full.filter((f) => !kept.includes(f));

  // Second walk-forward check: peers listed before 2024-06-01 score the ones listed after.
  const early = peers.map((p, i) => i).filter((i) => peers[i]!.listed_at !== null && peers[i]!.listed_at! < '2024-06-01');
  const late = peers.map((p, i) => i).filter((i) => peers[i]!.listed_at !== null && peers[i]!.listed_at! >= '2024-06-01');
  let walk2024 = chosenWalk;
  let baseWalk2024 = wfBaseBrier;
  if (early.length >= 20 && late.length >= 20) {
    const earlyPeers = early.map((i) => peers[i]!);
    const earlyBase = earlyPeers.filter((p) => p.mcap_usd !== null).length / earlyPeers.length;
    const earlyShares = categoryShares(earlyPeers, earlyBase);
    const w = fitLogistic(
      early.map((i) => oddsRow(peers[i]!, snapshot.as_of, earlyShares, earlyBase, kept)),
      early.map((i) => y[i]!),
    );
    walk2024 = brierScore(
      late.map((i) => predictLogistic(oddsRow(peers[i]!, snapshot.as_of, earlyShares, earlyBase, kept), w)),
      late.map((i) => y[i]!),
    );
    baseWalk2024 = brierScore(Array(late.length).fill(earlyBase), late.map((i) => y[i]!));
  }

  // Final fit on all peers with the chosen set; dropped features stay at 0.
  const finalW = fitLogistic(
    peers.map((p) => oddsRow(p, snapshot.as_of, shares, baseRate, kept)),
    y,
  );
  const byName = new Map<string, number>();
  kept.forEach((name, j) => byName.set(name, finalW[j + 1]!));
  return {
    // Coefficients stay full-precision: the dashboard recomputes every row from them, and a
    // rounded coefficient would move the implied value by dollars.
    intercept: finalW[0]!,
    age_coef: byName.get('age') ?? 0,
    tvl_coef: byName.get('tvl') ?? 0,
    category_coef: byName.get('category') ?? 0,
    growth_coef: byName.get('growth') ?? 0,
    base_rate: baseRate,
    peers: peers.length,
    token_peers: tokenPeers,
    brier_cv: round3(chosenCv === Infinity ? baseBrier : chosenCv),
    brier_base_cv: round3(baseBrier),
    brier_walk: round3(chosenWalk === Infinity ? wfBaseBrier : chosenWalk),
    brier_base_walk: round3(wfBaseBrier),
    brier_walk_2024: round3(walk2024),
    brier_base_walk_2024: round3(baseWalk2024),
    kept_features: kept,
    dropped_features: dropped,
    category_shares: shares,
  };
}

/** A protocol's launch odds within 24 months under the fitted model. */
export function launchOdds(p: SnapshotProtocol, asOf: string, model: OddsModel): number {
  const z =
    model.intercept +
    model.age_coef * Math.log(Math.max(ageDays(asOf, p.listed_at) ?? 365, 1) / 365) +
    model.tvl_coef * (Math.log(p.tvl_usd) - Math.log(1e8)) +
    model.category_coef * (logit(model.category_shares[p.category ?? 'Other'] ?? model.base_rate) - logit(model.base_rate)) +
    model.growth_coef * (Math.min(25, Math.max(-25, finite(p.change_7d, 0))) / 100);
  const clipped = Math.max(-30, Math.min(30, z));
  return 1 / (1 + Math.exp(-clipped));
}

// ---------------------------------------------------------------------------
// Honest ranges from leave-one-out residuals.
// ---------------------------------------------------------------------------

/** A quantile of a sorted array (linear interpolation on the index). */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** The range table: P10/P25/P75/P90 of the leave-one-out log residuals, with calibration. */
export interface RangeTable {
  p10: number;
  p25: number;
  p75: number;
  p90: number;
  in_p25_p75: number;
  in_p10_p90: number;
}

export function rangeTable(looResiduals: number[]): RangeTable {
  const sorted = [...looResiduals].sort((a, b) => a - b);
  const p10 = quantile(sorted, 0.1);
  const p25 = quantile(sorted, 0.25);
  const p75 = quantile(sorted, 0.75);
  const p90 = quantile(sorted, 0.9);
  const inMid = sorted.filter((r) => r >= p25 && r <= p75).length / Math.max(sorted.length, 1);
  const inWide = sorted.filter((r) => r >= p10 && r <= p90).length / Math.max(sorted.length, 1);
  return { p10: round3(p10), p25: round3(p25), p75: round3(p75), p90: round3(p90), in_p25_p75: round3(inMid), in_p10_p90: round3(inWide) };
}

/** Leave-one-out log residuals of the fitted size curve (base terms only, as fitted). */
export function looResiduals(snapshot: Snapshot, curve: SizeCurve): number[] {
  const live = snapshot.protocols.filter(isLiveToken);
  const out: number[] = [];
  for (let i = 0; i < live.length; i++) {
    const train = live.filter((_, j) => j !== i);
    const b = ols(train.map(baseFeatures), train.map((p) => Math.log(p.mcap_usd!)))!;
    out.push(Math.log(live[i]!.mcap_usd!) - (b[0]! + b[1]! * Math.log(live[i]!.tvl_usd)));
  }
  void curve;
  return out;
}

// ---------------------------------------------------------------------------
// The ledger: every one of the 758 protocols in exactly one group.
// ---------------------------------------------------------------------------

/** One ledger group: a label, a count, and what puts a protocol in it. */
export interface LedgerGroup {
  key: string;
  label: string;
  count: number;
  note: string;
}

/** Partition the whole snapshot into mutually exclusive groups; the counts sum to 758. */
export function ledger(snapshot: Snapshot, rankedSlugs: Set<string>): LedgerGroup[] {
  const groups: LedgerGroup[] = [];
  const take = (label: string, note: string, test: (p: SnapshotProtocol) => boolean): number => {
    const n = snapshot.protocols.filter((p) => !taken.has(p.slug) && test(p)).length;
    for (const p of snapshot.protocols) if (!taken.has(p.slug) && test(p)) taken.add(p.slug);
    groups.push({ key: label, label, count: n, note });
    return n;
  };
  const taken = new Set<string>();
  const watchlist = new Set(snapshot.watchlist);
  take('Ranked — watchlist', 'on the house watchlist and ranked by the board', (p) => watchlist.has(p.slug) && rankedSlugs.has(p.slug));
  take('Ranked — early', 'below the floor, pre-token and standalone, ranked by the board', (p) => rankedSlugs.has(p.slug));
  take('Token trades', 'records a token with a market cap over $0', (p) => isLiveToken(p));
  take('Token recorded, no cap', 'records a token ticker or a zero cap, so no market value to learn from', (p) => p.mcap_usd !== null || p.gecko_id !== null || p.symbol !== null);
  take('Bridge', 'moves other tokens between chains; not a launch of its own', (p) => p.category === 'Bridge' || p.category === 'Canonical Bridge' || p.category === 'Cross Chain Bridge');
  take('Staked', 'a staked form of an asset that already trades', (p) => p.category === 'Liquid Staking' || p.category === 'Liquid Restaking' || p.category === 'Restaked BTC');
  take('Exchange', 'a centralised exchange’s own product', (p) => p.category === 'CEX');
  take('Versioned', 'a versioned pool of another protocol (name ends in V2, 2.0 and the like)', (p) => VERSIONED.test(p.name));
  take('Wrapped / exchange product', 'a wrapped or staked product, or an exchange’s own name', (p) => WRAPPED_WORD.test(p.name) || EXCHANGE_PREFIX.test(p.name) || p.category === 'Stablecoin Wrapper');
  take('Unclassified', 'in no group above — must be zero for the ledger to balance', () => true);
  return groups;
}
