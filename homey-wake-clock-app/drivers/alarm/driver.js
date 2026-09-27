'use strict';

const Homey = require('homey');

class AlarmDriver extends Homey.Driver {
  async onInit() {
    this.homey.flow.getDeviceTriggerCard('wake_time_reached');
  }
}

module.exports = AlarmDriver;
