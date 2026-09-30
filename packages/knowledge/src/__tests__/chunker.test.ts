import { describe, expect, it } from 'vitest';
import { chunkDocument, embeddingText, DEFAULT_CHUNKING } from '../chunker.js';

const policy = `# Cancellation policy

## Individual bookings

A traveller who cancels at least 7 days before departure pays no fee.
A cancellation made between 3 and 6 days before departure is charged 25%.
A cancellation made less than 3 days before departure is not refunded.

## Group bookings

- A group is 10 or more people.
- A group that cancels at least 15 days ahead pays no fee.
- A group that cancels later pays a fee.

## Official closures

If an official authority closes the route the booking is refunded in full.`;

describe('chunking a document', () => {
  const chunks = chunkDocument('policy', 1, 'Cancellation policy', policy);

  it('never crosses a heading: each chunk is about one thing', () => {
    expect(chunks.map((c) => c.heading)).toEqual([
      'Cancellation policy > Individual bookings',
      'Cancellation policy > Group bookings',
      'Cancellation policy > Official closures',
    ]);
    for (const c of chunks) expect(c.text).not.toMatch(/^#/m);
  });

  it('makes each chunk exactly the characters it says it came from', () => {
    for (const c of chunks) expect(policy.slice(c.start, c.end)).toBe(c.text);
  });

  it('names a chunk by document, version and position, and records a hash of its text', () => {
    expect(chunks.map((c) => c.id)).toEqual(['policy@v1#0', 'policy@v1#1', 'policy@v1#2']);
    expect(new Set(chunks.map((c) => c.hash)).size).toBe(chunks.length);
    expect(chunkDocument('policy', 2, 'Cancellation policy', policy)[0]!.id).toBe('policy@v2#0');
  });

  it('is deterministic', () => {
    expect(chunkDocument('policy', 1, 'Cancellation policy', policy)).toEqual(chunks);
  });

  it('keeps the whole text: every sentence appears in some chunk', () => {
    const covered = chunks.map((c) => c.text).join('\n');
    for (const line of policy.split('\n').filter((l) => l.trim() && !l.startsWith('#'))) expect(covered).toContain(line.trim());
  });

  it('splits a long section at sentence boundaries, within the limit, and repeats a short boundary sentence', () => {
    const sentence = (n: number) => `Rule number ${n} says that travellers must keep the receipt for the booking.`;
    const body = Array.from({ length: 30 }, (_, i) => sentence(i)).join(' ');
    const long = chunkDocument('long', 1, 'Long', `# Rules\n\n${body}`, { maxChars: 300, overlapChars: 120 });
    expect(long.length).toBeGreaterThan(3);
    for (const c of long) {
      expect(c.text.length).toBeLessThanOrEqual(300);
      expect(c.text).toMatch(/[.]$/); // never cut mid-sentence
      expect(c.text.startsWith('Rule number')).toBe(true);
    }
    // the last sentence of one chunk opens the next
    const lastOf = (t: string) => t.match(/Rule number \d+ [^.]*\./g)!.at(-1)!;
    for (let i = 0; i + 1 < long.length; i++) expect(long[i + 1]!.text.startsWith(lastOf(long[i]!.text))).toBe(true);
    // and with overlap off, nothing is repeated
    const plain = chunkDocument('long', 1, 'Long', `# Rules\n\n${body}`, { maxChars: 300, overlapChars: 0 });
    const seen = new Set<string>();
    for (const c of plain) for (const s of c.text.match(/Rule number \d+/g) ?? []) {
      expect(seen.has(s)).toBe(false);
      seen.add(s);
    }
  });

  it('splits one sentence longer than the limit at a space, and loses nothing', () => {
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
    const out = chunkDocument('w', 1, 'W', `# Big\n\n${words}.`, { maxChars: 120, overlapChars: 0 });
    for (const c of out) expect(c.text.length).toBeLessThanOrEqual(120);
    expect(out.map((c) => c.text).join(' ')).toContain('word79');
  });

  it('handles a document without headings, and one that is only a heading', () => {
    const plain = chunkDocument('p', 1, 'Plain title', 'Just one paragraph of ordinary text about luggage.');
    expect(plain).toHaveLength(1);
    expect(plain[0]!.heading).toBe('Plain title');
    expect(chunkDocument('e', 1, 'Empty', '# Only a heading')).toEqual([]);
  });

  it('gives the embedder the title and heading with the text', () => {
    expect(embeddingText('Cancellation policy', chunks[1]!)).toBe(`Cancellation policy > Group bookings\n${chunks[1]!.text}`);
    expect(embeddingText('Rules', { heading: 'Fees', text: 'body' })).toBe('Rules > Fees\nbody');
    expect(embeddingText('T', { heading: 'T', text: 'body' })).toBe('T\nbody');
  });

  it('rejects a chunk limit too small to be useful', () => {
    expect(() => chunkDocument('x', 1, 'X', 'text', { maxChars: 10, overlapChars: 0 })).toThrow(RangeError);
    expect(DEFAULT_CHUNKING.maxChars).toBeGreaterThanOrEqual(80);
  });
});
