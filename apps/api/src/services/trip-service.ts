import { randomUUID } from 'node:crypto';
import {
  AnswerValidationError,
  applyAnswer,
  applyModification,
  classifyJourney,
  questionnaireState,
  rebuildConstraints,
  statedBudget,
  type BudgetAnswers,
  type KeptComponents,
  type ValidatedAnswer,
} from '@trip/engine';
import type { ProviderRegistry } from '@trip/providers';
import type { TripLlm } from '@trip/llm';
import {
  Answer,
  TripComponent,
  TripIntentInput,
  emptyConstraintSet,
  emptyTravelerProfile,
  isOk,
  localParts,
  type Money,
  type PendingModification,
  type Place,
  type PlanningRunView,
  type PlanningSession,
  type ProposedChange,
  type TravelerProfile,
  type TripPlan,
} from '@trip/shared';
import { ApiError } from '../errors.js';
import type { RunRecord, Store } from '../repository/store.js';
import { TripChangedError } from '../repository/types.js';
import { checkPins, componentsOf, selectedPlanOf } from './pins.js';
import { runView, type Actor, type RunService } from './run-service.js';

/**
 * Trip planning use cases.
 *
 * The route layer handles HTTP; this handles the actual sequence of the
 * product: resolve where the traveller means, decide what kind of journey it
 * is, interview them, then plan. Each step persists the session, so a
 * traveller can close the tab and come back.
 *
 * Every method takes the person acting, and a trip that is not theirs is
 * reported as not found, the same as one that does not exist, so ids cannot
 * be probed for.
 */

export interface TripServiceDeps {
  registry: ProviderRegistry;
  llm: TripLlm;
  repository: Store;
  runs: RunService;
}

export class TripService {
  constructor(private readonly deps: TripServiceDeps) {}

  private get store(): Store {
    return this.deps.repository;
  }

  // ------------------------------------------------------------ ownership

  private async owned(id: string, actor: Actor): Promise<PlanningSession> {
    const session = await this.store.getSession(id);
    if (!session || session.ownerId !== actor.userId) throw ApiError.notFound('That trip');
    return session;
  }

  /**
   * Reads, changes and saves a trip. If another request saved it in between,
   * the whole thing is done again on what it saved: right for changes that are
   * worked out afresh from the trip each time (an answer, a pin, a selection),
   * where losing a race should not cost the traveller a retry.
   */
  private async mutate(
    id: string,
    actor: Actor,
    change: (session: PlanningSession) => PlanningSession | Promise<PlanningSession>,
  ): Promise<PlanningSession> {
    for (let attempt = 0; ; attempt += 1) {
      const session = await this.owned(id, actor);
      try {
        return await this.store.updateSession(await change(session));
      } catch (err) {
        if (!(err instanceof TripChangedError) || attempt >= 3) throw err;
      }
    }
  }

  private async audit(tripId: string, actor: Actor, kind: string, detail: Record<string, unknown>): Promise<void> {
    try {
      await this.store.recordAudit({ tripId, kind, actor: actor.userId, detail });
    } catch {
      // The trail is a record, not a gate.
    }
  }

  // ---------------------------------------------------------------- trips

  /**
   * Step one of the funnel, and the only step with required questions:
   * where from, where to, when, and how many people.
   */
  async createTrip(input: unknown, actor: Actor): Promise<PlanningSession> {
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
      ownerId: actor.userId,
      version: 0,
      pins: [],
      lastSearch: null,
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

    const created = await this.store.createSession(session);
    await this.audit(created.id, actor, 'trip.created', {});
    return created;
  }

  async getTrip(id: string, actor: Actor): Promise<PlanningSession> {
    return this.owned(id, actor);
  }

  /** The trip with the state of its latest background search, which is what a screen needs. */
  async getTripWithRun(id: string, actor: Actor): Promise<{ session: PlanningSession; run: PlanningRunView | null }> {
    const session = await this.owned(id, actor);
    const run = await this.store.latestRunForTrip(id);
    return { session, run: run ? runView(run) : null };
  }

  async listTrips(actor: Actor, limit: number): Promise<PlanningSession[]> {
    return this.store.listSessions(actor.userId, limit);
  }

  async deleteTrip(id: string, actor: Actor): Promise<void> {
    await this.owned(id, actor);
    // Its runs go with it; a worker in the middle of one finds its lease gone and stops.
    await this.store.deleteSession(id);
  }

