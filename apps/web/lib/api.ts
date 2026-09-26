/**
 * Typed client for the planning API.
 *
 * Errors from the API carry a code and a sentence written for a traveller, so
 * this client preserves both rather than collapsing everything into "request
 * failed". The UI shows the API's own message: it is the one that knows which
 * provider was unavailable and why.
 */

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

  getTrip: (id: string) => request<{ trip: TripSession }>(`/v1/trips/${id}`),

  answer: (id: string, key: string, value: unknown, skipped = false) =>
    request<{ trip: TripSession }>(`/v1/trips/${id}/answers`, {
      method: 'POST',
      body: JSON.stringify({ key, value, skipped }),
    }),

  plan: (id: string) =>
    request<PlanResponse>(`/v1/trips/${id}/plan`, { method: 'POST' }),

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

  providers: () => request<ProvidersResponse>('/v1/providers'),
};

// ----------------------------------------------------------------- shapes
// Mirrors of the API's response envelopes. The domain types themselves come
// from @trip/shared; these describe only what each endpoint wraps them in.

export interface Money {
  amount: number;
  currency: string;
}

export interface TripSession {
  id: string;
  stage: string;
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
  plans: TripPlan[];
  selectedPlanId: string | null;
  providerNotes: Array<{ provider: string; providerLabel: string; status: string; message: string }>;
  decisionLog: Array<{ at: string; step: string; detail: string }>;
}

// The engine's own type, so the limits the UI enforces are exactly the ones
// the server validates against.
import type { Question } from '@trip/shared';
export type { Question };

export interface TransportOffer {
  id: string;
  mode: string;
  totalPrice: Money;
  pricePerTraveler: Money;
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
  };
  issues: Array<{
    code: string;
    severity: 'blocker' | 'warning' | 'info';
    message: string;
    suggestions: string[];
  }>;
  tradeoffs: string[];
  priorityScore: number;
  scoreBreakdown: Record<string, number>;
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

export interface PlanResponse {
  trip: TripSession;
  plans: TripPlan[];
  comparison: {
    outbound: { date: string; modes: ModeSummary[]; filteredByYourRequirements: Array<{ offerId: string; reason: string }> };
    inbound: { date: string; modes: ModeSummary[] } | null;
  };
  hotels: { considered: number; filtered: Array<{ hotelId: string; reason: string }> };
  budgetConflict: {
    overBy: Money;
    budget: Money;
    total: Money;
    adjustments: BudgetAdjustment[];
  } | null;
  providerNotes: TripSession['providerNotes'];
}

export interface ModifyResponse {
  trip: TripSession;
  interpretation: string;
  understoodBy: string;
  reSearched: string[];
  preserved: string[];
  requiresConsent: { constraint: string; question: string } | null;
  plans: TripPlan[];
  budgetConflict: PlanResponse['budgetConflict'];
}

export interface ProvidersResponse {
  configured: Array<{ id: string; label: string; kinds: string[]; attribution: string | null }>;
  disabled: Array<{ id: string; label: string; reason: string; requiredEnv: string[] }>;
  llm: { available: boolean; label: string };
  dataPolicy: string;
}

export function formatMoney(m: Money | null | undefined, locale = 'en-IN'): string {
  if (!m) return '—';
  const exponent = ['JPY', 'KRW', 'VND'].includes(m.currency) ? 0 : 2;
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
