import { randomUUID } from 'node:crypto';
import {
  AnswerValidationError,
  applyAnswer,
  applyModification,
  classifyJourney,
  generatePlans,
  questionnaireState,
  rebuildConstraints,
  statedBudget,
  type BudgetAnswers,
  type PlanGenerationResult,
  type ValidatedAnswer,
} from '@trip/engine';
import type { ProviderRegistry } from '@trip/providers';
import type { TripLlm } from '@trip/llm';
import {
  Answer,
  TripIntentInput,
  emptyConstraintSet,
  emptyTravelerProfile,
  isOk,
  localParts,
  type Money,
  type PendingModification,
  type Place,
  type PlanningSession,
  type ProposedChange,
  type ProviderNote,
  type TravelerProfile,
  type TripComponent,
  type TripPlan,
} from '@trip/shared';
import { ApiError } from '../errors.js';
import type { TripRepository } from '../repository/types.js';

/**
 * Trip planning use cases.
 *
 * The route layer handles HTTP; this handles the actual sequence of the
 * product: resolve where the traveller means, decide what kind of journey it
 * is, interview them, then plan. Each step persists the session, so a
 * traveller can close the tab and come back.
 */

export interface TripServiceDeps {
  registry: ProviderRegistry;
  llm: TripLlm;
  repository: TripRepository;
}

export class TripService {
  constructor(private readonly deps: TripServiceDeps) {}

  /**
   * Step one of the funnel, and the only step with required questions:
   * where from, where to, when, and how many people.
   */
  async createTrip(input: unknown, ownerId: string | null): Promise<PlanningSession> {
    const intent = TripIntentInput.parse(input);

    if (intent.returnDate && intent.returnDate < intent.departureDate) {
      throw ApiError.badRequest('The return date is before the departure date.');
    }

    const [origin, destination] = await Promise.all([
      this.resolvePlace(intent.originQuery, 'origin'),
      this.resolvePlace(intent.destinationQuery, 'destination'),
    ]);

    if (origin.countryCode === destination.countryCode && origin.name === destination.name) {
      throw ApiError.badRequest(
        'The origin and destination resolved to the same place. Try being more specific about one of them.',
      );
    }

    // "Today" where the trip starts, not where the server runs.
    const today = localParts(new Date().toISOString(), origin.timezone).date;
    if (intent.departureDate < today) {
      throw ApiError.badRequest(`The departure date ${intent.departureDate} has already passed.`);
    }

    const classification = classifyJourney(origin, destination);
    const now = new Date().toISOString();

    const session: PlanningSession = {
      id: randomUUID(),
      ownerId,
      stage: 'profiling',
      intent: { ...intent, origin, destination },
      classification,
      profile: emptyTravelerProfile(),
      constraints: emptyConstraintSet(),
      questionnaire: null,
      plans: [],
      selectedPlanId: null,
      pendingModification: null,
      providerNotes: [],
      decisionLog: [
        {
          at: now,
          step: 'classify',
          detail: `${classification.scope} journey, ${classification.greatCircleKm}km. Modes worth searching: ${classification.eligibleModes.join(', ') || 'none'}.`,
        },
      ],
      createdAt: now,
      updatedAt: now,
    };

    session.questionnaire = questionnaireState({
      intent: session.intent,
      classification,
      profile: session.profile,
    });

    return this.deps.repository.createSession(session);
  }

  async getTrip(id: string): Promise<PlanningSession> {
    const session = await this.deps.repository.getSession(id);
    if (!session) throw ApiError.notFound('That trip');
    return session;
  }

