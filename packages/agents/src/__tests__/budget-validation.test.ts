import { describe, expect, it } from 'vitest';
import { money, type TripPlan } from '@trip/shared';
import { assessBudget, describeBudget, validatePlan, validatePlans } from '../index.js';
import { constraintsFor, intent, profile, realPlans } from './kit.js';

/**
 * The deterministic services: the budget position is arithmetic, and the
 * validation gate is written against the trip rather than against the engine's
 * own reasoning.
 */

const cheapest = (plans: TripPlan[]) => plans[0]!;

describe('Budget / Optimisation Service', () => {
  it('has no opinion when there is no budget', async () => {
    const { plans, constraints } = await realPlans();
    const a = assessBudget(cheapest(plans), constraints);
    expect(a.status).toBe('no_budget');
    expect(a.consistent).toBe(true);
    expect(describeBudget(a)).toMatch(/No budget was set/);
  });

  it('says a plan is within budget only when its counted total is', async () => {
    const { plans, constraints } = await realPlans({ budget: { total: 500_000 } });
    const a = assessBudget(cheapest(plans), constraints);
    expect(a.status).toBe('within');
    expect(a.headroom!.amount + a.total.amount).toBe(a.budget!.amount);
    expect(describeBudget(a)).toMatch(/within your budget/);
  });

  it('calls a plan over a guide budget over it, and says it is only a guide', async () => {
    const { plans, constraints } = await realPlans({ budget: { total: 10_000, firm: false } });
    const a = assessBudget(cheapest(plans), constraints);
    expect(a.status).toBe('over_guide');
    expect(a.overBy!.amount).toBe(a.total.amount - 1_000_000);
    expect(describeBudget(a)).toMatch(/over your budget/);
    expect(describeBudget(a)).toMatch(/is a guide/);
    expect(describeBudget(a)).not.toMatch(/within your budget/);
  });

  it('calls a plan over a firm limit over it, never within', async () => {
    const { plans, constraints } = await realPlans({ budget: { total: 10_000, firm: true } });
    // A firm limit filters what cannot fit; anything left that is over is over_firm.
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) {
      const a = assessBudget(plan, constraints);
      expect(['over_firm', 'within']).toContain(a.status);
      if (a.total.amount > 1_000_000) {
        expect(a.status).toBe('over_firm');
        expect(describeBudget(a)).toMatch(/does not meet it/);
      }
    }
  });

  it('remembers that the traveller agreed to go over a firm limit', async () => {
    const { plans, constraints } = await realPlans({ budget: { total: 10_000, firm: true } });
    const waived = { ...constraints, waivers: [{ kind: 'max_total_budget' as const, waivedAt: '2030-01-01T00:00:00.000Z', reason: 'test' }] };
    const over = { ...cheapest(plans), cost: { ...cheapest(plans).cost, total: money(50_000, 'INR') } };
    expect(assessBudget(over, waived).status).toBe('over_firm_waived');
  });

  it('never lets "within budget" hide a cost that is not in the total', async () => {
    const { plans, constraints } = await realPlans({ budget: { total: 500_000 } });
    const plan = { ...cheapest(plans), cost: { ...cheapest(plans).cost, notIncluded: [{ label: 'Tolls', reason: 'no source can price them' }] } };
    const a = assessBudget(plan, constraints);
    expect(a.status).toBe('within');
    expect(a.complete).toBe(false);
    expect(describeBudget(a)).toMatch(/does not include: Tolls/);
  });

  it('notices when the parts of a cost do not add up to the total', async () => {
    const { plans, constraints } = await realPlans();
    const plan = cheapest(plans);
    const tampered = { ...plan, cost: { ...plan.cost, total: money(1, 'INR') } };
    expect(assessBudget(tampered, constraints).consistent).toBe(false);
  });

  it('is deterministic: the same plan and constraints always give the same answer', async () => {
    const { plans, constraints } = await realPlans({ budget: { total: 10_000 } });
    expect(assessBudget(cheapest(plans), constraints)).toEqual(assessBudget(cheapest(plans), constraints));
  });
});

