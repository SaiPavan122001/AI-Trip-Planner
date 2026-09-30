import { createHash } from 'node:crypto';
import { checkOutboundUrl } from '@trip/providers';
import { cleanUntrustedText } from '@trip/shared';
import { AUTHORITY, DocumentInputSchema, type DocumentInput, type StoredDocument } from './types.js';
import { scanText } from './scan.js';

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** A query-string key that carries a credential; a link with one is never stored or shown. */
const CREDENTIAL_KEY = /^(token|key|api[_-]?key|secret|sig|signature|auth|access[_-]?token|session|password|x-amz-.*)$/i;

/**
 * Checks a URL that will be shown to a traveller and stored, and never
 * fetched: https only, no credentials in it, no address that names something
 * internal (a stored link to `http://169.254.169.254/` is a trap even if this
 * service never follows it), and no query parameter that looks like a secret.
 */
export function checkSourceUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  const checked = checkOutboundUrl(raw, { requireHttps: true });
  if (!checked.ok) return checked;
  for (const key of checked.url.searchParams.keys()) {
    if (CREDENTIAL_KEY.test(key)) return { ok: false, reason: 'the link carries a credential in its query string' };
  }
  if (checked.url.hash.length > 80) return { ok: false, reason: 'the link fragment is too long' };
  // The canonical spelling, so the same page is never stored two ways.
  return { ok: true, url: checked.url.toString() };
}

export type Prepared =
  | { ok: true; input: DocumentInput; text: string; contentHash: string; quarantine: string[] }
  | { ok: false; problems: string[] };

/**
 * Turns what an operator submitted into what may be stored, or says why not.
 *
 * Structural problems (a missing field, a bad date, a link that is not
 * acceptable) reject the document: it was not well formed. Content problems
 * (instruction-like text, a secret, a personal detail) do not reject it but
 * mark it for quarantine: the document is kept on record with the reasons, and
 * is never searchable, so an operator can look and decide.
 */
export function prepareDocument(raw: unknown): Prepared {
  const parsed = DocumentInputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join('.') || 'document'}: ${i.message}`) };
  }
  const input = parsed.data;
  const problems: string[] = [];

  if (input.url !== undefined) {
    const url = checkSourceUrl(input.url);
    if (!url.ok) problems.push(`url: ${url.reason}`);
    else input.url = url.url;
  }
  if (input.reviewBy !== undefined && input.reviewBy < input.effectiveDate) problems.push('reviewBy: earlier than effectiveDate');

  // Metadata is displayed and shown to the model, so it gets the same cleaning as the body.
  for (const key of ['title', 'reference', 'destination'] as const) {
    const value = input[key];
    if (value === undefined) continue;
    const cleaned = cleanUntrustedText(value);
    if (cleaned !== value) problems.push(`${key}: contains control or hidden characters`);
  }
  if (problems.length > 0) return { ok: false, problems };

  const text = cleanUntrustedText(input.text, { keepNewlines: true });
  const quarantine = new Set<string>();
  for (const part of [text, input.title, input.reference, input.destination ?? '', input.url ?? '']) {
    for (const reason of scanText(part).reasons) quarantine.add(reason);
  }
  // Hidden characters in the body were just removed; that they were there at all is the finding.
  for (const reason of scanText(input.text).reasons) quarantine.add(reason);

  return { ok: true, input, text, contentHash: sha256(text), quarantine: [...quarantine].sort() };
}

export function storedFrom(input: DocumentInput, extra: Pick<StoredDocument, 'contentHash' | 'status' | 'quarantineReasons' | 'chunkCount' | 'embeddingSpace'> & { previousVersions?: StoredDocument['previousVersions']; ingestedAt: string }): StoredDocument {
  return {
    id: input.id,
    namespace: input.namespace,
    title: input.title,
    url: input.url ?? null,
    reference: input.reference,
    sourceType: input.sourceType,
    authority: AUTHORITY[input.sourceType],
    version: input.version,
    effectiveDate: input.effectiveDate,
    reviewBy: input.reviewBy ?? null,
    topic: input.topic ?? null,
    destination: input.destination ?? null,
    contentHash: extra.contentHash,
    status: extra.status,
    quarantineReasons: extra.quarantineReasons,
    chunkCount: extra.chunkCount,
    previousVersions: extra.previousVersions ?? [],
    embeddingSpace: extra.embeddingSpace,
    ingestedAt: extra.ingestedAt,
  };
}