  /**
   * Records one answer and returns the next question. Budget answers are the
   * one case where the answer becomes a constraint rather than a preference,
   * so they are routed to the constraint builder.
   */
  async answer(id: string, raw: unknown): Promise<PlanningSession> {
    const session = await this.getTrip(id);
    const parsed = Answer.parse(raw);

    let profile: TravelerProfile;
    let answer: ValidatedAnswer;
    try {
      ({ profile, answer } = applyAnswer(
        { intent: session.intent, classification: session.classification, profile: session.profile },
        parsed,
      ));
    } catch (err) {
      // Only a rejected answer is the caller's fault. Anything else is a bug
      // here, and reporting it as a 400 would hide it.
      if (err instanceof AnswerValidationError) {
        throw ApiError.badRequest(err.message, { key: err.key });
      }
      throw err;
    }

    let constraints = rebuildConstraints(session.intent, profile, session.constraints, this.budgetFrom(session, profile, answer));
    // A new total budget replaces any earlier agreement to go over the old one.
    if (answer.key === 'budget.total') {
      constraints = { ...constraints, waivers: constraints.waivers.filter((w) => w.kind !== 'max_total_budget') };
    }

    const updated: PlanningSession = {
      ...session,
      profile,
      constraints,
      questionnaire: questionnaireState({
        intent: session.intent,
        classification: session.classification,
        profile,
      }),
      // A pending modification is a snapshot of the trip before this answer;
      // accepting it later would silently undo the answer, so it lapses.
      ...withdrawPending(session, 'the trip was changed by answering a question'),
      updatedAt: new Date().toISOString(),
    };

    return this.deps.repository.updateSession(updated);
  }

  /**
   * Runs the full pipeline. Provider failures are attached to the session
   * rather than thrown, because "no trains are searchable" is information the
   * traveller needs, not an error that should lose their whole session.
   */
  async plan(id: string): Promise<{ session: PlanningSession; result: PlanGenerationResult }> {
    const session = await this.getTrip(id);
    if (session.questionnaire && !session.questionnaire.canPlan) {
      throw ApiError.unprocessable(
        'Some required answers are still missing, so a plan cannot be built yet.',
        { nextQuestion: session.questionnaire.next?.key ?? null },
      );
    }

    const result = await generatePlans({
      registry: this.deps.registry,
      intent: session.intent,
      profile: session.profile,
      constraints: session.constraints,
    });

    const withdrawn = withdrawPending(session, 'new plans were built');
    const updated: PlanningSession = {
      ...session,
      ...withdrawn,
      stage: result.plans.length > 0 ? 'planned' : 'searching',
      plans: result.plans,
      selectedPlanId: result.plans[0]?.id ?? null,
      providerNotes: dedupeNotes([...session.providerNotes, ...result.notes]),
      decisionLog: [...(withdrawn.decisionLog ?? session.decisionLog), ...result.decisionLog],
      updatedAt: new Date().toISOString(),
    };

    await this.deps.repository.updateSession(updated);
    return { session: updated, result };
  }

  /**
   * Conversational modification. The model only classifies what was asked;
   * the engine works out, in full, what that means for this trip. A change
   * that needs the traveller's say-so is stored and asked about; everything
   * else is applied, keeping pinned parts of the plan exactly as they were.
   */
  async modify(id: string, utterance: string): Promise<ModificationResult> {
    const session = await this.getTrip(id);
    const selected = selectedPlanOf(session);

    const interpreted = await this.deps.llm.interpretModification(utterance, {
      hasHotel: Boolean(selected?.hotels.length),
      modes: session.classification.eligibleModes,
    });
    const common = {
      understoodBy: interpreted.fromFallback ? 'rules' : this.deps.llm.label,
      diagnostics: {
        llmFallbackReason: interpreted.fallbackReason,
        rejectedParameters: interpreted.rejectedParameters,
      },
    };

    const outcome = applyModification(interpreted.request, {
      intent: session.intent,
      classification: session.classification,
      profile: session.profile,
      constraints: session.constraints,
      planComponents: componentsOf(selected),
    });

    // A new request replaces any question still waiting for an answer.
    const base = { ...session, ...withdrawPending(session, 'a new change was requested') };

    if (outcome.status === 'no_change') {
      if (base.pendingModification !== session.pendingModification) {
        await this.deps.repository.updateSession({ ...base, updatedAt: new Date().toISOString() });
      }
      return {
        ...common,
        session: base,
        status: 'no_change',
        interpretation: outcome.summary,
        reSearched: [],
        kept: [],
        released: [],
        consent: null,
        result: null,
      };
    }

    if (outcome.status === 'needs_consent') {
      const pending: PendingModification = {
        id: randomUUID(),
        utterance,
        intent: interpreted.request.intent,
        question: outcome.question,
        acceptLabel: outcome.acceptLabel,
        declineLabel: outcome.declineLabel,
        accept: outcome.accept,
        decline: outcome.decline,
        createdAt: new Date().toISOString(),
      };
      const staged = await this.deps.repository.updateSession({
        ...base,
        stage: 'modifying',
        pendingModification: pending,
        decisionLog: [
          ...base.decisionLog,
          { at: pending.createdAt, step: 'modify', detail: `Asked before changing: ${outcome.question}` },
        ],
        updatedAt: pending.createdAt,
      });
      return {
        ...common,
        session: staged,
        status: 'needs_consent',
        interpretation: interpreted.interpretation,
        reSearched: [],
        kept: [],
        released: [],
        consent: {
          id: pending.id,
          question: pending.question,
          acceptLabel: pending.acceptLabel,
          declineLabel: pending.declineLabel,
        },
        result: null,
      };
    }

    return {
      ...common,
      ...(await this.commit(base, outcome.change, `"${utterance}" → ${interpreted.request.intent}.`)),
    };
  }

