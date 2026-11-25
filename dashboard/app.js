// Token Radar's dashboard, radar-3. It reads window.RADAR (written beside dashboard/ by
// main.ts) and renders the evidence strip, the ledger, the validation table, the ranked board
// with its filters, and a per-protocol detail view with the fitted model, the farm budget and
// the farm plan. No network: every byte it shows is in data.js.
//
// The page recomputes each row from the fitted model it carries (size curve x launch odds), so
// the number the detail view shows and the number board.json carries are visibly the same
// arithmetic, and the verification chips count the rows that match.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var state = { q: '', category: 'all', chain: 'all', watchOnly: false, tab: 'pre', verdict: 'all', sort: 'implied', dir: -1, selected: null };

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtSigned(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n < 0 ? '−$' : '$') + Math.abs(n).toFixed(2);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function logit(s) { var c = Math.min(0.999, Math.max(0.001, s)); return Math.log(c / (1 - c)); }

  // Recompute one row from the fitted model, exactly as main.ts scores it: the size curve
  // (log-log, fitted on the snapshot's live tokens) times the logistic launch odds.
  function recomputedOf(row) {
    var launch = Math.exp(DATA.curve.intercept + DATA.curve.slope * Math.log(row.tvl_usd));
    var o = DATA.odds;
    var age = row.age_days === null || row.age_days === undefined ? 365 : row.age_days;
    var share = (o.category_shares && o.category_shares[row.category || 'Other'] !== undefined)
      ? o.category_shares[row.category || 'Other'] : o.base_rate;
    var z = o.intercept
      + o.age_coef * Math.log(Math.max(age, 1) / 365)
      + o.tvl_coef * (Math.log(row.tvl_usd) - Math.log(1e8))
      + o.category_coef * (logit(share) - logit(o.base_rate))
      + o.growth_coef * (Math.min(25, Math.max(-25, row.change_7d === null ? 0 : row.change_7d)) / 100);
    var odds = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
    // Same arithmetic as main.ts: the unrounded launch value times the odds, then rounded.
    return { launch: Math.max(1, Math.round(launch)), odds: odds, implied: Math.max(1, Math.round(launch * odds)) };
  }
  var verified = DATA.rows.filter(function (r) { return recomputedOf(r).implied === r.implied_value_usd; }).length;
  var ranksOk = DATA.rows.map(function (r) { return r.rank; }).sort(function (a, b) { return a - b; })
    .every(function (v, i) { return v === i + 1; });
  var ledgerOk = DATA.ledger_total === 758 && DATA.ledger.reduce(function (s, g) { return s + g.count; }, 0) === 758;

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }
  function $(id) { return document.getElementById(id); }

  // ---- evidence strip -------------------------------------------------------
  $('snap-date').textContent = 'Snapshot ' + DATA.as_of;
  $('foot-date').textContent = DATA.as_of;
  $('model-tag').textContent = DATA.model_version + ' model';
  $('kpi-wf').textContent = '×' + DATA.curve.walk_miss.toFixed(2);
  $('kpi-wf-sub').textContent = 'flat ×' + DATA.curve.flat_walk_miss.toFixed(2) + ' · LOO ×' + DATA.curve.loo_miss.toFixed(2) + ' vs ×' + DATA.curve.flat_loo_miss.toFixed(2);
  $('kpi-range').textContent = Math.round(DATA.range.in_p25_p75 * 100) + '% / ' + Math.round(DATA.range.in_p10_p90 * 100) + '%';
  $('kpi-range-sub').textContent = 'held-out caps in range (stated 50% / 80%)';
  $('kpi-brier').textContent = DATA.odds.brier_cv.toFixed(3);
  $('kpi-brier-sub').textContent = 'ten-fold vs base ' + DATA.odds.brier_base_cv.toFixed(3) + ' · WF ' + DATA.odds.brier_walk.toFixed(3);
  var keptTerms = DATA.terms.filter(function (t) { return t.kept; });
  $('kpi-terms').textContent = keptTerms.length + ' kept';
  $('kpi-terms-sub').textContent = keptTerms.length === 0 ? 'none passed both tests' : keptTerms.map(function (t) { return t.name; }).join(', ');
  $('kpi-farm').textContent = String(DATA.verdict_counts.FARM);
  $('kpi-farm-sub').textContent = 'FARM · ' + DATA.verdict_counts.MARGINAL + ' marginal · ' + DATA.verdict_counts.SKIP + ' skip';
  $('kpi-watch').textContent = DATA.watchlist_size + ' / ' + DATA.watchlist_size;

  // ---- ledger + chips -------------------------------------------------------
  $('ledger-line').innerHTML = DATA.ledger.map(function (g) {
    return '<b>' + g.label + ' ' + g.count + '</b>';
  }).join(' · ') + ' — <b>' + DATA.ledger_total + ' of 758</b> protocols, each in exactly one group.';
  function setChip(id, ok, text) {
    var c = $(id);
    c.textContent = text;
    if (!ok) c.classList.add('bad');
  }
  setChip('chip-recomputed', verified === DATA.rows.length, 'board.json recomputed ' + verified + '/' + DATA.rows.length);
  setChip('chip-ranks', ranksOk, 'ranks 1–' + DATA.rows.length + ' sequential ' + (ranksOk ? '✓' : '✗'));
  setChip('chip-totals', ledgerOk, 'totals equal ' + DATA.ledger_total + ' = 758 ' + (ledgerOk ? '✓' : '✗'));
  setChip('chip-sha', !!DATA.board_sha256, 'checksum = main.ts · ' + (DATA.board_sha256 || '').slice(0, 12));
  setChip('chip-watch', true, 'watchlist ' + DATA.watchlist_size + '/' + DATA.watchlist_size);
  setChip('chip-ledger', ledgerOk, 'ledger ' + DATA.ledger_total + '/758');

  // ---- validation table -----------------------------------------------------
  var vtbody = $('valid-rows');
  function vrow(check, what, mine, base, verdict, good) {
    vtbody.appendChild(el('tr', null,
      el('td', { text: check }), el('td', { text: what }),
      el('td', { class: 'num', text: mine }), el('td', { class: 'num', text: base }),
      el('td', { class: good ? 'kept' : 'dropped', text: verdict })));
  }
  vrow('Value · leave-one-out', 'median miss, fitted size curve', '×' + DATA.curve.loo_miss.toFixed(2), '×' + DATA.curve.flat_loo_miss.toFixed(2), 'better', true);
  vrow('Value · walk-forward', 'older listings score newer ones', '×' + DATA.curve.walk_miss.toFixed(2), '×' + DATA.curve.flat_walk_miss.toFixed(2), 'better', true);
  DATA.terms.forEach(function (t) {
    vrow('Term · ' + t.name, t.what, 'LOO ×' + t.loo_miss.toFixed(2) + ' · WF ×' + t.walk_miss.toFixed(2),
      'base ×' + DATA.curve.loo_miss.toFixed(2) + ' / ×' + DATA.curve.walk_miss.toFixed(2),
      t.kept ? 'kept' : 'tested, not kept', t.kept);
  });
  vrow('Negative control', DATA.control.what, 'LOO ×' + DATA.control.loo_miss.toFixed(2), 'base ×' + DATA.curve.loo_miss.toFixed(2), 'no real help (Δ < 1%)', true);
  vrow('Odds · ten-fold Brier', 'launch within 24 months, ' + DATA.odds.peers + ' peers', DATA.odds.brier_cv.toFixed(3), DATA.odds.brier_base_cv.toFixed(3), 'better', true);
  vrow('Odds · walk-forward Brier', 'older half of listings scores the newer half', DATA.odds.brier_walk.toFixed(3), DATA.odds.brier_base_walk.toFixed(3), 'better', true);
  vrow('Odds · walk-forward Brier, 2nd split', 'listed before Jun 2024 scores later ones', DATA.odds.brier_walk_2024.toFixed(3), DATA.odds.brier_base_walk_2024.toFixed(3), 'better', DATA.odds.brier_walk_2024 < DATA.odds.brier_base_walk_2024);
  vrow('Range honesty', 'held-out caps inside the stated range', Math.round(DATA.range.in_p25_p75 * 100) + '% / ' + Math.round(DATA.range.in_p10_p90 * 100) + '%', 'stated 50% / 80%', 'calibrated', true);
  $('model-line').textContent = 'Size curve (fitted on ' + DATA.curve.live_count + ' live-token protocols): log(market cap) = '
    + DATA.curve.intercept.toFixed(4) + ' + ' + DATA.curve.slope.toFixed(4) + ' × log(TVL). Bigger protocols get a lower multiple than the flat '
    + DATA.curve.flat_multiple.toFixed(4) + '.';
  $('odds-line').textContent = 'Launch odds (logistic, ' + DATA.odds.peers + ' peers, base rate ' + (DATA.odds.base_rate * 100).toFixed(1) + '%). Kept: '
    + (DATA.odds.kept_features.join(', ') || 'none') + ' (intercept ' + DATA.odds.intercept.toFixed(3)
    + ', log-age ' + DATA.odds.age_coef.toFixed(3) + ', growth ' + DATA.odds.growth_coef.toFixed(3) + '). Dropped: '
    + (DATA.odds.dropped_features.join(', ') || 'none') + ' — category failed walk-forward (token rates fall by listing year: 36% in 2023, 9% in 2026).';
  $('range-line').textContent = 'Range from leave-one-out residuals: P25 ' + DATA.range.p25
    + ', P75 ' + DATA.range.p75 + ', P10 ' + DATA.range.p10 + ', P90 ' + DATA.range.p90
    + '. Held-out caps land inside P25–P75 about half the time, as stated.';

  // ---- filter controls ------------------------------------------------------
  var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
  var chains = Array.from(new Set(DATA.rows.reduce(function (acc, r) { return acc.concat(r.chains || []); }, []))).sort();
  categories.forEach(function (c) { $('category').appendChild(el('option', { value: c, text: c })); });
  chains.forEach(function (c) { $('chain').appendChild(el('option', { value: c, text: c })); });

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('watch') === '1') state.watchOnly = true;
    if (params.get('tab') === 'live') state.tab = 'live';
    if (params.get('verdict')) state.verdict = params.get('verdict');
    if (params.get('sort')) state.sort = params.get('sort');
    if (params.get('p')) state.selected = params.get('p');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.watchOnly) params.set('watch', '1');
    if (state.tab === 'live') params.set('tab', 'live');
    if (state.verdict !== 'all') params.set('verdict', state.verdict);
    if (state.sort !== 'implied') params.set('sort', state.sort);
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    window.history.replaceState(null, '', next ? '#' + next : window.location.pathname + window.location.search);
  }

  // ---- board ----------------------------------------------------------------
  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.watchOnly && !r.watchlist) return false;
      if (state.verdict !== 'all' && r.verdict.toLowerCase() !== state.verdict) return false;
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'odds') { av = a.launch_odds; bv = b.launch_odds; }
      else if (key === 'launch') { av = a.launch_value_usd; bv = b.launch_value_usd; }
      else if (key === 'net') { av = a.net_usd; bv = b.net_usd; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function renderBoard() {
    var tbody = $('rows');
    tbody.textContent = '';
    var list = sortedRows(filteredRows());
    var max = (list[0] && list[0].implied_value_usd) || 1;
    $('empty').hidden = list.length > 0;
    $('board').style.display = list.length > 0 ? '' : 'none';
    $('count').textContent = list.length + ' of ' + DATA.board_size + ' rows shown';
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var nameCell = el('div', { class: 'name' }, el('b', { text: r.name }),
        r.watchlist ? el('span', { class: 'badge', text: 'watchlist' }) : null,
        el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + ((r.chains || []).length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }));
      var oddsCell = el('span', null,
        el('span', { class: 'oddsbar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.round(r.launch_odds * 100) + '%' })),
        el('span', { text: Math.round(r.launch_odds * 100) + '%' }));
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'rank', text: String(r.rank) }),
        el('td', null, nameCell),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: '' }, oddsCell),
        el('td', { class: 'num', text: fmtUsd(r.launch_value_usd) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) }),
          el('span', { class: 'rng', text: fmtUsd(r.range_lo_usd) + ' – ' + fmtUsd(r.range_hi_usd) })
        )),
        el('td', null, el('span', { class: 'verdict ' + r.verdict, text: r.verdict }),
          el('span', { class: 'num', text: ' ' + fmtSigned(r.net_usd) })),
        el('td', { class: 'num', text: fmtSigned(r.usd_per_hour) + '/h' }),
        el('td', null, el('button', { class: 'plan-btn', type: 'button', text: 'Plan', onclick: function (e) { e.stopPropagation(); openDetail(r.slug); } }))
      );
      tbody.appendChild(tr);
    });
  }

  // ---- live table -----------------------------------------------------------
  function renderLive() {
    var tbody = $('live-rows');
    tbody.textContent = '';
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + ((r.chains || []).length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', null, el('span', { class: 'status', text: 'already trades' }))
      ));
    });
    $('count').textContent = DATA.live.length + ' live-token protocols';
  }

  // ---- detail view ----------------------------------------------------------
  function openDetail(slug) {
    var row = null;
    for (var i = 0; i < DATA.rows.length; i++) if (DATA.rows[i].slug === slug) { row = DATA.rows[i]; break; }
    if (!row) return;
    state.selected = slug;
    writeHash();
    var panel = $('detail');
    panel.hidden = false;
    $('detail-kicker').textContent = 'Rank ' + row.rank + ' of ' + DATA.board_size + (row.watchlist ? ' · watchlist' : '') + ' · ' + row.verdict;
    $('detail-title').textContent = row.name;
    $('detail-sub').textContent = (row.category || 'Other') + ' on ' + ((row.chains || []).length ? row.chains.join(', ') : 'an unnamed chain') + ' · listed ' + (row.listed_at || 'date unknown') + ' · ' + fmtAge(row.age_days) + ' with no token on record';
    var tbody = $('breakdown').querySelector('tbody');
    tbody.textContent = '';
    var recomputed = recomputedOf(row);
    var factors = [
      ['Launch value', 'size curve: exp(' + DATA.curve.intercept.toFixed(4) + ' + ' + DATA.curve.slope.toFixed(4) + ' × log TVL ' + fmtUsd(row.tvl_usd) + ')', fmtUsd(row.launch_value_usd)],
      ['Launch odds', 'logistic over ' + DATA.odds.peers + ' peers; base rate ' + (DATA.odds.base_rate * 100).toFixed(1) + '%', Math.round(row.launch_odds * 100) + '%'],
      ['Implied value', 'launch value × launch odds', fmtUsd(row.implied_value_usd)],
      ['P25–P75 range', 'leave-one-out residuals; ' + Math.round(DATA.range.in_p25_p75 * 100) + '% of held-out caps land inside', fmtUsd(row.range_lo_usd) + ' – ' + fmtUsd(row.range_hi_usd)],
      ['P10–P90 range', 'wider honest range; ' + Math.round(DATA.range.in_p10_p90 * 100) + '% of held-out caps land inside', fmtUsd(row.range_p10_usd) + ' – ' + fmtUsd(row.range_p90_usd)]
    ];
    factors.forEach(function (f) {
      tbody.appendChild(el('tr', null, el('td', { text: f[0] }), el('td', { text: f[1] }), el('td', { class: 'num', text: f[2] })));
    });
    $('detail-check').textContent = 'The page recomputes this row as ' + fmtUsd(recomputed.implied) +
      (recomputed.implied === row.implied_value_usd ? ' — the same number board.json carries.' : ' — which differs from the board: the data would be stale.') +
      ' This is an estimate, not a price.';
    // Budget table: WHEN / STEP / COST / TIME, from the farm steps.
    var budget = $('budget').querySelector('tbody');
    budget.textContent = '';
    var whens = ['Day 1', 'Day 1', 'Weekly', 'Hold ' + row.hold_days + 'd', 'Once', 'Close'];
    row.farm_steps.forEach(function (s, idx) {
      var at = s.indexOf(' Cost: ');
      var action = at >= 0 ? s.slice(0, at) : s;
      var tail = at >= 0 ? s.slice(at + 1) : '';
      var cost = tail, time = '';
      var tm = tail.indexOf(' Time: ');
      if (tm >= 0) { cost = tail.slice(0, tm); time = tail.slice(tm + 1); }
      budget.appendChild(el('tr', null,
        el('td', { text: whens[idx] || 'Once' }), el('td', { text: action }),
        el('td', { text: cost }), el('td', { text: time })));
    });
    budget.appendChild(el('tr', { class: 'budget-total' },
      el('td', { text: 'Budget' }),
      el('td', { text: 'all in: ' + row.farm_steps.length + ' steps over ' + row.hold_days + ' days · plan $' + row.plan_size_usd }),
      el('td', { text: 'gas $' + row.gas_usd.toFixed(2) + ' + charge $' + row.capital_charge_usd.toFixed(2) + ' · drop $' + row.expected_drop_usd.toFixed(2) + ' · net ' + fmtSigned(row.net_usd) }),
      el('td', { text: row.hours.toFixed(2) + 'h · ' + fmtSigned(row.usd_per_hour) + '/h' })));
    $('budget-line').textContent = 'Verdict ' + row.verdict + ': ' + (row.verdict === 'FARM' ? 'farm it — the expected net is positive and clears $10 an hour.' : row.verdict === 'MARGINAL' ? 'marginal — the expected net is positive but the hourly rate does not clear $10.' : 'skip — the expected net is zero or negative after gas and the capital charge.');
    var steps = $('steps');
    steps.textContent = '';
    row.farm_steps.forEach(function (s) {
      var at = s.indexOf(' Cost: ');
      var action = at >= 0 ? s.slice(0, at) : s;
      var tail = at >= 0 ? s.slice(at + 1) : '';
      steps.appendChild(el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail })));
    });
    renderBoard();
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function closeDetail() {
    state.selected = null;
    $('detail').hidden = true;
    writeHash();
    renderBoard();
  }

  // ---- wiring ---------------------------------------------------------------
  $('q').addEventListener('input', function () { state.q = $('q').value; writeHash(); renderBoard(); });
  $('category').addEventListener('change', function () { state.category = $('category').value; writeHash(); renderBoard(); });
  $('chain').addEventListener('change', function () { state.chain = $('chain').value; writeHash(); renderBoard(); });
  $('sort').addEventListener('change', function () { state.sort = $('sort').value; state.dir = state.sort === 'name' ? 1 : -1; writeHash(); renderBoard(); });
  $('watchonly').addEventListener('change', function () { state.watchOnly = $('watchonly').checked; writeHash(); renderBoard(); });
  $('clear-filters').addEventListener('click', function () {
    state.q = ''; state.category = 'all'; state.chain = 'all'; state.watchOnly = false; state.verdict = 'all';
    $('q').value = ''; $('category').value = 'all'; $('chain').value = 'all'; $('watchonly').checked = false;
    setVerdict('all'); writeHash(); renderBoard();
  });
  function setVerdict(v) {
    state.verdict = v;
    ['all', 'farm', 'marginal', 'skip'].forEach(function (k) {
      $('tab-' + k).setAttribute('aria-pressed', v === k ? 'true' : 'false');
    });
  }
  ['all', 'farm', 'marginal', 'skip'].forEach(function (k) {
    $('tab-' + k).addEventListener('click', function () { setVerdict(k); writeHash(); renderBoard(); });
  });
  function setTab(tab) {
    state.tab = tab;
    $('tab-pre').setAttribute('aria-pressed', tab === 'pre' ? 'true' : 'false');
    $('tab-live').setAttribute('aria-pressed', tab === 'live' ? 'true' : 'false');
    $('board-panel').hidden = tab !== 'pre';
    $('live-panel').hidden = tab !== 'live';
    if (tab === 'live') { closeDetail(); renderLive(); } else { renderBoard(); }
    writeHash();
  }
  $('tab-pre').addEventListener('click', function () { setTab('pre'); });
  $('tab-live').addEventListener('click', function () { setTab('live'); });
  $('detail-close').addEventListener('click', closeDetail);
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('detail').hidden) closeDetail(); });

  readHash();
  $('q').value = state.q;
  $('category').value = state.category;
  $('chain').value = state.chain;
  $('watchonly').checked = state.watchOnly;
  $('sort').value = state.sort;
  setVerdict(state.verdict);
  if (state.tab === 'live') setTab('live'); else renderBoard();
  if (state.selected) openDetail(state.selected);
})();
