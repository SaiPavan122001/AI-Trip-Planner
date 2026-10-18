import { createHash } from 'node:crypto';
import { httpJson, RequestPacer } from '../http.js';

/**
 * What the three Hotelbeds APIs (Hotel, Activities, Transfers) have in common:
 * the hosts and how a request is signed. Each API still has its own adapter,
 * its own credentials and its own on/off switch (see `config.ts`); sharing a
 * key pair is a convenience of the account, not a reason for one to stand in
 * for another.
 *
 * Authentication, from https://developer.hotelbeds.com/documentation/getting-started/ :
 * an `Api-key` header, and an `X-Signature` header that is the hex SHA-256 of
 * the API key, the secret and the current Unix time in SECONDS, concatenated
 * in that order. The signature is made fresh for every request.
 *
 * Hosts: `https://api.test.hotelbeds.com` for the evaluation (test) account
 * and `https://api.hotelbeds.com` for live. Evaluation keys are limited (the
 * documentation states 50 requests a day, with 403 once exceeded).
 */

export type HotelbedsEnvironment = 'test' | 'live';

export interface HotelbedsCredentials {
  apiKey: string;
  secret: string;
}

export const HOTELBEDS_HOSTS: Record<HotelbedsEnvironment, string> = {
  test: 'https://api.test.hotelbeds.com',
  live: 'https://api.hotelbeds.com',
};

export function hotelbedsSignature(creds: HotelbedsCredentials, nowMs: number): string {
  const seconds = Math.floor(nowMs / 1000);
  return createHash('sha256').update(`${creds.apiKey}${creds.secret}${seconds}`).digest('hex');
}

export class HotelbedsClient {
  private readonly pacer: RequestPacer;
  private readonly baseUrl: string;

  constructor(
    private readonly creds: HotelbedsCredentials,
    readonly environment: HotelbedsEnvironment,
    minIntervalMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.baseUrl = HOTELBEDS_HOSTS[environment];
    this.pacer = new RequestPacer(minIntervalMs);
  }

  isConfigured(): boolean {
    return Boolean(this.creds.apiKey && this.creds.secret);
  }

  private headers(): Record<string, string> {
    return {
      'Api-key': this.creds.apiKey,
      'X-Signature': hotelbedsSignature(this.creds, this.now()),
      Accept: 'application/json',
    };
  }

  get<T>(path: string, query: Record<string, string | number | boolean | undefined> = {}, signal?: AbortSignal): Promise<T> {
    return this.pacer.run(
      () =>
        httpJson<T>(`${this.baseUrl}${path}`, {
          query,
          // The signature is time-based, so it is made when the request is sent, not when it was queued.
          headers: this.headers(),
          timeoutMs: 20_000,
          ...(signal ? { signal } : {}),
        }),
      signal,
    );
  }

  /** Searches are POSTs here but change nothing; they are still not repeated automatically. */
  post<T>(path: string, body: unknown, signal?: AbortSignal, timeoutMs = 30_000): Promise<T> {
    return this.pacer.run(
      () =>
        httpJson<T>(`${this.baseUrl}${path}`, {
          method: 'POST',
          body,
          headers: this.headers(),
          timeoutMs,
          retries: 0,
          ...(signal ? { signal } : {}),
        }),
      signal,
    );
  }
}
