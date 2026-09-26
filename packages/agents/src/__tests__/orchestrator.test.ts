import { describe, expect, it } from 'vitest';
import { generatePlans, type PlanGenerationDeps, type PlanProgress } from '@trip/engine';
import type { ProviderRegistry } from '@trip/providers';
import { emptyRequirements, money, ok, type RequirementsState, type TripPlan } from '@trip/shared';
import { PlanningOrchestrator, engineServices, type OrchestratorInput, type PlanningServices } from '../index.js';
import { classificationFor, constraintsFor, driveOffer, fakeLlm, fakeTravel, hotelOffer, intent, noModel, profile, realPlans, type Fake } from './kit.js';

/**
 * The orchestrator: a fixed workflow over bounded agents and deterministic
 * services. These tests hold it to what it promises: order and control flow
 * are code; a failed agent costs guidance, not the search; an impossible
 * request is said before any provider is called; a plan that fails validation
 * is never presented as workable; kept parts are kept or released with a
 * reason; and nothing an agent says can change a price.
 */

const stated = (soft: RequirementsState['soft'] = [], hard: RequirementsState['hard'] = []): RequirementsState => ({
  ...emptyRequirements(),
  soft,
  hard,
  complete: true,
});

const SOFT = stated([
  { kind: 'preferred_mode', value: 'flight', evidence: 'we like to fly' },
  { kind: 'amenity', value: 'breakfast', evidence: 'with breakfast' },
  { kind: 'activity_interest', value: 'history', evidence: 'love history' },
]);

function inputFor(fake: Fake, overrides: Partial<OrchestratorInput> = {}): { input: OrchestratorInput; fake: Fake } {
  const p = overrides.profile ?? profile({ priorities: ['cheapest'] });
  const tripIntent = overrides.intent ?? intent();
  return {
    fake,
    input: {
      intent: tripIntent,
      profile: p,
      constraints: overrides.constraints ?? constraintsFor(p, tripIntent),
      classification: overrides.classification ?? classificationFor(tripIntent),
      requirements: null,
      ...overrides,
    },
  };
}

const orchestrator = (fake: Fake, llm = noModel(), services?: PlanningServices) =>
  new PlanningOrchestrator({ registry: fake.registry, agents: { llm }, ...(services ? { services } : {}) });

/** Services that run the real engine but let a test look at, or change, what it returns. */
function spying(after?: (result: Awaited<ReturnType<typeof generatePlans>>) => void) {
  const seen: PlanGenerationDeps[] = [];
  const services: PlanningServices = {
    async buildPlans(deps) {
      seen.push(deps);
      const result = await generatePlans(deps);
      after?.(result);
      return result;
    },
  };
  return { services, seen };
}

/**
 * Plans without what is meant to differ between runs: the moment they were made
 * and the random identifier of each itinerary item (and the issues that point at one). Everything else, every price,
 * time, choice and message, must be identical.
 */
const stripTimes = (plans: TripPlan[]) =>
  plans.map(({ generatedAt: _g, days, issues, ...rest }) => ({
    ...rest,
    issues: issues.map(({ itemIds: _ids, ...issue }) => issue),
    days: days.map((d) => ({ ...d, items: d.items.map(({ id: _id, ...item }) => item) })),
  }));
const stages = (r: { trace: Array<{ stage: string }> }) => r.trace.map((t) => t.stage);

