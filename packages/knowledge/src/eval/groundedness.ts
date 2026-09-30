import { verifyClaim, type ClaimVerdict, type SourceText } from '../verify.js';

/**
 * The groundedness set, version 1: sentences of the kind a model might write,
 * each with the source text it cites and a label saying whether the source
 * really supports it. The verifier must accept exactly the ones labelled
 * `supported` and reject the rest.
 *
 * Labels: `supported` (the source says it), `unsupported` (the source does not
 * say it), `partial` (part of it is in the source and part is added),
 * `contradictory` (the source says something else: another figure, or the
 * opposite), `missing_context` (the cited source is about something else).
 *
 * The sources are fragments of the fictional corpus (`corpus.ts`).
 */

export const GROUNDEDNESS_VERSION = 'groundedness/1';

export type GroundednessLabel = 'supported' | 'unsupported' | 'partial' | 'contradictory' | 'missing_context';

export interface GroundednessCase {
  id: string;
  label: GroundednessLabel;
  claim: string;
  source: SourceText;
  /**
   * Written to defeat a lexical check: every figure and nearly every word is in the source, but combined into something it
   * does not say. Reported separately, because the verifier is expected to accept some of them (docs/knowledge.md).
   */
  hard?: boolean;
}

const cancellation: SourceText = {
  title: 'Wayfare Example Co. Cancellation Policy',
  heading: 'Cancellation policy > Group bookings',
  url: 'https://example.com/policies/cancellation',
  text: 'A group booking is a booking for 10 or more people.\nA group that cancels at least 15 days before departure pays no fee.\nA group that cancels between 7 and 14 days before departure is charged a fee of 10% of the booking value.\nA group that cancels less than 7 days before departure is charged a fee of 50% of the booking value.',
};
const railway: SourceText = {
  title: 'Example Toy Railway Passenger Charter',
  heading: 'Passenger charter > Luggage',
  url: null,
  text: 'Each passenger may carry up to 20 kg of luggage free of charge.\nLuggage above 20 kg is charged at ₹40 for each extra kg.\nBicycles are not carried on the Example Toy Railway.',
};
const fuel: SourceText = {
  title: 'Example Hill Road: Fuel and Distances',
  heading: 'Fuel and distances > Fuel',
  url: null,
  text: 'The last fuel station on the Example Hill Road is at Example Gate.\nFill the tank at Example Gate before you drive up.',
};
const altitude: SourceText = {
  title: 'Acclimatising at Altitude',
  heading: 'Acclimatising at altitude > Climbing higher',
  url: null,
  text: 'Raise the height at which you sleep by no more than 500 m each day.\nTake a rest day after every 3 days of climbing.',
};

export const GROUNDEDNESS_CASES: GroundednessCase[] = [
  // ---- supported
  { id: 'g01', label: 'supported', claim: 'A group that cancels at least 15 days before departure pays no fee.', source: cancellation },
  { id: 'g02', label: 'supported', claim: 'Groups cancelling between 7 and 14 days before departure are charged 10% of the booking value.', source: cancellation },
  { id: 'g03', label: 'supported', claim: 'Each passenger can carry up to 20 kg of luggage free of charge.', source: railway },
  { id: 'g04', label: 'supported', claim: 'Bicycles are not carried on the Example Toy Railway.', source: railway },
  { id: 'g05', label: 'supported', claim: 'Fill your tank at Example Gate before driving up, because it has the last fuel station.', source: fuel },
  { id: 'g06', label: 'supported', claim: 'Raise your sleeping height by no more than 500 m each day.', source: altitude },

  // ---- unsupported: says something the source does not
  { id: 'g10', label: 'unsupported', claim: 'Groups receive a free hotel upgrade when they cancel.', source: cancellation },
  { id: 'g11', label: 'unsupported', claim: 'The cancellation fee is ₹500 for each person.', source: cancellation },
  { id: 'g12', label: 'unsupported', claim: 'Passengers can buy a meal on board the railway.', source: railway },
  { id: 'g13', label: 'unsupported', claim: 'See https://evil.example.net/offers for discounted group rates.', source: cancellation },

  // ---- partial: some of it is in the source, some is added
  { id: 'g20', label: 'partial', claim: 'A group that cancels at least 15 days before departure pays no fee, receives a free rebooking voucher and a complimentary airport transfer.', source: cancellation },
  { id: 'g21', label: 'partial', claim: 'Each passenger may carry 20 kg of luggage free, and porters at every station will carry it to the platform for a small tip.', source: railway },
  { id: 'g22', label: 'partial', claim: 'The last fuel station is at Example Gate and it also has a cafe, a mechanic and a phone charging point.', source: fuel },

  // ---- contradictory: another figure, or the opposite
  { id: 'g30', label: 'contradictory', claim: 'A group that cancels between 7 and 14 days before departure is charged a fee of 20% of the booking value.', source: cancellation },
  { id: 'g31', label: 'contradictory', claim: 'Bicycles are carried on the Example Toy Railway.', source: railway },
  { id: 'g32', label: 'contradictory', claim: 'Each passenger may carry up to 30 kg of luggage free of charge.', source: railway },
  { id: 'g33', label: 'contradictory', claim: 'Raise the height at which you sleep by no more than 900 m each day.', source: altitude },
  { id: 'g34', label: 'contradictory', claim: 'A group that cancels at least 15 days before departure pays a fee.', source: cancellation },

  // ---- overstated (unsupported in a particular way: certainty the source does not have)
  { id: 'g35', label: 'unsupported', claim: 'A group that cancels at least 15 days before departure is guaranteed to pay no fee, with no exceptions.', source: cancellation },

  // ---- missing context: the cited source is about something else
  { id: 'g40', label: 'missing_context', claim: 'A refund is returned to the original payment method within 7 to 10 working days.', source: cancellation },
  { id: 'g41', label: 'missing_context', claim: 'The entry pass is valid for 5 days from the day it is issued.', source: fuel },
  { id: 'g42', label: 'missing_context', claim: 'Travel insurance is recommended for treks above 3500 m.', source: altitude },
  { id: 'g43', label: 'missing_context', claim: 'Children under 5 travel free and are not given a seat.', source: cancellation },

  // ---- hard: recombinations of the source's own words and figures
  { id: 'h01', label: 'contradictory', hard: true, claim: 'A group that cancels less than 7 days before departure is charged a fee of 10% of the booking value.', source: cancellation },
  { id: 'h02', label: 'contradictory', hard: true, claim: 'A group that cancels at least 7 days before departure is charged a fee of 50% of the booking value.', source: cancellation },
  { id: 'h03', label: 'contradictory', hard: true, claim: 'Luggage above 20 kg is free of charge for each extra kg.', source: railway },
];

