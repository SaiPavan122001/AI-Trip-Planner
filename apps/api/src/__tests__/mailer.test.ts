import { describe, expect, it, vi } from 'vitest';
import { ConsoleMailer, DisabledMailer, MailDeliveryError, WebhookMailer } from '../auth/mailer.js';

/**
 * The mail provider behind sign-in: a webhook the operator points at whatever
 * mail service they use. Served here by a stand-in for `fetch`, so nothing
 * touches a network, and each way the webhook can go wrong is a distinct,
 * traveller-safe error.
 */

const message = { to: 'traveller@example.invalid', link: 'https://app.example.test/auth/verify?token=abc', expiresInMinutes: 15 };
const HOOK = 'https://mail.example.test/send';

const respond = (status: number, body = '') => vi.fn(async () => new Response(body === '' ? null : body, { status }));
const failWith = (err: Error) =>
  vi.fn(async () => {
    throw err;
  });

describe('webhook mailer', () => {
  it('posts the sign-in message as JSON, with the token, and follows no redirects', async () => {
    const fetchImpl = respond(204);
    await new WebhookMailer(HOOK, 'placeholder-token', fetchImpl as never).sendLoginLink(message);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(HOOK);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer placeholder-token');
    expect(init.redirect).toBe('manual');
    expect(JSON.parse(String(init.body))).toMatchObject({ type: 'login_link', to: message.to, link: message.link });
    expect(JSON.parse(String(init.body)).text).toContain('expires in 15 minutes');
  });

  it('sends no Authorization header when no token is configured', async () => {
    const fetchImpl = respond(200);
    await new WebhookMailer(HOOK, undefined, fetchImpl as never).sendLoginLink(message);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)['authorization']).toBeUndefined();
  });

  it('turns a refusal into a delivery error that names the status and not the body', async () => {
    const fetchImpl = respond(500, 'internal detail: database password is hunter2');
    const err = await new WebhookMailer(HOOK, undefined, fetchImpl as never).sendLoginLink(message).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailDeliveryError);
    expect((err as Error).message).toBe('The mail webhook answered 500.');
    expect((err as Error).message).not.toMatch(/hunter2/);
  });

  it('treats a redirect as a failure rather than sending the link somewhere else', async () => {
    const fetchImpl = respond(302);
    await expect(new WebhookMailer(HOOK, undefined, fetchImpl as never).sendLoginLink(message)).rejects.toThrow(/answered 302/);
  });

  it('says a webhook that is too slow was too slow, and one that is down was unreachable', async () => {
    const slow = failWith(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    await expect(new WebhookMailer(HOOK, undefined, slow as never).sendLoginLink(message)).rejects.toThrow(/did not answer in time/);

    const down = failWith(new TypeError('fetch failed'));
    await expect(new WebhookMailer(HOOK, undefined, down as never).sendLoginLink(message)).rejects.toThrow(/could not be reached/);
  });

  it('never repeats the address it could not reach in the error', async () => {
    const down = failWith(new TypeError('connect ECONNREFUSED 10.0.0.5:9000'));
    const err = await new WebhookMailer(HOOK, undefined, down as never).sendLoginLink(message).catch((e: unknown) => e);
    expect((err as Error).message).not.toMatch(/10\.0\.0\.5|ECONNREFUSED/);
  });
});

describe('the other mailers', () => {
  it('a disabled mailer refuses to deliver and says email sign-in is off', async () => {
    const mailer = new DisabledMailer();
    expect(mailer.canDeliver).toBe(false);
    await expect(mailer.sendLoginLink()).rejects.toThrow(/not configured/);
  });

  it('the console mailer delivers by logging, for development', async () => {
    const info = vi.fn();
    await new ConsoleMailer({ info } as never).sendLoginLink(message);
    expect(info).toHaveBeenCalledOnce();
  });
});
