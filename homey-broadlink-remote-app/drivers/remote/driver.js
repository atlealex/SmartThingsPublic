'use strict';

const Homey = require('homey');
const { discover } = require('node-broadlink');
const { withTimeout } = require('../../lib/withTimeout');

const DISCOVER_TIMEOUT_MS = 8000;

class BroadlinkRemoteDriver extends Homey.Driver {
  async onInit() {
    this.homey.flow
      .getActionCard('learn_command')
      .registerRunListener(async (args) => {
        await args.device.learnCommand(args.name);
      });

    this.homey.flow
      .getActionCard('send_command')
      .registerRunListener(async (args) => {
        await args.device.sendCommand(args.name.name);
      })
      .registerArgumentAutocompleteListener('name', async (query, args) => {
        return args.device.getCommandNames()
          .filter((name) => name.toLowerCase().includes(query.toLowerCase()))
          .map((name) => ({ name }));
      });

    this.homey.flow
      .getActionCard('send_command_held')
      .registerRunListener(async (args) => {
        await args.device.sendHeldCommand(args.name.name, args.duration, args.interval);
      })
      .registerArgumentAutocompleteListener('name', async (query, args) => {
        return args.device.getCommandNames()
          .filter((name) => name.toLowerCase().includes(query.toLowerCase()))
          .map((name) => ({ name }));
      });
  }

  async onPairListDevices() {
    // Broadlink devices are discovered via a local UDP broadcast - they must
    // already be joined to the same WiFi network (the same one-time AP-mode
    // setup used by the official Broadlink app or the existing community
    // Homey app already did this; this driver only ever talks to a device
    // that's already on the network).
    const devices = await discover(DISCOVER_TIMEOUT_MS);
    this.log(`Discovery found ${devices.length} Broadlink device(s) total: ${devices.map((d) => `${d.TYPE || 'Unknown'}@${d.host.address}`).join(', ') || '(none)'}`);

    const remotes = devices.filter((device) => device.TYPE && device.TYPE.startsWith('RM'));
    this.log(`Of those, ${remotes.length} identified as an RM-series remote`);

    return remotes
      .map((device) => {
        if (device.isLocked) {
          this.log(`${device.name || device.host.address} is reported as locked (cloud-only mode) - local control may not work. See the app's README.`);
        }
        return {
          name: device.name || `${device.model || device.TYPE} (${device.host.address})`,
          data: {
            id: device.mac.join(':'),
            host: { address: device.host.address, port: device.host.port },
            mac: device.mac,
            deviceType: device.deviceType,
          },
        };
      });
  }
}

module.exports = BroadlinkRemoteDriver;
