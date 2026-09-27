'use strict';

function getDevice(homey, deviceId) {
  const driver = homey.drivers.getDriver('alarm');
  return driver.getDevices().find((device) => device.getData().id === deviceId);
}

module.exports = {
  async getState({ homey, query }) {
    const device = getDevice(homey, query.deviceId);
    if (!device) return { time: '07:00', enabled: true };
    return {
      time: device.getCapabilityValue('alarm_time') || '07:00',
      enabled: device.getCapabilityValue('onoff') !== false,
    };
  },

  async setTime({ homey, query, body }) {
    const device = getDevice(homey, query.deviceId || body.deviceId);
    if (!device) throw new Error('Device not found');
    await device.setWakeTime(body.time);
    return { ok: true };
  },

  async setEnabled({ homey, query, body }) {
    const device = getDevice(homey, query.deviceId || body.deviceId);
    if (!device) throw new Error('Device not found');
    await device.setEnabled(!!body.enabled);
    return { ok: true };
  },
};
