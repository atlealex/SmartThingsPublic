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
 * Splits a list of {from, consumption} nodes into energy cost and grid
 * (nettleie) cost, NOT including any fixed fees (monthly fee, fastledd) -
 * those are shown as their own separate figures, matching how "Strøm" and
 * "Nettleie" are shown apart from "Kapasitetsledd" on the reference app.
 *
 * Both prices are applied using *today's* actual hour-of-day rate (via
 * spotPriceByHour / gridRentPriceByHour), since Tibber's per-node historical
 * price isn't available for this account and Elvia doesn't expose
 * historical nettleiepris. Accurate for grid rent (stable through a tariff
 * season), only approximate for spot price on days before it was fetched.
 */
function splitEnergyAndGridCost(consumptionNodes, {
  priceMode, // 'spot' | 'fixed'
  fixedPrice = 0, // NOK/kWh
  markupNokPerKwh = 0, // NOK/kWh, only applied in spot mode
  spotPriceByHour = new Map(),
  gridRentPriceByHour = new Map(),
  includeGridRent = false,
}) {
  const fallbackSpotPrice = averageOf(spotPriceByHour);
  const fallbackGridRentPrice = averageOf(gridRentPriceByHour);

  let kwh = 0;
  let energyCost = 0;
  let gridCost = 0;

  for (const node of consumptionNodes) {
    const nodeKwh = typeof node.consumption === 'number' ? node.consumption : 0;
    kwh += nodeKwh;

    const energyPrice = priceMode === 'spot'
      ? priceForHour(node, spotPriceByHour, fallbackSpotPrice) + markupNokPerKwh
      : fixedPrice;
    energyCost += nodeKwh * energyPrice;

    if (includeGridRent) {
      gridCost += nodeKwh * priceForHour(node, gridRentPriceByHour, fallbackGridRentPrice);
    }
  }

  return { kwh, energyCost, gridCost };
}

/**
 * Scales a {kwh, energyCost, gridCost} result so its kwh matches
 * accurateKwh exactly (from Tibber's own daily accumulator), keeping the
 * energy/grid cost split proportionally consistent with the correction.
 */
function reconcile(result, accurateKwh) {
  if (typeof accurateKwh !== 'number' || result.kwh <= 0.001) return result;
  const scale = accurateKwh / result.kwh;
  return { kwh: accurateKwh, energyCost: result.energyCost * scale, gridCost: result.gridCost * scale };
}

/**
 * Computes this month's consumption/cost so far, plus a full-month
 * estimate, from a list of hourly Tibber consumption nodes covering the
 * elapsed hours of the current month.
 *
 * The estimate assumes the average hourly usage/cost seen so far continues
 * for the rest of the month - a simple, transparent projection.
 */
function computeMonthCost({
  consumptionNodes,
  priceMode,
  fixedPrice = 0,
  markupNokPerKwh = 0,
  spotPriceByHour = new Map(),
  monthlyFee = 0,
  includeGridRent = false,
  gridRentPriceByHour = new Map(),
  gridRentFixedPerHour = 0,
  now = new Date(),
  trackingStartedAt = null,
}) {
  const { kwh: consumptionKwh, energyCost, gridCost: gridRentEnergyCost } = splitEnergyAndGridCost(consumptionNodes, {
    priceMode, fixedPrice, markupNokPerKwh, spotPriceByHour, gridRentPriceByHour, includeGridRent,
  });

  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const trackedSince = trackingStartedAt && trackingStartedAt > startOfMonth ? trackingStartedAt : startOfMonth;
  const hoursElapsed = Math.max(1, (now - trackedSince) / HOUR_MS);
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

module.exports = { computeMonthCost, splitEnergyAndGridCost, reconcile };
