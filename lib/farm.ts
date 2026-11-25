// A protocol's farm plan: concrete steps with what they cost and how long they take, plus the
// quantified economics of farming it.
//
// Every step is derived from the protocol's own record — its category, its chains, its TVL and
// its age — never from a hand-written list of names. The economics are stated as assumptions on
// the page, not hidden: the airdrop pool is 5% of the implied value, the farmer's share of that
// pool is the plan size over 2% of the protocol's TVL (capped at 0.5% of the pool), gas is six
// transactions on the protocol's first chain, and locked capital is charged 2% a year over the
// hold. Net dollars and dollars per hour follow from those inputs, and the verdict follows from
// the net: FARM when the net is positive and the hourly rate clears $10, MARGINAL when the net
// is positive but the hourly rate does not, SKIP when the net is zero or negative.

import type { SnapshotProtocol } from './model.ts';

/** One farm step before it is flattened to a string: action, cost and time. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
export function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** What one transaction costs on a chain, in dollars, from the chain's own fee market. */
export function gasPerTx(chain: string): number {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 6.5;
  if (c === 'solana') return 0.01;
  if (c === 'bsc' || c === 'bnb chain' || c === 'binance') return 0.3;
  if (c === 'avalanche') return 0.6;
  if (c === 'polygon') return 0.12;
  if (c === 'fantom' || c === 'gnosis' || c === 'celo' || c === 'moonbeam') return 0.25;
  if (
    c === 'base' ||
    c === 'arbitrum' ||
    c === 'optimism' ||
    c === 'blast' ||
    c === 'linea' ||
    c === 'scroll' ||
    c === 'mantle' ||
    c === 'mode' ||
    c === 'zksync' ||
    c === 'zksync era' ||
    c === 'taiko' ||
    c === 'fraxtal'
  ) {
    return 0.2;
  }
  return 1.0;
}

