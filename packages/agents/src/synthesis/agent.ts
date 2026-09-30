import { z } from 'zod';
import {
  DATA_NOTICE,
  asData,
  runAgent,
  type AgentContext,
  type AgentOutcome,
  type AgentSpec,
  type Produced,
} from '../contract.js';
import { checkNarrative } from './fact-check.js';
import { allowedNumbers, type SearchFacts } from './facts.js';
import { planText, summaryText, templateNarrative, type Narrative } from './template.js';

/**
 * The Synthesis Agent: turn a validated plan into words.
 *
 * It is given the facts (already-formatted strings built in code) and writes a
 * friendly explanation of them. That is all it does: it decides no price, no
 * date, no route and no ranking, and it is never asked which plan is best,
 * because that was settled by ranking and validation before it was called.
 *
 * What it writes is untrusted and is checked part by part:
 *  - no number that is not in the facts, no link, and no claim that anything
 *    was booked, paid for or guaranteed;
 *  - a plan that cannot be carried out is never described as a recommendation;
 *  - text for a plan the facts do not contain is dropped.
 * A part that fails is replaced by the template's plain sentences and the
 * outcome lists what was replaced, so the explanation is always true even when
 * it is not eloquent.
 */

const Raw = z.object({
  summary: z.string().default(''),
  plans: z.array(z.object({ planId: z.string(), text: z.string() })).default([]),
});
type Raw = z.infer<typeof Raw>;

const SYSTEM = `You write a friendly, plain-language explanation of trip plans that have already been built and checked. You are given the facts as data.

Rules:
- Use only the facts you are given. Copy every figure, date and time exactly as written; never round, convert, add up, or estimate anything. If a figure is not in the facts, do not state it.
- Never say or imply that anything has been booked, reserved, paid for, confirmed or guaranteed. Nothing has.
- A plan marked valid=false cannot be carried out. Say so and why; never recommend it.
- Mention, honestly, any preference the traveller stated that the recommended plan does not meet, and any kept part that could not be kept, and why.
- summary: at most five sentences. plans: one short paragraph per plan you are given, keyed by its planId.
- Do not include links.

${DATA_NOTICE}`;

const MAX_SUMMARY = 900;
const MAX_PLAN_TEXT = 600;

function sanitise(raw: Raw, facts: SearchFacts): Produced<Narrative> {
  const template = templateNarrative(facts);
  const allowed = allowedNumbers(facts);
  const rejected: string[] = [];
  let modelParts = 0;
  let templateParts = 0;

  let summary = template.summary;
  const s = raw.summary.trim();
  if (s.length > 0) {
    const check = s.length > MAX_SUMMARY ? { ok: false as const, reason: 'it is too long' } : checkNarrative(s, allowed);
    if (check.ok) {
      summary = s;
      modelParts += 1;
    } else {
      rejected.push(`summary: ${check.reason}`);
      templateParts += 1;
    }
  } else templateParts += 1;

  const plans: Record<string, string> = {};
  for (const fact of facts.plans) {
    const written = raw.plans.find((p) => p.planId === fact.planId)?.text.trim();
    if (!written) {
      plans[fact.planId] = planText(fact);
      templateParts += 1;
      continue;
    }
    let check = written.length > MAX_PLAN_TEXT ? { ok: false as const, reason: 'it is too long' } : checkNarrative(written, allowed);
    // An unworkable plan is never dressed up as a good option.
    if (check.ok && !fact.valid && /\b(recommend|best|ideal|perfect|great choice|top pick)\b/i.test(written)) {
      check = { ok: false, reason: 'it recommends a plan that cannot be carried out' };
    }
    if (check.ok) {
      plans[fact.planId] = written;
      modelParts += 1;
    } else {
      rejected.push(`${fact.label}: ${check.reason}`);
      plans[fact.planId] = planText(fact);
      templateParts += 1;
    }
  }
  for (const stray of raw.plans) {
    if (!facts.plans.some((p) => p.planId === stray.planId)) rejected.push('text for a plan that does not exist was dropped');
  }

  const source: Narrative['source'] = templateParts === 0 ? 'model' : modelParts === 0 ? 'template' : 'mixed';
  return { ok: true, data: { summary, plans, source }, rejected };
}

const spec: AgentSpec<Raw, SearchFacts, Narrative> = {
  name: 'synthesis',
  system: SYSTEM,
  schemaName: 'plan_explanation',
  schemaDescription: 'A plain-language explanation of the plans, using only the facts given.',
  schema: Raw,
  maxOutputTokens: 1500,
  buildInput: (facts) => asData('facts', facts),
  sanitise,
  fallback: (facts) => ({ ok: true, data: templateNarrative(facts) }),
};

/**
 * Never fails a search: if the agent cannot produce anything usable the
 * template narrative stands in, and the meta says which it was.
 */
export async function runSynthesisAgent(
  facts: SearchFacts,
  ctx: AgentContext,
): Promise<AgentOutcome<Narrative>> {
  const outcome = await runAgent(spec, facts, ctx);
  if (outcome.ok) return outcome;
  return {
    ok: true,
    data: { ...templateNarrative(facts), summary: summaryText(facts) },
    meta: { ...outcome.meta, source: 'rules', warnings: [...outcome.meta.warnings, outcome.error.message] },
  };
}
