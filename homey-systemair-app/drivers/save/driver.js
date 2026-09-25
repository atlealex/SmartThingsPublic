'use strict';

const Homey = require('homey');

class SaveDriver extends Homey.Driver {
  async onInit() {
    this.homey.flow.getActionCard('set_mode').registerRunListener(async (args) => {
      await args.device.setMode(args.mode);
    });
    this.homey.flow.getActionCard('set_fan_speed').registerRunListener(async (args) => {
      await args.device.setFanSpeed(args.speed);
    });
    this.homey.flow.getActionCard('filter_replaced').registerRunListener(async (args) => {
      await args.device.resetFilterTimer();
    });
    this.homey.flow.getConditionCard('mode_is').registerRunListener(async (args) => (
      args.device.getCapabilityValue('ventilation_mode') === args.mode
    ));
  }
}

module.exports = SaveDriver;