/** The gas figure in words, for a step's cost line. */
export function gasWords(chain: string): string {
  const g = gasPerTx(chain);
  if (g >= 5) return '$4–$9';
  if (g >= 0.5) return '$0.50–$2';
  if (g >= 0.2) return '$0.15–$0.50';
  if (g >= 0.1) return '$0.05–$0.20';
  return 'about $0.01';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
export function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 500;
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
export function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The economics of one farm: every input the verdict is built from. */
export interface FarmEconomics {
  plan_size_usd: number;
  hold_days: number;
  gas_usd: number;
  capital_charge_usd: number;
  expected_drop_usd: number;
  net_usd: number;
  hours: number;
  usd_per_hour: number;
  verdict: 'FARM' | 'MARGINAL' | 'SKIP';
}

/** The farm's stated parameters, printed on the page beside the verdicts. */
export const FARM_PARAMS = {
  drop_pool_share: 0.05,
  competing_tvl_share: 0.02,
  farmer_share_cap: 0.005,
  transactions: 6,
  capital_charge_rate: 0.02,
  farm_hourly_threshold: 10,
} as const;

/**
 * The quantified economics of farming one protocol at one implied value. The drop pool is 5% of
 * the implied value; the farmer's share of it is the plan size over 2% of the protocol's TVL,
 * capped at 0.5% of the pool; gas is six transactions on the first chain; the capital charge is
 * 2% a year on the plan size over the hold. Hours are the setup, one short weekly action per
 * week of the hold, and the unwind.
 */
export function farmEconomics(p: SnapshotProtocol, impliedValue: number, age: number | null): FarmEconomics {
  const plan = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = FARM_PARAMS.transactions * gasPerTx(chainOf(p));
  const charge = plan * FARM_PARAMS.capital_charge_rate * (hold / 365);
  const share = Math.min(plan / Math.max(p.tvl_usd * FARM_PARAMS.competing_tvl_share, 1), FARM_PARAMS.farmer_share_cap);
  const expectedDrop = FARM_PARAMS.drop_pool_share * impliedValue * share;
  const net = expectedDrop - gas - charge;
  const hours = 0.5 + 0.17 * Math.ceil(hold / 7) + 0.25;
  const perHour = net / hours;
  const verdict: FarmEconomics['verdict'] = net > 0 && perHour >= FARM_PARAMS.farm_hourly_threshold ? 'FARM' : net > 0 ? 'MARGINAL' : 'SKIP';
  const r2 = (n: number): number => Math.round(n * 100) / 100;
  return {
    plan_size_usd: plan,
    hold_days: hold,
    gas_usd: r2(gas),
    capital_charge_usd: r2(charge),
    expected_drop_usd: r2(expectedDrop),
    net_usd: r2(net),
    hours: r2(hours),
    usd_per_hour: r2(perHour),
    verdict,
  };
}

/**
 * The category's main action, in words a farmer can follow. The match order matters: the most
 * specific category first, the generic deposit last. Nothing here names a protocol.
 */
export function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Supply $${capital} of USDC to ${name} on ${chain}, then borrow $20 of USDC against it and repay the loan a week later.`;
  }
  if (c.includes('dex')) {
    return `Provide $${capital} of liquidity to ${name}'s largest USDC pool on ${chain} and keep the LP position open.`;
  }
  if (c.includes('yield aggregator') || c.includes('yield') || c.includes('leveraged farm')) {
    return `Deposit $${capital} of USDC into ${name}'s highest-TVL vault on ${chain} and keep the shares.`;
  }
  if (c.includes('liquidity manager') || c.includes('curator') || c.includes('allocator') || c.includes('risk cur')) {
    return `Deposit $${capital} of USDC into a ${name} vault on ${chain} and keep the vault shares for the full hold.`;
  }
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options') || c.includes('basis trad')) {
    return `Deposit $${capital} of USDC as margin on ${name} on ${chain}, open one small long and one small short, and close them the same day.`;
  }
  if (c.includes('bridge') || c.includes('cross chain')) {
    return `Bridge $${capital} of USDC into ${chain} through ${name}, then use the bridged funds once inside its own app.`;
  }
  if (c.includes('liquid staking') || c.includes('restak') || c.includes('staking pool')) {
    return `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the liquid receipt token.`;
  }
  if (c.includes('rwa')) {
    return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} with USDC and hold it in the farming wallet.`;
  }
  if (c.includes('stable') || c.includes('algo-stables') || c.includes('dual-token')) {
    return `Mint $${capital} of the stable asset through ${name} on ${chain} and hold it, or provide it to its main pool.`;
  }
  if (c.includes('prediction')) {
    return `Fund $${capital} of USDC on ${name} on ${chain} and place one small position in an active market.`;
  }
  if (c.includes('launchpad')) {
    return `Stake $${capital} of USDC in ${name}'s launch pool on ${chain} and join one sale while the stake is live.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active for the full hold.`;
  }
  if (c.includes('payment')) {
    return `Load $${capital} of USDC into ${name} on ${chain} and pay for one real purchase or transfer with it each week.`;
  }
  if (c.includes('nft')) {
    return `List one item or buy the cheapest listed item for $${capital} on ${name} on ${chain}, then hold it.`;
  }
  if (c.includes('governance')) {
    return `Deposit $${capital} of USDC into ${name}'s incentive vault on ${chain} and vote once in its next proposal.`;
  }
  if (c.includes('token locker')) {
    return `Lock $${capital} of USDC in a ${name} locker on ${chain} for the hold period and keep the receipt.`;
  }
  if (c.includes('index')) {
    return `Buy $${capital} of ${name}'s index token on ${chain} and hold it for the full period.`;
  }
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The weekly qualifying action, flavored by category so it reads as a real routine, not a slogan. */
export function weeklyActionFor(p: SnapshotProtocol, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return 'Make one qualifying action each week: adjust the supply, borrow a little and repay it, or vote in governance.';
  }
  if (c.includes('dex') || c.includes('yield') || c.includes('liquidity manager')) {
    return 'Make one qualifying action each week: add or remove a little liquidity, or swap a small amount through the pool.';
  }
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options') || c.includes('basis trad')) {
    return 'Make one qualifying action each week: open and close one small hedge, or add a little margin.';
  }
  if (c.includes('bridge') || c.includes('cross chain')) {
    return `Make one qualifying action each week: bridge a small amount to or from ${chain}, or use the bridged funds in the app.`;
  }
  if (c.includes('liquid staking') || c.includes('restak') || c.includes('staking pool')) {
    return 'Make one qualifying action each week: stake a little more, or use the receipt token in one DeFi position.';
  }
  if (c.includes('prediction')) {
    return 'Make one qualifying action each week: place one small position in a new market.';
  }
  if (c.includes('launchpad')) {
    return 'Make one qualifying action each week: check the live sales and join one while the stake is live.';
  }
  return 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.';
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age), never from a hand-written list of
 * names. A multi-chain protocol gets a second-chain step, because farming two of its chains is a
 * different plan from farming one. The last step states the verdict and the expected net, so the
 * plan and the economics are the same numbers.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, econ: FarmEconomics): FarmStep[] {
  const chain = chainOf(p);
  const capital = econ.plan_size_usd;
  const hold = econ.hold_days;
  const gas = gasWords(chain);
  const second = p.chains.length > 1 ? p.chains[1]! : null;
  const netWords = econ.net_usd >= 0 ? `an expected net of $${econ.net_usd.toFixed(2)}` : `an expected net of −$${Math.abs(econ.net_usd).toFixed(2)}`;
  const steps: FarmStep[] = [
    {
      text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.',
      cost: `${gas} of gas for the first transaction`,
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and about ${gas} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: weeklyActionFor(p, chain),
      cost: `about ${gas} of gas a week`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
  ];
  if (second !== null) {
    steps.push({
      text: `Repeat the main position once on ${second} with $25, so the farm covers two of the protocol's chains.`,
      cost: `$25 of capital and about ${gasWords(second)} of gas`,
      time: '15 minutes, once',
    });
  } else {
    steps.push({
      text: "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.",
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    });
  }
  steps.push({
    text: `Verdict ${econ.verdict}: ${netWords} at $${econ.usd_per_hour.toFixed(2)} an hour over ${econ.hours.toFixed(2)} hours, after $${econ.gas_usd.toFixed(2)} of gas and a $${econ.capital_charge_usd.toFixed(2)} capital charge. Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
    cost: `expected drop $${econ.expected_drop_usd.toFixed(2)}, gas $${econ.gas_usd.toFixed(2)}`,
    time: '5 minutes to log',
  });
  return steps;
}
