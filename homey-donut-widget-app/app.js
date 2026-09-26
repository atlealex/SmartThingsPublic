'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');

class DonutChartApp extends Homey.App {
  async onInit() {
    this.log('Donut Chart app has been initialized');
    this.homeyApi = await HomeyAPI.createAppAPI({ homey: this.homey });
  }
}

module.exports = DonutChartApp;
