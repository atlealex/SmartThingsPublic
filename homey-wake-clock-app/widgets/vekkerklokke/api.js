'use strict';

// Homey.getDeviceIds() in the widget frontend returns the platform-wide
// device id, not this driver's own pairing data.id - so devices are looked
// up through the App API (keyed by that same platform id) rather than via
// homey.drivers.getDriver('alarm').getDevices().

module.exports = {
  async getState({ homey, query }) {
    const devices = await homey.app.homeyApi.devices.getDevices();
    const device = devices[query.deviceId];
    if (!device) return { time: '07:00', enabled: true };
    return {
      time: (device.capabilitiesObj && device.capabilitiesObj.alarm_time && device.capabilitiesObj.alarm_time.value) || '07:00',
      enabled: !(device.capabilitiesObj && device.capabilitiesObj.onoff && device.capabilitiesObj.onoff.value === false),
    };
  },

  async setTime({ homey, query, body }) {
    const deviceId = query.deviceId || body.deviceId;
    await homey.app.homeyApi.devices.setCapabilityValue({ deviceId, capabilityId: 'alarm_time', value: body.time });
    return { ok: true };
  },

  async setEnabled({ homey, query, body }) {
    const deviceId = query.deviceId || body.deviceId;
    await homey.app.homeyApi.devices.setCapabilityValue({ deviceId, capabilityId: 'onoff', value: !!body.enabled });
    return { ok: true };
  },
};
