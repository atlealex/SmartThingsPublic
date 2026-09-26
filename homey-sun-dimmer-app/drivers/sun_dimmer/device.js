'use strict';

const Homey = require('homey');
const suncalc = require('suncalc');
const { computeTargetPercent } = require('../../lib/dimSchedule');

const POLL_INTERVAL_MS = 30 * 1000;
const DEFAULT_TRANSITION_MINUTES = 45;
const DIM_EPSILON = 0.005; // ignore sub-0.5% differences to avoid write-spamming a light

class SunDimmerDevice extends Homey.Device {
  async onInit() {
    this.log('Sun Dimmer device initialized:', this.getName());

    this.trackedLights = this.getStoreValue('lights') || [];

    this.registerCapabilityListener('onoff', async () => {
      // Purely a local pause/resume toggle - nothing external to command.
    });

    await this._poll().catch((err) => this.error('Initial poll failed:', err.message));
    this._pollTimer = this.homey.setInterval(() => {
      this._poll().catch((err) => this.error('Poll failed:', err.message));
    }, POLL_INTERVAL_MS);
  }

  async onDeleted() {
    if (this._pollTimer) this.homey.clearInterval(this._pollTimer);
  }

  _now() {
    return new Date();
  }

  async _poll() {
    if (this.getCapabilityValue('onoff') === false) {
      await this.setAvailable().catch(() => {});
      return;
    }

    if (this.trackedLights.length === 0) {
      await this.setUnavailable('Ingen lys er valgt for denne soldimmeren').catch(() => {});
      return;
    }

    const lat = this.homey.geolocation.getLatitude();
    const lon = this.homey.geolocation.getLongitude();
    const now = this._now();
    const sunTimes = suncalc.getTimes(now, lat, lon);

    const settings = this.getSettings();
    const transitionMs = Math.max(1, Number(settings.transitionMinutes) || DEFAULT_TRANSITION_MINUTES) * 60 * 1000;

    const devices = await this.homey.app.homeyApi.devices.getDevices();

    let anyFound = false;

    for (const light of this.trackedLights) {
      const device = devices[light.id];
      if (!device) {
        this.log(`Tracked light ${light.name} (${light.id}) no longer exists - skipping this poll.`);
        continue;
      }
      anyFound = true;

      const targetPercent = computeTargetPercent(now, sunTimes.sunrise, sunTimes.sunset, transitionMs, light.min, light.max);
      const targetDim = targetPercent / 100;
      const desiredOnoff = targetDim > 0;

      const capabilities = device.capabilitiesObj || {};
      const currentOnoff = capabilities.onoff?.value;
      const currentDim = capabilities.dim?.value;

      try {
        if ('onoff' in capabilities && currentOnoff !== desiredOnoff) {
          await this.homey.app.homeyApi.devices.setCapabilityValue({
            deviceId: light.id, capabilityId: 'onoff', value: desiredOnoff,
          });
        }

        if (desiredOnoff && (typeof currentDim !== 'number' || Math.abs(currentDim - targetDim) > DIM_EPSILON)) {
          await this.homey.app.homeyApi.devices.setCapabilityValue({
            deviceId: light.id, capabilityId: 'dim', value: targetDim, opts: { duration: POLL_INTERVAL_MS },
          });
        }
      } catch (err) {
        this.error(`Failed to update light ${light.name} (${light.id}):`, err.message);
      }
    }

    if (!anyFound) {
      await this.setUnavailable('Ingen av de valgte lysene finnes lenger').catch(() => {});
      return;
    }

    await this.setAvailable().catch(() => {});
  }
}

module.exports = SunDimmerDevice;
