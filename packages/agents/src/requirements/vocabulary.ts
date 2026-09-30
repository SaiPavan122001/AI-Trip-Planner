import {
  AccessibilityNeed,
  ActivityInterest,
  ActivityPace,
  CabinClass,
  DietaryRequirement,
  PartyType,
  Priority,
  StayAmenity,
  StayArea,
  TransportMode,
  TravelStyle,
  type HardKind,
  type SoftKind,
} from '@trip/shared';
import type { z } from 'zod';

/**
 * The closed vocabulary behind every requirement, and the words that have to
 * be present in the quoted evidence for a value to be believed.
 *
 * A model reading "no trains please" may report an excluded mode of `train`;
 * reading "we like trains" it must not. The cue check does not understand
 * meaning, but it does mean that every requirement is anchored to words the
 * traveller actually used about that very thing. A requirement whose quote
 * never mentions its subject is dropped, which is the cheap way to stop a
 * model attaching a hard constraint to a sentence that was about something else.
 */

/** What kinds take which values. A value outside its list is rejected. */
const enumValues = (e: z.ZodEnum<[string, ...string[]]>) => new Set<string>(e.options);

export const HARD_VALUES: Record<HardKind, (value: string) => boolean> = {
  excluded_mode: (v) => enumValues(TransportMode).has(v),
  required_mode: (v) => enumValues(TransportMode).has(v),
  avoid_overnight: (v) => v === 'true',
  max_stops: (v) => /^[0-3]$/.test(v),
  min_hotel_category: (v) => /^[0-5]$/.test(v),
  accessibility: (v) => enumValues(AccessibilityNeed).has(v),
  rooms: (v) => /^([1-9]|1\d|20)$/.test(v),
  latest_arrival: (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v),
  earliest_departure: (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v),
  free_cancellation: (v) => v === 'true',
  dietary: (v) => enumValues(DietaryRequirement).has(v),
};

export const SOFT_VALUES: Record<SoftKind, (value: string) => boolean> = {
  priority: (v) => enumValues(Priority).has(v),
  preferred_mode: (v) => enumValues(TransportMode).has(v),
  travel_style: (v) => enumValues(TravelStyle).has(v),
  amenity: (v) => enumValues(StayAmenity).has(v),
  stay_area: (v) => enumValues(StayArea).has(v),
  activity_interest: (v) => enumValues(ActivityInterest).has(v),
  pace: (v) => enumValues(ActivityPace).has(v),
  cabin_class: (v) => enumValues(CabinClass).has(v),
  party_type: (v) => enumValues(PartyType).has(v),
};

const MODE_CUE: Record<string, RegExp> = {
  flight: /\b(flight|flights|fly|flying|plane|air|airline)\b/,
  train: /\b(train|trains|rail|railway)\b/,
  bus: /\b(bus|buses|coach)\b/,
  self_drive: /\b(drive|driving|own car|my car|our car|self-drive|self drive|road trip)\b/,
  rental_car: /\b(rental|rent a car|hire)\b/,
  taxi: /\b(taxi|cab|private car)\b/,
  ferry: /\b(ferry|boat|ship|cruise)\b/,
};

const ACCESSIBILITY_CUE: Record<string, RegExp> = {
  step_free_access: /step.?free|ramp|no stairs|wheelchair/,
  wheelchair_accessible_room: /wheelchair/,
  wheelchair_assistance_at_terminal: /wheelchair|assistance/,
  accessible_bathroom: /bathroom|shower|toilet/,
  elevator_required: /lift|elevator/,
  ground_floor_room: /ground.?floor/,
  service_animal: /service (animal|dog)|guide dog/,
  visual_assistance: /blind|visual|sight/,
  hearing_assistance: /deaf|hearing/,
};

const DIETARY_CUE: Record<string, RegExp> = {
  vegetarian: /vegetarian|veg\b/,
  vegan: /vegan/,
  jain: /jain/,
  halal: /halal/,
  kosher: /kosher/,
  gluten_free: /gluten/,
  nut_allergy: /nut/,
  lactose_free: /lactose|dairy/,
  diabetic: /diabet/,
};

const PRIORITY_CUE: Record<string, RegExp> = {
  cheapest: /cheap|budget|afford|low.?cost|save|saving|inexpensive/,
  fastest: /fast|quick|shortest|speed|\btime\b/,
  most_comfortable: /comfort|relax|cosy|cozy/,
  safest: /safe|safety|secure/,
  luxury: /luxur|premium|five.?star|5.?star/,
  family_friendly: /family|kids|children/,
  flexible: /flexib|refund|cancel/,
  scenic: /scenic|views?|picturesque/,
  least_travel_time: /least travel|short(est)? journey|less travel/,
  fewest_transfers: /direct|non.?stop|fewest|no changes|no transfers|few (changes|transfers)/,
};

const INTEREST_CUE: Record<string, RegExp> = {
  museums: /museum|gallery|\bart\b/,
  history: /histor|heritage|\bforts?\b|palace|monument|ruins/,
  nature: /nature|park|hik|trek|wildlife|forest|waterfall/,
  beaches: /beach|coast|\bsea\b/,
  adventure: /advent|trek|rafting|paraglid|dive|diving|thrill/,
  religious: /temple|church|mosque|pilgrim|shrine|spiritual|gurudwara/,
  shopping: /shop|market|bazaar/,
  nightlife: /night ?life|\bclubs?\b|\bbars?\b|\bparty\b/,
  family: /family|kids|children|zoo|aquarium/,
};

