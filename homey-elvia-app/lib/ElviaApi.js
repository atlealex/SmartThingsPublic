'use strict';

const DEFAULT_BASE_URL = 'https://elvia.azure-api.net';

/**
 * Client for the Elvia API (https://elvia.portal.azure-api.net).
 *
 * Endpoint paths and response shapes below are taken from real, working
 * open-source clients (https://github.com/sindrebroch/ha-elvia and
 * https://github.com/andersem/elvia-python) rather than Elvia's own docs,
 * since those aren't reachable from this environment. If Elvia changes
 * their API, check those projects or the developer portal and adjust here
 * (or override `baseUrl` in the device settings without a code change).
 *
 * Two products are used:
 *  - "Grid tariff"  — public tariff prices for a metering point (energy
 *                      price, fixed price by consumption level). Auth via
 *                      the `X-API-Key` header with the subscription key
 *                      (NOT Azure APIM's default Ocp-Apim-Subscription-Key
 *                      header name - Elvia's product uses a custom name).
 *  - "Meter values" — personal max-hour history used to determine your
 *                      fixed price level. Auth via a bearer access token
 *                      tied to the customer's ID-porten login (obtained
 *                      manually via elvid.no, since Homey cannot drive the
 *                      BankID/MinID flow).
 */
class ElviaApi {
  constructor({ subscriptionKey, accessToken, baseUrl } = {}) {
    this.subscriptionKey = subscriptionKey;
    this.accessToken = accessToken;
    this.baseUrl = baseUrl || DEFAULT_BASE_URL;
  }

  async _request(path, { method = 'GET', headers = {}, body } = {}) {
    const url = `${this.baseUrl}${path}`;
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { Accept: 'application/json', ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      const cause = err.cause ? ` (${err.cause.code || err.cause.message || err.cause})` : '';
      throw new Error(`Elvia API request failed (${url}): ${err.message}${cause}`);
    }

    if (!res.ok) {
      const responseBody = await res.text().catch(() => '');
      throw new Error(`Elvia API error ${res.status} ${res.statusText} on ${path}: ${responseBody.slice(0, 300)}`);
    }

    return res.json();
  }

  // ---- Grid tariff (energy price + fixed price by consumption level) ----

  /**
   * Fetches today's grid tariff data for a metering point (one collection
   * object with gridTariff + meteringPointsAndPriceLevels). Requires only
   * a subscription key. Use the extract* helpers below on the result.
   */
  async getGridTariffData(meteringPointId) {
    if (!meteringPointId) throw new Error('meteringPointId is required');
    if (!this.subscriptionKey) throw new Error('A subscription key is required to read grid tariff prices');

    const data = await this._request('/grid-tariff/digin/api/1/tariffquery/meteringpointsgridtariffs', {
      method: 'POST',
      headers: {
        'X-API-Key': this.subscriptionKey,
        'Content-Type': 'application/json',
      },
      body: { range: 'today', meteringPointIds: [meteringPointId] },
    });

    const collection = data?.gridTariffCollections?.[0];
    if (!collection) {
      throw new Error(`Unexpected grid-tariff response shape: ${JSON.stringify(data).slice(0, 500)}`);
    }
    return collection;
  }

  _findCurrentHour(hours) {
    if (!Array.isArray(hours) || hours.length === 0) return null;
    const now = new Date();
    const current = hours.find((hour) => {
      const start = new Date(hour.startTime);
      const end = new Date(hour.expiredAt || hour.endTime);
      return now >= start && now < end;
    });
    return current || hours[hours.length - 1];
  }

  extractEnergyPrice(collection) {
    const hours = collection?.gridTariff?.tariffPrice?.hours;
    const hour = this._findCurrentHour(hours);
    const total = hour?.energyPrice?.total;
    return typeof total === 'number' ? total : null;
  }

