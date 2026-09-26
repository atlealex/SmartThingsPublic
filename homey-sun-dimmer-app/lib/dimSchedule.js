'use strict';

/**
 * Computes the target dim level (0-100) for "now", given today's sunrise
 * and sunset. Stateless by design: every tick recomputes purely from the
 * clock and today's sun times, so it self-heals after an app restart or a
 * missed poll instead of needing to remember "we're mid-fade, X% through".
 *
 * Day layout (all times are for the same calendar day as `now`):
 *   [00:00, sunrise)                    -> min   (still night)
 *   [sunrise, sunrise+duration)         -> min -> max (morning transition)
 *   [sunrise+duration, sunset)          -> max   (day)
 *   [sunset, sunset+duration)           -> max -> min (evening transition)
 *   [sunset+duration, 24:00)            -> min   (night)
 *
 * @param {Date} now
 * @param {Date} sunrise - today's sunrise
 * @param {Date} sunset - today's sunset
 * @param {number} transitionMs - transition length in milliseconds, used for both edges
 * @param {number} min - target at night (0-100)
 * @param {number} max - target during the day (0-100)
 * @returns {number} target level, 0-100
 */
function computeTargetPercent(now, sunrise, sunset, transitionMs, min, max) {
  const t = now.getTime();
  const sunriseEnd = sunrise.getTime() + transitionMs;
  const sunsetEnd = sunset.getTime() + transitionMs;

  if (t < sunrise.getTime()) return min;
  if (t < sunriseEnd) return lerp(min, max, (t - sunrise.getTime()) / transitionMs);
  if (t < sunset.getTime()) return max;
  if (t < sunsetEnd) return lerp(max, min, (t - sunset.getTime()) / transitionMs);
  return min;
}

function lerp(from, to, fraction) {
  return from + (to - from) * fraction;
}

module.exports = { computeTargetPercent };
