'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');

class TibberCostApp extends Homey.App {
  async onInit() {
    this.log('Strømkostnad (Tibber) app has been initialized');
    this.homeyApi = await HomeyAPI.createAppAPI({ homey: this.homey });
  }
}

module.exports = TibberCostApp;