  /**
   * The traveller's answer to a pending modification. Both answers were
   * worked out when the question was asked, so the answer applies exactly
   * what the question described. An answer to a question that is no longer
   * pending (already answered, or replaced by a later change) is refused.
   */
  async consent(
    id: string,
    pendingId: string,
    accept: boolean,
  ): Promise<Omit<ModificationResult, 'understoodBy' | 'diagnostics'>> {
    const session = await this.getTrip(id);
    const pending = session.pendingModification;
    if (!pending || pending.id !== pendingId) {
      throw ApiError.conflict('That change is no longer waiting for an answer. Ask for it again if you still want it.');
    }

    const change = accept ? pending.accept : pending.decline;
    const cleared: PlanningSession = {
      ...session,
      pendingModification: null,
      stage: session.plans.length > 0 ? 'planned' : 'profiling',
      decisionLog: [
        ...session.decisionLog,
        { at: new Date().toISOString(), step: 'consent', detail: `${accept ? 'Accepted' : 'Declined'}: ${pending.question}` },
      ],
    };

    if (!change) {
      const saved = await this.deps.repository.updateSession({ ...cleared, updatedAt: new Date().toISOString() });
      return {
        session: saved,
        status: 'no_change',
        interpretation: 'Nothing has changed.',
        reSearched: [],
        kept: [],
        released: [],
        consent: null,
        result: null,
      };
    }
    return this.commit(cleared, change, `${accept ? 'Accepted' : 'Declined'} "${pending.utterance}".`);
  }

