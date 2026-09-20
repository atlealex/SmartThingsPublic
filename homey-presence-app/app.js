'use strict';

const Homey = require('homey');

class FamilyPresenceApp extends Homey.App {
  async onInit() {
    this.log('Family presence app has been initialized');
  }
}

module.exports = FamilyPresenceApp;
