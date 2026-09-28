'use strict';

// Homey.getDeviceIds() in the widget frontend returns the platform-wide
// device id, which isn't this driver's own pairing data.id. The App API's
// generic setCapabilityValue() writes the platform's cached value for
// display, but does not reliably invoke this driver's own
// registerCapabilityListener - so a set made that way never actually ran
// setWakeTime()/setEnabled() (no validation, no rescheduling of the alarm).
// Instead, the platform id is used only to find which paired device this
// is (via its own pairing data.id, exposed on the App API device as
// `.data.id`), and the actual local Device instance's own methods are
// called directly - the same code path the "Set wake time" Flow action uses.

async function findDevice(homey, deviceId) {
  const devices = await homey.app.homeyApi.devices.getDevices();
  const apiDevice = devices[deviceId];
  if (!apiDevice) return null;
  const localDataId = apiDevice.data && apiDevice.data.id;
  return homey.drivers.getDriver('alarm').getDevices()
    .find((device) => device.getData().id === localDataId) || null;
}

module.exports = {
  async getState({ homey, query }) {
    const device = await findDevice(homey, query.deviceId);
    if (!device) return { time: '07:00', enabled: true };
    return {
      time: device.getCapabilityValue('alarm_time') || '07:00',
      enabled: device.getCapabilityValue('onoff') !== false,
      next: device.getNextOccurrenceIso(),
    };
  },

  async setTime({ homey, query, body }) {
    const device = await findDevice(homey, query.deviceId || body.deviceId);
    if (!device) throw new Error('Device not found');
    await device.setWakeTime(body.time);
    return { ok: true };
  },

  async setEnabled({ homey, query, body }) {
    const device = await findDevice(homey, query.deviceId || body.deviceId);
    if (!device) throw new Error('Device not found');
    await device.setEnabled(!!body.enabled);
    return { ok: true };
  },
};