describe('the workflow', () => {
  it('runs guidance, search, validation and synthesis in a fixed order and leaves a trace', async () => {
    const fake = fakeTravel();
    const result = await orchestrator(fake).plan(inputFor(fake).input);

    expect(result.status).toBe('planned');
    expect(result.plans.length).toBeGreaterThan(0);
    expect(stages(result)).toEqual([
      'transport_agent', 'accommodation_agent', 'activity_agent', 'guidance', 'plan_search', 'validation', 'synthesis_agent',
    ]);
    expect(result.trace.map((t) => t.kind)).toEqual(['agent', 'agent', 'agent', 'service', 'service', 'service', 'agent']);
    expect(result.narrative.summary).toMatch(/Nothing has been booked or charged/);
    expect(result.validation!.anyValid).toBe(true);
    expect(result.error).toBeNull();
  });

  it('reports progress in order, staying under 100', async () => {
    const fake = fakeTravel();
    const seen: PlanProgress[] = [];
    await orchestrator(fake).plan({ ...inputFor(fake).input, onProgress: (p) => seen.push(p) });
    const steps = [...new Set(seen.map((p) => p.step))];
    expect(steps).toEqual(['guidance', 'classify', 'search', 'hotels', 'assemble', 'rank', 'validate', 'explain']);
    const percents = seen.map((p) => p.percent);
    expect([...percents].sort((a, b) => a - b)).toEqual(percents);
    expect(Math.max(...percents)).toBeLessThan(100);
  });

  it('is deterministic: with no model, the same request gives the same plans, statuses and words', async () => {
    const a = fakeTravel();
    const b = fakeTravel();
    const first = await orchestrator(a).plan(inputFor(a).input);
    const second = await orchestrator(b).plan(inputFor(b).input);
    expect(stripTimes(first.plans)).toEqual(stripTimes(second.plans));
    expect(first.status).toBe(second.status);
    expect(first.narrative.summary).toBe(second.narrative.summary);
    expect(first.trace.map((t) => [t.stage, t.status, t.detail])).toEqual(second.trace.map((t) => [t.stage, t.status, t.detail]));
  });

  it('never lets an agent set a price: a hostile model changes nothing the deterministic side computed', async () => {
    const baseline = fakeTravel();
    const plain = await orchestrator(baseline).plan({ ...inputFor(baseline).input, requirements: SOFT });

    const fake = fakeTravel();
    const { llm } = fakeLlm((call) =>
      call.schemaName === 'plan_explanation'
        ? { summary: 'It will cost ₹1 in total and your booking is confirmed.', plans: [] }
        : { preferredMode: 'flight', modeOrder: ['flight'], area: 'central', amenities: ['breakfast'], interests: ['history'], pace: 'relaxed', reasons: [], price: 1, total: 1, fare: 0, rooms: 99, discount: 100 },
    );
    const hostile = await orchestrator(fake, llm).plan({ ...inputFor(fake).input, requirements: SOFT });

    expect(hostile.plans.map((p) => [p.id, p.cost.total.amount, p.outboundTransport?.totalPrice.amount])).toEqual(
      plain.plans.map((p) => [p.id, p.cost.total.amount, p.outboundTransport?.totalPrice.amount]),
    );
    expect(hostile.narrative.summary).not.toMatch(/₹1 in total|confirmed/);
  });

  it('does not touch a provider itself: only the services do', async () => {
    const explosive = new Proxy({}, { get: () => { throw new Error('the orchestrator must not use the registry'); } }) as unknown as ProviderRegistry;
    const fake = fakeTravel();
    const { services } = spying();
    const orchestratorWithoutRegistry = new PlanningOrchestrator({ registry: explosive, agents: { llm: noModel() }, services: { buildPlans: (deps) => services.buildPlans({ ...deps, registry: fake.registry }) } });
    const result = await orchestratorWithoutRegistry.plan(inputFor(fake).input);
    expect(result.status).toBe('planned');
  });

  it('keeps what the traveller said out of the trace', async () => {
    const fake = fakeTravel();
    const result = await orchestrator(fake).plan({ ...inputFor(fake).input, requirements: SOFT });
    const text = JSON.stringify(result.trace);
    for (const quote of ['we like to fly', 'with breakfast', 'love history']) expect(text).not.toContain(quote);
  });
});

