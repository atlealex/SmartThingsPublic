'use strict';

const Homey = require('homey');

class SystemairApp extends Homey.App {
  async onInit() {
    this.log('Systemair Ventilation app has been initialized');
  }
}

module.exports = SystemairApp;
