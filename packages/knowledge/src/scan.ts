import { createHash } from 'node:crypto';
import { cleanUntrustedText, hasHiddenCharacters } from '@trip/shared';

/**
 * A screen for text that is trying to be read as an instruction, or that
 * should never have been written into a shared index.
 *
 * It runs twice: when a document is ingested (a document that trips it is held
 * back, "quarantined", for an operator to look at) and again on every chunk at
 * retrieval (so an index that was altered behind the ingestion path is still
 * screened). It is a tripwire, not the defence. A determined writer can phrase
 * an instruction this list has never seen, and nothing here pretends otherwise.
 * What holds when it misses is the design around it: retrieved text reaches the
 * model only as escaped data, the model may only cite what was retrieved, its
 * claims are checked against that text by code, and it has no tools and no
 * authority (docs/knowledge.md, "Prompt injection").
 *
 * Findings are reason codes from a closed list. The matched text is never
 * returned: it is, by definition, the thing that must not be repeated.
 */

export const SCAN_REASONS = [
  'instruction_override',
  'role_marker',
  'prompt_boundary',
  'prompt_disclosure',
  'behaviour_directive',
  'exfiltration',
  'hidden_characters',
  'encoded_payload',
  'encoded_instruction',
  'secret',
  'personal_data',
] as const;
export type ScanReason = (typeof SCAN_REASONS)[number];

interface Rule {
  reason: ScanReason;
  pattern: RegExp;
}

// Applied to text folded to lower case, with hidden characters removed and common look-alike letters mapped back.
const INSTRUCTION_RULES: Rule[] = [
  { reason: 'instruction_override', pattern: /\b(ignore|disregard|forget|override|bypass|discard)\b[^.\n]{0,40}\b(previous|prior|above|earlier|preceding|all|any|your|the|these|those)\b[^.\n]{0,30}\b(instructions?|rules?|prompts?|guidelines?|directions?|constraints?|context|polic(y|ies))\b/ },
  { reason: 'instruction_override', pattern: /\b(new|updated|revised|real|actual)\s+(instructions?|rules?|system\s+prompt|directives?)\b\s*[:-]/ },
  { reason: 'instruction_override', pattern: /\b(forget|ignore|disregard)\s+(everything|anything|all\s+of\s+(that|this)|what\s+you)\b/ },
  { reason: 'instruction_override', pattern: /\byou\s+(are|must)\s+now\b/ },
  { reason: 'instruction_override', pattern: /\bfrom\s+now\s+on\b[^.\n]{0,40}\b(act|behave|respond|answer|reply|you|ignore)\b/ },
  { reason: 'instruction_override', pattern: /\b(act|behave|respond|answer)\s+as\s+(an?|the)\s+[^.\n]{0,30}\b(assistant|ai|model|admin|administrator|developer|system|dan|unrestricted|jailbroken|hacker)\b/ },
  { reason: 'instruction_override', pattern: /\b(pretend|act|behave|respond)\s+(to\s+be|as\s+(if|though)|like)\b[^.\n]{0,40}\b(assistant|ai|model|admin|developer|system|dan|unrestricted)\b/ },
  { reason: 'instruction_override', pattern: /\b(jailbreak|do\s+anything\s+now|developer\s+mode|god\s+mode|dan\s+mode)\b/ },
  { reason: 'role_marker', pattern: /(^|\n)\s*(system|assistant|developer|user|human)\s*:\s*\S/ },
  { reason: 'role_marker', pattern: /<\|(im_start|im_end|system|user|assistant|endoftext)\|>|\[\/?inst\]|<<\/?sys>>/ },
  { reason: 'prompt_boundary', pattern: /<\/?\s*(system|instructions?|prompt|source|sources|retrieved_knowledge|user_question|traveller_message|app_rules|assistant|tool_result)\b[^>]{0,40}>/ },
  { reason: 'prompt_disclosure', pattern: /\b(reveal|print|show|output|repeat|display|leak|disclose|tell\s+me)\b[^.\n]{0,30}\b(system|hidden|initial|original|secret)\s+(prompt|instructions?|message|rules)\b/ },
  { reason: 'behaviour_directive', pattern: /\b(when|if)\s+(you\s+are\s+)?(asked|answering|responding|summari[sz]ing|a\s+user\s+asks)\b[^.\n]{0,80}\b(say|respond|answer|reply|write|recommend|output|state|claim)\b/ },
  { reason: 'behaviour_directive', pattern: /\b(always|never)\s+(answer|respond|reply|say|recommend|mention|cite|tell|reveal|refuse)\b/ },
  { reason: 'behaviour_directive', pattern: /\b(do\s+not|don'?t)\s+(mention|tell|reveal|cite|disclose|warn|inform)\b[^.\n]{0,40}\b(user|traveller|traveler|customer|anyone|this)\b/ },
  { reason: 'behaviour_directive', pattern: /\binstead\s+of\s+(answering|responding|following|the\s+above)\b/ },
  { reason: 'behaviour_directive', pattern: /\b(assistant|ai|model|chatbot|llm)\s*[,:]?\s+(must|should|shall|will\s+now|needs?\s+to)\b/ },
  { reason: 'exfiltration', pattern: /\b(send|post|forward|email|upload|transmit|exfiltrate|fetch|visit|open|browse|click)\b[^.\n]{0,60}https?:\/\// },
  { reason: 'exfiltration', pattern: /!\[[^\]]*\]\(\s*https?:\/\/[^)]*\)/ },
  { reason: 'exfiltration', pattern: /\b(cookie|session|token|password|credential|api[\s_-]?key)s?\b[^.\n]{0,40}\b(send|post|forward|include|append|leak|share)\b/ },
];

const SECRET_RULES: Rule[] = [
  { reason: 'secret', pattern: /\bsk-[a-z0-9_-]{20,}/i },
  { reason: 'secret', pattern: /\bakia[0-9a-z]{16}\b/i },
  { reason: 'secret', pattern: /-----begin [a-z ]*private key-----/i },
  { reason: 'secret', pattern: /\bbearer\s+[a-z0-9._~+/-]{20,}/i },
  { reason: 'secret', pattern: /\b(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*\S{6,}/i },
  { reason: 'personal_data', pattern: /[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}/i },
  { reason: 'personal_data', pattern: /(?<![\d-])(\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?![\d-])/ },
  { reason: 'personal_data', pattern: /\b\d{4}\s\d{4}\s\d{4}\b/ },
  { reason: 'personal_data', pattern: /\b[a-z]{5}\d{4}[a-z]\b/i },
];

/** Letters that look like other letters, mapped to the plain one before matching. */
const LOOKALIKES: Record<string, string> = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ɡ: 'g', ո: 'n', ν: 'v', ο: 'o', ρ: 'p', α: 'a',
};

/** The two joiners and the soft hyphen: legitimate in some scripts, but they can split a word the rules would otherwise see. */
const JOINERS = new Set([0x200c, 0x200d, 0xad]);

/** Text as the rules see it: compatibility-folded, without hidden characters, look-alikes mapped, lower case. */
export function foldForScan(text: string): string {
  // Hidden characters out (the same set the rest of the system removes), then the joiners, then look-alikes.
  const cleaned = cleanUntrustedText(text.normalize('NFKC'), { keepNewlines: true });
  let out = '';
  for (const ch of cleaned) {
    const code = ch.codePointAt(0)!;
    if (JOINERS.has(code)) continue;
    out += code > 0x7f ? (LOOKALIKES[ch] ?? ch) : ch;
  }
  return out.toLowerCase();
}

/** Plain printable text: what a decoded payload looks like when it was written to be read. */
function isReadable(text: string): boolean {
  if (text.length < 12) return false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (!(c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126))) return false;
  }
  return true;
}

