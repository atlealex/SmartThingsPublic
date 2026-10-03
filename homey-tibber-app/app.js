'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');

class TibberCostApp extends Homey.App {
  async onInit() {
    this.log('Strømkostnad (Tibber) app has been initialized');
    this.homeyApi = await HomeyAPI.createAppAPI({ homey: this.homey });

    this.homey.flow
      .getActionCard('refresh_prices_now')
      .registerRunListener(async (args) => {
        await args.device.refreshPricesNow();
      });

    this.homey.flow
      .getActionCard('add_missed_consumption')
      .registerRunListener(async (args) => {
        await args.device.addMissedConsumption(args.kwh);
      });
  }
}

module.exports = TibberCostApp;
