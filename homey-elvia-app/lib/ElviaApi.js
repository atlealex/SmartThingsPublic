'use strict';

const DEFAULT_BASE_URL = 'https://elvia.azure-api.net';

/**
 * Thin client for the public Elvia API (https://elvia.portal.azure-api.net).
 *
 * Two products are used:
 *  - "Grid tariff"   — public tariff prices for a metering point, needs only a
 *                       subscription key.
 *  - "Meter values"  — personal hourly consumption, needs a subscription key
 *                       AND a bearer access token tied to the customer's
 *                       ID-porten login (obtained manually via elvid.no,
 *                       since Homey cannot drive the BankID/MinID flow).
 *
 * Elvia can change these paths; if calls start failing, check the current
 * spec in the developer portal and adjust `baseUrl` in the device settings.
 */
class ElviaApi {
  constructor({ subscriptionKey, accessToken, baseUrl } = {}) {
    this.subscriptionKey = subscriptionKey;
    this.accessToken = accessToken;
    this.baseUrl = baseUrl || DEFAULT_BASE_URL;
  }

  _headers(extra = {}) {
    const headers = { Accept: 'application/json', ...extra };
    if (this.subscriptionKey) {
      headers['Ocp-Apim-Subscription-Key'] = this.subscriptionKey;
    }
    if (this.accessToken) {
      headers.Authorization = `Bearer ${this.accessToken}`;
    }
    return headers;
  }

  async _get(path) {
    const url = `${this.baseUrl}${path}`;
    let res;
    try {
      res = await fetch(url, { method: 'GET', headers: this._headers() });
    } catch (err) {
      const cause = err.cause ? ` (${err.cause.code || err.cause.message || err.cause})` : '';
      throw new Error(`Elvia API request failed (${url}): ${err.message}${cause}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Elvia API error ${res.status} ${res.statusText} on ${path}: ${body.slice(0, 300)}`);
    }

    return res.json();
  }

  /**
   * Current grid tariff price (NOK/kWh) for a metering point.
   * Requires only a subscription key.
   */
  async getCurrentGridTariff(meteringPointId) {
    if (!meteringPointId) throw new Error('meteringPointId is required');

    const now = new Date();
    const startTime = new Date(now);
    startTime.setMinutes(0, 0, 0);
    const stopTime = new Date(startTime.getTime() + 60 * 60 * 1000);

    const query = new URLSearchParams({
      meteringPointIds: meteringPointId,
      startTime: startTime.toISOString(),
      stopTime: stopTime.toISOString(),
    });

    const data = await this._get(`/grid-tariff/api/v1/grid-tariff-collections?${query.toString()}`);

    const price = this._extractGridTariffPrice(data);
    if (price === null) {
      throw new Error('Could not find a current price in the Elvia grid-tariff response');
    }
    return price;
  }

  _extractGridTariffPrice(data) {
    const collections = data && (data.gridTariffCollections || data.value || data);
    if (!Array.isArray(collections)) return null;

    for (const collection of collections) {
      const priceInfo = collection.gridTariffPriceInfo || collection.priceInfo;
      const rows = priceInfo && (priceInfo.energyPrice || priceInfo.prices);
      if (!Array.isArray(rows) || rows.length === 0) continue;
      const latest = rows[rows.length - 1];
      const amount = latest.total ?? latest.price ?? latest.amount;
      if (typeof amount === 'number') return amount;
    }
    return null;
  }

  /**
   * Hourly consumption values (kWh) for the last full hour.
   * Requires a subscription key AND a personal bearer access token.
   */
  async getLatestHourlyMeterValue(meteringPointId) {
    if (!meteringPointId) throw new Error('meteringPointId is required');
    if (!this.accessToken) throw new Error('An access token is required to read personal meter values');

    const now = new Date();
    const startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const query = new URLSearchParams({
      meteringPointIds: meteringPointId,
      startTime: startTime.toISOString(),
      endTime: now.toISOString(),
    });

    const data = await this._get(`/customer/metervalues/api/v1/metervalues/hourly?${query.toString()}`);

    const value = this._extractLatestMeterValue(data);
    if (value === null) {
      throw new Error('Could not find any hourly meter values in the Elvia response');
    }
    return value;
  }

  _extractLatestMeterValue(data) {
    const points = data && (data.meteringpoints || data.meteringPoints || data.value);
    if (!Array.isArray(points) || points.length === 0) return null;

    const readings = points[0].metervalue?.readings || points[0].readings;
    if (!Array.isArray(readings) || readings.length === 0) return null;

    const latest = readings[readings.length - 1];
    const kwh = latest.value ?? latest.consumption ?? latest.energy;
    return typeof kwh === 'number' ? kwh : null;
  }
}

module.exports = ElviaApi;
