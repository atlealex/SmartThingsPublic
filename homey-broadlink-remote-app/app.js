'use strict';

const Homey = require('homey');

class BroadlinkRemoteApp extends Homey.App {
  async onInit() {
    this.log('Broadlink Remote (Hold) app has been initialized');
  }
}

module.exports = BroadlinkRemoteApp;
