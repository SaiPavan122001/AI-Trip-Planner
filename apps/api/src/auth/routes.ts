import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { ApiError, sendError } from '../errors.js';
import { idempotently } from '../security/idempotency.js';
import { securityEvent } from '../security/events.js';
import type { RateLimitKit } from '../security/rate-limit.js';
import { applySession, clearSessionCookie } from './plugin.js';
import type { AuthService } from './service.js';

/**
 * Sign-in, and the traveller's control over their own data.
 */
export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext, auth: AuthService, limits: RateLimitKit): void {
  /** Who this browser is. Never creates anyone: a first visit is not yet a person. */
  app.get('/v1/me', async (req, reply) => {
    const principal = req.principal;
    const emailSignIn = auth.emailSignInAvailable;
    if (!principal) return reply.send({ user: null, tripCount: 0, emailSignIn });
    // Every page asks this, so it counts rows instead of reading fifty whole trips.
    const tripCount = Math.min(50, await ctx.repository.countSessions(principal.userId));
    return reply.send({
      user: { id: principal.userId, email: principal.email, isAnonymous: principal.isAnonymous },
      tripCount,
      emailSignIn,
    });
  });

  /**
   * Asks for a sign-in link. Deliberately tight: each request sends an email to
   * an address the caller chose, so it is limited by person, by address and by
   * day, and a repeated request with the same Idempotency-Key sends one email.
   */
  app.post(
    '/v1/auth/magic-link',
    { config: { limit: 'auth.magic_link' } },
    async (req, reply) => {
      try {
        const { email } = z.object({ email: z.unknown() }).strict().parse(req.body);
        return await idempotently(
          ctx,
          req,
          reply,
          { scope: 'POST /v1/auth/magic-link', principalId: req.principal?.userId ?? null },
          async () => {
            const { devLink } = await auth.requestLink(email, req.principal);
            return {
              status: 202,
              body: {
                message: 'If that address can sign in, a link is on its way. It works once and expires soon.',
                ...(devLink ? { devLink } : {}),
              },
            };
          },
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  /**
   * Exchanges the link's token for a session. This is a POST, not a GET on the
   * link itself: mail scanners and browsers prefetch links, and a GET that
   * signed someone in would let them use it up.
   *
   * A run of refused links from one address locks that address out for a
   * while. The token is 256 random bits, so guessing one is not the danger; the
   * lock keeps someone from making the service look up millions of them.
   */
  app.post(
    '/v1/auth/verify',
    { config: { limit: 'auth.verify' } },
    async (req, reply) => {
      const failed = limits.policies['auth.verify_failed'];
      const caller = limits.callerOf(req);
      try {
        const lock = await limits.limiter.isLocked(failed, caller);
        if (lock.locked) {
          securityEvent(ctx.logger, 'sign_in_locked', { route: '/v1/auth/verify', method: 'POST', address: caller.address });
          reply.header('retry-after', String(lock.retryAfterSeconds));
          throw ApiError.tooManyRequests(
            'too_many_failed_sign_ins',
            'Too many sign-in links were refused from this connection. Please wait a little while and request a new link.',
            { retryAfterSeconds: lock.retryAfterSeconds },
          );
        }
        const { token } = z.object({ token: z.unknown() }).strict().parse(req.body);
        let result: Awaited<ReturnType<AuthService['verifyLink']>>;
        try {
          result = await auth.verifyLink(token, req.principal);
        } catch (err) {
          if (err instanceof ApiError && err.code === 'invalid_link') {
            await limits.limiter.record(failed, caller);
            securityEvent(ctx.logger, 'sign_in_failed', { route: '/v1/auth/verify', method: 'POST', address: caller.address });
          }
          throw err;
        }
        const { principal, session, tripsMoved } = result;
        applySession(reply, ctx, session);
        return reply.send({
          user: { id: principal.userId, email: principal.email, isAnonymous: principal.isAnonymous },
          tripsMoved,
        });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post('/v1/auth/logout', async (req, reply) => {
    try {
      if (req.principal) await auth.logout(req.principal);
      clearSessionCookie(reply, ctx);
      return reply.status(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** Ends every session this person has, on every device: for a lost phone or a cookie that may have leaked. */
  app.post('/v1/auth/logout-all', { config: { limit: 'account.heavy' } }, async (req, reply) => {
    try {
      if (!req.principal) throw ApiError.unauthorized();
      await auth.logoutEverywhere(req.principal);
      securityEvent(ctx.logger, 'sessions_revoked', { route: '/v1/auth/logout-all', method: 'POST', address: req.addressTag, userId: req.principal.userId });
      clearSessionCookie(reply, ctx);
      return reply.status(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** Everything held about this person, as a file they can keep. */
  app.get('/v1/me/export', { config: { limit: 'account.heavy' } }, async (req, reply) => {
    try {
      if (!req.principal) throw ApiError.unauthorized();
      const data = await ctx.repository.exportUserData(req.principal.userId);
      if (!data) throw ApiError.notFound('That account');
      return reply
        .header('content-disposition', 'attachment; filename="wayfare-export.json"')
        .send({ exportedAt: new Date().toISOString(), ...data });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /**
   * Deletes the account and every trip, plan, and sign-in that belongs to it.
   * The body must confirm, so a stray request cannot do it.
   */
  app.delete('/v1/me', { config: { limit: 'account.heavy' } }, async (req, reply) => {
    try {
      if (!req.principal) throw ApiError.unauthorized();
      z.object({ confirm: z.literal('delete my account') }).strict().parse(req.body);
      await auth.deleteAccount(req.principal);
      clearSessionCookie(reply, ctx);
      return reply.status(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