  _getCurrentFixedPriceLevel(collection) {
    const hours = collection?.gridTariff?.tariffPrice?.hours;
    const fixedPrices = collection?.gridTariff?.tariffPrice?.priceInfo?.fixedPrices;
    const levelId = collection?.meteringPointsAndPriceLevels?.[0]?.currentFixedPriceLevel?.levelId;
    if (!Array.isArray(fixedPrices) || !levelId) return null;

    const hour = this._findCurrentHour(hours);
    const fixedPriceGroup = fixedPrices.find((fp) => fp.id === hour?.fixedPrice?.id) || fixedPrices[0];
    return fixedPriceGroup?.priceLevels?.find((level) => level.id === levelId) || null;
  }

  extractFixedPriceHourly(collection) {
    const level = this._getCurrentFixedPriceLevel(collection);
    const hourPrice = this._findCurrentHour(level?.hourPrices) || level?.hourPrices?.[0];
    const total = hourPrice?.total;
    return typeof total === 'number' ? total : null;
  }

  extractFixedPriceMonthly(collection) {
    const level = this._getCurrentFixedPriceLevel(collection);
    return typeof level?.monthlyTotal === 'number' ? level.monthlyTotal : null;
  }

  extractFixedPriceLevelInfo(collection) {
    const level = this._getCurrentFixedPriceLevel(collection);
    return typeof level?.levelInfo === 'string' ? level.levelInfo : null;
  }

  // ---- Max hours (personal consumption history, used for tariff level) ----

  /**
   * Fetches max-hour aggregate data (current + previous month) for a
   * metering point. Requires a personal bearer access token.
   */
  async getMaxHours(meteringPointId) {
    if (!meteringPointId) throw new Error('meteringPointId is required');
    if (!this.accessToken) throw new Error('An access token is required to read personal max-hour data');

    const query = new URLSearchParams({ meteringPointIds: meteringPointId });
    const data = await this._request(`/customer/metervalues/api/v2/maxhours?${query.toString()}`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });

    const aggregates = data?.meteringpoints?.[0]?.maxHoursAggregate;
    if (!Array.isArray(aggregates)) {
      throw new Error(`Unexpected max-hours response shape: ${JSON.stringify(data).slice(0, 500)}`);
    }
    return aggregates;
  }

  _findMonth(aggregates, monthsBack) {
    return aggregates.find((month) => month.noOfMonthsBack === monthsBack) || null;
  }

  extractMaxHoursAverage(aggregates, monthsBack) {
    const month = this._findMonth(aggregates, monthsBack);
    return typeof month?.averageValue === 'number' ? month.averageValue : null;
  }

  /** rank 1 = highest hour of the month, rank 3 = lowest of the top three. */
  extractMaxHourRank(aggregates, monthsBack, rank) {
    const month = this._findMonth(aggregates, monthsBack);
    if (!month || !Array.isArray(month.maxHours)) return null;
    const entry = month.maxHours[month.maxHours.length - rank];
    return typeof entry?.value === 'number' ? entry.value : null;
  }

  // ---- Meter values (personal hourly consumption) ----

  /**
   * Consumption (kWh) for the last full hour. Requires a personal bearer
   * access token (not the subscription key).
   */
  async getLatestHourlyConsumption(meteringPointId) {
    if (!meteringPointId) throw new Error('meteringPointId is required');
    if (!this.accessToken) throw new Error('An access token is required to read personal consumption data');

    const now = new Date();
    const startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const query = new URLSearchParams({
      meteringPointIds: meteringPointId,
      startTime: startTime.toISOString(),
      endTime: now.toISOString(),
    });

    const data = await this._request(`/customer/metervalues/api/v1/metervalues?${query.toString()}`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });

    const timeSeries = data?.meteringpoints?.[0]?.metervalue?.timeSeries;
    if (!Array.isArray(timeSeries) || timeSeries.length === 0) {
      throw new Error(`Unexpected meter-values response shape: ${JSON.stringify(data).slice(0, 500)}`);
    }

    const latest = timeSeries[timeSeries.length - 1];
    if (typeof latest.value !== 'number') {
      throw new Error('Could not find a consumption value in the latest meter-values entry');
    }
    return latest.value;
  }
}

module.exports = ElviaApi;
