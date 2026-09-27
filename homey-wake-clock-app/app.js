'use strict';

const Homey = require('homey');

class WakeClockApp extends Homey.App {
  async onInit() {
    this.log('Wake Clock app initialized');

    this.homey.flow.getActionCard('set_wake_time').registerRunListener(async (args) => {
      await args.device.setWakeTime(args.time);
    });
  }
}

module.exports = WakeClockApp;