describe('agent failures', () => {
  it('costs guidance, not the search, when a guidance agent is down', async () => {
    const fake = fakeTravel();
    const { llm } = fakeLlm((call) => (call.schemaName === 'transport_guidance' ? new Error('down') : { area: null, amenities: [], interests: [], pace: null, reasons: [] }));
    const result = await orchestrator(fake, llm).plan({ ...inputFor(fake).input, requirements: SOFT });

    expect(result.status).toBe('planned');
    const transport = result.trace.find((t) => t.stage === 'transport_agent')!;
    expect(transport.status).toBe('degraded');
    expect(transport.source).toBe('rules');
    expect(transport.warnings.join(' ')).toMatch(/unavailable/);
  });

  it('still plans when every model call fails', async () => {
    const fake = fakeTravel();
    const { llm } = fakeLlm(() => new Error('down'));
    const result = await orchestrator(fake, llm).plan({ ...inputFor(fake).input, requirements: SOFT });
    expect(result.status).toBe('planned');
    expect(result.narrative.source).toBe('template');
    expect(result.trace.filter((t) => t.kind === 'agent').every((t) => t.status !== 'failed')).toBe(true);
  });

  it('records what an agent proposed and had dropped, without failing', async () => {
    const fake = fakeTravel();
    const { llm } = fakeLlm((call) =>
      call.schemaName === 'accommodation_guidance'
        ? { area: 'central', amenities: ['breakfast', 'spa'], reasons: [] }
        : { preferredMode: null, modeOrder: [], interests: [], pace: null, area: null, amenities: [], reasons: [] },
    );
    const result = await orchestrator(fake, llm).plan({ ...inputFor(fake).input, requirements: SOFT });
    const stay = result.trace.find((t) => t.stage === 'accommodation_agent')!;
    expect(stay.rejected.join(' ')).toMatch(/spa: the traveller did not ask for it/);
    expect(result.applied!.applied.join(' ')).toMatch(/breakfast/);
  });

  it('turns an unusable synthesis into the template explanation, and still succeeds', async () => {
    const fake = fakeTravel();
    const { llm } = fakeLlm((call) => (call.schemaName === 'plan_explanation' ? { summary: 12 } : { preferredMode: null, modeOrder: [], area: null, amenities: [], interests: [], pace: null, reasons: [] }));
    const result = await orchestrator(fake, llm).plan({ ...inputFor(fake).input, requirements: SOFT });
    expect(result.status).toBe('planned');
    expect(result.narrative.source).toBe('template');
    expect(result.trace.find((t) => t.stage === 'synthesis_agent')!.status).toBe('degraded');
  });
});

describe('impossible and conflicting requests', () => {
  it('says so before any provider is called, when the way of travelling asked for is not possible', async () => {
    const fake = fakeTravel();
    const { services, seen } = spying();
    const { llm, calls } = fakeLlm(() => ({}));
    const base = inputFor(fake).input;
    const result = await orchestrator(fake, llm, services).plan({
      ...base,
      classification: { ...base.classification, eligibleModes: ['flight'] },
      requirements: stated([], [{ kind: 'required_mode', value: 'train', evidence: 'only by train' }]),
    });

    expect(result.status).toBe('impossible');
    expect(result.error).toMatchObject({ code: 'impossible' });
    expect(result.plans).toEqual([]);
    expect(result.narrative.summary).toMatch(/only by train, which is not possible for this journey.*Nothing was searched/);
    expect(seen).toHaveLength(0);
    expect(fake.calls).toEqual({ flights: 0, hotels: 0 });
    expect(calls).toHaveLength(0);
    expect(stages(result)).toEqual(['transport_agent']);
  });

  it('says so when every allowed way of travelling has been ruled out', async () => {
    const fake = fakeTravel();
    const p = profile({ priorities: ['cheapest'] });
    const base = inputFor(fake).input;
    p.transport.excludedModes = [...base.classification.eligibleModes];
    const result = await orchestrator(fake).plan({ ...base, profile: p, constraints: constraintsFor(p) });
    expect(result.status).toBe('impossible');
    expect(result.error!.message).toMatch(/Every way of travelling/);
    expect(fake.calls.flights).toBe(0);
  });
});

