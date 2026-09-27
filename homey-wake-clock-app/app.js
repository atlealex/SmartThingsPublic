'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');

class WakeClockApp extends Homey.App {
  async onInit() {
    this.log('Wake Clock app initialized');

    // The widget runs outside any specific device's context and only knows
    // the platform-wide device id (from Homey.getDeviceIds()), which isn't
    // the same as this driver's own pairing data.id - the App API lets the
    // widget's api.js look a device up by that platform id directly.
    this.homeyApi = await HomeyAPI.createAppAPI({ homey: this.homey });

    this.homey.flow.getActionCard('set_wake_time').registerRunListener(async (args) => {
      await args.device.setWakeTime(args.time);
    });
  }
}

module.exports = WakeClockApp;
