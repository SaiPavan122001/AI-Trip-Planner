/**
 * Typed client for the planning API.
 *
 * Errors from the API carry a code and a sentence written for a traveller, so
 * this client preserves both rather than collapsing everything into "request
 * failed". The UI shows the API's own message: it is the one that knows which
 * provider was unavailable and why.
 */

import type { Question } from '@trip/shared';
// The dependency-free entry point, so the browser bundle does not pull in the
// schema library the rest of @trip/shared uses.
import { minorUnitExponent } from '@trip/shared/currency';

export interface ApiFailure {
  code: string;
  message: string;
  details?: unknown;
  provider?: { id: string; label: string; status: string };
}

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly failure: ApiFailure,
  ) {
    super(failure.message);
    this.name = 'ApiClientError';
  }
}

const BASE_URL =
  process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:4000';

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
      cache: 'no-store',
      // The session lives in a cookie the browser keeps; without this it is
      // neither sent to the API nor stored from its answer.
      credentials: 'include',
    });
  } catch {
    throw new ApiClientError(0, {
      code: 'network_error',
      message:
        'The planning service could not be reached. Check that the API is running on ' + BASE_URL,
    });
  }

  if (response.status === 204) return undefined as T;

  const body = (await response.json().catch(() => null)) as
    | { error?: ApiFailure }
    | T
    | null;

  if (!response.ok) {
    const failure =
      body && typeof body === 'object' && 'error' in body && body.error
        ? body.error
        : { code: 'unknown', message: `Request failed with status ${response.status}.` };
    throw new ApiClientError(response.status, failure);
  }

  return body as T;
}

export interface TravelerCounts {
  adults: number;
  children: number;
  infants: number;
}

export interface CreateTripInput {
  originQuery: string;
  destinationQuery: string;
  departureDate: string;
  returnDate: string | null;
  travelers: TravelerCounts;
  currency: string;
}

