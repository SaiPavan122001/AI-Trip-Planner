import { describe, expect, it } from 'vitest';
import { money, type ConstraintSet } from '@trip/shared';
import { applyHardConstraints } from '../transport.js';
import { profile, transportOffer, INDIA_LEG } from './fixtures.js';

const constraints = (overrides: Partial<ConstraintSet> = {}): ConstraintSet => ({
  hard: [],
  soft: [],
  budget: {
    total: null,
    firm: false,
    transport: null,
    accommodation: null,
    dailySpend: null,
    activities: null,
  },
  waivers: [],
  ...overrides,
});

describe('hard constraints on transport', () => {
  it('drops an overnight leg when the traveller ruled overnight travel out', () => {
    const avoiding = profile();
    avoiding.transport.avoidOvernightTravel = true;

    const { kept, dropped } = applyHardConstraints(
      [
        transportOffer({ id: 'day', overnight: false }),
        transportOffer({ id: 'night', overnight: true, totalPrice: money(2000, 'INR') }),
      ],
      constraints(),
      avoiding,
      INDIA_LEG,
    );

    expect(kept.map((o) => o.id)).toEqual(['day']);
    // Even a much cheaper option is removed, and the traveller is told why, so
    // they can relax the requirement with their eyes open.
    expect(dropped[0]?.reason).toMatch(/overnight/i);
  });

  it('drops options with more changes than allowed', () => {
    const { kept, dropped } = applyHardConstraints(
      [
        transportOffer({ id: 'direct', transfers: 0 }),
        transportOffer({ id: 'two-stop', transfers: 2 }),
      ],
      constraints({ hard: [{ kind: 'max_stops', value: 0 }] }),
      profile(),
      INDIA_LEG,
    );

    expect(kept.map((o) => o.id)).toEqual(['direct']);
    expect(dropped[0]?.reason).toMatch(/2 change/);
  });

  it('drops anything that exceeds the transport budget on its own', () => {
    const { kept, dropped } = applyHardConstraints(
      [
        transportOffer({ id: 'affordable', totalPrice: money(9000, 'INR') }),
        transportOffer({ id: 'expensive', totalPrice: money(60_000, 'INR') }),
      ],
      // Only a firm limit filters; the ceiling is a hard constraint.
      constraints({ hard: [{ kind: 'max_transport_budget', value: money(20_000, 'INR') }] }),
      profile(),
      INDIA_LEG,
    );

    expect(kept.map((o) => o.id)).toEqual(['affordable']);
    expect(dropped[0]?.reason).toMatch(/firm budget/);
  });

  it('keeps a fare whose baggage the provider did not state, rather than hiding it', () => {
    // A null means "the provider said nothing", which is different from "it
    // includes no bags". Dropping it would hide a real fare.
    const unstated = transportOffer({
      id: 'unstated',
      fareClasses: [
        { ...transportOffer().fareClasses[0]!, checkedBagsIncluded: null },
      ],
    });

    const { kept } = applyHardConstraints(
      [unstated],
      constraints({ hard: [{ kind: 'required_checked_bags', value: 2 }] }),
      profile(),
      INDIA_LEG,
    );

    expect(kept.map((o) => o.id)).toEqual(['unstated']);
  });

  it('drops a fare that states fewer bags than the traveller needs', () => {
    const oneBag = transportOffer({ id: 'one-bag' });

    const { kept, dropped } = applyHardConstraints(
      [oneBag],
      constraints({ hard: [{ kind: 'required_checked_bags', value: 2 }] }),
      profile(),
      INDIA_LEG,
    );

    expect(kept).toEqual([]);
    expect(dropped[0]?.reason).toMatch(/1 checked bag/);
  });

  it('drops non-refundable fares when flexibility was required', () => {
    const flexible = profile();
    flexible.transport.refundableRequired = true;

    const { kept } = applyHardConstraints(
      [
        transportOffer({ id: 'flex', refundable: true }),
        transportOffer({ id: 'saver', refundable: false }),
      ],
      constraints(),
      flexible,
      INDIA_LEG,
    );

    expect(kept.map((o) => o.id)).toEqual(['flex']);
  });
});
