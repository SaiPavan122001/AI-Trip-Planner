/**
 * Keeping untrusted text where it belongs when it is put in front of a model.
 *
 * The model is given four kinds of thing, and they must never be mixed up:
 *
 *   1. instructions (the system prompt; written by us, contains nothing else)
 *   2. application state (which modes exist, whether the plan has a hotel)
 *   3. what the traveller wrote
 *   4. what a provider or destination supplied
 *
 * 3 and 4 are data. They go inside a tag the instructions name as data, as a
 * JSON string, and this file makes two things true of that string that plain
 * `JSON.stringify` does not: it cannot contain a tag boundary (`<`, `>` and `&`
 * are written as escapes, so `</traveller_message>` inside a request can never
 * end the block), and it cannot contain characters a person cannot see
 * (control characters, zero-width and direction-override characters, and the
 * invisible "tag" block of Unicode that has been used to hide instructions in
 * ordinary looking text).
 *
 * This does not make a model immune to persuasion, and nothing here claims to.
 * The design depends on the model having so little authority that persuading
 * it gains nothing: its output is schema-checked and sanitised, it has no
 * tools, and authorisation, budgets and consent are decided in code.
 */

/**
 * Code point ranges removed from untrusted text: C0 and C1 controls (other than
 * tab and line feed, which are handled separately), the zero-width space and
 * the left-to-right and right-to-left marks, bidirectional embedding, override
 * and isolate controls, line and paragraph separators, the word joiner and the
 * invisible operators, the byte-order mark, and the Unicode tag block.
 *
 * The zero-width joiner and non-joiner (U+200C, U+200D) are kept on purpose:
 * Malayalam, Sinhala, Persian and most emoji sequences are not spelled
 * correctly without them, and this planner's travellers write in those.
 */
const HIDDEN_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x0008],
  [0x000b, 0x000c],
  [0x000e, 0x001f],
  [0x007f, 0x009f],
  [0x200b, 0x200b],
  [0x200e, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x206f],
  [0xfeff, 0xfeff],
  [0xe0000, 0xe007f],
];

const hex = (n: number) => `\\u{${n.toString(16)}}`;
const HIDDEN = new RegExp(`[${HIDDEN_RANGES.map(([from, to]) => `${hex(from)}-${hex(to)}`).join('')}]`, 'gu');

export interface CleanOptions {
  /** Longest result, in characters. Longer text is cut, not refused. */
  maxLength?: number;
  /** Keep line breaks (a free-text answer may have them); otherwise they become spaces. */
  keepNewlines?: boolean;
}

/** Text a person or a provider wrote, made safe to store and to show a model. */
export function cleanUntrustedText(text: string, options: CleanOptions = {}): string {
  let cleaned = text.normalize('NFC').replace(HIDDEN, '');
  cleaned = options.keepNewlines ? cleaned.replace(/\r\n?/g, '\n') : cleaned.replace(/[\r\n\t]+/g, ' ');
  cleaned = cleaned.trim();
  if (options.maxLength !== undefined && cleaned.length > options.maxLength) {
    cleaned = cleaned.slice(0, options.maxLength).trimEnd();
  }
  return cleaned;
}

/** True if the text had anything in it that `cleanUntrustedText` would remove. */
export function hasHiddenCharacters(text: string): boolean {
  return new RegExp(HIDDEN.source, 'u').test(text);
}

/**
 * JSON that is safe to place between tags: valid JSON that a parser reads back
 * to the same value (apart from the hidden characters removed), with no `<`,
 * `>` or `&` in the text.
 */
export function jsonForPrompt(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'string' ? cleanUntrustedText(v, { keepNewlines: true }) : v))
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

/**
 * Wraps untrusted content for a prompt: JSON-escaped so it cannot close its own
 * quotes, free of tag boundaries and hidden characters so it cannot close its
 * own block, inside a tag the system prompt names as data.
 */
export function promptData(tag: string, value: unknown): string {
  if (!/^[a-z][a-z0-9_]*$/.test(tag)) throw new Error(`"${tag}" is not a valid data tag name.`);
  return `<${tag}>${jsonForPrompt(value)}</${tag}>`;
}
