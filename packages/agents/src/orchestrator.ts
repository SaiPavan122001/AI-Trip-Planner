import {
  checkPins,
  generatePlans,
  type KeptComponents,
  type PlanGenerationDeps,
  type PlanGenerationResult,
  type PlanProgress,
} from '@trip/engine';
import type { ProviderRegistry } from '@trip/providers';
import type {
  AgentTraceEntry,
  ConstraintSet,
  JourneyClassification,
  ProviderNote,
  RequirementsState,
  TransportMode,
  TravelerProfile,
  TripComponent,
  TripIntent,
  TripPlan,
} from '@trip/shared';
import { nightsBetween } from '@trip/shared';
import type { AgentContext, AgentError, AgentMeta, AgentOutcome } from './contract.js';
import { runAccommodationAgent } from './guidance/accommodation.js';
import { runActivityAgent } from './guidance/activity.js';
import { applyGuidance, noGuidance, type AppliedGuidance, type PlanGuidance } from './guidance/apply.js';
import { statedFrom } from './guidance/common.js';
import { consultableModes, runTransportAgent } from './guidance/transport.js';
import { runSynthesisAgent } from './synthesis/agent.js';
import { buildFacts } from './synthesis/facts.js';
import { summaryText, templateNarrative, type Narrative } from './synthesis/template.js';
import { validatePlans, type ValidationReport } from './validation-service.js';

/**
 * The Orchestrator: one fixed, deterministic workflow that coordinates the
 * agents and the services, and is the only thing that does.
 *
 *   guidance agents (transport, accommodation, activity)   -- may fail; degrade
 *        │  proposals, checked and reduced to soft guidance
 *        ▼
 *   apply guidance      -- fills gaps in soft preferences, nothing else
 *        ▼
 *   plan search         -- deterministic services: providers, itinerary, cost,
 *        │                 the engine's own validation
 *        ▼
 *   validation service  -- independent final gate; blockers, re-rank
 *        ▼
 *   synthesis agent     -- words, from facts, fact-checked; template on failure
 *
 * What this file guarantees, and what the tests hold it to:
 *  - Order and control flow are code, not something a model decides. There is
 *    no agent that plans, and no agent that calls another.
 *  - Agents receive structured input and return structured, checked output.
 *    None writes to a store or calls a provider; the orchestrator does not
 *    persist either. It returns a result and the caller decides what to save,
 *    under the caller's own authorisation and version checks.
 *  - A guidance agent that fails costs guidance, not the search. A request that
 *    cannot be met (an impossible constraint) is reported before any provider
 *    is called. A plan that fails validation is never presented as workable.
 *  - Every stage leaves a trace entry, so a search can be explained afterwards.
 *  - Cancellation is honoured between stages and passed into agents and
 *    providers.
 */

/** The deterministic side, behind a port so it can be stood in for in tests and moved out later. */
export interface PlanningServices {
  buildPlans(deps: PlanGenerationDeps): Promise<PlanGenerationResult>;
}

/** The default: the engine that searches, schedules, costs and validates. */
export const engineServices: PlanningServices = { buildPlans: generatePlans };

export interface OrchestratorDeps {
  registry: ProviderRegistry;
  /** Carries the model (or null) and limits shared by every agent. */
  agents: Omit<AgentContext, 'signal'>;
  services?: PlanningServices;
  now?: () => number;
}

export interface OrchestratorInput {
  intent: TripIntent;
  profile: TravelerProfile;
  constraints: ConstraintSet;
  classification: JourneyClassification;
  /** What the traveller said in words, if anything. Grounds the guidance agents. */
  requirements: RequirementsState | null;
  /** Parts to carry over unchanged. Already checked against the trip by the caller. */
  keep?: KeptComponents;
  /** Pins that could not be kept and why, for the explanation. */
  pinsReleased?: Array<{ component: string; reason: string }>;
  signal?: AbortSignal;
  onProgress?: (progress: PlanProgress) => void;
}

export type OrchestrationStatus =
  /** At least one plan can be carried out. */
  | 'planned'
  /** Plans exist but every one has a blocker. They are returned, marked. */
  | 'no_valid_plan'
  /** The providers returned nothing to build a plan from. */
  | 'no_plans'
  /** The request cannot be met by anything that exists for this trip. No provider was called. */
  | 'impossible';

export interface OrchestrationResult {
  status: OrchestrationStatus;
  /** The engine's search output, for the comparison view. Null when nothing was searched. */
  search: PlanGenerationResult | null;
  /** Validated and ranked; plans with blockers last, each carrying its blockers. */
  plans: TripPlan[];
  narrative: Narrative;
  guidance: PlanGuidance;
  applied: AppliedGuidance | null;
  trace: AgentTraceEntry[];
  /** Set when status is `impossible`. */
  error: AgentError | null;
  notes: ProviderNote[];
  validation: ValidationReport | null;
}

