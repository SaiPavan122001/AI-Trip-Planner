import { z } from 'zod';

/**
 * What the knowledge layer stores and returns.
 *
 * This layer answers questions whose answer is written down somewhere an
 * operator chose to trust: a cancellation policy, a permit rule, a note about
 * a railway's luggage limits. It never holds, and is never asked for, anything
 * that changes minute to minute (a fare, a room, a timetable, the weather, the
 * state of a booking): those come from providers, at the moment they are
 * needed, with their provenance. See docs/knowledge.md for the boundary.
 */

/**
 * Where a document came from, most trustworthy first. The rank is the
 * document's authority and is used to filter retrieval and to order sources
 * that disagree; it is a property of the source type, decided here, and never
 * of anything the document says about itself.
 */
export const SOURCE_TYPES = ['government_advisory', 'official_guideline', 'operator_policy', 'curated_guide', 'community_note'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const AUTHORITY: Record<SourceType, number> = {
  government_advisory: 4,
  official_guideline: 3,
  operator_policy: 3,
  curated_guide: 2,
  community_note: 1,
};

/** Community notes are stored (an operator may want them) but not used to answer unless a caller asks for them. */
export const DEFAULT_MIN_AUTHORITY = 2;

/** A namespace is a whole, separate index: retrieval always names one, and never spans two. */
export const NAMESPACE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
export const PUBLIC_NAMESPACE = 'public';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date as YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'a real date');

/**
 * What an operator submits. Strict: a field nobody asked for is an error. There
 * is deliberately no owner, user, trip or email field: this index is shared, so
 * nothing in it may belong to one traveller.
 */
export const DocumentInputSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/, 'lower-case letters, digits, dot, dash and underscore'),
    namespace: z.string().regex(NAMESPACE_PATTERN).default(PUBLIC_NAMESPACE),
    title: z.string().min(3).max(200),
    /** Where the traveller can read the original. Shown, never fetched. */
    url: z.string().max(500).optional(),
    /** A citation that stands without a link ("Example Rail Passenger Charter, section 4"). */
    reference: z.string().min(3).max(200),
    sourceType: z.enum(SOURCE_TYPES),
    /** Whole numbers only; a newer version has a larger number. */
    version: z.number().int().min(1).max(100_000),
    effectiveDate: isoDate,
    /** After this date the document is treated as out of date until someone reviews it. */
    reviewBy: isoDate.optional(),
    /** Documents about the same question share a topic; that is how disagreement is noticed. */
    topic: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).optional(),
    destination: z.string().min(2).max(80).optional(),
    text: z.string().min(20).max(200_000),
  })
  .strict();
export type DocumentInput = z.infer<typeof DocumentInputSchema>;

export type DocumentStatus = 'active' | 'superseded' | 'quarantined';

export interface StoredDocument {
  id: string;
  namespace: string;
  title: string;
  url: string | null;
  reference: string;
  sourceType: SourceType;
  authority: number;
  version: number;
  effectiveDate: string;
  reviewBy: string | null;
  topic: string | null;
  destination: string | null;
  /** SHA-256 of the cleaned text; what "the same document" means. */
  contentHash: string;
  status: DocumentStatus;
  /** Why a document was held back; reason codes, never the text that triggered them. */
  quarantineReasons: string[];
  chunkCount: number;
  /** Versions this id has had before, oldest first. */
  previousVersions: Array<{ version: number; contentHash: string; supersededAt: string }>;
  /** The embedding space its chunks live in, or null when it has none (quarantined). */
  embeddingSpace: string | null;
  ingestedAt: string;
}

export interface Chunk {
  /** `<docId>@v<version>#<index>`: stable, and names the version it came from. */
  id: string;
  docId: string;
  version: number;
  index: number;
  /** The heading path the chunk sits under ("Refunds > Cancelling a group booking"). */
  heading: string;
  /** Exactly `document.text.slice(start, end)`. */
  text: string;
  start: number;
  end: number;
  hash: string;
}

/** A chunk as the index holds it: its text and vector, and the document facts retrieval filters on. */
export interface IndexedChunk extends Chunk {
  namespace: string;
  space: string;
  vector: Float32Array;
  title: string;
  url: string | null;
  reference: string;
  sourceType: SourceType;
  authority: number;
  effectiveDate: string;
  reviewBy: string | null;
  topic: string | null;
  destination: string | null;
}

export interface SearchFilters {
  minAuthority?: number;
  sourceTypes?: readonly SourceType[];
  destination?: string;
  topics?: readonly string[];
}

export interface ScoredChunk {
  chunk: IndexedChunk;
  score: number;
}

/** Text shown when nothing verified answers the question. Exact, so callers can compare against it. */
export const INSUFFICIENT = 'Insufficient verified information.';
