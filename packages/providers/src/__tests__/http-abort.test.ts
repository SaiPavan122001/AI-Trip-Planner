import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { RequestAbortedError, TimeoutError, httpJson, toProviderFailure } from '../http.js';

/**
 * A search that has been cancelled must stop asking providers, and must not
 * retry: a retry is a second paid request for an answer nobody is waiting for.
 */

let server: Server | null = null;
let hits = 0;

async function slowServer(delayMs: number): Promise<string> {
  hits = 0;
  server = createServer((_req, res) => {
    hits += 1;
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    }, delayMs);
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

describe('httpJson with an abort signal', () => {
  it('does not send a request at all when already cancelled', async () => {
    const url = await slowServer(10);
    const controller = new AbortController();
    controller.abort();
    await expect(httpJson(url, { signal: controller.signal })).rejects.toBeInstanceOf(RequestAbortedError);
    expect(hits).toBe(0);
  });

  it('stops waiting as soon as it is cancelled, and does not retry', async () => {
    const url = await slowServer(5_000);
    const controller = new AbortController();
    const started = Date.now();
    const call = httpJson(url, { signal: controller.signal, retries: 3, timeoutMs: 10_000 });
    setTimeout(() => controller.abort(), 50);

    await expect(call).rejects.toBeInstanceOf(RequestAbortedError);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(hits).toBe(1);
  });

  it('still reports its own timeout as a timeout, not as a cancellation', async () => {
    const url = await slowServer(2_000);
    await expect(httpJson(url, { timeoutMs: 60, retries: 0 })).rejects.toBeInstanceOf(TimeoutError);
  });

  it('turns a cancellation into a provider failure that names the provider', () => {
    const failure = toProviderFailure(new RequestAbortedError('http://x/'), 'amadeus', 'Amadeus');
    expect(failure.status).toBe('timeout');
    expect(failure.message).toMatch(/stopped/);
    expect(failure.message).toContain('Amadeus');
  });
});
