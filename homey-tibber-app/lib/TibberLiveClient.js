'use strict';

const util = require('util');
const { createClient } = require('graphql-ws');
const WebSocket = require('ws');

const REST_API_URL = 'https://api.tibber.com/v1-beta/gql';
const USER_AGENT = 'HomeyStromkostnad/1.0.0 github.com/atlealex';

/**
 * Tibber's docs require a User-Agent header on both HTTP calls and the
 * WebSocket handshake (confirmed via Home Assistant's pyTibber client).
 * graphql-ws's `webSocketImpl` option only ever calls `new Impl(url,
 * protocol)` with no way to pass extra headers, so we wrap `ws`'s
 * WebSocket to inject the header on every connection it opens.
 */
class TibberWebSocket extends WebSocket {
  constructor(address, protocols) {
    super(address, protocols, { headers: { 'User-Agent': USER_AGENT } });
  }
}

/** JSON.stringify on Error/CloseEvent-like objects often yields "{}" since
 * their useful fields aren't own-enumerable. Pull out what we can. */
function describeError(err) {
  if (err instanceof Error) return err.stack || err.message;
  if (Array.isArray(err)) return err.map((e) => e?.message || util.inspect(e)).join('; ');
  if (err && typeof err === 'object') {
    const parts = [];
    for (const key of ['message', 'code', 'reason', 'type', 'wasClean']) {
      if (err[key] !== undefined) parts.push(`${key}=${err[key]}`);
    }
    if (parts.length) return parts.join(' ');
  }
  return util.inspect(err, { depth: 4 });
}

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
        'User-Agent': USER_AGENT,
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
      webSocketImpl: TibberWebSocket,
      connectionParams: { token: this.token },
      retryAttempts: Infinity,
      on: {
        connected: () => this.onLog('Tibber live connection established'),
        error: (err) => this.onError(`Tibber live connection error: ${describeError(err)}`),
        closed: (event) => this.onLog(`Tibber live connection closed: ${describeError(event)}`),
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
        error: (err) => this.onError(`Tibber live subscription error: ${describeError(err)}`),
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
      if (deltaHours > 0.05) {
        // Anything over ~3 minutes between readings is unusual (Tibber
        // normally pushes every ~2s) - almost certainly a reconnect gap.
        this.onLog(`Gap in live readings: ${(deltaHours * 60).toFixed(1)} min`);
      }
      if (deltaHours > 0 && deltaHours <= 1) {
        // Reasonable to estimate short-to-medium gaps (reconnects, brief
        // WiFi drops) as constant average power across the gap.
        const avgPower = (this._lastPower + reading.power) / 2;
        this._currentHourKwh += (avgPower * deltaHours) / 1000;
      } else if (deltaHours > 1) {
        // Longer than that (Homey restart, extended outage) - guessing
        // constant power across hours would likely be very wrong, so this
        // period is simply lost, same as any other downtime.
        this.onLog(`Gap too large to estimate (${deltaHours.toFixed(2)}h) - that period is not counted`);
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