describe('Validation Service', () => {
  it('passes plans the engine built correctly', async () => {
    const { plans, intent: i, profile: p, constraints } = await realPlans();
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) expect(validatePlan(plan, { intent: i, profile: p, constraints, plans })).toEqual([]);
    const report = validatePlans({ intent: i, profile: p, constraints, plans });
    expect(report.anyValid).toBe(true);
    expect(report.results.every((r) => r.valid)).toBe(true);
  });

  const broken = async (mutate: (plan: TripPlan) => TripPlan, options = {}) => {
    const built = await realPlans(options);
    const plan = mutate(structuredClone(built.plans[0]!));
    return {
      issues: validatePlan(plan, { intent: built.intent, profile: built.profile, constraints: built.constraints, plans: [plan] }),
      plan,
      built,
    };
  };
  const codes = (issues: Array<{ code: string }>) => issues.map((i) => i.code);

  it('catches a journey on the wrong date', async () => {
    const { issues } = await broken((p) => {
      p.outboundTransport!.segments[0]!.departureAt = '2030-11-11T08:00:00';
      return p;
    });
    expect(codes(issues)).toContain('validation.outbound_date');
    expect(issues[0]!.severity).toBe('blocker');
  });

  it('catches a stay that is not for the trip', async () => {
    const { issues } = await broken((p) => {
      p.hotels[0]!.checkIn = '2030-11-12';
      p.hotels[0]!.nights = 7;
      return p;
    });
    expect(codes(issues)).toEqual(expect.arrayContaining(['validation.stay_dates', 'validation.stay_nights']));
  });

  it('catches rooms that cannot hold the party', async () => {
    const { issues } = await broken((p) => {
      p.hotels[0]!.room.maxOccupancy = 1;
      p.hotels[0]!.rooms = 1;
      return p;
    });
    expect(codes(issues)).toContain('validation.stay_capacity');
  });

  it('catches a price in another currency', async () => {
    const { issues } = await broken((p) => {
      p.outboundTransport!.totalPrice = { amount: 100, currency: 'USD' };
      return p;
    });
    expect(codes(issues)).toContain('validation.currency');
  });

  it('catches a total that does not add up, and costs that do not match their parts', async () => {
    const { issues } = await broken((p) => {
      p.cost.total = money(1, 'INR');
      p.cost.accommodation = money(1, 'INR');
      p.cost.transport = money(1, 'INR');
      return p;
    });
    expect(codes(issues)).toEqual(expect.arrayContaining(['validation.cost_sum', 'validation.cost_stay', 'validation.cost_transport']));
  });

  it('catches a budget that is misreported', async () => {
    const { issues } = await broken(
      (p) => {
        p.cost.remainingBudget = money(999_999, 'INR');
        return p;
      },
      { budget: { total: 500_000 } },
    );
    expect(codes(issues)).toContain('validation.budget_misreported');
  });

  it('blocks a plan over a firm limit even if the engine had not', async () => {
    const built = await realPlans({ budget: { total: 500_000, firm: true } });
    const plan = structuredClone(built.plans[0]!);
    plan.issues = plan.issues.filter((i) => i.code !== 'budget_exceeded');
    // Same plan, judged against a much lower firm limit.
    const tight = constraintsFor(built.profile, built.intent, { total: 5_000, firm: true });
    const issues = validatePlan(plan, { intent: built.intent, profile: built.profile, constraints: tight, plans: [plan] });
    expect(codes(issues)).toContain('validation.budget_firm');
  });

  it('catches overlapping and backwards items in the itinerary', async () => {
    const { issues } = await broken((p) => {
      const items = p.days.flatMap((d) => d.items).filter((i) => i.kind !== 'rest');
      const [a, b] = items;
      b!.startUtc = a!.startUtc;
      a!.endUtc = a!.startUtc;
      return p;
    });
    expect(codes(issues)).toEqual(expect.arrayContaining(['validation.item_duration']));
  });

  it('catches a mode the traveller ruled out', async () => {
    const built = await realPlans();
    const plan = structuredClone(built.plans[0]!);
    const p = profile({ priorities: ['cheapest'] });
    p.transport.excludedModes = ['flight'];
    const constraints = constraintsFor(p, built.intent);
    const issues = validatePlan(plan, { intent: built.intent, profile: p, constraints, plans: [plan] });
    expect(codes(issues)).toContain('validation.excluded_mode');
  });

  it('requires a kept part to come through unchanged', async () => {
    const first = await realPlans();
    const previous = first.plans[0]!;
    const other = first.plans.find((p) => p.hotels[0]!.hotel.id !== previous.hotels[0]!.hotel.id);
    expect(other).toBeDefined();
    const issues = validatePlan(other!, {
      intent: first.intent,
      profile: first.profile,
      constraints: first.constraints,
      plans: [other!],
      kept: { hotel: previous.hotels[0]! },
    });
    expect(codes(issues)).toContain('validation.pin_not_preserved');
    expect(issues.find((i) => i.code === 'validation.pin_not_preserved')!.message).toMatch(/keep the hotel/);
    // And the same plan passes when the kept part is the one it has.
    expect(validatePlan(previous, { intent: first.intent, profile: first.profile, constraints: first.constraints, plans: [previous], kept: { hotel: previous.hotels[0]! } })).toEqual([]);
  });

  it('marks a failing plan, ranks it last, and never removes or edits it', async () => {
    const built = await realPlans();
    const [good, ...rest] = built.plans;
    const bad = structuredClone(rest[0] ?? good!);
    bad.id = 'tampered';
    bad.cost.total = money(1, 'INR');
    const report = validatePlans({ intent: built.intent, profile: built.profile, constraints: built.constraints, plans: [bad, good!] });

    expect(report.plans).toHaveLength(2);
    expect(report.anyValid).toBe(true);
    expect(report.plans[0]!.id).toBe(good!.id);
    const marked = report.plans.find((p) => p.id === 'tampered')!;
    expect(marked.issues.some((i) => i.code === 'validation.cost_sum' && i.severity === 'blocker')).toBe(true);
    // The traveller-visible numbers are untouched: validation marks, it does not repair.
    expect(marked.cost.total.amount).toBe(100);
    expect(report.results.find((r) => r.planId === 'tampered')!.valid).toBe(false);
  });

  it('reports that no plan is valid when none is', async () => {
    const built = await realPlans();
    const bad = structuredClone(built.plans[0]!);
    bad.cost.total = money(1, 'INR');
    expect(validatePlans({ intent: built.intent, profile: built.profile, constraints: built.constraints, plans: [bad] }).anyValid).toBe(false);
  });

  it('checks a one-way trip has no return leg', async () => {
    const built = await realPlans({ intent: intent({ returnDate: null }) });
    const plan = structuredClone(built.plans[0]!);
    plan.returnTransport = built.plans[0]!.outboundTransport;
    const issues = validatePlan(plan, { intent: built.intent, profile: built.profile, constraints: built.constraints, plans: [plan] });
    expect(codes(issues)).toContain('validation.return_unexpected');
  });
});
