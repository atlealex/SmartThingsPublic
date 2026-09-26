'use strict';

const Homey = require('homey');

const POLL_INTERVAL_MS = 10 * 1000;

// Capability instance ids only allow letters, numbers and underscores -
// device ids are UUIDs (with hyphens), so they need sanitizing.
function capabilityInstanceId(deviceId) {
  return deviceId.replace(/[^a-zA-Z0-9_]/g, '_');
}

class PowerGroupDevice extends Homey.Device {
  async onInit() {
    this.log('Power group device initialized:', this.getName());

    this.trackedDeviceIds = this.getStoreValue('trackedDeviceIds') || [];
    await this._ensureCapabilities();

    await this._poll().catch((err) => this.error('Initial poll failed:', err.message));
    this._pollTimer = this.homey.setInterval(() => {
      this._poll().catch((err) => this.error('Poll failed:', err.message));
    }, POLL_INTERVAL_MS);
  }

  async onDeleted() {
    if (this._pollTimer) this.homey.clearInterval(this._pollTimer);
  }

  async _ensureCapabilities() {
    for (const deviceId of this.trackedDeviceIds) {
      const capabilityId = `measure_power.${capabilityInstanceId(deviceId)}`;
      if (!this.hasCapability(capabilityId)) {
        await this.addCapability(capabilityId).catch((err) => this.error(`Failed to add capability ${capabilityId}:`, err.message));
      }
    }
  }

  async _poll() {
    const devices = await this.homey.app.homeyApi.devices.getDevices();

    let total = 0;
    let anyFound = false;

    for (const deviceId of this.trackedDeviceIds) {
      const device = devices[deviceId];
      const capabilityId = `measure_power.${capabilityInstanceId(deviceId)}`;

      if (!device) {
        this.log(`Tracked device ${deviceId} no longer exists - skipping this poll.`);
        continue;
      }

      anyFound = true;
      const capability = device.capabilitiesObj && device.capabilitiesObj.measure_power;
      const value = typeof capability?.value === 'number' ? capability.value : 0;

      await this.setCapabilityOptions(capabilityId, { title: device.name }).catch(() => {});
      await this._setCapabilitySafely(capabilityId, value);
      total += value;
    }

    if (!anyFound) {
      await this.setUnavailable('Ingen av de sporede enhetene finnes lenger').catch(() => {});
      return;
    }

    await this._setCapabilitySafely('measure_power', total);
    await this.setAvailable().catch(() => {});
  }

  async _setCapabilitySafely(capabilityId, value) {
    if (value === undefined || value === null || Number.isNaN(value)) return;
    if (!this.hasCapability(capabilityId)) return;
    await this.setCapabilityValue(capabilityId, value).catch((err) => {
      this.error(`Failed to set ${capabilityId}:`, err.message);
    });
  }
}

module.exports = PowerGroupDevice;
