/**
 * The answer-evaluation dataset, version 1: questions against the fixture
 * corpus (`corpus.ts`), each with the behaviour that would be correct.
 *
 * Nine kinds of question are covered: ordinary ones, ambiguous ones, ones the
 * corpus cannot answer, ones that need two documents, ones whose only source is
 * out of date, ones where sources conflict, ones that sound close to a
 * document but are not answered by it, ones that invite an invented answer, and
 * paraphrases that share no words with the text (which a lexical embedder is
 * expected to miss; they are here so that the number reflects that).
 *
 * `split` keeps honest numbers: `tune` cases may be looked at when choosing
 * retrieval parameters; `holdout` cases are not, and are reported separately,
 * so a parameter that only fits the cases it was chosen on shows up as a gap.
 */

export const DATASET_VERSION = 'answers/1';

export type CaseCategory =
  | 'normal'
  | 'ambiguous'
  | 'no_answer'
  | 'multi_doc'
  | 'outdated'
  | 'conflicting'
  | 'irrelevant'
  | 'hallucination_trap'
  | 'paraphrase';

export interface AnswerCase {
  id: string;
  category: CaseCategory;
  split: 'tune' | 'holdout';
  question: string;
  destination?: string;
  /** Documents that hold the answer: what retrieval should find. Empty when the correct behaviour is "insufficient". */
  relevantDocs: string[];
  expect: {
    status: 'answered' | 'insufficient';
    /** Each must appear in the answer (case-insensitive). */
    includes?: string[];
    /** None may appear in the answer. */
    excludes?: string[];
    /** Documents that must be among the citations. */
    cites?: string[];
    /** The answer must report a disagreement between sources. */
    conflict?: boolean;
  };
}

