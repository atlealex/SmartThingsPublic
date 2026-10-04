'use strict';

const Homey = require('homey');
const BroadlinkConnection = require('../../lib/BroadlinkConnection');

const LEARN_TIMEOUT_MS = 25 * 1000;
const RF_FREQUENCY_TIMEOUT_MS = 15 * 1000;
const RF_DATA_TIMEOUT_MS = 15 * 1000;
const DEFAULT_HOLD_DURATION_S = 3;
const DEFAULT_HOLD_INTERVAL_MS = 200;
const MIN_HOLD_INTERVAL_MS = 80; // Below this, UDP round-trip time alone (see BroadlinkConnection) eats most of the gap anyway.

class BroadlinkRemoteDevice extends Homey.Device {
  async onInit() {
    this.log('Broadlink remote device initialized:', this.getName());
    this._commands = this.getStoreValue('commands') || {};
    this._connect();

    // Devices paired before button.learn_rf existed (added in v1.2.0) don't
    // get it automatically - Homey only applies a driver's current
    // capability list to newly paired devices, not retroactively to
    // existing ones. Add it here so upgrading the app is enough, without
    // needing to delete and re-pair the device.
    if (!this.hasCapability('button.learn_rf')) {
      await this.addCapability('button.learn_rf');
    }

    // The four device-page buttons (mirroring the "Learn IR/RF command"
    // buttons the existing community Broadlink app shows on its own device
    // page) all act on whichever signal name is currently set in this
    // device's settings, rather than each needing its own Flow.
    this.registerCapabilityListener('button.learn', () => this._activeSignalAction((name) => this.learnCommand(name)));
    this.registerCapabilityListener('button.learn_rf', () => this._activeSignalAction((name) => this.learnRfCommand(name)));
    this.registerCapabilityListener('button.send', () => this._activeSignalAction((name) => this.sendCommand(name)));
    this.registerCapabilityListener('button.send_held', () => this._activeSignalAction((name) => {
      const settings = this.getSettings();
      return this.sendHeldCommand(name, settings.holdDurationSeconds, settings.holdIntervalMs);
    }));
  }

  /** Runs `action` against the signal name set in this device's settings, or throws a clear error (shown as a toast in the Homey app) if none is set yet. */
  async _activeSignalAction(action) {
    const { activeSignalName } = this.getSettings();
    if (!activeSignalName) {
      throw new Error('Sett et "Signalnavn" i enhetsinnstillingene først / Set a "Signal name" in the device settings first');
    }
    await action(activeSignalName);
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

  /**
   * Learns an RF (433/315MHz) signal instead of IR - use this instead of
   * learnCommand() when the device's learning-mode light cycles through two
   * phases: hold the remote button during the first phase, then once the
   * light comes back on for the second phase, press the same button again
   * quickly. See BroadlinkConnection.learnRf() for why RF needs this.
   */
  async learnRfCommand(name) {
    this.log(`Learning RF signal "${name}" - hold the remote button now (first phase)`);
    const hexCode = await this._connection.learnRf(RF_FREQUENCY_TIMEOUT_MS, RF_DATA_TIMEOUT_MS);
    this._commands[name] = hexCode;
    await this.setStoreValue('commands', this._commands);
    this.log(`Learned RF signal "${name}" (${hexCode.length / 2} bytes)`);
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
