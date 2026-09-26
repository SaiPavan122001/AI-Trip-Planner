/**
 * The time utilities live in @trip/shared so provider adapters can use them
 * too (a provider must never interpret a local time in the server's zone).
 * Re-exported here so the engine's existing imports keep working.
 */
export {
  addMinutes,
  datesBetween,
  formatLocal,
  instantFrom,
  isoWithOffset,
  localParts,
  minutesBetween,
  offsetMinutes,
  utcFromLocal,
  type LocalParts,
} from '@trip/shared';
