import { createHmac, randomBytes } from 'node:crypto';

/**
 * Sign-in tokens are 256 random bits, which cannot be guessed. Only a keyed
 * hash of one is ever stored: the database holds nothing that can be turned
 * back into a working cookie or link, even by someone who has a copy of it,
 * because they would also need the secret the hash is keyed with.
 */
export const newToken = (): string => randomBytes(32).toString('base64url');

export const hashToken = (secret: string, token: string): string =>
  createHmac('sha256', secret).update(token).digest('hex');
