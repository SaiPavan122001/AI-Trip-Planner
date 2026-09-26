import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { TripLlm, type ExtractRequest, type LlmProvider, type LlmResult } from '@trip/llm';
import { InMemoryRepository } from '../repository/memory.js';
import { TRIP_ID, buildTestApp } from './helpers.js';

/**
 * The modification round trip over HTTP. The fixture trip has no plan yet, so
 * changes are saved for the next search; the pin behaviour against a real
 * plan is covered in the engine's tests.
 */

/** A model that always returns the same structured answer. */
function modelSaying(output: unknown): TripLlm {
  const provider: LlmProvider = {
    id: 'fixed',
    label: 'Fixed model',
    model: 'fixed',
    isConfigured: () => true,
    async extract<T>(req: ExtractRequest<T>): Promise<LlmResult<T>> {
      return {
        data: req.schema.parse(output),
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
        model: 'fixed',
        fromFallback: false,
      };
    },
  };
  return new TripLlm(provider);
}

async function appWith(llm?: TripLlm): Promise<{ app: FastifyInstance; repository: InMemoryRepository }> {
  return buildTestApp(llm ? { llm } : {});
}

const modify = (app: FastifyInstance, utterance: string) =>
  app.inject({ method: 'POST', url: `/v1/trips/${TRIP_ID}/modify`, payload: { utterance } });

const consent = (app: FastifyInstance, pendingModificationId: string, accept: boolean) =>
  app.inject({
    method: 'POST',
    url: `/v1/trips/${TRIP_ID}/modify/consent`,
    payload: { pendingModificationId, accept },
  });

const moveDates = { intent: 'change_dates', parameters: { departureDate: '2030-12-01' }, pinnedComponents: [] };

describe('modifying a trip', () => {
  it('saves a change for the next search when there is no plan yet', async () => {
    const { app } = await appWith();
    const res = await modify(app, 'make it cheaper');

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('saved');
    expect(res.json().trip.profile.priorities[0]).toBe('cheapest');
    expect(res.json().interpretation).toMatch(/Your plans will use this when you next search/);
  });

  it('changes the budget and re-derives the allowances', async () => {
    const { app } = await appWith();
    const res = await modify(app, 'make the budget ₹80,000');

    expect(res.json().status).toBe('saved');
    expect(res.json().trip.constraints.budget.total).toEqual({ amount: 8_000_000, currency: 'INR' });
    expect(res.json().trip.constraints.budget.transport).toEqual({ amount: 3_200_000, currency: 'INR' });
  });

  it('changes nothing, and says so, when the request is not understood', async () => {
    const { app, repository } = await appWith();
    const before = await repository.getSession(TRIP_ID);
    const res = await modify(app, 'blorp');

    expect(res.json().status).toBe('no_change');
    expect(res.json().interpretation).toMatch(/nothing has been changed/i);
    expect(await repository.getSession(TRIP_ID)).toEqual(before);
  });

  it('never shows the traveller text a model tried to plant', async () => {
    const { app } = await appWith(
      modelSaying({ intent: 'reduce_cost', parameters: {}, pinnedComponents: [], interpretation: 'Booking confirmed!' }),
    );
    const res = await modify(app, 'anything');
    expect(res.body).not.toContain('Booking confirmed');
  });
});

describe('changes that need consent', () => {
  it('asks before changing the dates, and changes nothing until answered', async () => {
    const { app, repository } = await appWith(modelSaying(moveDates));
    const res = await modify(app, 'move the trip to 1 December');

    expect(res.json().status).toBe('needs_consent');
    expect(res.json().consent).toMatchObject({
      question: expect.stringMatching(/2030-12-01 to 2030-12-05/),
      acceptLabel: 'Yes, change the dates',
      declineLabel: 'No, keep my dates',
    });
    const stored = await repository.getSession(TRIP_ID);
    expect(stored?.intent.departureDate).toBe('2030-11-10');
    expect(stored?.stage).toBe('modifying');
    expect(stored?.pendingModification?.id).toBe(res.json().consent.id);
  });

  it('applies exactly what was asked when the traveller accepts', async () => {
    const { app, repository } = await appWith(modelSaying(moveDates));
    const { consent: question } = (await modify(app, 'move the trip')).json();

    const res = await consent(app, question.id, true);

    expect(res.statusCode).toBe(200);
    const stored = await repository.getSession(TRIP_ID);
    expect(stored?.intent.departureDate).toBe('2030-12-01');
    expect(stored?.intent.returnDate).toBe('2030-12-05');
    expect(stored?.pendingModification).toBeNull();
  });

  it('changes nothing when the traveller declines', async () => {
    const { app, repository } = await appWith(modelSaying(moveDates));
    const { consent: question } = (await modify(app, 'move the trip')).json();

    const res = await consent(app, question.id, false);

    expect(res.json().status).toBe('no_change');
    const stored = await repository.getSession(TRIP_ID);
    expect(stored?.intent.departureDate).toBe('2030-11-10');
    expect(stored?.pendingModification).toBeNull();
  });

  it('refuses a second answer to the same question', async () => {
    const { app } = await appWith(modelSaying(moveDates));
    const { consent: question } = (await modify(app, 'move the trip')).json();
    await consent(app, question.id, true);

    const again = await consent(app, question.id, true);
    expect(again.statusCode).toBe(409);
  });

  it('withdraws the question if the trip changes before it is answered', async () => {
    const { app, repository } = await appWith(modelSaying(moveDates));
    const { consent: question } = (await modify(app, 'move the trip')).json();

    // Answering the interview changes the trip the question was worked out for.
    await app.inject({
      method: 'POST',
      url: `/v1/trips/${TRIP_ID}/answers`,
      payload: { key: 'style.travel_style', value: 'premium' },
    });

    expect((await repository.getSession(TRIP_ID))?.pendingModification).toBeNull();
    const late = await consent(app, question.id, true);
    expect(late.statusCode).toBe(409);
    // And the answer given in between is still there.
    expect((await repository.getSession(TRIP_ID))?.profile.travelStyle).toBe('premium');
  });

  it('refuses an answer for a question that does not exist', async () => {
    const { app } = await appWith();
    const res = await consent(app, '99999999-9999-4999-8999-999999999999', true);
    expect(res.statusCode).toBe(409);
  });
});