export const ANSWER_CASES: AnswerCase[] = [
  // ---- ordinary questions
  { id: 'n01', category: 'normal', split: 'tune', question: 'Is there a fee to cancel an individual booking 10 days before departure?', relevantDocs: ['wayfare-cancellation'], expect: { status: 'answered', includes: ['no fee'], cites: ['wayfare-cancellation'] } },
  { id: 'n02', category: 'normal', split: 'tune', question: 'What is the cancellation fee for an individual booking cancelled 4 days before departure?', relevantDocs: ['wayfare-cancellation'], expect: { status: 'answered', includes: ['25%'], cites: ['wayfare-cancellation'] } },
  { id: 'n03', category: 'normal', split: 'holdout', question: 'How much is the rescheduling fee for each traveller?', relevantDocs: ['wayfare-rescheduling'], expect: { status: 'answered', includes: ['₹300'], cites: ['wayfare-rescheduling'] } },
  { id: 'n04', category: 'normal', split: 'tune', question: 'How long does a refund take to reach my payment method?', relevantDocs: ['wayfare-refunds'], expect: { status: 'answered', includes: ['7 to 10 working days'], cites: ['wayfare-refunds'] } },
  { id: 'n05', category: 'normal', split: 'tune', question: 'Where can I get an entry pass for the Example Hill Circuit and at what hours?', destination: 'Example Hill', relevantDocs: ['example-hill-permit'], expect: { status: 'answered', includes: ['Example Gate'], cites: ['example-hill-permit'] } },
  { id: 'n06', category: 'normal', split: 'holdout', question: 'How much luggage can a passenger carry free on the Example Toy Railway?', relevantDocs: ['example-toy-railway'], expect: { status: 'answered', includes: ['20 kg'], cites: ['example-toy-railway'] } },
  { id: 'n07', category: 'normal', split: 'tune', question: 'How early must passengers be at the station before the Example Toy Railway departs?', relevantDocs: ['example-toy-railway'], expect: { status: 'answered', includes: ['30 minutes'], cites: ['example-toy-railway'] } },
  { id: 'n08', category: 'normal', split: 'tune', question: 'Are bicycles allowed on the Example Toy Railway?', relevantDocs: ['example-toy-railway'], expect: { status: 'answered', includes: ['not carried'], cites: ['example-toy-railway'] } },
  { id: 'n09', category: 'normal', split: 'holdout', question: 'What speed should I stay below in heavy rain on hill roads?', relevantDocs: ['monsoon-driving'], expect: { status: 'answered', includes: ['50 km/h'], cites: ['monsoon-driving'] } },
  { id: 'n10', category: 'normal', split: 'tune', question: 'What should I do on the first day after arriving above 3000 m?', relevantDocs: ['altitude-guide'], expect: { status: 'answered', includes: ['rest'], cites: ['altitude-guide'] } },
  { id: 'n11', category: 'normal', split: 'tune', question: 'Where is the last fuel station on the Example Hill Road?', destination: 'Example Hill', relevantDocs: ['fuel-and-road'], expect: { status: 'answered', includes: ['Example Gate'], cites: ['fuel-and-road'] } },
  { id: 'n12', category: 'normal', split: 'holdout', question: 'Is travel insurance mandatory for domestic trips?', relevantDocs: ['insurance-note'], expect: { status: 'answered', includes: ['not mandatory'], cites: ['insurance-note'] } },
  { id: 'n13', category: 'normal', split: 'tune', question: 'How long is a Restricted Area Permit valid for the Example Lake region?', destination: 'Example Lake', relevantDocs: ['restricted-area-note'], expect: { status: 'answered', includes: ['7 days'], cites: ['restricted-area-note'] } },
  { id: 'n14', category: 'normal', split: 'tune', question: 'Do children under 5 pay on the Example Toy Railway?', relevantDocs: ['example-toy-railway'], expect: { status: 'answered', includes: ['travel free'], cites: ['example-toy-railway'] } },
  { id: 'n15', category: 'normal', split: 'holdout', question: 'What should I carry besides layers for a cold weather trek?', relevantDocs: ['cold-packing'], expect: { status: 'answered', includes: ['headlamp'], cites: ['cold-packing'] } },
  { id: 'n16', category: 'normal', split: 'tune', question: 'Who should I report lost luggage to?', relevantDocs: ['lost-luggage'], expect: { status: 'answered', includes: ['station master'], cites: ['lost-luggage'] } },

  // ---- questions that need two documents
  { id: 'm01', category: 'multi_doc', split: 'tune', question: 'What is the cancellation fee for a group booking and how long does the refund take?', relevantDocs: ['wayfare-cancellation', 'wayfare-refunds'], expect: { status: 'answered', cites: ['wayfare-cancellation', 'wayfare-refunds'] } },
  { id: 'm02', category: 'multi_doc', split: 'holdout', question: 'What should I pack and how should I acclimatise for a cold weather trek at altitude?', relevantDocs: ['cold-packing', 'altitude-guide'], expect: { status: 'answered', cites: ['cold-packing', 'altitude-guide'] } },
  { id: 'm03', category: 'multi_doc', split: 'tune', question: 'Are pets permitted on the Example Toy Railway and do children under 5 need a seat?', relevantDocs: ['example-toy-railway'], expect: { status: 'answered', includes: ['pets are not permitted'], cites: ['example-toy-railway'] } },

  // ---- sources that disagree
  { id: 'c01', category: 'conflicting', split: 'tune', question: 'What is the entry pass fee for the Example Hill Circuit?', destination: 'Example Hill', relevantDocs: ['example-hill-permit', 'example-hill-permit-guide'], expect: { status: 'answered', includes: ['₹200', '₹250'], cites: ['example-hill-permit', 'example-hill-permit-guide'], conflict: true } },
  { id: 'c02', category: 'conflicting', split: 'holdout', question: 'How many days is the entry pass valid for the Example Hill Circuit?', destination: 'Example Hill', relevantDocs: ['example-hill-permit', 'example-hill-permit-guide'], expect: { status: 'answered', includes: ['5 days', '3 days'], cites: ['example-hill-permit', 'example-hill-permit-guide'], conflict: true } },

  // ---- the only matching source is past its review date, or is a community note
  { id: 'o01', category: 'outdated', split: 'tune', question: 'Are life jackets compulsory on the Example Lake Ferry?', destination: 'Example Lake', relevantDocs: [], expect: { status: 'insufficient' } },
  { id: 'o02', category: 'outdated', split: 'holdout', question: 'How often does the Example Lake Ferry leave the main jetty?', destination: 'Example Lake', relevantDocs: [], expect: { status: 'insufficient' } },
  { id: 'o03', category: 'outdated', split: 'tune', question: 'Does the last Example Lake Ferry of the evening leave late?', destination: 'Example Lake', relevantDocs: [], expect: { status: 'insufficient' } },

  // ---- the corpus cannot answer (and several are live facts that belong to providers)
  { id: 'x01', category: 'no_answer', split: 'tune', question: 'What is the cheapest flight from Delhi to Goa tomorrow?', relevantDocs: [], expect: { status: 'insufficient' } },
  { id: 'x02', category: 'no_answer', split: 'holdout', question: 'What is the weather in Example Hill next week?', destination: 'Example Hill', relevantDocs: [], expect: { status: 'insufficient' } },
  { id: 'x03', category: 'no_answer', split: 'tune', question: 'Is the Example Toy Railway fully booked on 12 October?', relevantDocs: [], expect: { status: 'insufficient' } },
  { id: 'x04', category: 'no_answer', split: 'tune', question: 'What is the capital of France?', relevantDocs: [], expect: { status: 'insufficient' } },
  { id: 'x05', category: 'no_answer', split: 'holdout', question: 'Which hotel near Example Hill has the best breakfast?', destination: 'Example Hill', relevantDocs: [], expect: { status: 'insufficient' } },
  { id: 'x06', category: 'no_answer', split: 'tune', question: 'How much does a taxi from Example Gate to the summit cost?', destination: 'Example Hill', relevantDocs: [], expect: { status: 'insufficient' } },

  // ---- too vague to answer
  { id: 'a01', category: 'ambiguous', split: 'tune', question: 'fee?', relevantDocs: [], expect: { status: 'insufficient' } },
  { id: 'a02', category: 'ambiguous', split: 'holdout', question: 'What is the fee?', relevantDocs: [], expect: { status: 'insufficient' } },
  { id: 'a03', category: 'ambiguous', split: 'tune', question: 'Can I cancel?', relevantDocs: [], expect: { status: 'insufficient' } },

  // ---- close to a document in wording, not answered by it
  { id: 'i01', category: 'irrelevant', split: 'tune', question: 'Does the Example Toy Railway have a dining car?', relevantDocs: [], expect: { status: 'insufficient' } },
  { id: 'i02', category: 'irrelevant', split: 'holdout', question: 'Which railway runs between Delhi and Mumbai?', relevantDocs: [], expect: { status: 'insufficient' } },
  { id: 'i03', category: 'irrelevant', split: 'tune', question: 'Is there an entry pass for the Example Hill Circuit for helicopters?', destination: 'Example Hill', relevantDocs: [], expect: { status: 'insufficient' } },

  // ---- questions that invite an invented figure or fact
  { id: 'h01', category: 'hallucination_trap', split: 'tune', question: 'What is the price of a ticket on the Example Toy Railway?', relevantDocs: [], expect: { status: 'insufficient', excludes: ['₹'] } },
  { id: 'h02', category: 'hallucination_trap', split: 'holdout', question: 'Is there a senior citizen discount on the Example Toy Railway?', relevantDocs: [], expect: { status: 'insufficient' } },
  { id: 'h03', category: 'hallucination_trap', split: 'tune', question: 'Does the entry pass fee include lunch?', destination: 'Example Hill', relevantDocs: [], expect: { status: 'insufficient' } },
  { id: 'h04', category: 'hallucination_trap', split: 'holdout', question: 'How much is the fine for carrying a bicycle on the Example Toy Railway?', relevantDocs: [], expect: { status: 'insufficient', excludes: ['₹'] } },

  // ---- paraphrases with no shared vocabulary: a lexical embedder is expected to miss these
  { id: 'p01', category: 'paraphrase', split: 'tune', question: 'How heavy can my bags be on the mountain train before I pay extra?', relevantDocs: ['example-toy-railway'], expect: { status: 'answered', includes: ['20 kg'], cites: ['example-toy-railway'] } },
  { id: 'p02', category: 'paraphrase', split: 'holdout', question: 'Will I get my money back if I call off a trip at the last minute?', relevantDocs: ['wayfare-cancellation'], expect: { status: 'answered', cites: ['wayfare-cancellation'] } },
  { id: 'p03', category: 'paraphrase', split: 'tune', question: 'Do I need a ticket to walk into the forest trail?', destination: 'Example Hill', relevantDocs: ['example-hill-permit'], expect: { status: 'answered', cites: ['example-hill-permit'] } },
];
