'use strict';

const Homey = require('homey');

const DEFAULT_TIME = '07:00';
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

class AlarmDevice extends Homey.Device {
  async onInit() {
    this.log('Wake alarm device initialized:', this.getName());

    if (!TIME_PATTERN.test(this.getCapabilityValue('alarm_time'))) {
      await this.setCapabilityValue('alarm_time', DEFAULT_TIME).catch(() => {});
    }

    this.registerCapabilityListener('onoff', (value) => this.setEnabled(value));
    this.registerCapabilityListener('alarm_time', (value) => this.setWakeTime(value));

    this._scheduleNext();
  }

  /** Single entry point for changing the wake time, used by both the "Set wake time" flow action and the widget. */
  async setWakeTime(value) {
    if (!TIME_PATTERN.test(value)) throw new Error('Ugyldig klokkeslett - bruk formatet TT:MM');
    await this.setCapabilityValue('alarm_time', value);
    this._scheduleNext();
  }

  /** Single entry point for enabling/disabling the alarm, used by both the onoff capability listener and the widget. */
  async setEnabled(value) {
    await this.setCapabilityValue('onoff', value);
    this._scheduleNext();
  }

  _nextOccurrence() {
    const [hours, minutes] = this.getCapabilityValue('alarm_time').split(':').map(Number);
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    return next;
  }

  _scheduleNext() {
    if (this._timer) this.homey.clearTimeout(this._timer);
    if (this.getCapabilityValue('onoff') === false) return;
    const ms = this._nextOccurrence().getTime() - Date.now();
    this._timer = this.homey.setTimeout(() => this._fire(), ms);
  }

  async _fire() {
    await this.homey.flow.getDeviceTriggerCard('wake_time_reached')
      .trigger(this)
      .catch((err) => this.error('Failed to trigger wake_time_reached:', err.message));
    // Re-arm for the same time tomorrow - a wake alarm repeats daily until disabled.
    this._scheduleNext();
  }

  async onDeleted() {
    if (this._timer) this.homey.clearTimeout(this._timer);
  }
}

module.exports = AlarmDevice;
