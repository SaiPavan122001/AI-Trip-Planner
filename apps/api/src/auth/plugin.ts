import cookie from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { corsOrigins } from '../env.js';
import { ApiError, sendError } from '../errors.js';
import { securityEvent } from '../security/events.js';
import { AuthService, type IssuedSession, type Principal } from './service.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Who the request is from, or null if it carries no valid sign-in. */
    principal: Principal | null;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Sign-in for the whole API: reads the session cookie into `req.principal`,
 * and refuses browser requests that come from a site we do not recognise.
 */
export async function registerAuth(app: FastifyInstance, ctx: AppContext, auth: AuthService): Promise<void> {
  await app.register(cookie);
  app.decorateRequest('principal', null);

  const allowedOrigins = new Set(corsOrigins(ctx.env));

  app.addHook('onRequest', async (req, reply) => {
    // A request that changes something must come from our own web app. The
    // SameSite cookie already stops most cross-site requests; this closes
    // the rest, for browsers and setups where it does not. Requests with no
    // Origin header (curl, servers) are not browsers acting for a victim.
    const origin = req.headers.origin;
    const where = { route: req.routeOptions?.url ?? 'unmatched', method: req.method, address: req.addressTag };
    if (!SAFE_METHODS.has(req.method)) {
      if (typeof origin === 'string') {
        if (!allowedOrigins.has(origin)) {
          securityEvent(ctx.logger, 'bad_origin', where);
          return sendError(
            reply,
            ApiError.forbidden('bad_origin', 'This request came from a site that is not allowed to use this service.'),
          );
        }
      } else if (req.headers['sec-fetch-site'] === 'cross-site') {
        // A browser that names the request as cross-site but sent no Origin (some
        // older ones do not on a form post) is still not our web app. A request
        // with neither header is not a browser acting for someone (curl, servers).
        securityEvent(ctx.logger, 'cross_site_blocked', where);
        return sendError(
          reply,
          ApiError.forbidden('bad_origin', 'This request came from a site that is not allowed to use this service.'),
        );
      }
    }

    const token = req.cookies[ctx.env.COOKIE_NAME];
    const resolved = await auth.resolve(token);
    req.principal = resolved?.principal ?? null;
    if (resolved?.renewedUntil) setSessionCookie(reply, ctx, token!, resolved.renewedUntil);
    // A cookie that no longer matches a session is dropped, so the browser
    // stops sending it.
    if (token && !resolved) clearSessionCookie(reply, ctx);
    return undefined;
  });
}

export function setSessionCookie(reply: FastifyReply, ctx: AppContext, token: string, expires: Date): void {
  reply.setCookie(ctx.env.COOKIE_NAME, token, {
    httpOnly: true,
    secure: ctx.env.COOKIE_SECURE,
    sameSite: ctx.env.COOKIE_SAMESITE,
    path: '/',
    expires,
    ...(ctx.env.COOKIE_DOMAIN ? { domain: ctx.env.COOKIE_DOMAIN } : {}),
  });
}

export function clearSessionCookie(reply: FastifyReply, ctx: AppContext): void {
  reply.clearCookie(ctx.env.COOKIE_NAME, {
    path: '/',
    ...(ctx.env.COOKIE_DOMAIN ? { domain: ctx.env.COOKIE_DOMAIN } : {}),
  });
}

/** Signs the browser in as a new person, and remembers it in a cookie. */
export async function startAnonymousSession(
  req: FastifyRequest,
  reply: FastifyReply,
  ctx: AppContext,
  auth: AuthService,
): Promise<Principal> {
  const { principal, session } = await auth.startAnonymous();
  setSessionCookie(reply, ctx, session.token, session.expiresAt);
  req.principal = principal;
  return principal;
}

export function applySession(reply: FastifyReply, ctx: AppContext, session: IssuedSession): void {
  setSessionCookie(reply, ctx, session.token, session.expiresAt);
}
