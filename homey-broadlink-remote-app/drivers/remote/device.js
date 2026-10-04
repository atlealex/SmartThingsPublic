'use strict';

const Homey = require('homey');
const BroadlinkConnection = require('../../lib/BroadlinkConnection');

const LEARN_TIMEOUT_MS = 25 * 1000;
const DEFAULT_HOLD_DURATION_S = 3;
const DEFAULT_HOLD_INTERVAL_MS = 200;
const MIN_HOLD_INTERVAL_MS = 80; // Below this, UDP round-trip time alone (see BroadlinkConnection) eats most of the gap anyway.

class BroadlinkRemoteDevice extends Homey.Device {
  async onInit() {
    this.log('Broadlink remote device initialized:', this.getName());
    this._commands = this.getStoreValue('commands') || {};
    this._connect();
  }

  _connect() {
    const { host, mac, deviceType } = this.getData();
    this._connection = new BroadlinkConnection({ host, mac, deviceType });
  }

  /** Learned command names, for the Flow action autocomplete arguments. */
  getCommandNames() {
    return Object.keys(this._commands);
  }

  /**
   * Enters learning mode and waits for a signal to be captured - the user
   * needs to press (and, for a "hold" style signal like a blind's favorite-
   * position button, hold down) the physical remote button while this runs.
   * Overwrites any existing command with the same name.
   */
  async learnCommand(name) {
    this.log(`Learning signal "${name}" - press the remote button now`);
    const hexCode = await this._connection.learn(LEARN_TIMEOUT_MS);
    this._commands[name] = hexCode;
    await this.setStoreValue('commands', this._commands);
    this.log(`Learned signal "${name}" (${hexCode.length / 2} bytes)`);
  }

  async sendCommand(name) {
    const hexCode = this._commands[name];
    if (!hexCode) throw new Error(`No signal named "${name}" has been learned on this device yet`);
    await this._connection.send(hexCode);
  }

  /** The actual point of this app: resend a learned signal repeatedly with precise, sub-second timing, to simulate physically holding down a remote button. */
  async sendHeldCommand(name, durationSeconds, intervalMs) {
    const hexCode = this._commands[name];
    if (!hexCode) throw new Error(`No signal named "${name}" has been learned on this device yet`);
    const duration = Math.max(1, Number(durationSeconds) || DEFAULT_HOLD_DURATION_S) * 1000;
    const interval = Math.max(MIN_HOLD_INTERVAL_MS, Number(intervalMs) || DEFAULT_HOLD_INTERVAL_MS);
    const sends = await this._connection.sendHeld(hexCode, duration, interval);
    this.log(`Sent "${name}" ${sends} times over ${duration}ms (interval ${interval}ms)`);
  }

  async deleteCommand(name) {
    delete this._commands[name];
    await this.setStoreValue('commands', this._commands);
  }
}

module.exports = BroadlinkRemoteDevice;
