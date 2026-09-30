/**
 * How a provider outcome reads to a traveller.
 *
 * Deliberately free of any import, so the web app can use it without pulling
 * in the schema library (`@trip/shared/provider-status`), the same way it
 * uses `@trip/shared/currency`.
 */

/**
 * What a traveller needs to know about a provider outcome, which is coarser
 * than the status and is the distinction the product cares about: a source
 * this deployment does not have is not a source that broke, and neither is
 * the same as a source that answered with nothing.
 */
export const PROVIDER_STATUS_CLASSES = [
  'ok',
  /** Not connected here, or not able to serve this kind of request. */
  'not_available',
  /** Connected, and it failed (an error from the provider, or a refused request). */
  'failed',
  'timed_out',
  'rate_limited',
  /** Answered correctly and found nothing. */
  'empty',
  /** Answered with data that could not be read or trusted, so none of it was used. */
  'unusable',
] as const;
export type ProviderStatusClass = (typeof PROVIDER_STATUS_CLASSES)[number];

const STATUS_CLASS: Record<string, ProviderStatusClass> = {
  ok: 'ok',
  not_configured: 'not_available',
  unsupported_capability: 'not_available',
  unavailable: 'failed',
  invalid_request: 'failed',
  price_changed: 'failed',
  booking_unavailable: 'failed',
  timeout: 'timed_out',
  rate_limited: 'rate_limited',
  no_availability: 'empty',
  unsupported_route: 'empty',
  invalid_response: 'unusable',
};

/** The class of any status string. An unknown one, from an older record, is a failure. */
export function statusClass(status: string): ProviderStatusClass {
  return STATUS_CLASS[status] ?? 'failed';
}

const CLASS_LABEL: Record<ProviderStatusClass, string> = {
  ok: 'Note',
  not_available: 'Not available',
  failed: 'Failed',
  timed_out: 'Timed out',
  rate_limited: 'Rate limited',
  empty: 'No results',
  unusable: 'Unusable response',
};

/** A short label for the class of a status, for the traveller. */
export function statusLabel(status: string): string {
  return CLASS_LABEL[statusClass(status)];
}

/**
 * The kinds of thing a provider is asked for. A note names the capability it
 * is about, so "flights could not be searched" and "hotels could not be
 * searched" stay two notes even when one vendor (Amadeus) serves both.
 */
export const PROVIDER_CAPABILITIES = [
  'geocoding',
  'flights',
  'hotels',
  'trains',
  'buses',
  'self_drive',
  'transfers',
  'activities',
  'routing',
  'planner',
] as const;
export type ProviderCapabilityName = (typeof PROVIDER_CAPABILITIES)[number];

export const CAPABILITY_LABEL: Record<ProviderCapabilityName, string> = {
  geocoding: 'Place lookup',
  flights: 'Flights',
  hotels: 'Hotels',
  trains: 'Trains',
  buses: 'Buses',
  self_drive: 'Self-drive',
  transfers: 'Transfers',
  activities: 'Things to do',
  routing: 'Routing',
  planner: 'Planner',
};
