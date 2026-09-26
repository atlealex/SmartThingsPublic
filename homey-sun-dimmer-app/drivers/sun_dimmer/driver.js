'use strict';

const Homey = require('homey');

class SunDimmerDriver extends Homey.Driver {
  async onPair(session) {
    session.setHandler('list_lights', async () => {
      const devices = await this.homey.app.homeyApi.devices.getDevices();
      return Object.values(devices)
        .filter((device) => device.capabilitiesObj && device.capabilitiesObj.dim)
        .map((device) => ({ id: device.id, name: device.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
    });
  }
}

module.exports = SunDimmerDriver;
