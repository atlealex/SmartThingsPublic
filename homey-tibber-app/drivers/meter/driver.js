'use strict';

const Homey = require('homey');

class StromkostnadDriver extends Homey.Driver {
  async onInit() {
    this.log('Strømkostnad driver initialized');
  }
}

module.exports = StromkostnadDriver;
