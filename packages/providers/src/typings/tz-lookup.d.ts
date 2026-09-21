declare module 'tz-lookup' {
  /** Returns the IANA timezone for a coordinate; throws if out of range. */
  export default function tzLookup(lat: number, lon: number): string;
}
