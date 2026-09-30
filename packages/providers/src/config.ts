import { z } from 'zod';
import { SUPPORTED_CURRENCY } from '@trip/shared';
import { validateConfiguredUrl } from './ssrf.js';

/**
 * Provider configuration is read once, from the environment, and validated.
 * Anything missing simply disables its adapter: the system is designed to run
 * with zero credentials and report honestly about what it cannot search,
 * rather than to fall over or to substitute sample data.
 */

// Configured costs must be in the one currency the planner works in. A
// tariff or vehicle profile in another currency would otherwise be ignored
// or, worse, summed with rupees; failing at boot names the problem instead.
const InrOnly = z.literal(SUPPORTED_CURRENCY, {
  errorMap: () => ({ message: `must be ${SUPPORTED_CURRENCY}; this planner works in Indian rupees only` }),
});

const TariffSchema = z.object({
  currency: InrOnly,
  baseFare: z.number().nonnegative(),
  perKm: z.number().nonnegative(),
  perMinute: z.number().nonnegative(),
  nightMultiplier: z.number().min(1).default(1.25),
});

const VehicleProfileSchema = z.object({
  currency: InrOnly,
  consumptionPer100Km: z.number().positive(),
  energyPrice: z.number().positive(),
  perKmAllowance: z.number().nonnegative().default(0),
  maxDrivingHoursBeforeBreak: z.number().positive().default(3),
  breakMinutes: z.number().nonnegative().default(30),
  // Accepted so existing settings keep loading. No longer used: the fare for
  // driving your own car is ₹0, so there is nothing to split per traveller.
  averageOccupancy: z.number().positive().default(2),
});

// Generic over the schema rather than its type argument: zod's input and
// output types differ wherever a field has a default, and inferring from the
// input side would lose every default the schema applies.
function parseJsonEnv<S extends z.ZodTypeAny>(
  raw: string | undefined,
  schema: S,
  name: string,
): z.infer<S> | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} is not valid JSON. See .env.example for the expected shape.`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${name} is invalid: ${result.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  }
  return result.data;
}

export interface ProvidersEnv {
  nominatim: { baseUrl: string; userAgent: string; minIntervalMs: number };
  osrm: { baseUrl: string; minIntervalMs: number } | null;
  amadeus: {
    clientId: string;
    clientSecret: string;
    environment: 'test' | 'production';
    minIntervalMs: number;
  } | null;
  google: { apiKey: string; minIntervalMs: number } | null;
  rail: {
    baseUrl: string;
    apiKey: string | null;
    label: string;
    coverage: 'global' | string[];
    minIntervalMs: number;
    timeoutMs: number;
  } | null;
  bus: {
    baseUrl: string;
    apiKey: string | null;
    label: string;
    coverage: 'global' | string[];
    minIntervalMs: number;
    timeoutMs: number;
  } | null;
  taxiTariffs: Record<string, z.infer<typeof TariffSchema>>;
  selfDriveProfile: z.infer<typeof VehicleProfileSchema> | null;
  /** Limits that apply to every provider call, whichever adapter makes it. */
  policy: {
    /** Backstop on one provider call, in ms; on top of each adapter's own timeout and retries. */
    callTimeoutMs: number;
    /** Consecutive failures that open a provider's circuit. */
    circuitFailureThreshold: number;
    /** How long an open circuit waits before it lets one probe through, in ms. */
    circuitRecoveryMs: number;
    /** Retries after the first attempt of a safe request, and the longest wait between attempts. */
    maxRetries: number;
    retryMaxDelayMs: number;
  };
  /** Caching of the answers that are safe to keep (places, routes, things to do). */
  cache: {
    enabled: boolean;
    geocodingTtlMs: number;
    routingTtlMs: number;
    activitiesTtlMs: number;
    maxEntries: number;
  };
}

/** A positive number from the environment, or the default when unset. A bad value stops start-up. */
function positiveNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number of milliseconds.`);
  return n;
}

