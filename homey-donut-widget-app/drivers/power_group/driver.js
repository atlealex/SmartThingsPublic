'use strict';

const Homey = require('homey');

class PowerGroupDriver extends Homey.Driver {
  async onPair(session) {
    session.setHandler('list_devices', async () => {
      const devices = await this.homey.app.homeyApi.devices.getDevices();
      return Object.values(devices)
        .filter((device) => device.capabilitiesObj && device.capabilitiesObj.measure_power)
        .map((device) => ({ id: device.id, name: device.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
    });
  }
}

module.exports = PowerGroupDriver;
