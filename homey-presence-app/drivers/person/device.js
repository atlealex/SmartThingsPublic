'use strict';

const Homey = require('homey');
const { buildAvatarFromUrl } = require('../../lib/AvatarImage');

const HOME_COLOR = '#3ECF5C';
const AWAY_COLOR = '#8A8A8A';

class PersonDevice extends Homey.Device {
  async onInit() {
    this.log('Person device initialized:', this.getName());

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
    const home = this.getCapabilityValue('home') === true;
    return buildAvatarFromUrl(photoUrl, home ? HOME_COLOR : AWAY_COLOR);
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
   * regardless of which path changed it.
   */
  async applyPresence(value) {
    const previousValue = this.getCapabilityValue('home');
    await this.setCapabilityValue('home', value).catch((err) => this.error('Failed to set home capability:', err.message));
    await this._refreshImage();

    if (previousValue !== value) {
      const triggerId = value ? 'became_home' : 'became_away';
      await this.homey.flow.getDeviceTriggerCard(triggerId).trigger(this).catch((err) => this.error(`Failed to trigger ${triggerId}:`, err.message));
    }
  }
}

module.exports = PersonDevice;