describe('validation is the last gate', () => {
  it('never presents a plan that fails validation as workable, and does not repair it', async () => {
    const fake = fakeTravel();
    const { services } = spying((result) => {
      for (const plan of result.plans) plan.cost.total = money(1, 'INR');
    });
    const result = await orchestrator(fake, noModel(), services).plan(inputFor(fake).input);

    expect(result.status).toBe('no_valid_plan');
    expect(result.validation!.anyValid).toBe(false);
    for (const plan of result.plans) {
      expect(plan.issues.some((i) => i.code === 'validation.cost_sum' && i.severity === 'blocker')).toBe(true);
      // Marked, not edited.
      expect(plan.cost.total.amount).toBe(100);
    }
    expect(result.narrative.summary).toMatch(/none of the plans found can be carried out/);
    expect(result.narrative.summary).not.toMatch(/best fits/);
    expect(result.trace.find((t) => t.stage === 'validation')!.status).toBe('degraded');
  });

  it('keeps a valid plan ahead of a failing one', async () => {
    const fake = fakeTravel();
    const { services } = spying((result) => {
      result.plans[0]!.cost.total = money(1, 'INR');
    });
    const result = await orchestrator(fake, noModel(), services).plan(inputFor(fake).input);
    expect(result.status).toBe('planned');
    expect(result.plans[0]!.issues.some((i) => i.severity === 'blocker')).toBe(false);
    expect(result.plans.at(-1)!.issues.some((i) => i.code === 'validation.cost_sum')).toBe(true);
  });

  it('reports that nothing could be built when the providers return nothing', async () => {
    const fake = fakeTravel();
    fake.registry.flights.length = 0;
    fake.registry.hotels.length = 0;
    const result = await orchestrator(fake).plan(inputFor(fake).input);
    expect(result.status).toBe('no_plans');
    expect(result.plans).toEqual([]);
    expect(result.narrative.summary).toMatch(/No plan could be built/);
    expect(result.trace.find((t) => t.stage === 'plan_search')!.status).toBe('degraded');
  });
});

describe('budget behaviour is preserved', () => {
  it('shows a plan over a guide budget, ranked and described as over it', async () => {
    const fake = fakeTravel();
    const p = profile({ priorities: ['cheapest'] });
    const result = await orchestrator(fake).plan(inputFor(fake, { profile: p, constraints: constraintsFor(p, intent(), { total: 10_000, firm: false }) }).input);
    expect(result.status).toBe('planned');
    expect(result.plans.some((pl) => pl.issues.some((i) => i.code === 'over_budget_guide'))).toBe(true);
    expect(result.narrative.summary).toMatch(/over your budget/);
    expect(result.narrative.summary).not.toMatch(/within your budget/);
  });

  it('never presents a plan over a firm limit as workable', async () => {
    const fake = fakeTravel();
    const p = profile({ priorities: ['cheapest'] });
    const result = await orchestrator(fake).plan(inputFor(fake, { profile: p, constraints: constraintsFor(p, intent(), { total: 10_000, firm: true }) }).input);
    expect(result.status).not.toBe('planned');
    for (const plan of result.plans) expect(plan.issues.some((i) => i.severity === 'blocker')).toBe(true);
    expect(result.narrative.summary).not.toMatch(/best fits/);
  });
});

describe('cancellation', () => {
  it('stops when the search is cancelled, before asking anything more', async () => {
    const fake = fakeTravel();
    const controller = new AbortController();
    const { services, seen } = spying();
    const run = orchestrator(fake, noModel(), services).plan({
      ...inputFor(fake).input,
      signal: controller.signal,
      onProgress: (p) => {
        if (p.step === 'validate') controller.abort(new Error('stopped'));
      },
    });
    await expect(run).rejects.toThrow('stopped');
    expect(seen).toHaveLength(1);
  });

  it('does not start when already cancelled', async () => {
    const fake = fakeTravel();
    const controller = new AbortController();
    controller.abort(new Error('stopped'));
    await expect(orchestrator(fake).plan({ ...inputFor(fake).input, signal: controller.signal })).rejects.toThrow('stopped');
    expect(fake.calls).toEqual({ flights: 0, hotels: 0 });
  });
});

