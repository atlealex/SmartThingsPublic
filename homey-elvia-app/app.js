'use strict';

const Homey = require('homey');

class ElviaApp extends Homey.App {
  async onInit() {
    this.log('Elvia app has been initialized');

    this.homey.flow
      .getConditionCard('price_above')
      .registerRunListener(async (args) => {
        const price = args.device.getCapabilityValue('measure_price');
        return typeof price === 'number' && price > args.price;
      });

    this.homey.flow
      .getActionCard('refresh_now')
      .registerRunListener(async (args) => {
        await args.device.pollElviaData();
      });
  }
}

module.exports = ElviaApp;
