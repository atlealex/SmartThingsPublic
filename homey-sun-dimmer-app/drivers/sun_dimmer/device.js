'use strict';

const Homey = require('homey');
const suncalc = require('suncalc');
const {
  computeScheduledPercent, computeOverridePercent, isOverrideFinished, nextOccurrence, formatRelative,
} = require('../../lib/dimSchedule');

const POLL_INTERVAL_MS = 30 * 1000;
const DEFAULT_TRANSITION_MINUTES = 45;
const DIM_EPSILON = 0.005; // ignore sub-0.5% differences to avoid write-spamming a light
const LIGHT_CAPABILITY_BASES = ['dim', 'light_level', 'light_min', 'light_max'];
const LIGHT_CAPABILITY_TITLE_SUFFIX = {
  dim: ' – juster', light_level: ' – nivå', light_min: ' – min', light_max: ' – max',
};

// Capability instance ids only allow letters, numbers and underscores -
// device ids are UUIDs (with hyphens), so they need sanitizing.
function capabilityInstanceId(deviceId) {
  return deviceId.replace(/[^a-zA-Z0-9_]/g, '_');
}

class SunDimmerDevice extends Homey.Device {
  async onInit() {
    this.log('Sun Dimmer device initialized:', this.getName());

    this.trackedLights = this.getStoreValue('lights') || [];
    this.manualOverride = null; // { direction: 'sunset'|'sunrise', startedAt: Date } | null

    this.registerCapabilityListener('onoff.sunset', async () => {});
    this.registerCapabilityListener('onoff.sunrise', async () => {});

    await this.onLightsUpdated();

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

  /** Called by the "Start sunset dimming now" / "Start sunrise brightening now" flow actions. */
  startManualOverride(direction) {
    this.manualOverride = { direction, startedAt: this._now() };
    this.log(`Manual override started: ${direction}`);
  }

  /**
   * Called after onInit(), and again after the repair flow saves a new
   * light selection: adds per-light capabilities (live level, min, max)
   * for every tracked light, removes them for lights no longer tracked,
   * and (re-)registers their capability listeners.
   */
  async onLightsUpdated() {
    const trackedIds = new Set(this.trackedLights.map((light) => capabilityInstanceId(light.id)));

    for (const capabilityId of this.getCapabilities()) {
      const [base, instanceId] = capabilityId.split('.');
      if (!instanceId || !LIGHT_CAPABILITY_BASES.includes(base)) continue;
      if (!trackedIds.has(instanceId)) {
        await this.removeCapability(capabilityId).catch((err) => this.error(`Failed to remove capability ${capabilityId}:`, err.message));
      }
    }

    for (const light of this.trackedLights) {
      const sid = capabilityInstanceId(light.id);

      for (const base of LIGHT_CAPABILITY_BASES) {
        const capabilityId = `${base}.${sid}`;
        if (!this.hasCapability(capabilityId)) {
          await this.addCapability(capabilityId).catch((err) => this.error(`Failed to add capability ${capabilityId}:`, err.message));
        }
        const title = `${light.name}${LIGHT_CAPABILITY_TITLE_SUFFIX[base]}`;
        await this.setCapabilityOptions(capabilityId, { title }).catch(() => {});
      }

      await this._setCapabilitySafely(`light_min.${sid}`, light.min);
      await this._setCapabilitySafely(`light_max.${sid}`, light.max);

      this.registerCapabilityListener(`light_min.${sid}`, async (value) => this._onLightMinMaxChanged(light.id, 'min', value));
      this.registerCapabilityListener(`light_max.${sid}`, async (value) => this._onLightMinMaxChanged(light.id, 'max', value));
      this.registerCapabilityListener(`dim.${sid}`, async (value) => this._onLightDimChanged(light.id, value));
    }
  }

  async _onLightMinMaxChanged(lightId, field, percentValue) {
    const light = this.trackedLights.find((l) => l.id === lightId);
    if (!light) return;
    light[field] = Math.max(0, Math.min(100, Math.round(percentValue)));
    await this.setStoreValue('lights', this.trackedLights).catch((err) => this.error('Failed to persist light min/max change:', err.message));
  }

  async _onLightDimChanged(lightId, dimValue) {
    try {
      await this.homey.app.homeyApi.devices.setCapabilityValue({ deviceId: lightId, capabilityId: 'onoff', value: dimValue > 0 });
      await this.homey.app.homeyApi.devices.setCapabilityValue({ deviceId: lightId, capabilityId: 'dim', value: dimValue });
    } catch (err) {
      this.error(`Failed to manually set light ${lightId} to ${dimValue}:`, err.message);
    }
  }

  async _poll() {
    if (this.trackedLights.length === 0) {
      await this.setUnavailable('Ingen lys er valgt for denne soldimmeren').catch(() => {});
      return;
    }

    const lat = this.homey.geolocation.getLatitude();
    const lon = this.homey.geolocation.getLongitude();
    const now = this._now();

    const settings = this.getSettings();
    const transitionMs = Math.max(1, Number(settings.transitionMinutes) || DEFAULT_TRANSITION_MINUTES) * 60 * 1000;
    const sunsetOffsetMs = Math.max(0, Number(settings.sunsetOffsetMinutes) || 0) * 60 * 1000;
    const sunriseOffsetMs = Math.max(0, Number(settings.sunriseOffsetMinutes) || 0) * 60 * 1000;

    const sunsetEnabled = this.getCapabilityValue('onoff.sunset') !== false;
    const sunriseEnabled = this.getCapabilityValue('onoff.sunrise') !== false;

    const todaySun = suncalc.getTimes(now, lat, lon);
    const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
    const tomorrowSun = suncalc.getTimes(tomorrow, lat, lon);

    await this._updateNextTransitionTexts({
      now, todaySun, tomorrowSun, sunsetOffsetMs, sunriseOffsetMs, sunsetEnabled, sunriseEnabled,
    });

    // A manual "start now" trigger overrides the sun-clock schedule for the
    // duration of one transition, then falls back to it automatically.
    let overrideElapsedMs = null;
    if (this.manualOverride) {
      overrideElapsedMs = now.getTime() - this.manualOverride.startedAt.getTime();
      if (isOverrideFinished(overrideElapsedMs, transitionMs)) {
        this.manualOverride = null;
        overrideElapsedMs = null;
      }
    }

    const devices = await this.homey.app.homeyApi.devices.getDevices();
    let anyFound = false;

    for (const light of this.trackedLights) {
      const device = devices[light.id];
      const sid = capabilityInstanceId(light.id);
      if (!device) {
        this.log(`Tracked light ${light.name} (${light.id}) no longer exists - skipping this poll.`);
        continue;
      }
      anyFound = true;

      const targetPercent = this.manualOverride
        ? computeOverridePercent(this.manualOverride.direction, overrideElapsedMs, transitionMs, light.min, light.max)
        : computeScheduledPercent({
          now, sunrise: todaySun.sunrise, sunset: todaySun.sunset, transitionMs,
          sunriseEnabled, sunriseOffsetMs, sunsetEnabled, sunsetOffsetMs,
          min: light.min, max: light.max,
        });

      const targetDim = targetPercent / 100;
      const scheduleWantsOff = targetDim <= 0;

      const capabilities = device.capabilitiesObj || {};
      const currentOnoff = capabilities.onoff?.value;
      const currentDim = capabilities.dim?.value;
      const lightIsOn = currentOnoff === true;

      // Only lights that are already on get dimmed by the schedule - a
      // light someone switched off (everyone's away, or their own choice)
      // is left alone rather than being turned back on. A light that's on
      // and reaches a 0% target is still turned off, so the evening fade
      // can complete naturally.
      try {
        if (lightIsOn) {
          if (scheduleWantsOff) {
            await this.homey.app.homeyApi.devices.setCapabilityValue({
              deviceId: light.id, capabilityId: 'onoff', value: false,
            });
          } else if (typeof currentDim !== 'number' || Math.abs(currentDim - targetDim) > DIM_EPSILON) {
            await this.homey.app.homeyApi.devices.setCapabilityValue({
              deviceId: light.id, capabilityId: 'dim', value: targetDim, opts: { duration: POLL_INTERVAL_MS },
            });
          }
        }
      } catch (err) {
        this.error(`Failed to update light ${light.name} (${light.id}):`, err.message);
      }

      // The overview tiles reflect what's actually happening, not the
      // schedule's theoretical target - a light left off because it was
      // already off shows as 0, not whatever level the schedule would
      // otherwise be at.
      const effectiveDim = lightIsOn && !scheduleWantsOff ? targetDim : 0;
      await this._setCapabilitySafely(`dim.${sid}`, effectiveDim);
      await this._setCapabilitySafely(`light_level.${sid}`, Math.round(effectiveDim * 100));
    }

    if (!anyFound) {
      await this.setUnavailable('Ingen av de valgte lysene finnes lenger').catch(() => {});
      return;
    }

    await this.setAvailable().catch(() => {});
  }

  async _updateNextTransitionTexts({ now, todaySun, tomorrowSun, sunsetOffsetMs, sunriseOffsetMs, sunsetEnabled, sunriseEnabled }) {
    const nextSunsetStart = nextOccurrence(
      now,
      new Date(todaySun.sunset.getTime() - sunsetOffsetMs),
      new Date(tomorrowSun.sunset.getTime() - sunsetOffsetMs),
    );
    const nextSunriseStart = nextOccurrence(
      now,
      new Date(todaySun.sunrise.getTime() - sunriseOffsetMs),
      new Date(tomorrowSun.sunrise.getTime() - sunriseOffsetMs),
    );

    const sunsetText = sunsetEnabled ? formatRelative(nextSunsetStart.getTime() - now.getTime()) : 'Deaktivert';
    const sunriseText = sunriseEnabled ? formatRelative(nextSunriseStart.getTime() - now.getTime()) : 'Deaktivert';

    await this._setCapabilitySafely('next_sunset_text', sunsetText);
    await this._setCapabilitySafely('next_sunrise_text', sunriseText);
  }

  async _setCapabilitySafely(capabilityId, value) {
    if (value === undefined || value === null || Number.isNaN(value)) return;
    if (!this.hasCapability(capabilityId)) return;
    await this.setCapabilityValue(capabilityId, value).catch((err) => {
      this.error(`Failed to set ${capabilityId}:`, err.message);
    });
  }
}

module.exports = SunDimmerDevice;
