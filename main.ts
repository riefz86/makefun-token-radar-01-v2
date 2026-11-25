// A token-radar-01 entry, radar-3 (Node 22, standard library only).
//
// The program reads the sealed snapshot from /input/snapshot.json (or --input <file|dir>), fits
// the radar-3 model from the snapshot's own figures — a log-log size curve over the live-token
// protocols, launch odds from a logistic fit over the stand-alone peers, honest ranges from the
// size curve's leave-one-out residuals, and quantified farm economics per row — scores every
// rankable pre-token protocol into the ranked board, and writes the outputs the gate reads:
//
//   /output/board.json    the ranked board (watchlist + the whole early radar)
//   /output/data.js       the dashboard's dataset, beside the page
//   /output/dashboard/    a copy of this repository's dashboard/
//   /output/screenshots/  a copy of this repository's screenshots/
//   /output/dossier.json  the judge's dossier, built by the vendored make.fun library
//
// The dashboard is a static page, no framework and no network: dashboard/index.html, app.css and
// app.js read /output/data.js. Every row carries its launch value, its launch odds, its implied
// value with a P25–P75 range, and a farm plan with quantified economics, so the page and
// board.json are the same numbers. The run is deterministic: the same snapshot bytes always
// write the same output bytes.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSnapshot } from './lib/model.ts';
import { boardIssue, buildRadar, dataScript } from './lib/board.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar, curve, terms, odds, range } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}
if (radar.ledger_total !== snapshot.protocols.length) {
  process.stderr.write(`token radar: the ledger sums to ${radar.ledger_total}, not ${snapshot.protocols.length}: a protocol is in no group or in two\n`);
  process.exit(1);
}
const unclassified = radar.ledger.find((g) => g.key === 'Unclassified');
if (unclassified !== undefined && unclassified.count !== 0) {
  process.stderr.write(`token radar: the ledger leaves ${unclassified.count} protocols unclassified\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
const boardText = `${JSON.stringify({ rows: board })}\n`;
writeFileSync(join(out, 'board.json'), boardText);
// The dashboard's checksum chip names the board.json bytes it was built from.
radar.board_sha256 = createHash('sha256').update(boardText, 'utf8').digest('hex');
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const dashboardFiles = copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
// A re-run must not keep stale files from an earlier run: clear the copied directories first.
rmSync(join(out, 'screenshots'), { recursive: true, force: true });
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

const kept = terms.filter((t) => t.kept).map((t) => t.name);
process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: size curve log(mcap) = ${curve.intercept} + ${curve.slope} * log(TVL) from ${curve.live_count} live; LOO miss x${curve.loo_miss} vs flat x${curve.flat_loo_miss}; walk-forward x${curve.walk_miss} vs flat x${curve.flat_walk_miss}\n` +
    `token radar: terms kept: ${kept.length === 0 ? 'none — log-age, log-chains, growth and category all failed at least one of the two tests' : kept.join(', ')}\n` +
    `token radar: odds Brier ten-fold ${odds.brier_cv} vs base ${odds.brier_base_cv}; walk-forward ${odds.brier_walk} vs base ${odds.brier_base_walk}; base rate ${odds.base_rate} over ${odds.peers} peers\n` +
    `token radar: range P25–P75 holds ${Math.round(range.in_p25_p75 * 100)}% of held-out caps (stated 50%), P10–P90 holds ${Math.round(range.in_p10_p90 * 100)}% (stated 80%)\n` +
    `token radar: verdicts FARM ${radar.verdict_counts.FARM}, MARGINAL ${radar.verdict_counts.MARGINAL}, SKIP ${radar.verdict_counts.SKIP}; ledger ${radar.ledger_total}/${snapshot.protocols.length}\n` +
    `token radar: rank 1 ${board[0]!.slug} at $${board[0]!.implied_value_usd.toLocaleString('en-US')} (launch $${board[0]!.launch_value_usd.toLocaleString('en-US')} x odds ${board[0]!.launch_odds}); board sha256 ${radar.board_sha256.slice(0, 12)}\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (${dashboardFiles.length} files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
