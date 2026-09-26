import { randomUUID } from 'node:crypto';
import {
  AnswerValidationError,
  applyAnswer,
  type ValidatedAnswer,
  buildConstraints,
  classifyJourney,
  generatePlans,
  questionnaireState,
  applyModification,
  type BudgetAnswers,
  type PlanGenerationResult,
} from '@trip/engine';
import type { ProviderRegistry } from '@trip/providers';
import type { TripLlm } from '@trip/llm';
import {
  Answer,
  TripIntentInput,
  emptyConstraintSet,
  emptyTravelerProfile,
  isOk,
  type Money,
  type Place,
  type PlanningSession,
  type ProviderNote,
  type TravelerProfile,
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

    const budget = this.budgetFrom(session, answer);
    const constraints = buildConstraints(session.intent, profile, budget);

    const updated: PlanningSession = {
      ...session,
      profile,
      constraints,
      questionnaire: questionnaireState({
        intent: session.intent,
        classification: session.classification,
        profile,
      }),
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

    const updated: PlanningSession = {
      ...session,
      stage: result.plans.length > 0 ? 'planned' : 'searching',
      plans: result.plans,
      selectedPlanId: result.plans[0]?.id ?? null,
      providerNotes: dedupeNotes([...session.providerNotes, ...result.notes]),
      decisionLog: [...session.decisionLog, ...result.decisionLog],
      updatedAt: new Date().toISOString(),
    };

    await this.deps.repository.updateSession(updated);
    return { session: updated, result };
  }

  /**
   * Conversational modification. The model only classifies what was asked;
   * the engine decides what that means and what has to be searched again.
   */
  async modify(
    id: string,
    utterance: string,
  ): Promise<{
    session: PlanningSession;
    interpretation: string;
    reSearch: string[];
    preserved: string[];
    requiresConsent: { constraint: string; question: string } | null;
    understoodBy: string;
    result: PlanGenerationResult | null;
  }> {
    const session = await this.getTrip(id);
    const selected = session.plans.find((p) => p.id === session.selectedPlanId) ?? session.plans[0];

    const { request, interpretation, fromFallback } = await this.deps.llm.interpretModification(
      utterance,
      {
        hasHotel: Boolean(selected?.hotels.length),
        modes: session.classification.eligibleModes,
      },
    );

    const outcome = applyModification(request, session.intent, session.profile, session.constraints);

    // Nothing was understood well enough to act on, so nothing is changed and
    // the traveller is told exactly that.
    if (request.intent === 'unknown' || outcome.reSearch.length === 0) {
      return {
        session,
        interpretation: outcome.summary,
        reSearch: [],
        preserved: outcome.preserved,
        requiresConsent: outcome.requiresConsent,
        understoodBy: fromFallback ? 'rules' : this.deps.llm.label,
        result: null,
      };
    }

    // A change that would breach a hard constraint waits for explicit consent.
    if (outcome.requiresConsent) {
      const staged: PlanningSession = {
        ...session,
        stage: 'modifying',
        updatedAt: new Date().toISOString(),
      };
      await this.deps.repository.updateSession(staged);
      return {
        session: staged,
        interpretation: `${interpretation} ${outcome.summary}`,
        reSearch: outcome.reSearch,
        preserved: outcome.preserved,
        requiresConsent: outcome.requiresConsent,
        understoodBy: fromFallback ? 'rules' : this.deps.llm.label,
        result: null,
      };
    }

    const result = await generatePlans({
      registry: this.deps.registry,
      intent: session.intent,
      profile: outcome.profile,
      constraints: outcome.constraints,
    });

    const updated: PlanningSession = {
      ...session,
      stage: 'planned',
      profile: outcome.profile,
      constraints: outcome.constraints,
      plans: result.plans,
      selectedPlanId: result.plans[0]?.id ?? null,
      providerNotes: dedupeNotes([...session.providerNotes, ...result.notes]),
      decisionLog: [
        ...session.decisionLog,
        {
          at: new Date().toISOString(),
          step: 'modify',
          detail: `"${utterance}" → ${request.intent}. ${outcome.summary}`,
        },
        ...result.decisionLog,
      ],
      updatedAt: new Date().toISOString(),
    };

    await this.deps.repository.updateSession(updated);
    return {
      session: updated,
      interpretation: `${interpretation} ${outcome.summary}`,
      reSearch: outcome.reSearch,
      preserved: outcome.preserved,
      requiresConsent: null,
      understoodBy: fromFallback ? 'rules' : this.deps.llm.label,
      result,
    };
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
  private budgetFrom(session: PlanningSession, answer: ValidatedAnswer): BudgetAnswers {
    const existing: BudgetAnswers = {
      total: session.constraints.budget.total,
      transport: session.constraints.budget.transport,
      accommodation: session.constraints.budget.accommodation,
      dailySpendPerPerson: session.constraints.budget.dailySpend,
    };

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

/** Provider notes repeat across searches; the traveller only needs each once. */
function dedupeNotes(notes: ProviderNote[]): ProviderNote[] {
  const seen = new Map<string, ProviderNote>();
  for (const note of notes) {
    seen.set(`${note.provider}|${note.status}|${note.message}`, note);
  }
  return [...seen.values()];
}