  /**
   * Applies a worked-out change: the new trip facts, preferences and
   * constraints are saved, the parts the change keeps are taken from the
   * selected plan exactly as they are, and only the rest is searched again.
   */
  private async commit(
    session: PlanningSession,
    change: ProposedChange,
    detail: string,
  ): Promise<Omit<ModificationResult, 'understoodBy' | 'diagnostics'>> {
    const now = new Date().toISOString();
    const selected = selectedPlanOf(session);
    const questionnaire = questionnaireState({
      intent: change.intent,
      classification: session.classification,
      profile: change.profile,
    });
    const tripChanged = JSON.stringify(change.intent) !== JSON.stringify(session.intent);
    const updated: PlanningSession = {
      ...session,
      intent: change.intent,
      profile: change.profile,
      constraints: change.constraints,
      questionnaire,
      pendingModification: null,
      decisionLog: [...session.decisionLog, { at: now, step: 'modify', detail: `${detail} ${change.summary}` }],
      updatedAt: now,
    };
    const answer = { reSearched: change.reSearch, kept: change.keep, released: change.released, consent: null };

    // Nothing to re-plan yet: no plan exists, or a changed trip now needs one
    // more answer before plans can be built. Plans for the old trip are not
    // left looking current.
    if (!selected || !questionnaire.canPlan) {
      const saved = await this.deps.repository.updateSession({
        ...updated,
        ...(tripChanged ? { plans: [], selectedPlanId: null } : {}),
        stage: selected && !tripChanged ? 'planned' : 'profiling',
      });
      const next = selected && !questionnaire.canPlan
        ? ' One more question needs answering before new plans can be built.'
        : ' Your plans will use this when you next search.';
      return { ...answer, session: saved, status: 'saved', interpretation: `${change.summary}${next}`, result: null };
    }

    // Everything the change touches was pinned: the plan stays as it is.
    if (change.reSearch.length === 0 && !tripChanged) {
      const saved = await this.deps.repository.updateSession({ ...updated, stage: 'planned' });
      return { ...answer, session: saved, status: 'applied', interpretation: change.summary, result: null };
    }

    const kept = change.keep;
    const result = await generatePlans({
      registry: this.deps.registry,
      intent: change.intent,
      profile: change.profile,
      constraints: change.constraints,
      keep: {
        outbound: kept.includes('outbound') ? selected.outboundTransport : null,
        return: kept.includes('return') ? selected.returnTransport : null,
        hotel: kept.includes('hotel') ? (selected.hotels[0] ?? null) : null,
        activities: kept.includes('activities') && selected.activities.length > 0 ? selected.activities : null,
      },
    });
    const saved = await this.deps.repository.updateSession({
      ...updated,
      stage: 'planned',
      plans: result.plans,
      selectedPlanId: result.plans[0]?.id ?? null,
      providerNotes: dedupeNotes([...session.providerNotes, ...result.notes]),
      decisionLog: [...updated.decisionLog, ...result.decisionLog],
    });
    return { ...answer, session: saved, status: 'applied', interpretation: change.summary, result };
  }