export interface GroundednessMetrics {
  cases: number;
  /** Accepted exactly the supported claims and rejected the rest. */
  accuracy: number;
  /** Of the claims that are NOT supported, the share that was accepted anyway. The dangerous error. */
  falseAcceptRate: number;
  /** Of the supported claims, the share that was rejected. The costly-but-safe error. */
  falseRejectRate: number;
  /** Of the contradictory claims, how many were called `contradicted` (not merely unsupported). */
  contradictionRecall: number;
  byLabel: Record<string, { cases: number; correct: number }>;
  misjudged: Array<{ id: string; label: GroundednessLabel; verdict: ClaimVerdict; problems: string[] }>;
  /** The recombination cases: how many there are and how many were wrongly accepted. */
  hard: { cases: number; falseAccepts: number };
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;

export function runGroundedness(all: readonly GroundednessCase[] = GROUNDEDNESS_CASES): GroundednessMetrics {
  const cases = all.filter((c) => !c.hard);
  const hard = all.filter((c) => c.hard);
  const hardAccepted = hard.filter((c) => verifyClaim(c.claim, [c.source]).verdict === 'supported').length;
  let correct = 0;
  let notSupported = 0;
  let falseAccepts = 0;
  let supported = 0;
  let falseRejects = 0;
  let contradictory = 0;
  let contradictionHits = 0;
  const byLabel: GroundednessMetrics['byLabel'] = {};
  const misjudged: GroundednessMetrics['misjudged'] = [];
  for (const c of cases) {
    const check = verifyClaim(c.claim, [c.source]);
    const accepted = check.verdict === 'supported';
    const right = accepted === (c.label === 'supported');
    if (right) correct++;
    else misjudged.push({ id: c.id, label: c.label, verdict: check.verdict, problems: check.problems });
    const bucket = (byLabel[c.label] ??= { cases: 0, correct: 0 });
    bucket.cases++;
    if (right) bucket.correct++;
    if (c.label === 'supported') {
      supported++;
      if (!accepted) falseRejects++;
    } else {
      notSupported++;
      if (accepted) falseAccepts++;
    }
    if (c.label === 'contradictory') {
      contradictory++;
      if (check.verdict === 'contradicted') contradictionHits++;
    }
  }
  return {
    cases: cases.length,
    accuracy: round(correct / cases.length),
    falseAcceptRate: round(notSupported === 0 ? 0 : falseAccepts / notSupported),
    falseRejectRate: round(supported === 0 ? 0 : falseRejects / supported),
    contradictionRecall: round(contradictory === 0 ? 1 : contradictionHits / contradictory),
    byLabel,
    misjudged,
    hard: { cases: hard.length, falseAccepts: hardAccepted },
  };
}
