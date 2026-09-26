import { describe, expect, it } from 'vitest';
import { loadProvidersEnv } from '../config.js';

/**
 * Configured costs must be in rupees. A tariff or vehicle profile in another
 * currency used to be accepted and then ignored or summed with rupees; now
 * the service refuses to start and says exactly what to change.
 */
describe('provider configuration currency', () => {
  const inr = { currency: 'INR', baseFare: 50, perKm: 18, perMinute: 2 };

  it('accepts rupee tariffs', () => {
    const env = loadProvidersEnv({ GROUND_TRANSPORT_TARIFFS: JSON.stringify([inr]) });
    expect(env.taxiTariffs['INR']?.perKm).toBe(18);
  });

  it('refuses a tariff in another currency', () => {
    expect(() =>
      loadProvidersEnv({
        GROUND_TRANSPORT_TARIFFS: JSON.stringify([inr, { ...inr, currency: 'EUR' }]),
      }),
    ).toThrow(/GROUND_TRANSPORT_TARIFFS is invalid: 1\.currency must be INR/);
  });

  it('refuses a vehicle profile in another currency', () => {
    expect(() =>
      loadProvidersEnv({
        SELF_DRIVE_PROFILE: JSON.stringify({ currency: 'USD', consumptionPer100Km: 7, energyPrice: 1.2 }),
      }),
    ).toThrow(/SELF_DRIVE_PROFILE is invalid: currency must be INR/);
  });
});