function rot13(text: string): string {
  return text.replace(/[a-z]/gi, (c) => {
    const base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}

const BASE64_RUN = /[A-Za-z0-9+/]{48,}={0,2}/g;
const HEX_RUN = /\b(?:[0-9a-fA-F]{2}){24,}\b/g;

function decodedPayloads(text: string): string[] {
  const out: string[] = [];
  for (const run of text.match(BASE64_RUN) ?? []) {
    try {
      const decoded = Buffer.from(run, 'base64').toString('utf8');
      if (isReadable(decoded)) out.push(decoded);
    } catch {
      /* not base64 after all */
    }
  }
  for (const run of text.match(HEX_RUN) ?? []) {
    const decoded = Buffer.from(run, 'hex').toString('utf8');
    if (isReadable(decoded)) out.push(decoded);
  }
  return out;
}

function instructionReasons(folded: string): Set<ScanReason> {
  const found = new Set<ScanReason>();
  for (const rule of INSTRUCTION_RULES) if (rule.pattern.test(folded)) found.add(rule.reason);
  return found;
}

/** A hash of every pattern above, so the evaluation baseline notices a change to the screen even where no case shows it. */
export const SCAN_RULES_HASH = createHash('sha256')
  .update([...INSTRUCTION_RULES, ...SECRET_RULES].map((r) => `${r.reason}:${r.pattern.source}:${r.pattern.flags}`).join('\n'))
  .digest('hex')
  .slice(0, 16);

export interface ScanResult {
  flagged: boolean;
  reasons: ScanReason[];
}

/** Screens text for instruction-like content, encoded payloads, hidden characters, secrets and personal data. */
export function scanText(text: string): ScanResult {
  const reasons = new Set<ScanReason>();
  if (hasHiddenCharacters(text)) reasons.add('hidden_characters');

  const folded = foldForScan(text);
  for (const r of instructionReasons(folded)) reasons.add(r);
  for (const rule of SECRET_RULES) if (rule.pattern.test(text)) reasons.add(rule.reason);

  // The same rules on what encoded text says once decoded: base64 and hex runs, and rot13.
  const payloads = decodedPayloads(text);
  if (payloads.length > 0) {
    reasons.add('encoded_payload');
    for (const p of payloads) if (instructionReasons(foldForScan(p)).size > 0) reasons.add('encoded_instruction');
  }
  if (instructionReasons(rot13(folded)).size > 0 && instructionReasons(folded).size === 0) reasons.add('encoded_instruction');

  const list = [...reasons].sort();
  return { flagged: list.length > 0, reasons: list };
}
