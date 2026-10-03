'use strict';

const util = require('util');
const { createClient } = require('graphql-ws');
const WebSocket = require('ws');

const REST_API_URL = 'https://api.tibber.com/v1-beta/gql';
const USER_AGENT = 'HomeyStromkostnad/1.0.0 github.com/atlealex';

// A real midnight reset lands accumulatedConsumption near zero. Anything
// below this still counts as "just rolled over" even a few minutes into
// the new day; a drop that lands above it is treated as a glitch, not a
// day boundary (see _handleReading).
const DAY_RESET_THRESHOLD_KWH = 2;

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
 * Subscribes to Tibber's real-time power feed (liveMeasurement).
 *
 * This exists because, for this Tibber account, the historical
 * `consumption` query returns null at every resolution (confirmed directly
 * via Tibber's own GraphQL explorer) even though realTimeConsumptionEnabled
 * is true - so the live stream is the only consumption data actually
 * available from Tibber's API.
 *
 * Two consumption sources come out of the same subscription:
 *  - `power` (W): we integrate this into hourly kWh ourselves (trapezoidal),
 *    used to give consumption a realistic hour-of-day shape for pricing.
 *  - `accumulatedConsumption` (kWh since local midnight): computed by the
 *    Pulse hardware itself, not by us - the same field Home Assistant's
 *    "Akkumulert forbruk" sensor reads. This keeps counting even while our
 *    websocket connection is down, so it "catches up" automatically on
 *    reconnect and is immune to the gaps our own power integration can
 *    lose. It resets to ~0 at local midnight, which is how day boundaries
 *    are detected (a drop in value) rather than by our own clock.
 * The device uses accumulatedConsumption as the authoritative kWh total
 * for today/this month, and the hourly power integration only to shape
 * how that total is distributed across hours for cost purposes.
 */
class TibberLiveClient {
  /**
   * @param {object} opts
   * @param {string} opts.token
   * @param {string} opts.homeId
   * @param {(hour: {startedAt: string, kwh: number}) => void} opts.onHourComplete
   *   Called once an hour's worth of readings has been integrated.
   * @param {(dayTotalKwh: number) => void} [opts.onDayComplete]
   *   Called once when accumulatedConsumption resets at local midnight,
   *   with the finalized total for the day that just ended.
   * @param {(power: number) => void} [opts.onPower] Called on every reading (instantaneous W).
   * @param {(message: string) => void} [opts.onLog]
   * @param {(message: string) => void} [opts.onError]
   */
  constructor({ token, homeId, onHourComplete, onDayComplete, onPower, onLog, onError }) {
    this.token = token;
    this.homeId = homeId;
    this.onHourComplete = onHourComplete;
    this.onDayComplete = onDayComplete || (() => {});
    this.onPower = onPower || (() => {});
    this.onLog = onLog || (() => {});
    this.onError = onError || (() => {});

    this._lastTimestamp = null;
    this._lastPower = null;
    this._currentHourKey = null;
    this._currentHourKwh = 0;
    this._lastAccumulated = null;
    this._client = null;
    this._unsubscribe = null;
    this._resubscribeTimer = null;
    this._stopped = false;
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
            accumulatedConsumption
          }
        }`,
        variables: { homeId: this.homeId },
      },
      {
        next: (result) => this._handleReading(result?.data?.liveMeasurement),
        error: (err) => this.onError(`Tibber live subscription error: ${describeError(err)}`),
        // `retryAttempts: Infinity` above only covers the underlying
        // websocket *transport* dropping (closed/error) - it reconnects the
        // socket, but doesn't know this specific GraphQL subscription
        // operation needs re-issuing on top of it. If Tibber's server ever
        // ends the subscription itself (a clean "complete", e.g. a
        // server-side session/subscription timeout) rather than erroring
        // the connection, nothing was resubscribing - confirmed live: a
        // completed-but-never-resubscribed stream left measure_power frozen
        // at one exact wattage for 10 hours straight, since _handleReading
        // simply stopped being called with nothing left to notice or retry.
        complete: () => {
          this.onLog('Tibber live subscription completed - resubscribing');
          this._scheduleResubscribe();
        },
      },
    );
  }

  stop() {
    this._stopped = true;
    if (this._resubscribeTimer) {
      clearTimeout(this._resubscribeTimer);
      this._resubscribeTimer = null;
    }
    if (this._unsubscribe) this._unsubscribe();
    if (this._client) this._client.dispose();
  }

  /** Tears down and re-establishes the whole connection + subscription after the server ends it cleanly (see the `complete` handler above). */
  _scheduleResubscribe() {
    if (this._resubscribeTimer || this._stopped) return;
    this._resubscribeTimer = setTimeout(() => {
      this._resubscribeTimer = null;
      if (this._stopped) return;
      if (this._unsubscribe) this._unsubscribe();
      if (this._client) this._client.dispose();
      this.start().catch((err) => {
        this.onError(`Failed to resubscribe to Tibber live measurement: ${err.message}`);
        this._scheduleResubscribe();
      });
    }, 5000);
  }

  _handleReading(reading) {
    if (!reading || typeof reading.power !== 'number' || !reading.timestamp) return;

    this.onPower(reading.power);

    // Checked first, deliberately: a reading exactly at midnight on the
    // last day of the month crosses both a day AND a month boundary at
    // once. onDayComplete must land the outgoing day's total in the OLD
    // month's tally before onHourComplete triggers the month rollover in
    // the device, or that day's consumption would be lost/misfiled.
    //
    // A drop alone isn't enough to call it a day rollover: a websocket
    // reconnect (retryAttempts: Infinity above) can occasionally hand back
    // a stale/out-of-order reading with a slightly lower value than the
    // last one seen, which isn't a real midnight reset. Treating that as
    // "day complete" would file today's partial total as if the day had
    // ended, then silently double-count it once the real total climbs back
    // past that point (confirmed live: a whole extra day's worth of kWh
    // showing up in consumption_current_month). Requiring the new value to
    // actually be near zero - not just lower than before - is what a real
    // midnight reset looks like, and what a mid-day glitch doesn't.
    if (typeof reading.accumulatedConsumption === 'number') {
      if (this._lastAccumulated !== null && reading.accumulatedConsumption < this._lastAccumulated - 0.01) {
        if (reading.accumulatedConsumption < DAY_RESET_THRESHOLD_KWH) {
          this.onDayComplete(this._lastAccumulated);
        } else {
          this.onLog(`Ignored a drop in accumulatedConsumption that doesn't look like a real day rollover (${this._lastAccumulated.toFixed(2)} -> ${reading.accumulatedConsumption.toFixed(2)} kWh) - not treated as day-complete.`);
        }
      }
      this._lastAccumulated = reading.accumulatedConsumption;
    }

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

  /** Partial kWh accumulated so far in the hour that hasn't completed yet (power-integration based). */
  getCurrentPartialHourKwh() {
    return this._currentHourKwh;
  }

  /** Today's consumption so far (kWh since local midnight), per the Pulse's own counter. Null if not yet received. */
  getTodayAccumulated() {
    return this._lastAccumulated;
  }
}

module.exports = TibberLiveClient;
