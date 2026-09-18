'use strict';

const Homey = require('homey');

class ElviaMeterDriver extends Homey.Driver {
  async onInit() {
    this.log('Elvia meter driver initialized');
  }
}

module.exports = ElviaMeterDriver;
