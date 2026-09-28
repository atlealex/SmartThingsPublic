'use strict';

const MIN_ELAPSED_HOURS = 1;

/**
 * Estimates a full period's (today's or this month's) total consumption by
 * extrapolating a "baseline" load - the whole-house reading with a set of
 * known bursty appliances subtracted out - across the period, then adding
 * those appliances' own already-known usage back in afterwards rather than
 * extrapolating it too. Without this split, an appliance that happens to be
 * drawing heavily right when the estimate runs (an oven at 2kW for one
 * hour) gets multiplied across the whole remaining period as if it would
 * keep drawing that much all day/month, wildly inflating the estimate.
 *
 * @param {number} houseConsumptionSoFarKwh whole-house kWh consumed so far this period
 * @param {number} applianceConsumptionSoFarKwh sum of the excluded appliances' own kWh so far this period
 * @param {number} elapsedHours hours elapsed so far in the period
 * @param {number} periodHours total hours in the whole period (24 for a day, days-in-month*24 for a month)
 * @returns {number} estimated total kWh for the whole period
 */
function estimatePeriodKwh({
  houseConsumptionSoFarKwh, applianceConsumptionSoFarKwh, elapsedHours, periodHours,
}) {
  const baselineSoFar = Math.max(0, houseConsumptionSoFarKwh - applianceConsumptionSoFarKwh);
  const safeElapsedHours = Math.max(MIN_ELAPSED_HOURS, elapsedHours);
  const baselineRatePerHour = baselineSoFar / safeElapsedHours;
  return baselineRatePerHour * periodHours + applianceConsumptionSoFarKwh;
}

module.exports = { estimatePeriodKwh, MIN_ELAPSED_HOURS };
