import { z } from 'zod';

/**
 * Provider configuration is read once, from the environment, and validated.
 * Anything missing simply disables its adapter: the system is designed to run
 * with zero credentials and report honestly about what it cannot search,
 * rather than to fall over or to substitute sample data.
 */

const TariffSchema = z.object({
  currency: z.string().length(3),
  baseFare: z.number().nonnegative(),
  perKm: z.number().nonnegative(),
  perMinute: z.number().nonnegative(),
  nightMultiplier: z.number().min(1).default(1.25),
});

const VehicleProfileSchema = z.object({
  currency: z.string().length(3),
  consumptionPer100Km: z.number().positive(),
  energyPrice: z.number().positive(),
  perKmAllowance: z.number().nonnegative().default(0),
  maxDrivingHoursBeforeBreak: z.number().positive().default(3),
  breakMinutes: z.number().nonnegative().default(30),
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
}

function coverageFrom(raw: string | undefined): 'global' | string[] {
  if (!raw || raw.trim().toLowerCase() === 'global') return 'global';
  return raw
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
}

export function loadProvidersEnv(env: NodeJS.ProcessEnv = process.env): ProvidersEnv {
  const tariffList = parseJsonEnv(env['GROUND_TRANSPORT_TARIFFS'], z.array(TariffSchema), 'GROUND_TRANSPORT_TARIFFS');
  const taxiTariffs: ProvidersEnv['taxiTariffs'] = {};
  for (const t of tariffList ?? []) taxiTariffs[t.currency] = t;

  return {
    nominatim: {
      baseUrl: env['NOMINATIM_BASE_URL'] ?? 'https://nominatim.openstreetmap.org',
      userAgent: env['NOMINATIM_USER_AGENT'] ?? '',
      minIntervalMs: Number(env['NOMINATIM_MIN_INTERVAL_MS'] ?? 1100),
    },
    osrm: env['OSRM_BASE_URL']
      ? {
          baseUrl: env['OSRM_BASE_URL'],
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
          baseUrl: env['RAIL_PROVIDER_URL'],
          apiKey: env['RAIL_PROVIDER_KEY'] ?? null,
          label: env['RAIL_PROVIDER_LABEL'] ?? 'Rail provider',
          coverage: coverageFrom(env['RAIL_PROVIDER_COVERAGE']),
          minIntervalMs: Number(env['RAIL_PROVIDER_MIN_INTERVAL_MS'] ?? 200),
          timeoutMs: Number(env['RAIL_PROVIDER_TIMEOUT_MS'] ?? 15_000),
        }
      : null,
    bus: env['BUS_PROVIDER_URL']
      ? {
          baseUrl: env['BUS_PROVIDER_URL'],
          apiKey: env['BUS_PROVIDER_KEY'] ?? null,
          label: env['BUS_PROVIDER_LABEL'] ?? 'Bus provider',
          coverage: coverageFrom(env['BUS_PROVIDER_COVERAGE']),
          minIntervalMs: Number(env['BUS_PROVIDER_MIN_INTERVAL_MS'] ?? 200),
          timeoutMs: Number(env['BUS_PROVIDER_TIMEOUT_MS'] ?? 15_000),
        }
      : null,
    taxiTariffs,
    selfDriveProfile: parseJsonEnv(env['SELF_DRIVE_PROFILE'], VehicleProfileSchema, 'SELF_DRIVE_PROFILE'),
  };
}