describe('pins and re-planning', () => {
  const firstPlan = async () => {
    const built = await realPlans();
    return built.plans.find((p) => p.hotels[0]!.hotel.id === 'h-simple') ?? built.plans[0]!;
  };

  it('carries a pinned hotel over exactly, and does not search for it again', async () => {
    const previous = await firstPlan();
    const fake = fakeTravel();
    const { services, seen } = spying();
    const result = await orchestrator(fake, noModel(), services).replan({
      ...inputFor(fake).input, pins: ['hotel'], previous,
    });

    expect(result.pinsReleased).toEqual([]);
    expect(seen[0]!.keep!.hotel!.hotel.id).toBe(previous.hotels[0]!.hotel.id);
    expect(fake.calls.hotels).toBe(0);
    expect(fake.calls.flights).toBeGreaterThan(0);
    expect(result.status).toBe('planned');
    for (const plan of result.plans) expect(plan.hotels[0]!.hotel.id).toBe(previous.hotels[0]!.hotel.id);
  });

  it('refuses a plan that changed something the traveller asked to keep', async () => {
    const previous = await firstPlan();
    const fake = fakeTravel();
    // Services that quietly swap the hotel for the other one.
    const { services } = spying((result) => {
      const other = hotelOffer('h-grand', 'Grand Stay', 5, 56_000);
      for (const plan of result.plans) {
        plan.hotels[0] = { ...plan.hotels[0]!, hotel: other, room: other.rooms[0]! };
      }
    });
    const result = await orchestrator(fake, noModel(), services).replan({ ...inputFor(fake).input, pins: ['hotel'], previous });
    expect(result.status).toBe('no_valid_plan');
    for (const plan of result.plans) expect(plan.issues.some((i) => i.code === 'validation.pin_not_preserved')).toBe(true);
  });

  it('releases a pin that new dates make impossible, says why, and searches everything afresh', async () => {
    const previous = await firstPlan();
    const fake = fakeTravel();
    const { services, seen } = spying();
    const moved = intent({ departureDate: '2030-12-01', returnDate: '2030-12-05' });
    const result = await orchestrator(fake, noModel(), services).replan({
      ...inputFor(fake, { intent: moved, constraints: constraintsFor(profile({ priorities: ['cheapest'] }), moved) }).input,
      pins: ['hotel', 'outbound'],
      previous,
    });

    expect(result.pinsReleased.map((r) => r.component).sort()).toEqual(['hotel', 'outbound']);
    for (const r of result.pinsReleased) expect(r.reason).toMatch(/old dates/);
    expect(seen[0]!.keep).toEqual({ outbound: null, return: null, hotel: null, activities: null });
    // The new plans are for the new dates, and are valid for them.
    expect(result.status).toBe('planned');
    expect(result.plans[0]!.hotels[0]!.checkIn).toBe('2030-12-01');
    expect(result.plans[0]!.outboundTransport!.segments[0]!.departureAt.slice(0, 10)).toBe('2030-12-01');
    // And the traveller is told, in the explanation, not just in a log.
    expect(result.narrative.summary).toMatch(/could not be kept.*hotel: The hotel cannot be kept: it was for the old dates/);
  });

  it('runs every agent again for the changed trip, and recomputes the budget', async () => {
    const previous = await firstPlan();
    const fake = fakeTravel();
    const { llm, calls } = fakeLlm(() => ({ preferredMode: null, modeOrder: [], area: null, amenities: [], interests: [], pace: null, reasons: [], summary: '', plans: [] }));
    const p = profile({ priorities: ['cheapest'] });
    const moved = intent({ departureDate: '2030-12-01', returnDate: '2030-12-08' });
    const base = { requirements: SOFT };
    const o = orchestrator(fake, llm);
    await o.plan({ ...inputFor(fake, { profile: p }).input, ...base });
    const before = calls.length;
    const result = await o.replan({
      ...inputFor(fake, { intent: moved, profile: p, constraints: constraintsFor(p, moved, { total: 500_000 }) }).input,
      ...base,
      pins: [],
      previous,
    });
    expect(calls.length - before).toBeGreaterThanOrEqual(3);
    expect(result.plans[0]!.hotels[0]!.nights).toBe(7);
    expect(result.validation!.results.every((r) => r.valid)).toBe(true);
    expect(result.plans[0]!.cost.remainingBudget!.amount).toBe(500_000_00 - result.plans[0]!.cost.total.amount);
  });

  it('is the same result through plan() and replan() when nothing was pinned', async () => {
    const previous = await firstPlan();
    const a = fakeTravel();
    const b = fakeTravel();
    const viaPlan = await orchestrator(a).plan(inputFor(a).input);
    const viaReplan = await orchestrator(b).replan({ ...inputFor(b).input, pins: [], previous });
    expect(stripTimes(viaReplan.plans)).toEqual(stripTimes(viaPlan.plans));
  });
});

