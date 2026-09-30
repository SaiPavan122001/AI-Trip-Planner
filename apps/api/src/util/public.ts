/**
 * What may leave the server. A provider's revalidation token is the key to
 * re-pricing (and, later, booking) an offer, so it stays in the store and is
 * blanked in everything a browser receives. The web app never needs it.
 */
export function publicView<T>(value: T): T {
  if (Array.isArray(value)) return value.map(publicView) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = key === 'revalidationToken' ? null : publicView(v);
    }
    return out as T;
  }
  return value;
}
