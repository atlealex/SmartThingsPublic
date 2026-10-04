'use strict';

const { genDevice } = require('node-broadlink');
const { withTimeout } = require('./withTimeout');

const AUTH_TIMEOUT_MS = 5000;
const SEND_TIMEOUT_MS = 5000;
const LEARN_POLL_TIMEOUT_MS = 3000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Thin wrapper around node-broadlink's device object: reconnects from stored
 * host/mac/deviceType (no fresh network discovery needed after pairing - see
 * README "Why reconnect by address instead of re-discovering"), and wraps
 * every call with a timeout since the library itself never times out a lost
 * UDP packet.
 */
class BroadlinkConnection {
  /**
   * @param {{address: string, port: number}} host
   * @param {number[]} mac
   * @param {number} deviceType
   */
  constructor({ host, mac, deviceType }) {
    this._device = genDevice(deviceType, host, mac);
    this._authenticated = false;
  }

  async _ensureAuthenticated() {
    if (this._authenticated) return;
    await withTimeout(this._device.auth(), AUTH_TIMEOUT_MS, 'Authentication');
    this._authenticated = true;
  }

  /** Re-runs auth() even if already authenticated - used after a send/learn call fails, in case the device rebooted and its session key no longer matches ours. */
  async reauthenticate() {
    this._authenticated = false;
    await this._ensureAuthenticated();
  }

  /** @returns {Promise<string>} the learned IR/RF code as a hex string, or throws if nothing was learned within timeoutMs. */
  async learn(timeoutMs) {
    await this._ensureAuthenticated();
    await withTimeout(this._device.enterLearning(), SEND_TIMEOUT_MS, 'Enter learning mode');

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(1000);
      try {
        const data = await withTimeout(this._device.checkData(), LEARN_POLL_TIMEOUT_MS, 'Check learned data');
        return Buffer.from(data).toString('hex');
      } catch (err) {
        // Not an error yet - the device replies with a non-zero status until a
        // signal has actually been captured. Keep polling until the deadline.
      }
    }
    await this._device.cancelLearning().catch(() => {});
    throw new Error('No signal was learned in time - was the remote button pressed while learning was active?');
  }

  /** Sends a previously learned code (hex string) once. */
  async send(hexCode) {
    await this._ensureAuthenticated();
    await withTimeout(this._device.sendData(hexCode), SEND_TIMEOUT_MS, 'Send command');
  }

  /**
   * Sends a learned code repeatedly, to simulate holding down the physical
   * remote's button - the whole reason this app exists instead of using the
   * single-shot "Send command" action the community Broadlink app already
   * has. Runs for durationMs, sending once every intervalMs (best-effort;
   * actual spacing also includes however long each UDP round-trip takes).
   */
  async sendHeld(hexCode, durationMs, intervalMs) {
    await this._ensureAuthenticated();
    const deadline = Date.now() + durationMs;
    let sends = 0;
    while (Date.now() < deadline) {
      await withTimeout(this._device.sendData(hexCode), SEND_TIMEOUT_MS, 'Send command (held)');
      sends += 1;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(intervalMs, remaining));
    }
    return sends;
  }
}

module.exports = BroadlinkConnection;