  // -------------------------------------------------------------- answers

  /**
   * Records one answer and returns the next question. Budget answers are the
   * one case where the answer becomes a constraint rather than a preference,
   * so they are routed to the constraint builder.
   */
  async answer(id: string, actor: Actor, raw: unknown): Promise<PlanningSession> {
    const parsed = Answer.parse(raw);
    return this.mutate(id, actor, (session) => {
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

      let constraints = rebuildConstraints(
        session.intent,
        profile,
        session.constraints,
        this.budgetFrom(session, profile, answer),
      );
      // A new total budget replaces any earlier agreement to go over the old one.
      if (answer.key === 'budget.total') {
        constraints = { ...constraints, waivers: constraints.waivers.filter((w) => w.kind !== 'max_total_budget') };
      }

      return {
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
    });
  }

  // ---------------------------------------------------------------- pins

  /**
   * Sets which parts of the selected plan the traveller wants kept. Only
   * parts the plan actually has can be pinned, and the answer says which
   * were refused and why.
   */
  async setPins(
    id: string,
    actor: Actor,
    requested: TripComponent[],
  ): Promise<{ session: PlanningSession; refused: Array<{ component: TripComponent; reason: string }> }> {
    const refused: Array<{ component: TripComponent; reason: string }> = [];
    const session = await this.mutate(id, actor, (current) => {
      refused.length = 0;
      const plan = selectedPlanOf(current);
      const available = new Set(componentsOf(plan));
      const pins: TripComponent[] = [];
      for (const component of new Set(requested)) {
        if (component === 'transfers') {
          refused.push({ component, reason: 'Transfers are recalculated whenever the journey or hotel changes.' });
        } else if (!available.has(component)) {
          refused.push({ component, reason: 'The selected plan has nothing of that kind to keep.' });
        } else pins.push(component);
      }
      return {
        ...current,
        pins,
        decisionLog: [
          ...current.decisionLog,
          {
            at: new Date().toISOString(),
            step: 'pins',
            detail: pins.length ? `Kept as the traveller asked: ${pins.join(', ')}.` : 'No parts are being kept.',
          },
        ],
        updatedAt: new Date().toISOString(),
      };
    });
    await this.audit(id, actor, 'pins.changed', { pins: session.pins });
    return { session, refused };
  }

  // ------------------------------------------------------------- planning

  /**
   * Starts a search. It returns at once with the run, which a worker carries
   * out; the traveller watches it. Provider failures are attached to the
   * session rather than thrown, because "no trains are searchable" is
   * information the traveller needs, not an error that should lose their
   * whole session.
   *
   * Anything the traveller pinned is kept exactly, if it still fits the trip.
   * A pin that no longer fits is released and reported, not quietly kept.
   */
  async plan(
    id: string,
    actor: Actor,
  ): Promise<{
    session: PlanningSession;
    run: RunRecord;
    reused: boolean;
    pinsReleased: Array<{ component: TripComponent; reason: string }>;
  }> {
    let session = await this.owned(id, actor);
    if (session.questionnaire && !session.questionnaire.canPlan) {
      throw ApiError.unprocessable(
        'Some required answers are still missing, so a plan cannot be built yet.',
        { nextQuestion: session.questionnaire.next?.key ?? null },
      );
    }

    const check = checkPins(session);
    const withdrawn = withdrawPending(session, 'new plans were requested');
    if (check.released.length > 0 || withdrawn.pendingModification !== undefined) {
      const now = new Date().toISOString();
      session = await this.store.updateSession({
        ...session,
        ...withdrawn,
        pins: check.keep,
        decisionLog: [
          ...(withdrawn.decisionLog ?? session.decisionLog),
          ...check.released.map((r) => ({ at: now, step: 'pins', detail: `Released ${r.component}: ${r.reason}` })),
        ],
        updatedAt: now,
      });
    }

    const { run, reused } = await this.deps.runs.enqueue(session, actor, {
      kind: session.plans.length > 0 ? 'replan' : 'plan',
      keep: keptFrom(selectedPlanOf(session), check.keep),
      reason: 'The traveller asked for plans.',
    });
    return { session, run, reused, pinsReleased: check.released };
  }

  async getRun(id: string, actor: Actor, runId: string): Promise<PlanningRunView> {
    await this.owned(id, actor);
    const run = await this.store.getRun(runId);
    if (!run || run.tripId !== id) throw ApiError.notFound('That search');
    return runView(run);
  }

  async cancelRun(id: string, actor: Actor, runId: string): Promise<PlanningRunView> {
    await this.getRun(id, actor, runId);
    const run = await this.deps.runs.cancel(runId);
    if (!run) throw ApiError.notFound('That search');
    await this.audit(id, actor, 'run.cancel_requested', { runId });
    return runView(run);
  }

  // --------------------------------------------------------- modification

  /**
   * Conversational modification. The model only classifies what was asked;
   * the engine works out, in full, what that means for this trip. A change
   * that needs the traveller's say-so is stored and asked about; everything
   * else is applied, keeping pinned parts of the plan exactly as they were.
   */
  async modify(id: string, actor: Actor, utterance: string): Promise<ModificationResult> {
    const session = await this.owned(id, actor);
    await this.refuseWhileSearching(id);
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

    // What the traveller said to keep, and what they had already pinned.
    const pinned = [...new Set([...session.pins, ...interpreted.request.pinnedComponents])];
    const outcome = applyModification(
      { ...interpreted.request, pinnedComponents: pinned },
      {
        intent: session.intent,
        classification: session.classification,
        profile: session.profile,
        constraints: session.constraints,
        planComponents: componentsOf(selected),
      },
    );

    // A new request replaces any question still waiting for an answer.
    const base = { ...session, ...withdrawPending(session, 'a new change was requested') };

    if (outcome.status === 'no_change') {
      const saved =
        base.pendingModification !== session.pendingModification
          ? await this.store.updateSession({ ...base, updatedAt: new Date().toISOString() })
          : base;
      return {
        ...common,
        session: saved,
        status: 'no_change',
        interpretation: outcome.summary,
        reSearched: [],
        kept: [],
        released: [],
        consent: null,
        run: null,
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
      const staged = await this.store.updateSession({
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
        run: null,
      };
    }

    return {
      ...common,
      ...(await this.commit(base, actor, pinned, outcome.change, `"${utterance}" → ${interpreted.request.intent}.`)),
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
    actor: Actor,
    pendingId: string,
    accept: boolean,
  ): Promise<Omit<ModificationResult, 'understoodBy' | 'diagnostics'>> {
    const session = await this.owned(id, actor);
    const pending = session.pendingModification;
    if (!pending || pending.id !== pendingId) {
      throw ApiError.conflict(
        'That change is no longer waiting for an answer. Ask for it again if you still want it.',
        'consent_stale',
      );
    }
    await this.refuseWhileSearching(id);

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
    await this.audit(id, actor, accept ? 'consent.accepted' : 'consent.declined', {
      intent: pending.intent,
      question: pending.question,
    });

    if (!change) {
      const saved = await this.store.updateSession({ ...cleared, updatedAt: new Date().toISOString() });
      return {
        session: saved,
        status: 'no_change',
        interpretation: 'Nothing has changed.',
        reSearched: [],
        kept: [],
        released: [],
        consent: null,
        run: null,
      };
    }
    return this.commit(cleared, actor, session.pins, change, `${accept ? 'Accepted' : 'Declined'} "${pending.utterance}".`);
  }

  /** A change while a search is running would be made against plans about to be replaced. */
  private async refuseWhileSearching(id: string): Promise<void> {
    const active = await this.store.activeRunForTrip(id);
    if (active) {
      throw ApiError.conflict(
        'Your plans are still being built. Wait for them to finish, or stop the search, before changing the trip.',
        'run_in_progress',
        { run: runView(active) },
      );
    }
  }

  /**
   * Applies a worked-out change: the new trip facts, preferences and
   * constraints are saved, the parts the change keeps are taken from the
   * selected plan exactly as they are, and only the rest is searched again,
   * in the background.
   *
   * Pins the change could not honour are released, and reported, so the
   * traveller is told rather than left believing a part was kept.
   */
  private async commit(
    session: PlanningSession,
    actor: Actor,
    pinnedBefore: TripComponent[],
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
    const releasedComponents = new Set(change.released.map((r) => r.component));
    const updated: PlanningSession = {
      ...session,
      intent: change.intent,
      profile: change.profile,
      constraints: change.constraints,
      questionnaire,
      pins: pinnedBefore.filter((p) => !releasedComponents.has(p)),
      pendingModification: null,
      decisionLog: [
        ...session.decisionLog,
        { at: now, step: 'modify', detail: `${detail} ${change.summary}` },
        ...change.released.map((r) => ({ at: now, step: 'pins', detail: `Released ${r.component}: ${r.reason}` })),
      ],
      updatedAt: now,
    };
    const answer = { reSearched: change.reSearch, kept: change.keep, released: change.released, consent: null };

    // Nothing to re-plan yet: no plan exists, or a changed trip now needs one
    // more answer before plans can be built. Plans for the old trip are not
    // left looking current.
    if (!selected || !questionnaire.canPlan) {
      const saved = await this.store.updateSession({
        ...updated,
        ...(tripChanged ? { plans: [], selectedPlanId: null, lastSearch: null } : {}),
        stage: selected && !tripChanged ? 'planned' : 'profiling',
      });
      const next =
        selected && !questionnaire.canPlan
          ? ' One more question needs answering before new plans can be built.'
          : ' Your plans will use this when you next search.';
      return { ...answer, session: saved, status: 'saved', interpretation: `${change.summary}${next}`, run: null };
    }

    // Everything the change touches was pinned: the plan stays as it is.
    if (change.reSearch.length === 0 && !tripChanged) {
      const saved = await this.store.updateSession({ ...updated, stage: 'planned' });
      return { ...answer, session: saved, status: 'applied', interpretation: change.summary, run: null };
    }

    // The search is queued against the trip as it will be saved, and the
    // parts to keep are captured now, because a changed trip's old plans are
    // cleared below and the search must not depend on them still being there.
    const staged: PlanningSession = {
      ...updated,
      stage: 'searching',
      ...(tripChanged ? { plans: [], selectedPlanId: null, lastSearch: null } : {}),
    };
    await this.deps.runs.assertQuota(actor);
    const saved = await this.store.updateSession(staged);
    const { run } = await this.deps.runs.enqueue(saved, actor, {
      kind: 'replan',
      keep: keptFrom(selected, change.keep),
      reason: change.summary,
    });
    return {
      ...answer,
      session: saved,
      status: 'replanning',
      interpretation: change.summary,
      run: runView(run),
    };
  }

  async selectPlan(id: string, actor: Actor, planId: string): Promise<PlanningSession> {
    return this.mutate(id, actor, (session) => {
      if (!session.plans.some((p) => p.id === planId)) throw ApiError.notFound('That plan');
      return { ...session, selectedPlanId: planId, updatedAt: new Date().toISOString() };
    });
  }

  // --------------------------------------------------------------- places

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
    if (answer.key === 'budget.firm') {
      // Skipping means "a guide", which is also the default.
      return { ...existing, firm: !answer.skipped && answer.value === 'firm' };
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
   * replanning: the change is saved and new plans are being built; see `run`.
   * applied: the change is saved and needed no new search.
   * saved: the change is saved; plans will use it when next built.
   */
  status: 'no_change' | 'needs_consent' | 'replanning' | 'applied' | 'saved';
  /** Written from the validated request and the engine's outcome, never by a model. */
  interpretation: string;
  reSearched: TripComponent[];
  kept: TripComponent[];
  /** Pins that could not be honoured, each with the reason. */
  released: Array<{ component: TripComponent; reason: string }>;
  consent: { id: string; question: string; acceptLabel: string; declineLabel: string } | null;
  understoodBy: string;
  run: PlanningRunView | null;
  /** For operators only: why the model was not used, and what it proposed that failed validation. */
  diagnostics: { llmFallbackReason: string | null; rejectedParameters: string[] };
}

/** The parts of a plan to carry into the next search unchanged. */
function keptFrom(plan: TripPlan | undefined, keep: TripComponent[]): KeptComponents {
  if (!plan) return {};
  return {
    outbound: keep.includes('outbound') ? plan.outboundTransport : null,
    return: keep.includes('return') ? plan.returnTransport : null,
    hotel: keep.includes('hotel') ? (plan.hotels[0] ?? null) : null,
    activities: keep.includes('activities') && plan.activities.length > 0 ? plan.activities : null,
  };
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