export const api = {
  createTrip: (input: CreateTripInput) =>
    request<{ trip: TripSession }>('/v1/trips', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /** The trip, and its latest background search (which may have finished, failed or still be going). */
  getTrip: (id: string) => request<{ trip: TripSession; run: PlanningRun | null }>(`/v1/trips/${id}`),

  /** Summaries, enough to recognise a trip and open it; `getTrip` has the whole document. */
  listTrips: () => request<{ trips: TripSummary[] }>('/v1/trips'),

  /**
   * Tell the planner more, in your own words. What is understood is checked and
   * applied through the same answers as the interview; the reply says what was
   * applied, what could not be, and what still needs the change flow.
   */
  sayInWords: (id: string, message: string) =>
    request<RequirementsReply>(`/v1/trips/${id}/requirements`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),

  deleteTrip: (id: string) => request<void>(`/v1/trips/${id}`, { method: 'DELETE' }),

  answer: (id: string, key: string, value: unknown, skipped = false) =>
    request<{ trip: TripSession }>(`/v1/trips/${id}/answers`, {
      method: 'POST',
      body: JSON.stringify({ key, value, skipped }),
    }),

  /** Starts the search in the background; returns the run to watch. */
  plan: (id: string) => request<PlanStarted>(`/v1/trips/${id}/plan`, { method: 'POST' }),

  getRun: (id: string, runId: string) =>
    request<{ run: PlanningRun }>(`/v1/trips/${id}/runs/${runId}`),

  cancelRun: (id: string, runId: string) =>
    request<{ run: PlanningRun }>(`/v1/trips/${id}/runs/${runId}/cancel`, { method: 'POST' }),

  /** Replaces the set of parts of the selected plan to keep. */
  setPins: (id: string, pins: string[]) =>
    request<{ trip: TripSession; refused: Array<{ component: string; reason: string }> }>(
      `/v1/trips/${id}/pins`,
      { method: 'PUT', body: JSON.stringify({ pins }) },
    ),

  selectPlan: (id: string, planId: string) =>
    request<{ trip: TripSession }>(`/v1/trips/${id}/select`, {
      method: 'POST',
      body: JSON.stringify({ planId }),
    }),

  modify: (id: string, utterance: string) =>
    request<ModifyResponse>(`/v1/trips/${id}/modify`, {
      method: 'POST',
      body: JSON.stringify({ utterance }),
    }),

  answerModification: (id: string, pendingModificationId: string, accept: boolean) =>
    request<ModifyResponse>(`/v1/trips/${id}/modify/consent`, {
      method: 'POST',
      body: JSON.stringify({ pendingModificationId, accept }),
    }),

  providers: () => request<ProvidersResponse>('/v1/providers'),

  // ------------------------------------------------------------- account

  me: () => request<Me>('/v1/me'),

  requestSignInLink: (email: string) =>
    request<{ message: string; devLink?: string }>('/v1/auth/magic-link', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  verifySignInLink: (token: string) =>
    request<{ user: MeUser; tripsMoved: number }>('/v1/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),

  signOut: () => request<void>('/v1/auth/logout', { method: 'POST' }),

  deleteAccount: () =>
    request<void>('/v1/me', { method: 'DELETE', body: JSON.stringify({ confirm: 'delete my account' }) }),

  /** Where the browser can fetch the person's data as a file. */
  exportUrl: `${BASE_URL}/v1/me/export`,
};

// ----------------------------------------------------------------- shapes
// Mirrors of the API's response envelopes. The domain types themselves come
// from @trip/shared; these describe only what each endpoint wraps them in.

export interface Money {
  amount: number;
  currency: string;
}

export interface MeUser {
  id: string;
  email: string | null;
  isAnonymous: boolean;
}

export interface Me {
  user: MeUser | null;
  tripCount: number;
  /** False where the operator has not set up email, so sign-in cannot be offered. */
  emailSignIn: boolean;
}

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'superseded';

/** A background search. */
export interface PlanningRun {
  id: string;
  tripId: string;
  kind: 'plan' | 'replan';
  status: RunStatus;
  progress: { step: string; label: string; percent: number } | null;
  error: { code: string; message: string } | null;
  cancelRequested: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export const isActiveRun = (run: PlanningRun | null | undefined): boolean =>
  run?.status === 'queued' || run?.status === 'running';

/** A trip as the list shows it. */
export interface TripSummary {
  id: string;
  stage: string;
  origin: string;
  destination: string;
  departureDate: string;
  returnDate: string | null;
  planCount: number;
  updatedAt: string;
}

/**
 * A link the API sent us, as something safe to put in an href: http(s) only.
 * Anything else (a script URL, say) is not a link, whatever sent it.
 */
export function safeHttpLink(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export interface TripSession {
  id: string;
  stage: string;
  /** Bumped on every save. */
  version: number;
  /** Parts of the selected plan the traveller asked to keep. */
  pins: string[];
  /** What the latest search found, kept so the comparison survives a reload. */
  lastSearch: SearchSummary | null;
  /** A change waiting for the traveller's answer; survives a page reload. */
  pendingModification: {
    id: string;
    question: string;
    acceptLabel: string;
    declineLabel: string;
  } | null;
  intent: {
    origin: { name: string; displayName: string; countryName: string; timezone: string };
    destination: { name: string; displayName: string; countryName: string; timezone: string };
    departureDate: string;
    returnDate: string | null;
    travelers: TravelerCounts;
    currency: string;
  };
  classification: {
    scope: 'domestic' | 'international';
    greatCircleKm: number;
    eligibleModes: string[];
    excludedModes: Array<{ mode: string; reason: string }>;
    documentationNotes: string[];
    originTimezone: string;
    destinationTimezone: string;
  };
  questionnaire: {
    next: Question | null;
    completeness: number;
    canPlan: boolean;
  } | null;
  /** The explanation of the latest plans, written from their checked facts. */
  narrative: {
    summary: string;
    plans: Record<string, string>;
    /** template: written in code. model: written by a language model and fact-checked. mixed: both. */
    source: 'model' | 'template' | 'mixed';
    builtAt: string;
  } | null;
  /** What the planning agents and services did on the latest search. */
  agentTrace: AgentTraceEntry[];
  /** What the traveller has said in words, as understood and checked. */
  statedRequirements: { soft: Array<{ kind: string; value: string }>; hard: Array<{ kind: string; value: string }> } | null;
  /** What the traveller said about money. `firm` is true only for "do not exceed". */
  constraints: { budget: { total: Money | null; firm: boolean } };
  plans: TripPlan[];
  selectedPlanId: string | null;
  providerNotes: Array<{
    provider: string;
    providerLabel: string;
    /** What the note is about (flights, hotels, ...). Absent on notes saved before it existed. */
    capability?: string;
    status: string;
    message: string;
  }>;
  decisionLog: Array<{ at: string; step: string; detail: string }>;
}

// The engine's own type, so the limits the UI enforces are exactly the ones
// the server validates against.
export type { Question };

export interface TransportOffer {
  id: string;
  mode: string;
  /** The fare. ₹0 for your own car is a real, known amount. */
  totalPrice: Money;
  pricePerTraveler: Money;
  itemisedFees: Array<{
    label: string;
    amount: Money;
    included: boolean;
    isEstimate: boolean;
    basis: string | null;
  }>;
  /** Costs this option involves that nothing can price, e.g. "Tolls". */
  unpricedCosts: string[];
  totalDurationMinutes: number;
  transfers: number;
  overnight: boolean;
  refundable: boolean | null;
  baggageSummary: string | null;
  fareClasses: Array<{
    code: string;
    label: string;
    cabin: string | null;
    price: Money;
    availabilityLabel: string | null;
    checkedBagsIncluded: number | null;
  }>;
  segments: Array<{
    mode: string;
    operatorName: string | null;
    serviceNumber: string | null;
    origin: { code: string | null; name: string; terminal: string | null };
    destination: { code: string | null; name: string; terminal: string | null };
    departureAt: string;
    arrivalAt: string;
    durationMinutes: number;
  }>;
  provenance: { providerLabel: string; retrievedAt: string; attribution: string | null };
}

export interface ItineraryItem {
  id: string;
  kind: string;
  title: string;
  description: string | null;
  startUtc: string;
  endUtc: string;
  timezone: string;
  locationName: string | null;
  cost: Money | null;
  costIsEstimate: boolean;
  notes: string[];
}

export interface TripPlan {
  id: string;
  archetype: string;
  label: string;
  rationale: string;
  outboundTransport: TransportOffer | null;
  returnTransport: TransportOffer | null;
  hotels: Array<{
    hotel: {
      id: string;
      name: string;
      category: number | null;
      address: string | null;
      amenities: string[];
      provenance: { providerLabel: string; retrievedAt: string };
    };
    room: {
      description: string;
      totalPrice: Money;
      pricePerNight: Money;
      refundable: boolean | null;
      breakfastIncluded: boolean | null;
      cancellationPolicy: string | null;
    };
    rooms: number;
    nights: number;
    distanceToActivitiesKm: number | null;
    impliedDailyTransportCost: Money | null;
  }>;
  /** The places chosen for the days; only their number is shown here. */
  activities: unknown[];
  days: Array<{ date: string; timezone: string; items: ItineraryItem[]; daySubtotal: Money }>;
  cost: {
    transport: Money;
    transportFees: Money;
    accommodation: Money;
    localTransport: Money;
    activities: Money;
    meals: Money;
    total: Money;
    perPerson: Money;
    estimatedPortion: Money;
    remainingBudget: Money | null;
    /** Costs no source could price; the total is complete only when empty. */
    notIncluded: Array<{ label: string; reason: string }>;
  };
  issues: Array<{
    code: string;
    severity: 'blocker' | 'warning' | 'info';
    message: string;
    suggestions: string[];
  }>;
  tradeoffs: string[];
  /** The decisions behind the plan and what was passed over. */
  choices: PlanChoice[];
  priorityScore: number;
  scoreBreakdown: Record<string, number>;
}

export interface PlanChoice {
  topic: 'outbound' | 'return' | 'stay' | 'room' | 'budget';
  chosen: string;
  why: string;
  alternatives: Array<{ label: string; note: string }>;
}

export interface FeasibilityFinding {
  code: string;
  severity: 'blocker' | 'warning' | 'info';
  message: string;
  suggestions: string[];
}

/** Whether the trip can be done as asked, and what stands in the way when it cannot. */
export interface FeasibilityReport {
  status: 'feasible' | 'partial' | 'infeasible';
  findings: FeasibilityFinding[];
}

export interface ModeSummary {
  mode: string;
  optionCount: number;
  cheapest: TransportOffer | null;
  fastest: TransportOffer | null;
  bestForYou: TransportOffer | null;
  allOffers: Array<{ candidate: TransportOffer; score: number; breakdown: Record<string, number> }>;
  unavailableReason: { providerLabel: string; status: string; message: string } | null;
}

export interface BudgetAdjustment {
  id: string;
  label: string;
  estimatedSaving: Money | null;
  tradeoff: string;
  affects: string;
}

export interface BudgetConflict {
  overBy: Money;
  budget: Money;
  total: Money;
  adjustments: BudgetAdjustment[];
}

export interface SearchSummary {
  builtAt: string;
  outbound: { date: string; modes: ModeSummary[]; filteredByYourRequirements: Array<{ offerId: string; reason: string }> };
  inbound: { date: string; modes: ModeSummary[] } | null;
  hotelsConsidered: number;
  hotelsFiltered: Array<{ hotelId: string; reason: string }>;
  budgetConflict: BudgetConflict | null;
  feasibility: FeasibilityReport | null;
}

export interface AgentTraceEntry {
  stage: string;
  kind: 'agent' | 'service';
  status: 'ok' | 'degraded' | 'failed' | 'skipped';
  source: 'model' | 'rules' | null;
  durationMs: number;
  detail: string;
  warnings: string[];
  rejected: string[];
}

export interface RequirementsReply {
  trip: TripSession;
  /** What was understood, quoted from the message. */
  requirements: {
    hard: Array<{ kind: string; value: string; evidence: string }>;
    soft: Array<{ kind: string; value: string; evidence: string }>;
  };
  missing: Array<{ field: string; question: string }>;
  conflicts: Array<{ fields: string[]; message: string }>;
  applied: string[];
  rejected: Array<{ key: string; reason: string }>;
  unmapped: Array<{ item: string; reason: string }>;
  keptForPlanning: string[];
  differences: Array<{ field: string; said: string; current: string }>;
  understoodBy: string;
  droppedCount: number;
  notes: string[];
}

export interface PlanStarted {
  run: PlanningRun;
  /** True when the trip was already being searched for exactly this. */
  reused: boolean;
  /** Pins that no longer fit the trip and were let go, each with the reason. */
  pinsReleased: Array<{ component: string; reason: string }>;
  trip: TripSession;
}

export interface ModifyResponse {
  trip: TripSession;
  /**
   * no_change: nothing changed; `interpretation` says why.
   * needs_consent: nothing changes until `consent` is answered.
   * replanning: saved, and new plans are being built; see `run`.
   * applied: saved, and no new search was needed.
   * saved: saved; plans will use it when next built.
   */
  status: 'no_change' | 'needs_consent' | 'replanning' | 'applied' | 'saved';
  interpretation: string;
  /** Absent on the answer to a consent question. */
  understoodBy?: string;
  reSearched: string[];
  kept: string[];
  released: Array<{ component: string; reason: string }>;
  consent: { id: string; question: string; acceptLabel: string; declineLabel: string } | null;
  run: PlanningRun | null;
  plans: TripPlan[];
}

export interface ProvidersResponse {
  configured: Array<{ id: string; label: string; kinds: string[]; attribution: string | null }>;
  disabled: Array<{ id: string; label: string; reason: string; requiredEnv: string[] }>;
  llm: { available: boolean; label: string };
  dataPolicy: string;
}

export function formatMoney(m: Money | null | undefined, locale = 'en-IN'): string {
  if (!m) return '—';
  const exponent = minorUnitExponent(m.currency);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: m.currency,
    maximumFractionDigits: 0,
  }).format(m.amount / 10 ** exponent);
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function formatLocalTime(instantUtc: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(instantUtc));
}

export function formatLocalDate(instantUtc: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(instantUtc));
}
