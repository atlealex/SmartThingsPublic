'use strict';

const { genDevice } = require('node-broadlink');
const { withTimeout } = require('./withTimeout');

const AUTH_TIMEOUT_MS = 5000;
const SEND_TIMEOUT_MS = 5000;
const LEARN_POLL_TIMEOUT_MS = 3000;
const RF_FREQUENCY_POLL_TIMEOUT_MS = 3000;

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

  /**
   * Learns an RF (433/315MHz) signal instead of IR - a separate, two-phase
   * procedure real Broadlink hardware requires, visible as two back-to-back
   * cycles of the device's learning-mode LED:
   *
   *  1. sweepFrequency() starts a frequency scan (LED on) - the remote
   *     button must be held down during this whole phase so the device can
   *     detect which RF frequency it's using.
   *  2. Once checkFrequency() reports the frequency was found, findRfPacket()
   *     switches the device into packet-capture mode (LED cycles off then
   *     on again) - the SAME button must then be pressed again, quickly,
   *     to capture the actual signal data, read via the same checkData()
   *     poll IR learning uses.
   *
   * Many "hold to activate" signals (e.g. a blind's favorite-position
   * button) turn out to be RF rather than IR - if the device's own learning
   * LED cycles through two phases like this, use this method instead of
   * learn().
   *
   * @returns {Promise<string>} the learned code as a hex string, or throws
   *   if either phase doesn't complete within its timeout.
   */
  async learnRf(frequencyTimeoutMs, dataTimeoutMs) {
    await this._ensureAuthenticated();
    await withTimeout(this._device.sweepFrequency(), SEND_TIMEOUT_MS, 'Start RF frequency sweep');

    const frequencyDeadline = Date.now() + frequencyTimeoutMs;
    let frequencyFound = false;
    while (Date.now() < frequencyDeadline) {
      await sleep(1000);
      try {
        frequencyFound = await withTimeout(this._device.checkFrequency(), RF_FREQUENCY_POLL_TIMEOUT_MS, 'Check RF frequency');
        if (frequencyFound) break;
      } catch (err) {
        // Not detected yet - keep polling until the deadline.
      }
    }
    if (!frequencyFound) {
      await this._device.cancelSweepFrequency().catch(() => {});
      throw new Error('No RF frequency was detected - was the remote button held down during the first (yellow light) phase?');
    }

    await withTimeout(this._device.findRfPacket(), SEND_TIMEOUT_MS, 'Prepare RF packet capture');

    const dataDeadline = Date.now() + dataTimeoutMs;
    while (Date.now() < dataDeadline) {
      await sleep(1000);
      try {
        const data = await withTimeout(this._device.checkData(), LEARN_POLL_TIMEOUT_MS, 'Check learned RF data');
        return Buffer.from(data).toString('hex');
      } catch (err) {
        // Not captured yet - keep polling until the deadline.
      }
    }
    await this._device.cancelLearning().catch(() => {});
    throw new Error('No RF signal was captured in time - once the light came back on for the second phase, was the remote button pressed again quickly?');
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
