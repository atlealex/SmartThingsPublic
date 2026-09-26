'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');

class SunDimmerApp extends Homey.App {
  async onInit() {
    this.log('Sun Dimmer app has been initialized');
    this.homeyApi = await HomeyAPI.createAppAPI({ homey: this.homey });
  }
}

module.exports = SunDimmerApp;
