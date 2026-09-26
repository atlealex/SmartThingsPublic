'use strict';

/**
 * Computes the scheduled target dim level (0-100) for "now", given today's
 * sunrise/sunset and independent enable/offset settings for each direction.
 * Stateless by design: every tick recomputes purely from the clock and
 * today's sun times, so it self-heals after an app restart or a missed
 * poll instead of needing to remember "we're mid-fade, X% through".
 *
 * "Offset" shifts the transition to start that many ms *before* the sun
 * event (e.g. sunsetOffsetMs of 10 minutes starts dimming 10 minutes
 * before actual sunset).
 *
 * @returns {number} target level, 0-100
 */
function computeScheduledPercent({
  now, sunrise, sunset, transitionMs,
  sunriseEnabled, sunriseOffsetMs,
  sunsetEnabled, sunsetOffsetMs,
  min, max,
}) {
  const t = now.getTime();
  const sunriseStart = sunrise.getTime() - sunriseOffsetMs;
  const sunriseEnd = sunriseStart + transitionMs;
  const sunsetStart = sunset.getTime() - sunsetOffsetMs;
  const sunsetEnd = sunsetStart + transitionMs;

  if (sunriseEnabled && sunsetEnabled) {
    if (t < sunriseStart) return min;
    if (t < sunriseEnd) return lerp(min, max, (t - sunriseStart) / transitionMs);
    if (t < sunsetStart) return max;
    if (t < sunsetEnd) return lerp(max, min, (t - sunsetStart) / transitionMs);
    return min;
  }

  if (sunriseEnabled && !sunsetEnabled) {
    // No evening dim-down: once the morning ramp finishes, hold at max.
    if (t < sunriseStart) return min;
    if (t < sunriseEnd) return lerp(min, max, (t - sunriseStart) / transitionMs);
    return max;
  }

  if (!sunriseEnabled && sunsetEnabled) {
    // No morning ramp: assume day-bright by default until the evening dim.
    if (t < sunsetStart) return max;
    if (t < sunsetEnd) return lerp(max, min, (t - sunsetStart) / transitionMs);
    return min;
  }

  // Neither direction enabled: hold at max (manual/flow-action-only mode).
  return max;
}

/**
 * Target level while a manually-triggered transition (a flow action, or
 * one of the device's own "start now" buttons) is in progress, overriding
 * the sun-clock schedule for its duration.
 *
 * @param {'sunset'|'sunrise'} direction
 * @param {number} elapsedMs - time since the manual transition was triggered
 * @param {number} transitionMs
 * @returns {number} target level, 0-100
 */
function computeOverridePercent(direction, elapsedMs, transitionMs, min, max) {
  const fraction = transitionMs <= 0 ? 1 : Math.min(1, Math.max(0, elapsedMs / transitionMs));
  return direction === 'sunset' ? lerp(max, min, fraction) : lerp(min, max, fraction);
}

/** Whether a manual override started `elapsedMs` ago has finished. */
function isOverrideFinished(elapsedMs, transitionMs) {
  return elapsedMs >= transitionMs;
}

/** The next occurrence (today's or tomorrow's) of a daily instant, relative to `now`. */
function nextOccurrence(now, todayInstant, tomorrowInstant) {
  return now.getTime() < todayInstant.getTime() ? todayInstant : tomorrowInstant;
}

/** Norwegian relative-time text for a countdown, e.g. "Om 8 timer" / "Om 12 min" / "Nå". */
function formatRelative(ms) {
  if (ms <= 0) return 'Nå';
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'Nå';
  if (minutes < 60) return `Om ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `Om ${hours} time${hours === 1 ? '' : 'r'}`;
}

/** A 24h "HH:MM" clock time for a Date, in the Homey's own local time. */
function formatClockTime(date) {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function lerp(from, to, fraction) {
  return from + (to - from) * fraction;
}

module.exports = {
  computeScheduledPercent,
  computeOverridePercent,
  isOverrideFinished,
  nextOccurrence,
  formatRelative,
  formatClockTime,
};
