'use strict';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Computes this month's consumption/cost so far, plus a full-month
 * estimate, from a list of hourly Tibber consumption nodes covering the
 * elapsed hours of the current month.
 *
 * The estimate assumes the average hourly usage/cost seen so far continues
 * for the rest of the month - a simple, transparent projection rather than
 * anything clever with weekday/weekend patterns.
 */
function computeMonthCost({
  consumptionNodes,
  priceMode, // 'spot' | 'fixed'
  fixedPrice = 0, // NOK/kWh
  markupNokPerKwh = 0, // NOK/kWh, only applied in spot mode
  monthlyFee = 0, // NOK/month, from the electricity supplier
  includeGridRent = false,
  gridRentPricePerKwh = 0, // current Elvia nettleiepris (NOK/kWh)
  gridRentFixedPerHour = 0, // current Elvia fastledd, per hour (NOK/h)
  now = new Date(),
}) {
  let consumptionKwh = 0;
  let energyCost = 0;
  let gridRentEnergyCost = 0;

  for (const node of consumptionNodes) {
    const kwh = typeof node.consumption === 'number' ? node.consumption : 0;
    consumptionKwh += kwh;

    const energyPrice = priceMode === 'spot'
      ? (typeof node.unitPrice === 'number' ? node.unitPrice : 0) + markupNokPerKwh
      : fixedPrice;
    energyCost += kwh * energyPrice;

    if (includeGridRent) {
      gridRentEnergyCost += kwh * gridRentPricePerKwh;
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
