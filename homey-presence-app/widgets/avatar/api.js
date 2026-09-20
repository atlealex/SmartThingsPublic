'use strict';

module.exports = {
  async getPeople({ homey }) {
    const driver = homey.drivers.getDriver('person');
    await driver.ready();

    return driver.getDevices().map((device) => ({
      id: device.getData().id,
      name: device.getName(),
      photoUrl: device.getSetting('photoUrl') || '',
      home: device.getCapabilityValue('home') === true,
    }));
  },
};
