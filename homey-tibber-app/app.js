'use strict';

const Homey = require('homey');

class TibberCostApp extends Homey.App {
  async onInit() {
    this.log('Strømkostnad (Tibber) app has been initialized');
  }
}

module.exports = TibberCostApp;
