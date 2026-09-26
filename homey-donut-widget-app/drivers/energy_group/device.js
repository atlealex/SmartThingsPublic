'use strict';

const Homey = require('homey');
const { ALL_METRICS, METRIC_GROUP_CAPABILITY, sumMetric } = require('../../lib/energySummary');

const POLL_INTERVAL_MS = 60 * 1000;

class EnergyGroupDevice extends Homey.Device {
  async onInit() {
    this.log('Energy group device initialized:', this.getName());

    this.trackedDeviceIds = this.getStoreValue('trackedDeviceIds') || [];
    this.selectedMetrics = this.getStoreValue('selectedMetrics') || ALL_METRICS;

    await this.onConfigUpdated();

    await this._poll().catch((err) => this.error('Initial poll failed:', err.message));
    this._pollTimer = this.homey.setInterval(() => {
      this._poll().catch((err) => this.error('Poll failed:', err.message));
    }, POLL_INTERVAL_MS);
  }

  async onDeleted() {
    if (this._pollTimer) this.homey.clearInterval(this._pollTimer);
  }

  /**
   * Called after onInit() and again after a repair save: adds/removes the
   * per-period capabilities so the device only shows the tiles the user
   * actually chose.
   */
  async onConfigUpdated() {
    for (const metric of ALL_METRICS) {
      const capabilityId = METRIC_GROUP_CAPABILITY[metric];
      const shouldHave = this.selectedMetrics.includes(metric);
      const has = this.hasCapability(capabilityId);

      if (shouldHave && !has) {
        await this.addCapability(capabilityId).catch((err) => this.error(`Failed to add capability ${capabilityId}:`, err.message));
      } else if (!shouldHave && has) {
        await this.removeCapability(capabilityId).catch((err) => this.error(`Failed to remove capability ${capabilityId}:`, err.message));
      }
    }
  }

  async _poll() {
    if (this.trackedDeviceIds.length === 0) {
      await this.setUnavailable('Ingen enheter er valgt for denne energigruppen').catch(() => {});
      return;
    }

    const devices = await this.homey.app.homeyApi.devices.getDevices();
    let anyFound = false;

    for (const metric of this.selectedMetrics) {
      const { total, anyFound: found } = sumMetric(devices, this.trackedDeviceIds, metric);
      if (found) anyFound = true;
      await this._setCapabilitySafely(METRIC_GROUP_CAPABILITY[metric], total);
    }

    if (!anyFound) {
      await this.setUnavailable('Ingen av de sporede enhetene finnes lenger').catch(() => {});
      return;
    }

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

module.exports = EnergyGroupDevice;
