'use strict';

const Homey = require('homey');

class PersonDriver extends Homey.Driver {
  async onInit() {
    this.homey.flow.getActionCard('mark_home').registerRunListener(async (args) => {
      await args.device.applyPresence(true);
    });
    this.homey.flow.getActionCard('mark_away').registerRunListener(async (args) => {
      await args.device.applyPresence(false);
    });
    this.homey.flow.getConditionCard('is_home').registerRunListener(async (args) => args.device.getCapabilityValue('home') === true);
  }
}

module.exports = PersonDriver;
