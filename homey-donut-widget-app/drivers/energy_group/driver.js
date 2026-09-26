'use strict';

const Homey = require('homey');
const { METRIC_SOURCE_CAPABILITY } = require('../../lib/energySummary');

class EnergyGroupDriver extends Homey.Driver {
  async onPair(session) {
    session.setHandler('list_devices', async () => this._listEnergyDevices());
  }

  async onRepair(session, device) {
    session.setHandler('list_devices', async () => this._listEnergyDevices());
    session.setHandler('get_current_state', async () => ({
      deviceIds: device.getStoreValue('trackedDeviceIds') || [],
      metrics: device.getStoreValue('selectedMetrics') || [],
    }));
    session.setHandler('save_state', async ({ deviceIds, metrics }) => {
      await device.setStoreValue('trackedDeviceIds', deviceIds);
      await device.setStoreValue('selectedMetrics', metrics);
      device.trackedDeviceIds = deviceIds;
      device.selectedMetrics = metrics;
      await device.onConfigUpdated();
      return true;
    });
  }

  // "Power by the Hour" companion devices (e.g. "<Device>_Σpower") are the
  // ones exposing these meter_kwh_this_* capabilities - filtering on the
  // "hour" one is enough, since a device with any of the four has all four.
  async _listEnergyDevices() {
    const devices = await this.homey.app.homeyApi.devices.getDevices();
    return Object.values(devices)
      .filter((device) => device.capabilitiesObj && device.capabilitiesObj[METRIC_SOURCE_CAPABILITY.hour])
      .map((device) => ({ id: device.id, name: device.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}

module.exports = EnergyGroupDriver;
