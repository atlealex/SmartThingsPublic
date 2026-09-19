'use strict';

const DEFAULT_BASE_URL = 'https://elvia.azure-api.net';

/**
 * Minimal Elvia grid-tariff client, adapted from the Elvia-Nett app's
 * lib/ElviaApi.js. This app keeps its own Elvia credentials rather than
 * reading the Elvia-Nett app's device cross-app, so it can pull the full
 * hourly price curve for today (not just the current hour) and apply the
 * correct hour-of-day rate to each historical hour this month.
 */
class ElviaGridTariff {
  constructor({ subscriptionKey, baseUrl } = {}) {
    this.subscriptionKey = subscriptionKey;
    this.baseUrl = baseUrl || DEFAULT_BASE_URL;
  }

  async getTodaysGridTariff(meteringPointId) {
    if (!meteringPointId) throw new Error('meteringPointId is required');
    if (!this.subscriptionKey) throw new Error('An Elvia subscription key is required for grid rent');

    const url = `${this.baseUrl}/grid-tariff/digin/api/1/tariffquery/meteringpointsgridtariffs`;
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'X-API-Key': this.subscriptionKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ range: 'today', meteringPointIds: [meteringPointId] }),
      });
    } catch (err) {
      const cause = err.cause ? ` (${err.cause.code || err.cause.message || err.cause})` : '';
      throw new Error(`Elvia API request failed (${url}): ${err.message}${cause}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Elvia API error ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
    }

    const data = await res.json();
    const collection = data?.gridTariffCollections?.[0];
    if (!collection) {
      throw new Error(`Unexpected grid-tariff response shape: ${JSON.stringify(data).slice(0, 500)}`);
    }
    return collection;
  }

  /** Map of hour-of-day (0-23) -> energy price (NOK/kWh) for today. */
  extractHourlyEnergyPriceByHour(collection) {
    const hours = collection?.gridTariff?.tariffPrice?.hours;
    const map = new Map();
    if (!Array.isArray(hours)) return map;

    for (const hour of hours) {
      const total = hour?.energyPrice?.total;
      const start = hour?.startTime && new Date(hour.startTime);
      if (typeof total === 'number' && start && !Number.isNaN(start.getTime())) {
        map.set(start.getHours(), total);
      }
    }
    return map;
  }

  _getCurrentFixedPriceGroup(collection) {
    const hours = collection?.gridTariff?.tariffPrice?.hours;
    const fixedPrices = collection?.gridTariff?.tariffPrice?.priceInfo?.fixedPrices;
    if (!Array.isArray(fixedPrices) || fixedPrices.length === 0) return null;

    const now = new Date();
    const currentHour = Array.isArray(hours)
      ? hours.find((h) => {
        const start = new Date(h.startTime);
        const end = new Date(h.expiredAt || h.endTime);
        return now >= start && now < end;
      }) || hours[hours.length - 1]
      : null;

    return fixedPrices.find((fp) => fp.id === currentHour?.fixedPrice?.id) || fixedPrices[0];
  }

  _getCurrentFixedPriceLevel(collection) {
    const levelId = collection?.meteringPointsAndPriceLevels?.[0]?.currentFixedPriceLevel?.levelId;
    const group = this._getCurrentFixedPriceGroup(collection);
    return group?.priceLevels?.find((lvl) => lvl.id === levelId) || null;
  }

  /** Current fastledd, expressed as an hourly rate (NOK/h). */
  extractFixedPriceHourly(collection) {
    const level = this._getCurrentFixedPriceLevel(collection);
    const hourPrice = level?.hourPrices?.[0];
    return typeof hourPrice?.total === 'number' ? hourPrice.total : 0;
  }

  /** Current fastledd (kapasitetsledd) for the full month (NOK/month), not prorated. */
  extractFixedPriceMonthly(collection) {
    const level = this._getCurrentFixedPriceLevel(collection);
    return typeof level?.monthlyTotal === 'number' ? level.monthlyTotal : 0;
  }

  /** Text description of the current capacity level, e.g. "2-5 kWh/h". */
  extractFixedPriceLevelInfo(collection) {
    const level = this._getCurrentFixedPriceLevel(collection);
    return typeof level?.levelInfo === 'string' ? level.levelInfo : '';
  }
}

module.exports = ElviaGridTariff;