/** A whole number from the environment, at least `min`, or the default when unset. A bad value stops start-up. */
function wholeNumber(raw: string | undefined, fallback: number, min: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be a whole number of at least ${min}.`);
  return n;
}

function coverageFrom(raw: string | undefined): 'global' | string[] {
  if (!raw || raw.trim().toLowerCase() === 'global') return 'global';
  return raw
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
}

export function loadProvidersEnv(env: NodeJS.ProcessEnv = process.env): ProvidersEnv {
  // A base URL is operator configuration, so it may name a host on the
  // operator's own network, but it must be plain http(s), carry no credentials,
  // and be https in production. A bad one stops start-up naming the setting.
  const production = env['NODE_ENV'] === 'production';
  const checked = (name: string, value: string): string => validateConfiguredUrl(name, value, { production });
  const tariffList = parseJsonEnv(env['GROUND_TRANSPORT_TARIFFS'], z.array(TariffSchema), 'GROUND_TRANSPORT_TARIFFS');
  const taxiTariffs: ProvidersEnv['taxiTariffs'] = {};
  for (const t of tariffList ?? []) taxiTariffs[t.currency] = t;

  return {
    nominatim: {
      baseUrl: checked('NOMINATIM_BASE_URL', env['NOMINATIM_BASE_URL'] ?? 'https://nominatim.openstreetmap.org'),
      userAgent: env['NOMINATIM_USER_AGENT'] ?? '',
      minIntervalMs: Number(env['NOMINATIM_MIN_INTERVAL_MS'] ?? 1100),
    },
    osrm: env['OSRM_BASE_URL']
      ? {
          baseUrl: checked('OSRM_BASE_URL', env['OSRM_BASE_URL']),
          minIntervalMs: Number(env['OSRM_MIN_INTERVAL_MS'] ?? 250),
        }
      : null,
    amadeus:
      env['AMADEUS_CLIENT_ID'] && env['AMADEUS_CLIENT_SECRET']
        ? {
            clientId: env['AMADEUS_CLIENT_ID'],
            clientSecret: env['AMADEUS_CLIENT_SECRET'],
            environment: env['AMADEUS_ENV'] === 'production' ? 'production' : 'test',
            minIntervalMs: Number(env['AMADEUS_MIN_INTERVAL_MS'] ?? 120),
          }
        : null,
    google: env['GOOGLE_MAPS_API_KEY']
      ? {
          apiKey: env['GOOGLE_MAPS_API_KEY'],
          minIntervalMs: Number(env['GOOGLE_MAPS_MIN_INTERVAL_MS'] ?? 50),
        }
      : null,
    rail: env['RAIL_PROVIDER_URL']
      ? {
          baseUrl: checked('RAIL_PROVIDER_URL', env['RAIL_PROVIDER_URL']),
          apiKey: env['RAIL_PROVIDER_KEY'] ?? null,
          label: env['RAIL_PROVIDER_LABEL'] ?? 'Rail provider',
          coverage: coverageFrom(env['RAIL_PROVIDER_COVERAGE']),
          minIntervalMs: Number(env['RAIL_PROVIDER_MIN_INTERVAL_MS'] ?? 200),
          timeoutMs: Number(env['RAIL_PROVIDER_TIMEOUT_MS'] ?? 15_000),
        }
      : null,
    bus: env['BUS_PROVIDER_URL']
      ? {
          baseUrl: checked('BUS_PROVIDER_URL', env['BUS_PROVIDER_URL']),
          apiKey: env['BUS_PROVIDER_KEY'] ?? null,
          label: env['BUS_PROVIDER_LABEL'] ?? 'Bus provider',
          coverage: coverageFrom(env['BUS_PROVIDER_COVERAGE']),
          minIntervalMs: Number(env['BUS_PROVIDER_MIN_INTERVAL_MS'] ?? 200),
          timeoutMs: Number(env['BUS_PROVIDER_TIMEOUT_MS'] ?? 15_000),
        }
      : null,
    taxiTariffs,
    selfDriveProfile: parseJsonEnv(env['SELF_DRIVE_PROFILE'], VehicleProfileSchema, 'SELF_DRIVE_PROFILE'),
    policy: {
      callTimeoutMs: positiveNumber(env['PROVIDER_CALL_TIMEOUT_MS'], 45_000, 'PROVIDER_CALL_TIMEOUT_MS'),
      circuitFailureThreshold: wholeNumber(env['PROVIDER_CIRCUIT_FAILURE_THRESHOLD'], 5, 1, 'PROVIDER_CIRCUIT_FAILURE_THRESHOLD'),
      circuitRecoveryMs: wholeNumber(env['PROVIDER_CIRCUIT_RECOVERY_MS'], 30_000, 1000, 'PROVIDER_CIRCUIT_RECOVERY_MS'),
      maxRetries: wholeNumber(env['PROVIDER_MAX_RETRIES'], 2, 0, 'PROVIDER_MAX_RETRIES'),
      retryMaxDelayMs: wholeNumber(env['PROVIDER_RETRY_MAX_DELAY_MS'], 3000, 0, 'PROVIDER_RETRY_MAX_DELAY_MS'),
    },
    cache: {
      enabled: env['CACHE_ENABLED'] !== 'false',
      geocodingTtlMs: wholeNumber(env['CACHE_TTL_GEOCODING_S'], 86_400, 1, 'CACHE_TTL_GEOCODING_S') * 1000,
      routingTtlMs: wholeNumber(env['CACHE_TTL_ROUTING_S'], 21_600, 1, 'CACHE_TTL_ROUTING_S') * 1000,
      activitiesTtlMs: wholeNumber(env['CACHE_TTL_ACTIVITIES_S'], 21_600, 1, 'CACHE_TTL_ACTIVITIES_S') * 1000,
      maxEntries: wholeNumber(env['CACHE_MAX_ENTRIES'], 2000, 10, 'CACHE_MAX_ENTRIES'),
    },
  };
}
