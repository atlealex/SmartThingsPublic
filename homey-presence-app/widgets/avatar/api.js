'use strict';

module.exports = {
  async getStatus({ homey, query }) {
    const deviceId = query.deviceId;
    if (!deviceId) throw new Error('Missing deviceId');

    const driver = homey.drivers.getDriver('person');
    await driver.ready();
    const device = driver.getDevices().find((d) => d.getData().id === deviceId);
    if (!device) throw new Error('Device not found');

    return {
      name: device.getName(),
      photoUrl: device.getSetting('photoUrl') || '',
      home: device.getCapabilityValue('home') === true,
    };
  },
};
