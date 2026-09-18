'use strict';

const { createClient } = require('graphql-ws');
const WebSocket = require('ws');

const REST_API_URL = 'https://api.tibber.com/v1-beta/gql';

/**
 * Subscribes to Tibber's real-time power feed (liveMeasurement) and
 * integrates the Watt readings into hourly kWh totals ourselves.
 *
 * This exists because, for this Tibber account, the historical
 * `consumption` query returns null at every resolution (confirmed directly
 * via Tibber's own GraphQL explorer) even though realTimeConsumptionEnabled
 * is true - so live power is the only consumption data actually available
 * from Tibber's API. We integrate power (W) over time into kWh using
 * simple trapezoidal integration between consecutive readings.
 *
 * Gaps (Homey restarts, dropped connections) are simply missed - there is
 * no way to backfill from Tibber for this account, which is the whole
 * reason this class exists instead of a plain historical query.
 */
class TibberLiveClient {
  /**
   * @param {object} opts
   * @param {string} opts.token
   * @param {string} opts.homeId
   * @param {(hour: {startedAt: string, kwh: number}) => void} opts.onHourComplete
   *   Called once an hour's worth of readings has been integrated.
   * @param {(power: number) => void} [opts.onPower] Called on every reading (instantaneous W).
   * @param {(message: string) => void} [opts.onLog]
   * @param {(message: string) => void} [opts.onError]
   */
  constructor({ token, homeId, onHourComplete, onPower, onLog, onError }) {
    this.token = token;
    this.homeId = homeId;
    this.onHourComplete = onHourComplete;
    this.onPower = onPower || (() => {});
    this.onLog = onLog || (() => {});
    this.onError = onError || (() => {});

    this._lastTimestamp = null;
    this._lastPower = null;
    this._currentHourKey = null;
    this._currentHourKwh = 0;
    this._client = null;
    this._unsubscribe = null;
  }

  _hourKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}`;
  }

  async _getSubscriptionUrl() {
    const res = await fetch(REST_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: '{ viewer { websocketSubscriptionUrl } }' }),
    });
    const body = await res.json();
    const url = body?.data?.viewer?.websocketSubscriptionUrl;
    if (!url) throw new Error(`Could not get Tibber websocket URL: ${JSON.stringify(body).slice(0, 300)}`);
    return url;
  }

  async start() {
    const url = await this._getSubscriptionUrl();

    this._client = createClient({
      url,
      webSocketImpl: WebSocket,
      connectionParams: { token: this.token },
      retryAttempts: Infinity,
      on: {
        connected: () => this.onLog('Tibber live connection established'),
        error: (err) => this.onError(`Tibber live connection error: ${err?.message || err}`),
        closed: () => this.onLog('Tibber live connection closed'),
      },
    });

    this._unsubscribe = this._client.subscribe(
      {
        query: `subscription($homeId: ID!) {
          liveMeasurement(homeId: $homeId) {
            timestamp
            power
          }
        }`,
        variables: { homeId: this.homeId },
      },
      {
        next: (result) => this._handleReading(result?.data?.liveMeasurement),
        error: (err) => this.onError(`Tibber live subscription error: ${err?.message || JSON.stringify(err)}`),
        complete: () => this.onLog('Tibber live subscription completed'),
      },
    );
  }

  stop() {
    if (this._unsubscribe) this._unsubscribe();
    if (this._client) this._client.dispose();
  }

  _handleReading(reading) {
    if (!reading || typeof reading.power !== 'number' || !reading.timestamp) return;

    this.onPower(reading.power);

    const timestamp = new Date(reading.timestamp);
    const hourKey = this._hourKey(timestamp);

    if (this._currentHourKey === null) {
      this._currentHourKey = hourKey;
    }

    if (this._lastTimestamp !== null) {
      const deltaHours = (timestamp - this._lastTimestamp) / (1000 * 60 * 60);
      // Guard against clock jumps / long gaps (e.g. after a reconnect) -
      // don't integrate implausibly large gaps as if power was constant.
      if (deltaHours > 0 && deltaHours < 0.2) {
        const avgPower = (this._lastPower + reading.power) / 2;
        this._currentHourKwh += (avgPower * deltaHours) / 1000;
      }
    }

    if (hourKey !== this._currentHourKey) {
      this.onHourComplete({ startedAt: this._currentHourKey, kwh: this._currentHourKwh });
      this._currentHourKey = hourKey;
      this._currentHourKwh = 0;
    }

    this._lastTimestamp = timestamp;
    this._lastPower = reading.power;
  }

  /** Partial kWh accumulated so far in the hour that hasn't completed yet. */
  getCurrentPartialHourKwh() {
    return this._currentHourKwh;
  }
}

module.exports = TibberLiveClient;
