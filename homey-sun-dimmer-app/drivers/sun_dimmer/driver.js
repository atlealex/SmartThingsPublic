'use strict';

const Homey = require('homey');

class SunDimmerDriver extends Homey.Driver {
  async onInit() {
    this.homey.flow.getActionCard('start_sunset_dim_now').registerRunListener(async (args) => {
      args.device.startManualOverride('sunset');
    });
    this.homey.flow.getActionCard('start_sunrise_brighten_now').registerRunListener(async (args) => {
      args.device.startManualOverride('sunrise');
    });
  }

  async onPair(session) {
    session.setHandler('list_lights', async () => this._listDimmableLights());
  }

  async onRepair(session, device) {
    session.setHandler('list_lights', async () => this._listDimmableLights());
    session.setHandler('get_current_lights', async () => device.getStoreValue('lights') || []);
    session.setHandler('save_lights', async (lights) => {
      await device.setStoreValue('lights', lights);
      device.trackedLights = lights;
      return true;
    });
  }

  async _listDimmableLights() {
    const devices = await this.homey.app.homeyApi.devices.getDevices();
    return Object.values(devices)
      .filter((device) => device.capabilitiesObj && device.capabilitiesObj.dim)
      .map((device) => ({ id: device.id, name: device.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}

module.exports = SunDimmerDriver;