describe('self-drive', () => {
  it('keeps a drive in your own car at ₹0, with its distance and time and fuel apart, and never counts what cannot be priced as zero', async () => {
    const fake = fakeTravel();
    const meta = { provider: 'fake-drive', providerLabel: 'Fake drive', retrievedAt: '2026-01-01T00:00:00.000Z', validUntil: null, searchId: null, attribution: null };
    Object.assign(fake.registry, {
      selfDrive: {
        estimate: async (opts: { date: string; origin: { name: string } }) =>
          ok(opts.origin.name === 'Bengaluru' ? driveOffer(opts.date, 'BLR', 'HYD', 13) : driveOffer(opts.date, 'HYD', 'BLR', 6), meta),
      },
    });
    const p = profile({ priorities: ['cheapest'] });
    p.transport.excludedModes = ['flight', 'train', 'bus', 'rental_car', 'taxi', 'ferry'];
    const result = await orchestrator(fake).plan(inputFor(fake, { profile: p, constraints: constraintsFor(p, intent(), { total: 500_000 }) }).input);

    expect(result.status).toBe('planned');
    const plan = result.plans[0]!;
    expect(plan.outboundTransport!.mode).toBe('self_drive');
    // The fare is a real ₹0; the drive's length and duration are kept apart from money; fuel is a separate, labelled estimate.
    expect(plan.outboundTransport!.totalPrice.amount).toBe(0);
    expect(plan.cost.transport.amount).toBe(0);
    expect(plan.outboundTransport!.totalDurationMinutes).toBe(480);
    expect(plan.cost.transportFees.amount).toBe(600_000);
    expect(plan.cost.estimatedPortion.amount).toBeGreaterThanOrEqual(600_000);
    // What cannot be priced is named, and never counted as zero or hidden by "within budget".
    expect(plan.cost.notIncluded.map((n) => n.label)).toContain('Tolls and parking');
    expect(result.narrative.summary).toMatch(/does not include: .*Tolls and parking/);
    // Validation treats a ₹0 fare as a known amount, not a missing one.
    expect(result.validation!.results.every((r) => r.valid)).toBe(true);
  });
});

describe('the default services', () => {
  it('are the engine', () => {
    expect(engineServices.buildPlans).toBe(generatePlans);
  });
});

describe('a trip that cannot be done as asked', () => {
  it('says which limit stands in the way, with the numbers, in the search and in the explanation', async () => {
    const fake = fakeTravel();
    const p = profile({ priorities: ['cheapest'] });
    const tripIntent = intent();
    const result = await orchestrator(fake).plan(
      inputFor(fake, { profile: p, intent: tripIntent, constraints: constraintsFor(p, tripIntent, { total: 30_000, firm: true }) }).input,
    );

    expect(result.search!.feasibility.status).toBe('partial');
    const finding = result.search!.feasibility.findings.find((f) => f.code === 'budget_below_cheapest_plan');
    expect(finding?.severity).toBe('blocker');
    // Two flights and four nights come to 43,200 before food or getting around, against 30,000.
    expect(finding?.message).toMatch(/43,200/);
    expect(finding?.message).toMatch(/30,000/);
    // Nothing was loosened: the plans are shown, and each is marked as breaking the limit.
    expect(result.status).toBe('no_valid_plan');
    for (const plan of result.plans) expect(plan.issues.some((i) => i.severity === 'blocker')).toBe(true);
    // The explanation carries the same finding, from the facts, so it can say why.
    expect(result.narrative.summary).toMatch(/none of the plans found can be carried out/);
  });

  it('keeps a hard limit through a re-plan: what was kept stays, and the rest is still held to the limit', async () => {
    const fake = fakeTravel();
    const p = profile({ priorities: ['cheapest'] });
    const tripIntent = intent();
    const constraints = constraintsFor(p, tripIntent, { total: 60_000, firm: true });
    const first = await orchestrator(fake).plan(inputFor(fake, { profile: p, intent: tripIntent, constraints }).input);
    const previous = first.plans[0]!;

    const again = await orchestrator(fake).replan({
      intent: tripIntent,
      profile: p,
      constraints,
      classification: classificationFor(tripIntent),
      requirements: null,
      pins: ['hotel'],
      previous,
    });
    expect(again.pinsReleased).toEqual([]);
    for (const plan of again.plans) {
      expect(plan.hotels[0]!.hotel.id).toBe(previous.hotels[0]!.hotel.id);
      expect(plan.cost.total.amount).toBeLessThanOrEqual(6_000_000);
    }
  });
});