const AMENITY_CUE: Record<string, RegExp> = {
  wifi: /wi.?fi|internet/,
  breakfast: /breakfast/,
  pool: /pool|swim/,
  parking: /parking/,
  air_conditioning: /\bac\b|air.?con/,
  gym: /gym|fitness/,
  spa: /spa|massage/,
  kitchen: /kitchen|self.?cater/,
  family_rooms: /family room|connecting/,
};

const STYLE_CUE: Record<string, RegExp> = {
  budget: /budget|cheap|backpack|shoestring/,
  standard: /standard|mid.?range|comfortable/,
  premium: /premium|upscale|nice/,
  luxury: /luxur|five.?star|5.?star|lavish/,
};

const CABIN_CUE: Record<string, RegExp> = {
  economy: /economy|coach/,
  premium_economy: /premium economy/,
  business: /business class|business cabin/,
  first: /first class/,
};

const PARTY_CUE: Record<string, RegExp> = {
  solo: /solo|\balone\b|by myself|just me/,
  couple: /couple|wife|husband|partner|honeymoon/,
  family: /family|kids|children/,
  friends: /friends/,
  group: /group|team outing/,
  business_team: /colleagues|team|business/,
};

const AREA_CUE: Record<string, RegExp> = {
  near_activities: /near|close|walking|nearby/,
  central: /central|centre|center|downtown|heart of/,
  quiet: /quiet|peaceful|calm/,
  near_transport: /station|airport|metro|transit/,
};

const PACE_CUE: Record<string, RegExp> = {
  relaxed: /relax|slow|easy|leisurely|not too much/,
  balanced: /balanced|moderate/,
  packed: /packed|busy|as much as|everything|full/,
};

/** Words that say something is ruled out. */
const NEGATION = /\b(?:no|avoid|without|not|never|skip|exclude|rule out|don'?t|do not|can'?t|cannot|won'?t|hate|dislike|except)\b/;
/** Words that say something is required, not just liked. */
const REQUIREMENT = /\b(?:only|must|have to|need to|needs to|just|exclusively|require[sd]?|insist|by)\b/;

/**
 * Does this evidence talk about this value? Kinds with a free-form value
 * (times, counts) are checked by their own parsers instead.
 */
export function evidenceMentions(kind: HardKind | SoftKind, value: string, evidence: string): boolean {
  const e = evidence.toLowerCase();
  switch (kind) {
    // Ruling a mode out or insisting on one is a hard requirement, so the words
    // must say so, not merely mention the mode: "we like trains" excludes nothing.
    case 'excluded_mode':
      return (MODE_CUE[value]?.test(e) ?? false) && NEGATION.test(e);
    case 'required_mode':
      return (MODE_CUE[value]?.test(e) ?? false) && REQUIREMENT.test(e) && !NEGATION.test(e);
    case 'preferred_mode':
      return MODE_CUE[value]?.test(e) ?? false;
    case 'accessibility':
      return ACCESSIBILITY_CUE[value]?.test(e) ?? false;
    case 'dietary':
      return DIETARY_CUE[value]?.test(e) ?? false;
    case 'priority':
      return PRIORITY_CUE[value]?.test(e) ?? false;
    case 'activity_interest':
      return INTEREST_CUE[value]?.test(e) ?? false;
    case 'amenity':
      return AMENITY_CUE[value]?.test(e) ?? false;
    case 'travel_style':
      return STYLE_CUE[value]?.test(e) ?? false;
    case 'cabin_class':
      return CABIN_CUE[value]?.test(e) ?? false;
    case 'party_type':
      return PARTY_CUE[value]?.test(e) ?? false;
    case 'stay_area':
      return AREA_CUE[value]?.test(e) ?? false;
    case 'pace':
      return PACE_CUE[value]?.test(e) ?? false;
    case 'avoid_overnight':
      return /overnight|night (train|bus|journey|travel)|red.?eye|sleeper/.test(e) && NEGATION.test(e);
    case 'free_cancellation':
      return /cancel|refund/.test(e);
    case 'max_stops':
      return /stop|direct|non.?stop|change|transfer|layover/.test(e);
    case 'min_hotel_category':
      return /star|category|rated/.test(e) && /\b(?:minimum|at least|or (?:above|better|more)|no less than|only|must)\b/.test(e);
    case 'rooms':
      return /room/.test(e);
    case 'latest_arrival':
      return /arriv|reach|get there|land/.test(e);
    case 'earliest_departure':
      return /depart|leave|leaving|after|start/.test(e);
  }
}

/**
 * Words that make a budget a limit rather than a guide. Whole words only:
 * "confirm my booking" contains "firm" and says nothing about a budget.
 */
export const FIRM_CUE =
  /\b(?:(?:do not|don'?t|never|must not|cannot|can'?t|not)\s+(?:exceed|go over|spend more)|hard limit|strict|strictly|firm|no more than|at most|maximum|max|absolute|upper limit)\b/i;

/** Words that make a budget a rough guide. */
export const GUIDE_CUE = /\b(?:guide|flexible|roughly|around|approx|approximately|about|ballpark|rough)\b/i;

/** The tables the rule-based fallback reads, in the order they are tried. */
export const RULE_CUES = {
  MODE_CUE,
  ACCESSIBILITY_CUE,
  DIETARY_CUE,
  PRIORITY_CUE,
  INTEREST_CUE,
  AMENITY_CUE,
  STYLE_CUE,
  CABIN_CUE,
  PARTY_CUE,
  AREA_CUE,
  PACE_CUE,
} as const;
