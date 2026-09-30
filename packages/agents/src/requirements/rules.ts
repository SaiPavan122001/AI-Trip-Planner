import type { StatedHard, StatedSoft } from '@trip/shared';
import type { RequirementsDraft } from './finalise.js';
import { findDateSpans, findTime, numbersIn, parseRupees } from './text.js';
import { FIRM_CUE, GUIDE_CUE } from './vocabulary.js';

/**
 * The Requirements Agent without a model: keyword rules.
 *
 * Blunter than a model and entirely predictable. It reads only what is stated
 * plainly ("from Hyderabad to Goa", "12 to 16 December", "2 adults", "budget
 * ₹80,000", "no trains"), and leaves everything else unread rather than
 * guessing. The words each item was read from become its evidence, so it is
 * held to the same rules as a model's output.
 */

const NUMBER_TOKEN = '(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)';

export function draftFromRules(message: string, today: string): RequirementsDraft {
  const draft: RequirementsDraft = {
    origin: null,
    destination: null,
    departureDate: null,
    returnDate: null,
    adults: null,
    children: null,
    infants: null,
    budgetRupees: null,
    budgetFirm: null,
    hard: [],
    soft: [],
  };
  const hard = (kind: StatedHard['kind'], value: string, evidence: string) =>
    draft.hard.push({ kind, value, evidence: evidence.trim().slice(0, 200) });
  const soft = (kind: StatedSoft['kind'], value: string, evidence: string) =>
    draft.soft.push({ kind, value, evidence: evidence.trim().slice(0, 200) });

  // ---- places ------------------------------------------------------------
  const STOP = "(?=\\s+(?:on|in|for|with|from|between|starting|leaving|departing|by|next|this|around|during|and|under|within|budget)\\b|[,.;!?]|\\s+\\d|$)";
  const place = "([a-z][a-z.'-]*(?:\\s+[a-z][a-z.'-]*){0,2}?)";
  const fromTo = message.match(new RegExp(`\\bfrom\\s+${place}\\s+to\\s+${place}${STOP}`, 'i'));
  if (fromTo) {
    draft.origin = fromTo[1]!;
    draft.destination = fromTo[2]!;
  } else {
    const to = message.match(new RegExp(`\\b(?:trip|travel|going|go|fly|drive|visit|holiday|vacation)\\s+to\\s+${place}${STOP}`, 'i'));
    if (to) draft.destination = to[1]!;
    const from = message.match(new RegExp(`\\b(?:from|leaving|starting from|based in)\\s+${place}${STOP}`, 'i'));
    if (from) draft.origin = from[1]!;
  }

  // ---- dates -------------------------------------------------------------
  const dates = findDateSpans(message, today);
  if (dates[0]) draft.departureDate = dates[0].iso;
  if (dates[1] && dates[0] && dates[1].iso >= dates[0].iso) draft.returnDate = dates[1].iso;

  // ---- travellers ----------------------------------------------------------
  const count = (words: string) => {
    const m = message.match(new RegExp(`\\b${NUMBER_TOKEN}\\s+(?:${words})\\b`, 'i'));
    return m ? { n: numbersIn(m[1]!)[0] ?? null, text: m[0] } : null;
  };
  const adults = count('adults?|people|persons|travell?ers|of us|guests|pax');
  if (adults?.n) draft.adults = adults.n;
  if (/\b(solo|alone|by myself|just me|only me)\b/i.test(message) && draft.adults === null) draft.adults = 1;
  const children = count('children|kids|child');
  if (children?.n !== undefined && children?.n !== null) draft.children = children.n;
  const infants = count('infants?|babies|baby');
  if (infants?.n !== undefined && infants?.n !== null) draft.infants = infants.n;

  // ---- budget --------------------------------------------------------------
  for (const clause of message.split(/[.;!?\n]/)) {
    const amount = parseRupees(clause);
    if (amount === null) continue;
    // Whole words: "tours" ends in "rs" and "understand" starts with "under".
    if (!/(?:₹|\brs\b|\binr\b|\bbudget\b|\bspend|\bunder\b|\bwithin\b|\bbelow\b|\bexceed|\blimit\b|\bmaximum\b|\bmax\b|\bat most\b|\bno more\b)/i.test(clause)) continue;
    draft.budgetRupees = amount;
    if (FIRM_CUE.test(clause)) {
      draft.budgetFirm = true;
    } else if (GUIDE_CUE.test(clause)) {
      draft.budgetFirm = false;
    }
    break;
  }

  // ---- hard requirements ---------------------------------------------------
  const MODE_WORDS: Array<[string, RegExp]> = [
    ['flight', /(flights?|flying|planes?)/i],
    ['train', /(trains?|rail(?:way)?)/i],
    ['bus', /(buses|bus|coach(?:es)?)/i],
    ['self_drive', /(driving|self-?drive|my own car|our own car)/i],
    ['taxi', /(taxis?|cabs?)/i],
  ];
  const negation = '(?:no|avoid|without|not|never|skip|exclude|rule out|do not want|don\'?t want|don\'?t use)';
  for (const [mode, word] of MODE_WORDS) {
    const neg = message.match(new RegExp(`\\b${negation}\\b[^.,;]{0,25}\\b${word.source}`, 'i'));
    if (neg) {
      hard('excluded_mode', mode, neg[0]);
      continue;
    }
    const only = message.match(new RegExp(`\\b(?:only|must|have to|need to|just)\\b[^.,;]{0,20}\\b${word.source}|\\bby ${word.source}\\s+only\\b`, 'i'));
    if (only) {
      hard('required_mode', mode, only[0]);
      continue;
    }
    const prefer = message.match(new RegExp(`\\b(?:by|prefer|like|via|take the|would like)\\b[^.,;]{0,15}\\b${word.source}`, 'i'));
    if (prefer) soft('preferred_mode', mode, prefer[0]);
  }

  const overnight = message.match(new RegExp(`\\b${negation}\\b[^.,;]{0,20}(?:overnight|red.?eye|night (?:train|bus|journey|travel))`, 'i'));
  if (overnight) hard('avoid_overnight', 'true', overnight[0]);

  const direct = message.match(/\b(?:only|must be|just)\s+(?:direct|non.?stop)\b|\b(?:direct|non.?stop)\s+(?:flights?|only)\b/i);
  if (direct && /only|must|just/i.test(direct[0])) hard('max_stops', '0', direct[0]);

  const ACCESS: Array<[string, RegExp]> = [
    ['wheelchair_accessible_room', /wheelchair/i],
    ['step_free_access', /step.?free|no stairs/i],
    ['elevator_required', /\b(?:lift|elevator)\b/i],
    ['ground_floor_room', /ground.?floor/i],
    ['service_animal', /service (?:animal|dog)|guide dog/i],
    ['visual_assistance', /\b(?:blind|visually impaired)\b/i],
    ['hearing_assistance', /\b(?:deaf|hearing impaired|hard of hearing)\b/i],
  ];
  for (const [need, re] of ACCESS) {
    const m = message.match(re);
    if (m) hard('accessibility', need, m[0]);
  }
  const DIET: Array<[string, RegExp]> = [
    ['vegetarian', /vegetarian/i],
    ['vegan', /vegan/i],
    ['jain', /\bjain\b/i],
    ['halal', /halal/i],
    ['gluten_free', /gluten/i],
    ['nut_allergy', /nut allerg/i],
  ];
  for (const [diet, re] of DIET) {
    const m = message.match(re);
    if (m) hard('dietary', diet, m[0]);
  }

  const rooms = message.match(new RegExp(`\\b${NUMBER_TOKEN}\\s+rooms?\\b`, 'i'));
  if (rooms) {
    const n = numbersIn(rooms[1]!)[0];
    if (n) hard('rooms', String(n), rooms[0]);
  }
  const stars = message.match(/\b([345])\s*-?\s*star\b[^.,;]{0,20}\b(?:or (?:above|better|more)|minimum|at least)|\b(?:at least|minimum|no less than)\s+(?:a\s+)?([345])\s*-?\s*star/i);
  if (stars) hard('min_hotel_category', stars[1] ?? stars[2]!, stars[0]);
  if (/\b(?:free cancell?ation|refundable|cancell?able)\b/i.test(message)) {
    hard('free_cancellation', 'true', message.match(/\b(?:free cancell?ation|refundable|cancell?able)\b/i)![0]);
  }
  const arrive = message.match(/\b(?:arrive|reach|land|be there)\b[^.,;]{0,20}\b(?:before|by)\s+([^.,;]{1,12})/i);
  const arriveTime = arrive ? findTime(arrive[1]!) : null;
  if (arrive && arriveTime) hard('latest_arrival', arriveTime, arrive[0]);
  const leave = message.match(/\b(?:depart|leave|leaving|set off)\b[^.,;]{0,20}\bafter\s+([^.,;]{1,12})/i);
  const leaveTime = leave ? findTime(leave[1]!) : null;
  if (leave && leaveTime) hard('earliest_departure', leaveTime, leave[0]);

  // ---- soft preferences ------------------------------------------------------
  const PRIORITY: Array<[string, RegExp]> = [
    ['cheapest', /\b(?:cheap(?:est)?|budget-?friendly|low.?cost|inexpensive|save money)\b/i],
    ['fastest', /\b(?:fastest|quickest|shortest journey)\b/i],
    ['most_comfortable', /\b(?:comfortable|comfort)\b/i],
    ['safest', /\b(?:safe|safest|safety)\b/i],
    ['luxury', /\b(?:luxury|luxurious|lavish)\b/i],
    ['family_friendly', /\bfamily.?friendly\b/i],
    ['scenic', /\b(?:scenic|picturesque)\b/i],
  ];
  const priorities = PRIORITY.map(([p, re]) => ({ p, m: message.match(re) }))
    .filter((x) => x.m)
    .sort((a, b) => (a.m!.index ?? 0) - (b.m!.index ?? 0));
  for (const { p, m } of priorities) soft('priority', p, m![0]);

  const STYLE: Array<[string, RegExp]> = [
    ['luxury', /\bluxur(?:y|ious)\b/i],
    ['budget', /\bbackpack(?:ing|er)?\b|\bshoestring\b/i],
  ];
  for (const [style, re] of STYLE) {
    const m = message.match(re);
    if (m) soft('travel_style', style, m[0]);
  }
  const INTEREST: Array<[string, RegExp]> = [
    ['museums', /\b(?:museums?|galleries|gallery)\b/i],
    ['history', /\b(?:history|historical|heritage|forts?|palaces?|monuments?)\b/i],
    ['nature', /\b(?:nature|hiking|trekking|wildlife|waterfalls?|forests?)\b/i],
    ['beaches', /\b(?:beach(?:es)?)\b/i],
    ['adventure', /\b(?:adventure|rafting|paragliding|diving|thrill)\b/i],
    ['religious', /\b(?:temples?|churches|church|mosques?|pilgrimage|shrines?)\b/i],
    ['shopping', /\b(?:shopping|markets?|bazaars?)\b/i],
    ['nightlife', /\b(?:nightlife|night life|clubs?|bars)\b/i],
  ];
  for (const [interest, re] of INTEREST) {
    const m = message.match(re);
    if (m) soft('activity_interest', interest, m[0]);
  }
  const pace = message.match(/\b(?:relaxed|slow|leisurely|easy)\s+(?:pace|days?|trip|itinerary)|\bnot too (?:much|busy)\b/i);
  if (pace) soft('pace', 'relaxed', pace[0]);
  else {
    const busy = message.match(/\b(?:packed|busy|jam.?packed)\s+(?:itinerary|days?|schedule)|\bsee as much as\b/i);
    if (busy) soft('pace', 'packed', busy[0]);
  }
  const AMENITY: Array<[string, RegExp]> = [
    ['wifi', /\bwi.?fi\b/i],
    ['breakfast', /\bbreakfast\b/i],
    ['pool', /\b(?:swimming )?pool\b/i],
    ['parking', /\bparking\b/i],
  ];
  for (const [amenity, re] of AMENITY) {
    const m = message.match(re);
    if (m) soft('amenity', amenity, m[0]);
  }
  const PARTY: Array<[string, RegExp]> = [
    ['couple', /\b(?:honeymoon|with my (?:wife|husband|partner))\b/i],
    ['family', /\bwith (?:my |our )?(?:family|kids|children)\b/i],
    ['friends', /\bwith (?:my |our )?friends\b/i],
  ];
  for (const [party, re] of PARTY) {
    const m = message.match(re);
    if (m) soft('party_type', party, m[0]);
  }

  return draft;
}
