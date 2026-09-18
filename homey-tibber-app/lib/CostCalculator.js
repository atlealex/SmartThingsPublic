'use strict';

const HOUR_MS = 60 * 60 * 1000;

/** Average of a Map's values, or 0 if empty - used as a fallback for hours with no matching entry. */
function averageOf(map) {
  if (map.size === 0) return 0;
  return [...map.values()].reduce((a, b) => a + b, 0) / map.size;
}

function priceForHour(node, priceByHour, fallback) {
  const hourOfDay = node.from ? new Date(node.from).getHours() : null;
  if (hourOfDay === null) return fallback;
  const price = priceByHour.get(hourOfDay);
  return typeof price === 'number' ? price : fallback;
}

/**
 * Computes this month's consumption/cost so far, plus a full-month
 * estimate, from a list of hourly Tibber consumption nodes covering the
 * elapsed hours of the current month.
 *
 * The estimate assumes the average hourly usage/cost seen so far continues
 * for the rest of the month - a simple, transparent projection rather than
 * anything clever with weekday/weekend patterns.
 *
 * Both spot price and grid rent are applied using *today's* actual
 * hour-of-day rate (via spotPriceByHour / gridRentPriceByHour), since
 * Tibber's per-node historical price isn't available for Pulse-only
 * accounts (no active power subscription) and Elvia doesn't expose
 * historical nettleiepris. This is accurate for grid rent (which is
 * stable through a tariff season) but only approximate for spot price
 * (which genuinely changes every day) - a real limitation for days
 * before the app started tracking, not just a rounding error.
 */
function computeMonthCost({
  consumptionNodes,
  priceMode, // 'spot' | 'fixed'
  fixedPrice = 0, // NOK/kWh
  markupNokPerKwh = 0, // NOK/kWh, only applied in spot mode
  spotPriceByHour = new Map(), // hour-of-day (0-23) -> today's Tibber spot price (NOK/kWh)
  monthlyFee = 0, // NOK/month, from the electricity supplier
  includeGridRent = false,
  gridRentPriceByHour = new Map(), // hour-of-day (0-23) -> Elvia nettleiepris (NOK/kWh)
  gridRentFixedPerHour = 0, // current Elvia fastledd, per hour (NOK/h)
  now = new Date(),
}) {
  let consumptionKwh = 0;
  let energyCost = 0;
  let gridRentEnergyCost = 0;

  const fallbackSpotPrice = averageOf(spotPriceByHour);
  const fallbackGridRentPrice = averageOf(gridRentPriceByHour);

  for (const node of consumptionNodes) {
    const kwh = typeof node.consumption === 'number' ? node.consumption : 0;
    consumptionKwh += kwh;

    const energyPrice = priceMode === 'spot'
      ? priceForHour(node, spotPriceByHour, fallbackSpotPrice) + markupNokPerKwh
      : fixedPrice;
    energyCost += kwh * energyPrice;

    if (includeGridRent) {
      gridRentEnergyCost += kwh * priceForHour(node, gridRentPriceByHour, fallbackGridRentPrice);
    }
  }

  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const hoursElapsed = Math.max(1, (now - startOfMonth) / HOUR_MS);
  const hoursInMonth = (startOfNextMonth - startOfMonth) / HOUR_MS;
  const elapsedFraction = hoursElapsed / hoursInMonth;

  const gridRentFixedSoFar = includeGridRent ? gridRentFixedPerHour * hoursElapsed : 0;
  const gridRentFixedFullMonth = includeGridRent ? gridRentFixedPerHour * hoursInMonth : 0;

  const cost = energyCost + gridRentEnergyCost + (monthlyFee * elapsedFraction) + gridRentFixedSoFar;

  const avgVariableCostPerHour = (energyCost + gridRentEnergyCost) / hoursElapsed;
  const estimatedConsumptionKwh = (consumptionKwh / hoursElapsed) * hoursInMonth;
  const estimatedCost = (avgVariableCostPerHour * hoursInMonth) + monthlyFee + gridRentFixedFullMonth;

  return {
    consumptionKwh,
    cost,
    estimatedConsumptionKwh,
    estimatedCost,
  };
}

module.exports = { computeMonthCost };
