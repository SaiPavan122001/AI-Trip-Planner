import type { Logger } from 'pino';
import type { Env } from '../env.js';

/**
 * How a sign-in link reaches a person. The application only knows this
 * interface; what sits behind it (a mail service's webhook, a console for
 * development) is configuration, so no mail provider is baked in and none
 * needs credentials to run locally.
 */

export interface LoginEmail {
  to: string;
  link: string;
  expiresInMinutes: number;
}

export interface Mailer {
  readonly kind: 'console' | 'webhook' | 'disabled';
  /** False when sign-in by email is switched off. */
  readonly canDeliver: boolean;
  sendLoginLink(message: LoginEmail): Promise<void>;
}

export class MailDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailDeliveryError';
  }
}

const subject = 'Your sign-in link';
/** Longest the sign-in request waits for the mail service. */
const WEBHOOK_TIMEOUT_MS = 10_000;
const text = ({ link, expiresInMinutes }: LoginEmail) =>
  `Use this link to sign in to Wayfare. It works once and expires in ${expiresInMinutes} minutes.\n\n${link}\n\nIf you did not ask for this, you can ignore this email.`;

/** Development only: prints the link instead of sending it. */
export class ConsoleMailer implements Mailer {
  readonly kind = 'console';
  readonly canDeliver = true;
  constructor(private readonly logger: Logger) {}

  async sendLoginLink(message: LoginEmail): Promise<void> {
    this.logger.info({ to: message.to, link: message.link }, 'Sign-in link (console mailer, development only)');
  }
}

/**
 * Posts the message as JSON to a URL the operator controls, which is expected
 * to hand it to whatever mail service they use.
 */
export class WebhookMailer implements Mailer {
  readonly kind = 'webhook';
  readonly canDeliver = true;
  constructor(
    private readonly url: string,
    private readonly token: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async sendLoginLink(message: LoginEmail): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify({ type: 'login_link', to: message.to, subject, text: text(message), link: message.link }),
        // The body carries a sign-in link, so it goes to the address the operator
        // configured and nowhere else: a redirect is a failure, not a detour.
        redirect: 'manual',
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
    } catch (err) {
      // Slow and unreachable are different problems for whoever runs the service.
      const slow = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new MailDeliveryError(
        slow ? 'The mail webhook did not answer in time.' : 'The mail webhook could not be reached.',
      );
    }
    if (!res.ok) throw new MailDeliveryError(`The mail webhook answered ${res.status}.`);
  }
}

export class DisabledMailer implements Mailer {
  readonly kind = 'disabled';
  readonly canDeliver = false;
  async sendLoginLink(): Promise<void> {
    throw new MailDeliveryError('Email sign-in is not configured.');
  }
}

export function mailerFromEnv(env: Env, logger: Logger): Mailer {
  const production = env.NODE_ENV === 'production';
  const kind = env.MAILER ?? (env.MAIL_WEBHOOK_URL ? 'webhook' : production ? 'disabled' : 'console');
  if (kind === 'console' && production) {
    throw new Error('MAILER=console prints sign-in links to the log and is not allowed in production.');
  }
  if (kind === 'webhook') {
    if (!env.MAIL_WEBHOOK_URL) throw new Error('MAILER=webhook needs MAIL_WEBHOOK_URL.');
    return new WebhookMailer(env.MAIL_WEBHOOK_URL, env.MAIL_WEBHOOK_TOKEN);
  }
  if (kind === 'console') return new ConsoleMailer(logger);
  return new DisabledMailer();
}
