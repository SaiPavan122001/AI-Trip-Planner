/**
 * The evaluation corpus, version 1.
 *
 * **Every document here is fictional.** The railway, the ferry, the hill
 * circuit, the company and every rule, fee and date are invented for this
 * fixture, so that nothing in it can be mistaken for real travel advice and so
 * that no answer to a question about it can be known from anywhere but the
 * retrieved text. A real deployment ingests its operator's own curated
 * documents; this corpus is for measuring the pipeline.
 *
 * The fixture is versioned (`CORPUS_VERSION`): changing a document, adding one
 * or removing one is a new version, and the regression baseline is recorded
 * against a version.
 */

export const CORPUS_VERSION = 'corpus/1';
export const EVAL_NAMESPACE = 'eval';
/** "Today" for every evaluation run, so results do not depend on the date they are run. */
export const EVAL_AS_OF = '2026-09-01';

const FIXTURE = 'Fictional evaluation fixture; not real advice.';

export interface CorpusDoc {
  id: string;
  title: string;
  reference: string;
  url?: string;
  sourceType: 'government_advisory' | 'official_guideline' | 'operator_policy' | 'curated_guide' | 'community_note';
  version: number;
  effectiveDate: string;
  reviewBy?: string;
  topic?: string;
  destination?: string;
  text: string;
}