const traceOf = (
  stage: AgentTraceEntry['stage'],
  kind: AgentTraceEntry['kind'],
  status: AgentTraceEntry['status'],
  detail: string,
  meta?: Pick<AgentMeta, 'source' | 'durationMs' | 'warnings' | 'rejected'>,
  durationMs = 0,
): AgentTraceEntry => ({
  stage,
  kind,
  status,
  source: kind === 'agent' && meta ? meta.source : null,
  durationMs: meta?.durationMs ?? durationMs,
  detail,
  warnings: (meta?.warnings ?? []).slice(0, 10),
  rejected: (meta?.rejected ?? []).slice(0, 20),
});

export class PlanningOrchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  private get services(): PlanningServices {
    return this.deps.services ?? engineServices;
  }

  async plan(input: OrchestratorInput): Promise<OrchestrationResult> {
    const now = this.deps.now ?? Date.now;
    const trace: AgentTraceEntry[] = [];
    const ctx: AgentContext = { ...this.deps.agents, ...(input.signal ? { signal: input.signal } : {}) };
    const checkpoint = () => input.signal?.throwIfAborted();
    const emit = (p: PlanProgress) => {
      checkpoint();
      input.onProgress?.(p);
      checkpoint();
    };

    const { intent, profile, classification } = input;
    const stated = statedFrom(input.requirements);
    emit({ step: 'guidance', label: 'Thinking about how to travel and what to look for', percent: 3 });

    // ---- 1. guidance agents: independent, so they run together ---------------
    const excludedModes = profile.transport.excludedModes.filter((m): m is TransportMode =>
      classification.eligibleModes.includes(m as TransportMode),
    );
    const requiredMode = (input.requirements?.hard.find((h) => h.kind === 'required_mode')?.value ?? null) as TransportMode | null;
    const nights = nightsBetween(intent.departureDate, intent.returnDate);

    const transportInput = {
      scope: classification.scope,
      eligibleModes: classification.eligibleModes,
      excludedModes,
      requiredMode,
      currentPreferredMode: profile.transport.preferredMode,
      stated,
    };

    const guidance = noGuidance();

    // A request nothing can satisfy is said before anything else is spent on
    // it: no model call, no provider call. This conclusion is arithmetic on
    // sets, so it does not wait for, or depend on, a model.
    const feasible = consultableModes(transportInput);
    if (!feasible.ok) {
      const error: AgentError = { code: 'impossible', message: feasible.message };
      trace.push(traceOf('transport_agent', 'agent', 'failed', 'The request cannot be met for this journey.', { source: 'rules', durationMs: 0, warnings: [], rejected: [] }));
      const facts = buildFacts({
        intent,
        constraints: input.constraints,
        plans: [],
        results: [],
        requirements: input.requirements,
        pinsReleased: input.pinsReleased ?? [],
        guidanceApplied: [],
        providerNotes: [],
      });
      const narrative = templateNarrative(facts);
      narrative.summary = `${feasible.message} Nothing was searched, and nothing has been booked or charged. Change that requirement, or ask for something else, and I will try again.`;
      return { status: 'impossible', search: null, plans: [], narrative, guidance, applied: null, trace, error, notes: [], validation: null };
    }

    const [transportOutcome, accommodationOutcome, activityOutcome] = await Promise.all([
      runTransportAgent(transportInput, ctx),
      runAccommodationAgent({ nights, travelers: intent.travelers, stated }, ctx),
      runActivityAgent({ days: Math.max(0, nights - 1), stated }, ctx),
    ]);
    checkpoint();

    if (transportOutcome.ok) guidance.transport = transportOutcome.data;
    if (accommodationOutcome.ok) guidance.accommodation = accommodationOutcome.data;
    if (activityOutcome.ok) guidance.activities = activityOutcome.data;
    trace.push(this.agentTrace('transport_agent', transportOutcome, guidance.transport ? `Considering ${guidance.transport.consult.join(', ')}.` : 'No transport guidance.'));
    trace.push(this.agentTrace('accommodation_agent', accommodationOutcome, guidance.accommodation?.area || guidance.accommodation?.amenities.length ? 'Stay preferences read from what was said.' : 'No stay preferences to add.'));
    trace.push(this.agentTrace('activity_agent', activityOutcome, guidance.activities?.interests.length ? 'Interests read from what was said.' : 'No activity interests to add.'));

    // ---- 2. guidance fills gaps in soft preferences ----------------------------
    const applied = applyGuidance(profile, guidance);
    trace.push(
      traceOf('guidance', 'service', applied.applied.length > 0 ? 'ok' : 'skipped',
        applied.applied.length > 0 ? applied.applied.join(' ') : 'Nothing from the agents changed the search.',
        { source: 'rules', durationMs: 0, warnings: applied.notApplied, rejected: [] }),
    );

    // ---- 3. the deterministic search -------------------------------------------
    const started = now();
    const search = await this.services.buildPlans({
      registry: this.deps.registry,
      intent,
      profile: applied.profile,
      constraints: input.constraints,
      ...(input.keep ? { keep: input.keep } : {}),
      activityGuidance: applied.activityGuidance,
      ...(input.signal ? { signal: input.signal } : {}),
      onProgress: (p) => input.onProgress?.(p),
    });
    checkpoint();
    trace.push(
      traceOf('plan_search', 'service', search.plans.length > 0 ? 'ok' : 'degraded',
        search.plans.length > 0 ? `${search.plans.length} plan(s) built.` : 'The providers returned nothing to build a plan from.',
        undefined, Math.max(0, now() - started)),
    );

    // ---- 4. validation: the last gate --------------------------------------------
    emit({ step: 'validate', label: 'Checking every plan', percent: 96 });
    const validationStart = now();
    const validation = validatePlans({
      intent,
      profile: applied.profile,
      constraints: input.constraints,
      plans: search.plans,
      ...(input.keep ? { kept: input.keep } : {}),
    });
    const blocked = validation.results.filter((r) => !r.valid).length;
    trace.push(
      traceOf('validation', 'service', blocked === 0 ? 'ok' : 'degraded',
        search.plans.length === 0
          ? 'There were no plans to check.'
          : blocked === 0 ? 'Every plan passed.' : `${blocked} of ${search.plans.length} plan(s) failed a check and are marked as not workable.`,
        undefined, Math.max(0, now() - validationStart)),
    );

    // ---- 5. synthesis ---------------------------------------------------------------
    emit({ step: 'explain', label: 'Writing it up', percent: 98 });
    const notes = [...search.notes];
    const facts = buildFacts({
      intent,
      constraints: input.constraints,
      plans: validation.plans,
      results: validation.results,
      requirements: input.requirements,
      pinsReleased: input.pinsReleased ?? [],
      guidanceApplied: applied.applied,
      providerNotes: notes,
      feasibility: search.feasibility,
    });
    const synthesis: AgentOutcome<Narrative> = await runSynthesisAgent(facts, ctx);
    checkpoint();
    const narrative = synthesis.ok ? synthesis.data : { ...templateNarrative(facts), summary: summaryText(facts) };
    trace.push(this.agentTrace('synthesis_agent', synthesis, narrative.source === 'template' ? 'Explanation written from the facts.' : 'Explanation written and checked against the facts.'));

    const status: OrchestrationStatus =
      search.plans.length === 0 ? 'no_plans' : validation.anyValid ? 'planned' : 'no_valid_plan';

    return { status, search, plans: validation.plans, narrative, guidance, applied, trace, error: null, notes, validation };
  }

  /**
   * Re-plans after a change to the trip (new dates, a different group).
   *
   * Every agent runs again, because what they concluded was about the old trip;
   * every search runs again for what is not kept; the budget is recomputed
   * because the plans are new; and the traveller's pins are checked against the
   * new trip first, by the same rules the API applies. A pin that no longer
   * fits is released with its reason, and the release is carried into the
   * explanation, never silent.
   */
  async replan(
    input: Omit<OrchestratorInput, 'keep' | 'pinsReleased'> & {
      pins: TripComponent[];
      /** The plan the pins were taken from. */
      previous: TripPlan | null;
    },
  ): Promise<OrchestrationResult & { pinsReleased: Array<{ component: TripComponent; reason: string }> }> {
    const check = checkPins({
      intent: input.intent,
      plans: input.previous ? [input.previous] : [],
      selectedPlanId: input.previous?.id ?? null,
      pins: input.pins,
    });
    const from = input.previous;
    const keep: KeptComponents = from
      ? {
          outbound: check.keep.includes('outbound') ? from.outboundTransport : null,
          return: check.keep.includes('return') ? from.returnTransport : null,
          hotel: check.keep.includes('hotel') ? (from.hotels[0] ?? null) : null,
          activities: check.keep.includes('activities') && from.activities.length > 0 ? from.activities : null,
        }
      : {};
    const result = await this.plan({ ...input, keep, pinsReleased: check.released });
    return { ...result, pinsReleased: check.released };
  }

  private agentTrace<T>(stage: AgentTraceEntry['stage'], outcome: AgentOutcome<T>, okDetail: string): AgentTraceEntry {
    if (outcome.ok) {
      const degraded = outcome.meta.source === 'rules' && outcome.meta.warnings.length > 0;
      return traceOf(stage, 'agent', degraded ? 'degraded' : 'ok', okDetail, outcome.meta);
    }
    return traceOf(stage, 'agent', 'failed', outcome.error.message, outcome.meta);
  }
}
