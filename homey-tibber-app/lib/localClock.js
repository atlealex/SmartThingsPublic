'use strict';

/**
 * Homey Pro's own OS clock runs UTC regardless of the timezone configured
 * in the Homey app - plain `new Date().getHours()` reflects that OS clock,
 * not the user's actual local time. This resolves "now" against Homey's
 * configured timezone (homey.clock.getTimezone()) instead, for anything
 * that needs to know the real local wall-clock time, local midnight, or
 * local start-of-month.
 *
 * @param {string|undefined} timeZone e.g. "Europe/Oslo"
 * @returns {{year:number, month:number, day:number, hour:number, minute:number, midnightMs:number, nowMs:number}}
 *   year/month(1-12)/day/hour/minute: local wall-clock date and time right now.
 *   midnightMs: the real UTC instant of local midnight today.
 *   nowMs: the real UTC instant right now (same as Date.now()).
 */
function zoneNow(timeZone) {
  const now = new Date();
  if (!timeZone) {
    return {
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      day: now.getDate(),
      hour: now.getHours(),
      minute: now.getMinutes(),
      midnightMs: new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(),
      nowMs: now.getTime(),
    };
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const hour = get('hour') === 24 ? 0 : get('hour');
  const year = get('year');
  const month = get('month');
  const day = get('day');

  const asUtc = Date.UTC(year, month - 1, day, hour, get('minute'), get('second'));
  const offsetMs = asUtc - now.getTime();
  const midnightAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0);

  return {
    year, month, day, hour, minute: get('minute'), midnightMs: midnightAsUtc - offsetMs, nowMs: now.getTime(),
  };
}

/**
 * The real UTC instant of the 1st of the given local year/month at
 * 00:00 local time, plus how many days that month has - both needed to
 * turn "elapsed since start of month" and "hours in this month" into real
 * durations without the OS-clock timezone trap described above.
 */
function monthBoundsMs(timeZone, year, month) {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (!timeZone) {
    return { startMs: new Date(year, month - 1, 1).getTime(), daysInMonth };
  }
  // Same trick as zoneNow: format a UTC-anchored guess through the target
  // zone to recover that zone's UTC offset, then apply it to the naive
  // Date.UTC(...) instant for local midnight on the 1st.
  const guess = new Date(Date.UTC(year, month - 1, 1, 12, 0, 0));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(guess);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const hour = get('hour') === 24 ? 0 : get('hour');
  const asUtc = Date.UTC(year, month - 1, 1, hour, get('minute'), get('second'));
  const offsetMs = asUtc - guess.getTime();
  const startAsUtc = Date.UTC(year, month - 1, 1, 0, 0, 0);
  return { startMs: startAsUtc - offsetMs, daysInMonth };
}

module.exports = { zoneNow, monthBoundsMs };
