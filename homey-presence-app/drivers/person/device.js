'use strict';

const Homey = require('homey');
const { buildAvatarFromUrl } = require('../../lib/AvatarImage');

const HOME_COLOR = '#3ECF5C';
const AWAY_COLOR = '#8A8A8A';
const ZONE_COLOR = '#F5C542';

const REQUIRED_CAPABILITIES = ['home', 'zone'];

class PersonDevice extends Homey.Device {
  async onInit() {
    this.log('Person device initialized:', this.getName());

    // Devices paired before this app used class "camera" need a runtime
    // migration - only camera-class devices show their image as the tile
    // icon in room/device lists (class "other" only shows the photo inside
    // the device's own detail view, which isn't what the photo is for here).
    if (this.getClass() !== 'camera') {
      await this.setClass('camera').catch((err) => this.error('Failed to migrate device class:', err.message));
    }

    // Devices paired before the "zone" capability existed need it added
    // manually - Homey doesn't retroactively apply app.json capability
    // changes to already-paired devices.
    for (const capabilityId of REQUIRED_CAPABILITIES) {
      if (!this.hasCapability(capabilityId)) {
        await this.addCapability(capabilityId).catch((err) => this.error(`Failed to add ${capabilityId}:`, err.message));
      }
    }

    this._cameraImage = await this.homey.images.createImage();
    this._cameraImage.setStream(async (stream) => {
      const buffer = await this._composeCurrentAvatar();
      stream.end(buffer);
    });
    await this.setCameraImage('avatar', this.getName(), this._cameraImage);

    this.registerCapabilityListener('home', async (value) => {
      await this.applyPresence(value);
    });
  }

  async onSettings({ changedKeys }) {
    if (changedKeys.includes('photoUrl')) {
      await this._refreshImage();
    }
  }

  async onRenamed(name) {
    await this.setCameraImage('avatar', name, this._cameraImage).catch(() => {});
  }

  /** @returns {Promise<Buffer>} the current PNG for whatever this device's live state is right now. */
  async _composeCurrentAvatar() {
    const photoUrl = this.getSetting('photoUrl');
    if (!photoUrl) {
      throw new Error('No photo URL configured yet - open this device\'s settings to add one.');
    }
    return buildAvatarFromUrl(photoUrl, this._currentRingColor());
  }

  _currentRingColor() {
    const zone = this.getCapabilityValue('zone');
    if (zone) return ZONE_COLOR;
    return this.getCapabilityValue('home') === true ? HOME_COLOR : AWAY_COLOR;
  }

  /** Forces Homey to re-pull the avatar image (e.g. after the photo URL or presence changes). */
  async _refreshImage() {
    await this._cameraImage.update().catch((err) => this.error('Failed to refresh avatar image:', err.message));
  }

  /**
   * Single entry point for changing presence, used by both the manual
   * device-tile toggle (via registerCapabilityListener) and this driver's
   * own "mark home/away" flow actions - keeps the capability value, the
   * avatar ring color, and the became_home/became_away triggers in sync
   * regardless of which path changed it. Marking home or plain away always
   * clears any zone.
   */
  async applyPresence(value) {
    await this._applyStatus({ home: value, zone: '' });
  }

  /**
   * Marks the person as being in a named zone (e.g. "Work") rather than
   * plain home/away - shown with its own ring color and the zone name in
   * the Familie widget, driven from an external zone source (e.g. Home
   * Assistant) via a Homey Flow webhook and this driver's "mark_zone"
   * action.
   */
  async applyZone(zoneName) {
    await this._applyStatus({ home: false, zone: zoneName || '' });
  }

  async _applyStatus({ home, zone }) {
    const previousHome = this.getCapabilityValue('home');
    await this.setCapabilityValue('home', home).catch((err) => this.error('Failed to set home capability:', err.message));
    await this.setCapabilityValue('zone', zone).catch((err) => this.error('Failed to set zone capability:', err.message));
    await this._refreshImage();

    if (previousHome !== home) {
      const triggerId = home ? 'became_home' : 'became_away';
      await this.homey.flow.getDeviceTriggerCard(triggerId).trigger(this).catch((err) => this.error(`Failed to trigger ${triggerId}:`, err.message));
    }
  }
}

module.exports = PersonDevice;
