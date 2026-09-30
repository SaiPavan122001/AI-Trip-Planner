import type { Chunk } from './types.js';
import { sha256 } from './validate.js';

/**
 * Splitting a document into pieces a search can return.
 *
 * The content is policies, rules and guides: headed sections of short
 * paragraphs and lists, where the answer to a question is usually one or two
 * sentences under the right heading. So:
 *
 *  - a chunk never spans a heading: "Refunds" text and "Permits" text are never
 *    one chunk, so a hit is about one thing;
 *  - the unit is the paragraph, or a list item, or (for a paragraph longer than
 *    the limit) a sentence; a chunk is whole units, never a cut mid-sentence
 *    unless one sentence alone is longer than the limit;
 *  - consecutive chunks in a section share their boundary unit (the overlap),
 *    when that unit is short, so an answer that straddles two chunks is whole in
 *    at least one of them;
 *  - each chunk is exactly `text.slice(start, end)` of the document, so a
 *    citation can always be traced to the characters it came from.
 *
 * The heading path is kept with the chunk, and the embedder is shown it too
 * (see `embeddingText`): a sentence that says "Fees are 10%" means little
 * without knowing it was under "Group cancellations".
 */

export interface ChunkOptions {
  /** The most characters in a chunk (except a single sentence longer than this, which is split at a space). */
  maxChars: number;
  /** Repeat the last unit of a chunk at the start of the next one if it is at most this long. 0 turns overlap off. */
  overlapChars: number;
}

export const DEFAULT_CHUNKING: ChunkOptions = { maxChars: 700, overlapChars: 160 };

interface Unit {
  start: number;
  end: number;
  heading: string;
}

const HEADING = /^(#{1,4})\s+(\S.*?)\s*#*\s*$/;
const LIST_ITEM = /^\s*(?:[-*•]|\d{1,3}[.)])\s+\S/;

export function chunkDocument(docId: string, version: number, title: string, text: string, options: ChunkOptions = DEFAULT_CHUNKING): Chunk[] {
  if (options.maxChars < 80) throw new RangeError('maxChars must be at least 80');
  const units = splitUnits(text, options.maxChars);
  const chunks: Chunk[] = [];

  let group: Unit[] = [];
  const flush = () => {
    if (group.length === 0) return;
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const body = text.slice(first.start, last.end);
    const index = chunks.length;
    chunks.push({
      id: `${docId}@v${version}#${index}`,
      docId,
      version,
      index,
      heading: first.heading || title,
      text: body,
      start: first.start,
      end: last.end,
      hash: sha256(body),
    });
  };

  for (const unit of units) {
    const sameSection = group.length > 0 && group[0]!.heading === unit.heading;
    const width = group.length > 0 ? unit.end - group[0]!.start : unit.end - unit.start;
    if (group.length > 0 && (!sameSection || width > options.maxChars)) {
      const last = group[group.length - 1]!;
      flush();
      const overlaps = sameSection && options.overlapChars > 0 && last.end - last.start <= options.overlapChars && last.end - last.start + (unit.end - unit.start) <= options.maxChars;
      group = overlaps ? [last] : [];
    }
    group.push(unit);
  }
  flush();
  return chunks;
}

/** The text an embedder sees for a chunk: where it sits, then what it says. */
export function embeddingText(title: string, chunk: Pick<Chunk, 'heading' | 'text'>): string {
  // A heading path usually starts with the document's own top heading; the title is not said twice.
  const said = chunk.heading === title || chunk.heading.startsWith(`${title} >`);
  return said ? `${chunk.heading}\n${chunk.text}` : `${title} > ${chunk.heading}\n${chunk.text}`;
}

function splitUnits(text: string, maxChars: number): Unit[] {
  const units: Unit[] = [];
  const headings: string[] = [];
  const lines = lineSpans(text);
  let heading = '';

  let paragraph: Array<{ start: number; end: number }> = [];
  const closeParagraph = () => {
    if (paragraph.length === 0) return;
    // A paragraph of list items is one unit per item; a plain paragraph is one unit.
    const listy = paragraph.every((l) => LIST_ITEM.test(text.slice(l.start, l.end)));
    if (listy) {
      for (const l of paragraph) pushUnit(units, text, l.start, l.end, heading, maxChars);
    } else {
      pushUnit(units, text, paragraph[0]!.start, paragraph[paragraph.length - 1]!.end, heading, maxChars);
    }
    paragraph = [];
  };

  for (const line of lines) {
    const raw = text.slice(line.start, line.end);
    if (raw.trim() === '') {
      closeParagraph();
      continue;
    }
    const h = HEADING.exec(raw);
    if (h) {
      closeParagraph();
      const level = h[1]!.length;
      headings.length = level - 1;
      headings[level - 1] = h[2]!;
      heading = headings.filter(Boolean).join(' > ');
      continue;
    }
    paragraph.push(line);
  }
  closeParagraph();
  return units;
}

function lineSpans(text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      out.push({ start, end: i });
      start = i + 1;
    }
  }
  return out;
}

/** Trims the span to its content, then splits it into sentences if it is too long for one chunk. */
function pushUnit(units: Unit[], text: string, from: number, to: number, heading: string, maxChars: number): void {
  let start = from;
  let end = to;
  while (start < end && /\s/.test(text[start]!)) start++;
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  if (start >= end) return;
  if (end - start <= maxChars) {
    units.push({ start, end, heading });
    return;
  }
  for (const [s, e] of sentenceSpans(text, start, end)) {
    if (e - s <= maxChars) units.push({ start: s, end: e, heading });
    else for (const [ss, ee] of hardSplit(text, s, e, maxChars)) units.push({ start: ss, end: ee, heading });
  }
}

function sentenceSpans(text: string, start: number, end: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const slice = text.slice(start, end);
  const boundary = /([.!?])\s+(?=[A-Z0-9₹"'([])/g;
  let from = 0;
  for (let m = boundary.exec(slice); m; m = boundary.exec(slice)) {
    const cut = m.index + 1;
    out.push([start + from, start + cut]);
    from = m.index + m[0].length;
  }
  out.push([start + from, end]);
  return out.filter(([s, e]) => e > s);
}

function hardSplit(text: string, start: number, end: number, maxChars: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let s = start;
  while (end - s > maxChars) {
    let cut = text.lastIndexOf(' ', s + maxChars);
    if (cut <= s) cut = s + maxChars;
    out.push([s, cut]);
    s = cut;
    while (s < end && text[s] === ' ') s++;
  }
  if (s < end) out.push([s, end]);
  return out;
}
