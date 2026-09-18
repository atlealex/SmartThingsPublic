'use strict';

const DEFAULT_BASE_URL = 'https://elvia.azure-api.net';

/**
 * Client for the Elvia API (https://elvia.portal.azure-api.net).
 *
 * Endpoint paths below are taken from real, working open-source clients
 * (https://github.com/sindrebroch/ha-elvia and
 * https://github.com/andersem/elvia-python) rather than Elvia's own docs,
 * since those aren't reachable from this environment. If Elvia changes
 * their API, check those projects or the developer portal and adjust here
 * (or override `baseUrl` in the device settings without a code change).
 *
 * Two products are used:
 *  - "Grid tariff"  — public tariff prices for a metering point. Auth via
 *                      the `X-API-Key` header with the subscription key
 *                      (NOT Azure APIM's default Ocp-Apim-Subscription-Key
 *                      header name - Elvia's product uses a custom name).
 *  - "Meter values" — personal hourly consumption. Auth via a bearer access
 *                      token tied to the customer's ID-porten login
 *                      (obtained manually via elvid.no, since Homey cannot
 *                      drive the BankID/MinID flow).
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

  /**
   * Current grid tariff price (NOK/kWh, incl. VAT) for a metering point.
   * Requires only a subscription key.
   */
  async getCurrentGridTariff(meteringPointId) {
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

    const price = this._extractGridTariffPrice(data);
    if (price === null) {
      throw new Error('Could not find a current price in the Elvia grid-tariff response');
    }
    return price;
  }

  _extractGridTariffPrice(data) {
    const collections = data && data.gridTariffCollections;
    if (!Array.isArray(collections) || collections.length === 0) return null;

    const hours = collections[0].gridTariff?.tariffPrice?.hours;
    if (!Array.isArray(hours) || hours.length === 0) return null;

    const now = new Date();
    const current = hours.find((hour) => {
      const start = new Date(hour.startTime);
      const end = new Date(hour.expiredAt || hour.endTime);
      return now >= start && now < end;
    });

    const total = (current || hours[hours.length - 1]).energyPrice?.total;
    return typeof total === 'number' ? total : null;
  }

  /**
   * Hourly consumption values (kWh) for the last full hour.
   * Requires a personal bearer access token (not the subscription key).
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

    const data = await this._request(`/customer/metervalues/api/v1/metervalues?${query.toString()}`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });

    const value = this._extractLatestMeterValue(data);
    if (value === null) {
      throw new Error('Could not find any hourly meter values in the Elvia response');
    }
    return value;
  }

  _extractLatestMeterValue(data) {
    const points = data && data.meteringpoints;
    if (!Array.isArray(points) || points.length === 0) return null;

    const timeSeries = points[0].metervalue?.timeSeries;
    if (!Array.isArray(timeSeries) || timeSeries.length === 0) return null;

    const latest = timeSeries[timeSeries.length - 1];
    return typeof latest.value === 'number' ? latest.value : null;
  }
}

module.exports = ElviaApi;