  async selectPlan(id: string, planId: string): Promise<PlanningSession> {
    const session = await this.getTrip(id);
    if (!session.plans.some((p) => p.id === planId)) {
      throw ApiError.notFound('That plan');
    }
    return this.deps.repository.updateSession({
      ...session,
      selectedPlanId: planId,
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * Resolves free text to exactly one place. A query that cannot be resolved
   * to a country stops the funnel here, because everything downstream depends
   * on knowing which country the traveller means.
   */
  async resolvePlace(query: string, role: 'origin' | 'destination'): Promise<Place> {
    const geocoders = this.deps.registry.geocoding;
    if (geocoders.length === 0) {
      const missing = this.deps.registry.missingCapabilityNote('Place lookup', ['nominatim']);
      throw ApiError.providerUnavailable(
        missing.provider,
        missing.providerLabel,
        missing.status,
        missing.message,
      );
    }

    for (const geocoder of geocoders) {
      const res = await geocoder.resolvePlace(query, { limit: 5 });
      if (isOk(res) && res.data[0]) {
        const place = res.data[0];
        // Enriching with airport codes here keeps flight search from having
        // to guess later, and makes the "which airport?" answer visible in
        // the trip record.
        return this.withAirports(place);
      }
      if (!isOk(res) && res.status !== 'no_availability') {
        throw ApiError.providerUnavailable(res.provider, res.providerLabel, res.status, res.message);
      }
    }

    throw ApiError.badRequest(
      `The ${role} "${query}" could not be resolved to a place. Try adding a country, for example "Hyderabad, India".`,
    );
  }

  async searchPlaces(query: string): Promise<Place[]> {
    const geocoder = this.deps.registry.geocoding[0];
    if (!geocoder) {
      const missing = this.deps.registry.missingCapabilityNote('Place lookup', ['nominatim']);
      throw ApiError.providerUnavailable(
        missing.provider,
        missing.providerLabel,
        missing.status,
        missing.message,
      );
    }
    const res = await geocoder.resolvePlace(query, { limit: 6 });
    if (!isOk(res)) {
      if (res.status === 'no_availability') return [];
      throw ApiError.providerUnavailable(res.provider, res.providerLabel, res.status, res.message);
    }
    return res.data;
  }

  private async withAirports(place: Place): Promise<Place> {
    const amadeus = this.deps.registry.amadeus;
    if (!amadeus) return place;
    const res = await amadeus.nearestAirports(place.coordinates);
    if (!isOk(res)) return place;
    return {
      ...place,
      airports: res.data,
      iataCityCode: place.iataCityCode ?? res.data[0]?.iataCode,
    };
  }

  /**
   * Budget answers arrive as money values and belong on the constraint set.
   * Everything already stated is preserved so answering one budget question
   * does not erase another.
   */
  private budgetFrom(session: PlanningSession, profile: TravelerProfile, answer: ValidatedAnswer): BudgetAnswers {
    // Only what the traveller stated. The transport and accommodation splits
    // are derived from the total, and passing them back in as if stated used
    // to turn them into fixed hard constraints on the next answer.
    const existing = statedBudget(session.constraints, profile);

    // The answer has already been validated against its question, so a
    // money question's value is a positive amount in the trip's currency.
    if (answer.key === 'budget.total' && !answer.skipped) {
      return { ...existing, total: answer.value as Money };
    }
    if (answer.key === 'budget.daily_spend') {
      // Skipping withdraws an allowance given earlier, rather than keeping it.
      return { ...existing, dailySpendPerPerson: answer.skipped ? null : (answer.value as Money) };
    }
    return existing;
  }
}

export interface ModificationResult {
  session: PlanningSession;
  /**
   * no_change: nothing was changed, and `interpretation` says why.
   * needs_consent: nothing changes until the question in `consent` is answered.
   * applied: the change is saved and, where needed, plans were rebuilt.
   * saved: the change is saved; plans will use it when next built.
   */
  status: 'no_change' | 'needs_consent' | 'applied' | 'saved';
  /** Written from the validated request and the engine's outcome, never by a model. */
  interpretation: string;
  reSearched: TripComponent[];
  kept: TripComponent[];
  released: Array<{ component: TripComponent; reason: string }>;
  consent: { id: string; question: string; acceptLabel: string; declineLabel: string } | null;
  understoodBy: string;
  result: PlanGenerationResult | null;
  /** For operators only: why the model was not used, and what it proposed that failed validation. */
  diagnostics: { llmFallbackReason: string | null; rejectedParameters: string[] };
}

function selectedPlanOf(session: PlanningSession): TripPlan | undefined {
  return session.plans.find((p) => p.id === session.selectedPlanId) ?? session.plans[0];
}

/** The parts a plan actually has, so the engine knows what can be kept. */
function componentsOf(plan: TripPlan | undefined): TripComponent[] {
  if (!plan) return [];
  const parts: TripComponent[] = [];
  if (plan.outboundTransport) parts.push('outbound');
  if (plan.returnTransport) parts.push('return');
  if (plan.hotels.length > 0) parts.push('hotel');
  if (plan.transfers.length > 0) parts.push('transfers');
  if (plan.activities.length > 0) parts.push('activities');
  return parts;
}

/**
 * Drops a modification that is waiting for consent, recording why. Its
 * answers were worked out against the trip as it was; once the trip changes
 * in any other way, applying them would silently undo that change.
 */
function withdrawPending(
  session: PlanningSession,
  why: string,
): Partial<Pick<PlanningSession, 'pendingModification' | 'decisionLog' | 'stage'>> {
  if (!session.pendingModification) return {};
  return {
    pendingModification: null,
    stage: session.plans.length > 0 ? 'planned' : 'profiling',
    decisionLog: [
      ...session.decisionLog,
      {
        at: new Date().toISOString(),
        step: 'consent',
        detail: `No longer waiting for an answer to "${session.pendingModification.question}", because ${why}.`,
      },
    ],
  };
}

/** Provider notes repeat across searches; the traveller only needs each once. */
function dedupeNotes(notes: ProviderNote[]): ProviderNote[] {
  const seen = new Map<string, ProviderNote>();
  for (const note of notes) {
    seen.set(`${note.provider}|${note.status}|${note.message}`, note);
  }
  return [...seen.values()];
}
