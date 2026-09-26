import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { ApiError, sendError } from '../errors.js';
import { applySession, clearSessionCookie } from './plugin.js';
import type { AuthService } from './service.js';

/**
 * Sign-in, and the traveller's control over their own data.
 */
export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext, auth: AuthService): void {
  /** Who this browser is. Never creates anyone: a first visit is not yet a person. */
  app.get('/v1/me', async (req, reply) => {
    const principal = req.principal;
    const emailSignIn = auth.emailSignInAvailable;
    if (!principal) return reply.send({ user: null, tripCount: 0, emailSignIn });
    const trips = await ctx.repository.listSessions(principal.userId, 50);
    return reply.send({
      user: { id: principal.userId, email: principal.email, isAnonymous: principal.isAnonymous },
      tripCount: trips.length,
      emailSignIn,
    });
  });

  /** Asks for a sign-in link. Deliberately tight: each request sends an email. */
  app.post(
    '/v1/auth/magic-link',
    { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (req, reply) => {
      try {
        const { email } = z.object({ email: z.unknown() }).parse(req.body);
        const { devLink } = await auth.requestLink(email, req.principal);
        return reply.status(202).send({
          message: 'If that address can sign in, a link is on its way. It works once and expires soon.',
          ...(devLink ? { devLink } : {}),
        });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  /**
   * Exchanges the link's token for a session. This is a POST, not a GET on the
   * link itself: mail scanners and browsers prefetch links, and a GET that
   * signed someone in would let them use it up.
   */
  app.post(
    '/v1/auth/verify',
    { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      try {
        const { token } = z.object({ token: z.unknown() }).parse(req.body);
        const { principal, session, tripsMoved } = await auth.verifyLink(token, req.principal);
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

  /** Everything held about this person, as a file they can keep. */
  app.get('/v1/me/export', async (req, reply) => {
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
  app.delete('/v1/me', async (req, reply) => {
    try {
      if (!req.principal) throw ApiError.unauthorized();
      z.object({ confirm: z.literal('delete my account') }).parse(req.body);
      await auth.deleteAccount(req.principal);
      clearSessionCookie(reply, ctx);
      return reply.status(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
