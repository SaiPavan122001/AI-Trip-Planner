import { z } from 'zod';
import type { Logger } from 'pino';
import type { Env } from '../env.js';
import { ApiError } from '../errors.js';
import { EmailTakenError, type Store, type UserRecord } from '../repository/store.js';
import { MailDeliveryError, type Mailer } from './mailer.js';
import { hashToken, newToken } from './tokens.js';

/**
 * Who a request is from.
 *
 * Everyone gets an account the moment they start planning, with no email, so
 * their trips belong to someone and nobody else can open them. Signing in
 * with an emailed link attaches an email to that same account (or moves the
 * trips to the account that already has the email), so a traveller never has
 * to choose between trying the planner and keeping what they made.
 */

export interface Principal {
  userId: string;
  email: string | null;
  /** True until the person has signed in with an email. */
  isAnonymous: boolean;
  sessionId: string;
}

export interface IssuedSession {
  token: string;
  expiresAt: Date;
}

const Email = z.string().trim().toLowerCase().email().max(254);

/** A session used again after this long is extended; more often is wasted writes. */
const REFRESH_AFTER_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export class AuthService {
  constructor(
    private readonly deps: {
      store: Store;
      env: Env;
      mailer: Mailer;
      logger: Logger;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private ttlMs(): number {
    return this.deps.env.SESSION_TTL_DAYS * DAY_MS;
  }

  get emailSignInAvailable(): boolean {
    return this.deps.mailer.canDeliver;
  }

  private hash(token: string): string {
    return hashToken(this.deps.env.sessionSecret, token);
  }

  /** Resolves a cookie's token to a person, and reports whether the cookie should be renewed. */
  async resolve(token: string | undefined): Promise<{ principal: Principal; renewedUntil: Date | null } | null> {
    if (!token || token.length > 200) return null;
    const now = this.now();
    const found = await this.deps.store.findAuthSession(this.hash(token), now);
    if (!found) return null;
    // Renewal keeps an active session alive, which on its own means a stolen
    // cookie that is used often enough never stops working. A session also ends
    // a fixed time after it began, and the person signs in again.
    if (now.getTime() - Date.parse(found.session.createdAt) > this.deps.env.SESSION_MAX_DAYS * DAY_MS) {
      await this.deps.store.revokeAuthSession(found.session.id);
      return null;
    }

    let renewedUntil: Date | null = null;
    if (now.getTime() - Date.parse(found.session.lastSeenAt) > REFRESH_AFTER_MS) {
      renewedUntil = new Date(now.getTime() + this.ttlMs());
      await this.deps.store.touchAuthSession(found.session.id, now, renewedUntil);
    }
    return { principal: toPrincipal(found.user, found.session.id), renewedUntil };
  }

  /** A new person with no email, signed in. */
  async startAnonymous(): Promise<{ principal: Principal; session: IssuedSession }> {
    const user = await this.deps.store.createUser({ email: null });
    const { session, sessionId } = await this.issue(user.id);
    return { principal: toPrincipal(user, sessionId), session };
  }

  private async issue(userId: string): Promise<{ session: IssuedSession; sessionId: string }> {
    const token = newToken();
    const expiresAt = new Date(this.now().getTime() + this.ttlMs());
    const record = await this.deps.store.createAuthSession({ userId, tokenHash: this.hash(token), expiresAt });
    return { session: { token, expiresAt }, sessionId: record.id };
  }

  /**
   * Sends a sign-in link. It answers the same whether or not the address has
   * an account, so it cannot be used to find out who is registered.
   */
  async requestLink(rawEmail: unknown, current: Principal | null): Promise<{ devLink: string | null }> {
    const parsed = Email.safeParse(rawEmail);
    if (!parsed.success) throw ApiError.badRequest('Enter a valid email address.', { field: 'email' });
    const email = parsed.data;
    const { store, env, mailer } = this.deps;

    if (!mailer.canDeliver) {
      throw new ApiError(
        503,
        'email_sign_in_unavailable',
        'Signing in by email is not set up on this server. You can keep planning without signing in.',
      );
    }

    const since = new Date(this.now().getTime() - 60 * 60 * 1000);
    if ((await store.countLoginChallengesSince(email, since)) >= env.MAGIC_LINK_MAX_PER_HOUR) {
      throw ApiError.tooManyRequests(
        'too_many_sign_in_emails',
        'Several sign-in emails were already sent to this address. Check your inbox, or try again in an hour.',
      );
    }

    const token = newToken();
    await store.createLoginChallenge({
      email,
      tokenHash: this.hash(token),
      // Only someone who has not signed in yet has trips to bring along.
      anonymousUserId: current?.isAnonymous ? current.userId : null,
      expiresAt: new Date(this.now().getTime() + env.MAGIC_LINK_TTL_MINUTES * 60_000),
    });

    const link = `${env.WEB_BASE_URL.replace(/\/$/, '')}/auth/verify?token=${encodeURIComponent(token)}`;
    try {
      await mailer.sendLoginLink({ to: email, link, expiresInMinutes: env.MAGIC_LINK_TTL_MINUTES });
    } catch (err) {
      if (err instanceof MailDeliveryError) {
        this.deps.logger.error({ err: err.message }, 'Could not deliver a sign-in link');
        throw new ApiError(
          503,
          'email_delivery_failed',
          'The sign-in email could not be sent right now. Please try again in a few minutes.',
        );
      }
      throw err;
    }
    // Showing the link in the response is a convenience for local development
    // only; with any real mailer the link goes to the inbox and nowhere else.
    return { devLink: mailer.kind === 'console' && env.NODE_ENV === 'development' ? link : null };
  }

  /**
   * Turns a link into a signed-in session. The link is single-use: it is
   * marked used before anything else happens, so a second click, a mail
   * scanner's prefetch that runs the page twice, or an attacker replaying it
   * all find it spent.
   */
  async verifyLink(
    token: unknown,
    current: Principal | null,
  ): Promise<{ principal: Principal; session: IssuedSession; tripsMoved: number }> {
    if (typeof token !== 'string' || token.length === 0 || token.length > 200) throw invalidLink();
    const { store } = this.deps;
    const challenge = await store.consumeLoginChallenge(this.hash(token), this.now());
    if (!challenge) throw invalidLink();

    // Whoever asked for the link, or whoever is using this browser now, if
    // that person has not signed in yet: their trips come with them.
    const candidates = [challenge.anonymousUserId, current?.isAnonymous ? current.userId : null];
    const anonymousIds = [...new Set(candidates.filter((id): id is string => id !== null))];
    const anonymous: UserRecord[] = [];
    for (const id of anonymousIds) {
      const user = await store.getUser(id);
      if (user && user.email === null) anonymous.push(user);
    }

    let user = await store.getUserByEmail(challenge.email);
    let tripsMoved = 0;
    if (!user) {
      const first = anonymous.shift();
      try {
        user = first
          ? await store.setUserEmail(first.id, challenge.email)
          : await store.createUser({ email: challenge.email });
      } catch (err) {
        // Someone signed in with this address a moment ago; join them.
        if (!(err instanceof EmailTakenError)) throw err;
        user = await store.getUserByEmail(challenge.email);
        if (first) anonymous.unshift(first);
      }
    }
    if (!user) throw invalidLink();

    for (const other of anonymous) {
      if (other.id === user.id) continue;
      tripsMoved += await store.transferTrips(other.id, user.id);
      await store.deleteUserAndData(other.id);
    }

    // A fresh session on every sign-in: the browser never keeps the token it
    // had before it proved who it was.
    if (current) await store.revokeAuthSession(current.sessionId);
    const { session, sessionId } = await this.issue(user.id);
    await store.recordAudit({
      tripId: null,
      kind: 'auth.signed_in',
      actor: user.id,
      detail: { tripsMoved },
    });
    return { principal: toPrincipal(user, sessionId), session, tripsMoved };
  }

  async logout(principal: Principal): Promise<void> {
    await this.deps.store.revokeAuthSession(principal.sessionId);
  }

  /** Ends every session this person has, on every device, including this one. */
  async logoutEverywhere(principal: Principal): Promise<void> {
    await this.deps.store.revokeSessionsForUser(principal.userId);
    await this.deps.store.recordAudit({ tripId: null, kind: 'auth.signed_out_everywhere', actor: principal.userId, detail: {} });
  }

  /** Removes the person and everything they made. */
  async deleteAccount(principal: Principal): Promise<void> {
    await this.deps.store.deleteUserAndData(principal.userId);
  }
}

function toPrincipal(user: UserRecord, sessionId: string): Principal {
  return { userId: user.id, email: user.email, isAnonymous: user.email === null, sessionId };
}

const invalidLink = () =>
  new ApiError(400, 'invalid_link', 'That sign-in link is invalid, has expired, or was already used. Request a new one.');
