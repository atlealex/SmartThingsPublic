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

  /** Exposes the actually-scheduled next fire time, so the widget can show it directly - visible proof the alarm is armed for what the display says, without needing app console access. */
  getNextOccurrenceIso() {
    if (this.getCapabilityValue('onoff') === false) return null;
    return this._nextOccurrence().toISOString();
  }

  /**
   * How far Homey's configured timezone is ahead of UTC, in ms, at `at`.
   * Homey Pro's own OS clock runs UTC regardless of the timezone configured
   * in the app - plain `new Date(y, m, d, h, min)` uses the OS's (UTC)
   * interpretation of those numbers, silently scheduling against the wrong
   * wall-clock time whenever the configured timezone isn't UTC (e.g. 2h off
   * for Oslo in summer). `homey.clock.getTimezone()` is Homey's own source
   * of truth for what "wall clock" actually means here.
   */
  _timezoneOffsetMs(timeZone, at) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(at);
    const get = (type) => Number(parts.find((p) => p.type === type).value);
    const asUtc = Date.UTC(
      get('year'), get('month') - 1, get('day'),
      get('hour') === 24 ? 0 : get('hour'), get('minute'), get('second'),
    );
    return asUtc - at.getTime();
  }

  _nextOccurrence() {
    const [hours, minutes] = this.getCapabilityValue('alarm_time').split(':').map(Number);
    const now = new Date();

    let timeZone;
    try {
      timeZone = this.homey.clock.getTimezone();
    } catch (err) {
      timeZone = undefined;
    }
    if (!timeZone) {
      // No configured timezone available - fall back to the OS clock's own interpretation.
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0);
      if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
      return next;
    }

    const offsetMs = this._timezoneOffsetMs(timeZone, now);
    const dateParts = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now);
    const get = (type) => Number(dateParts.find((p) => p.type === type).value);

    let candidate = Date.UTC(get('year'), get('month') - 1, get('day'), hours, minutes, 0) - offsetMs;
    if (candidate <= now.getTime()) {
      candidate = Date.UTC(get('year'), get('month') - 1, get('day') + 1, hours, minutes, 0) - offsetMs;
    }
    return new Date(candidate);
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