export const CORPUS: CorpusDoc[] = [
  {
    id: 'wayfare-cancellation',
    title: 'Wayfare Example Co. Cancellation Policy',
    reference: `Wayfare Example Co. Cancellation Policy v2. ${FIXTURE}`,
    url: 'https://example.com/policies/cancellation',
    sourceType: 'operator_policy',
    version: 2,
    effectiveDate: '2026-01-15',
    reviewBy: '2027-01-15',
    topic: 'cancellation',
    text: `# Cancellation policy

## Individual bookings

A traveller who cancels an individual booking at least 7 days before departure pays no fee.
A cancellation made between 3 and 6 days before departure is charged a fee of 25% of the booking value.
A cancellation made less than 3 days before departure is not refunded.

## Group bookings

A group booking is a booking for 10 or more people.
A group that cancels at least 15 days before departure pays no fee.
A group that cancels between 7 and 14 days before departure is charged a fee of 10% of the booking value.
A group that cancels less than 7 days before departure is charged a fee of 50% of the booking value.

## Cancelling because of an official closure

If an official authority closes the route the trip depends on, the booking is refunded in full and no cancellation fee applies.`,
  },
  {
    id: 'wayfare-rescheduling',
    title: 'Wayfare Example Co. Rescheduling Rules',
    reference: `Wayfare Example Co. Rescheduling Rules v1. ${FIXTURE}`,
    sourceType: 'operator_policy',
    version: 1,
    effectiveDate: '2026-02-01',
    reviewBy: '2027-02-01',
    topic: 'rescheduling',
    text: `# Rescheduling

## Changing the travel dates

Changing the travel dates of a booking costs a rescheduling fee of ₹300 for each traveller.
A date change made within 24 hours of making the booking has no rescheduling fee.
A booking can be rescheduled only once.`,
  },
  {
    id: 'wayfare-refunds',
    title: 'Wayfare Example Co. Refund Timelines',
    reference: `Wayfare Example Co. Refund Timelines v1. ${FIXTURE}`,
    sourceType: 'operator_policy',
    version: 1,
    effectiveDate: '2026-02-01',
    reviewBy: '2027-02-01',
    topic: 'refunds',
    text: `# Refunds

## When the money comes back

An approved refund is returned to the original payment method within 7 to 10 working days.
Refunds are never paid in cash or to a different account.
A refund for a cancelled group booking is processed as one payment to the person who made the booking.`,
  },
  {
    id: 'example-hill-permit',
    title: 'Example Hill Circuit Entry Pass Notice',
    reference: `Example Hill Forest Authority Notice 12/2026. ${FIXTURE}`,
    url: 'https://example.org/hill-circuit/entry-pass',
    sourceType: 'government_advisory',
    version: 1,
    effectiveDate: '2026-03-01',
    reviewBy: '2027-03-01',
    topic: 'hill-entry-pass',
    destination: 'Example Hill',
    text: `# Entry pass

## Who needs a pass

Every visitor to the Example Hill Circuit needs an entry pass.
Children under 5 do not need a pass.

## Fee and validity

The entry pass fee is ₹200 for each person.
A pass is valid for 5 days from the day it is issued.

## Where to get it

Passes are issued at the Example Gate office between 8 am and 4 pm.`,
  },
  {
    id: 'example-hill-permit-guide',
    title: 'Independent Guide to the Example Hill Circuit',
    reference: `Hill Walkers Example Guide, 2024 edition. ${FIXTURE}`,
    sourceType: 'curated_guide',
    version: 1,
    effectiveDate: '2024-06-10',
    reviewBy: '2027-06-10',
    topic: 'hill-entry-pass',
    destination: 'Example Hill',
    text: `# Entry pass

## Fee and validity

The entry pass fee is ₹250 for each person.
A pass is valid for 3 days from the day it is issued.`,
  },
  {
    id: 'example-toy-railway',
    title: 'Example Toy Railway Passenger Charter',
    reference: `Example Toy Railway Passenger Charter, section 4. ${FIXTURE}`,
    url: 'https://example.net/toy-railway/charter',
    sourceType: 'official_guideline',
    version: 3,
    effectiveDate: '2026-04-01',
    reviewBy: '2027-04-01',
    topic: 'toy-railway-rules',
    destination: 'Example Hill',
    text: `# Passenger charter

## Luggage

Each passenger may carry up to 20 kg of luggage free of charge.
Luggage above 20 kg is charged at ₹40 for each extra kg.
Bicycles are not carried on the Example Toy Railway.

## Boarding

Passengers must be at the station 30 minutes before departure.
Children under 5 travel free and are not given a seat of their own.

## Pets

Pets are not permitted on the Example Toy Railway.
Assistance dogs are permitted when the passenger carries a certificate.`,
  },
  {
    id: 'example-ferry-rules',
    title: 'Example Lake Ferry Rules',
    reference: `Example Lake Ferry Rules 2024. ${FIXTURE}`,
    sourceType: 'curated_guide',
    version: 1,
    effectiveDate: '2024-05-01',
    reviewBy: '2025-12-31',
    topic: 'ferry-rules',
    destination: 'Example Lake',
    text: `# Ferry rules

## Safety

Life jackets are compulsory for every passenger on the Example Lake Ferry.
The ferry leaves every 2 hours from the main jetty.`,
  },
  {
    id: 'example-lake-ferry-forum',
    title: 'Traveller Notes on the Example Lake Ferry',
    reference: `Traveller forum thread. ${FIXTURE}`,
    sourceType: 'community_note',
    version: 1,
    effectiveDate: '2026-06-01',
    reviewBy: '2027-06-01',
    destination: 'Example Lake',
    text: `# Traveller notes

## Delays

Some travellers report that the last ferry of the evening sometimes leaves 20 minutes late.`,
  },
  {
    id: 'monsoon-driving',
    title: 'Driving in Heavy Rain: A Practical Guide',
    reference: `Example Motorists Guide, monsoon edition. ${FIXTURE}`,
    sourceType: 'curated_guide',
    version: 1,
    effectiveDate: '2026-05-01',
    reviewBy: '2027-05-01',
    topic: 'monsoon-driving',
    text: `# Driving in heavy rain

## Speed and distance

In heavy rain keep your speed below 50 km/h on hill roads.
Leave a gap of at least 3 seconds to the vehicle in front.

## Flooded roads

Do not drive through water when you cannot see the road surface.
Turn back and take another route if the water is deeper than the middle of the wheel.`,
  },
  {
    id: 'altitude-guide',
    title: 'Acclimatising at Altitude',
    reference: `Example Mountain Health Guide. ${FIXTURE}`,
    sourceType: 'curated_guide',
    version: 1,
    effectiveDate: '2026-01-10',
    reviewBy: '2027-01-10',
    topic: 'altitude',
    text: `# Acclimatising at altitude

## The first day

After arriving at a place above 3000 m, rest for the whole first day.

## Climbing higher

Raise the height at which you sleep by no more than 500 m each day.
Take a rest day after every 3 days of climbing.

## Warning signs

A headache that gets worse, nausea and dizziness are warning signs of altitude sickness.
Descend at once if the symptoms get worse.`,
  },
  {
    id: 'fuel-and-road',
    title: 'Example Hill Road: Fuel and Distances',
    reference: `Example Hill Motorists Note. ${FIXTURE}`,
    sourceType: 'curated_guide',
    version: 1,
    effectiveDate: '2026-02-20',
    reviewBy: '2027-02-20',
    destination: 'Example Hill',
    text: `# Fuel and distances

## Fuel

The last fuel station on the Example Hill Road is at Example Gate.
Fill the tank at Example Gate before you drive up.

## Distances

The road from Example Gate to the summit is 62 km long.`,
  },
  {
    id: 'insurance-note',
    title: 'Travel Insurance for Domestic Trips',
    reference: `Example Traveller Guide, insurance chapter. ${FIXTURE}`,
    sourceType: 'curated_guide',
    version: 1,
    effectiveDate: '2026-03-15',
    reviewBy: '2027-03-15',
    topic: 'insurance',
    text: `# Travel insurance

## Is it required

Travel insurance is not mandatory for domestic trips.
It is recommended for treks that go above 3500 m.`,
  },
  {
    id: 'cold-packing',
    title: 'Packing for Cold Weather Treks',
    reference: `Example Trekkers Handbook, packing list. ${FIXTURE}`,
    sourceType: 'curated_guide',
    version: 1,
    effectiveDate: '2026-01-05',
    reviewBy: '2027-01-05',
    topic: 'packing',
    text: `# Packing for cold treks

## Layers

Carry three layers: a base layer, an insulating layer and a waterproof shell.
Wool or synthetic base layers stay warm when damp.

## Small items

Carry a headlamp with spare batteries and a small first-aid kit.`,
  },
  {
    id: 'restricted-area-note',
    title: 'Example Lake Region Access Rules',
    reference: `Example Lake District Notice 3/2026. ${FIXTURE}`,
    sourceType: 'government_advisory',
    version: 1,
    effectiveDate: '2026-04-10',
    reviewBy: '2027-04-10',
    topic: 'lake-access',
    destination: 'Example Lake',
    text: `# Access rules

## Who needs a permit

Visitors from outside the country need a Restricted Area Permit to enter the Example Lake region.
Citizens of the country do not need a permit for the Example Lake region.

## Validity

A Restricted Area Permit is valid for 7 days.`,
  },
  {
    id: 'lost-luggage',
    title: 'Wayfare Example Co. Lost Luggage Help',
    reference: `Wayfare Example Co. Support Note. ${FIXTURE}`,
    sourceType: 'operator_policy',
    version: 1,
    effectiveDate: '2026-02-15',
    reviewBy: '2027-02-15',
    topic: 'lost-luggage',
    text: `# Lost luggage

## Reporting

Report lost luggage to the station master before you leave the station.
Keep the report number, because the operator asks for it when you make a claim.`,
  },
];
