'use strict';

const Homey = require('homey');
const ModbusClient = require('../../lib/ModbusClient');
const {
  REGISTERS,
  ADDR_MODE_COMMAND,
  ADDR_MANUAL_SPEED_COMMAND,
  ADDR_FILTER_REPLACEMENT_TIME_L,
  ADDR_FILTER_REPLACEMENT_TIME_H,
  COMMAND_MODE_OPTIONS,
  STATUS_MODE_TO_KEY,
  MANUAL_SPEED_OPTIONS,
  UNIT_MODEL_QV_MAX,
} = require('../../lib/SystemairRegisters');

const DEFAULT_POLL_INTERVAL_S = 10;
const MIN_POLL_INTERVAL_S = 5;
const DEFAULT_TEMPERATURE_REPORT_INTERVAL_S = 60;
// Generous ceiling for one full ~98-register cycle (well above the ~10-15s
// a healthy poll takes) - a last-resort backstop for a read that hangs
// completely rather than failing cleanly (ModbusClient's own per-register
// retry/backoff already handles ordinary failures and never itself blocks
// forever). Without this, a single truly-stuck read would leave _poll()
// permanently unresolved, and since polling is now deliberately serialized
// (the next poll only gets scheduled once the current one finishes - see
// _schedulePolling), that one stuck read would silently halt updates
// forever instead of just failing that one cycle.
const POLL_TIMEOUT_MS = 45000;

// Capability migrations for devices paired with an older version of this
// app: Homey only grants a device the capabilities its driver declared at
// pairing time, so newly added/renamed capabilities need to be applied
// explicitly here rather than just added to app.json.
const CAPABILITIES_TO_ADD = ['measure_temperature', 'ventilation_mode_text', 'fan_speed_text'];
const CAPABILITIES_TO_REMOVE = [
  'mode_status_text',
  'active_season',
  'alarm_generic.a_alarm',
  'alarm_generic.b_alarm',
  'alarm_generic.c_alarm',
  'alarm_generic.filter_alarm',
  'alarm_generic.filter_warning',
];

const MANUAL_SPEED_OPTIONS_INV = Object.fromEntries(
  Object.entries(MANUAL_SPEED_OPTIONS).map(([label, value]) => [value, label]),
);

// Settings-mirrored registers: written to the unit on save, and kept in
// sync with the live device via setSettings() after each poll so the
// settings page always shows the actual current value, not a stale default.
const SETTINGS_REGISTER_MAP = {
  holidayDurationDays: 'holiday_mode_duration',
  awayDurationHours: 'away_mode_duration',
  partyDurationHours: 'crowded_mode_duration',
  refreshDurationMinutes: 'refresh_mode_duration',
  ecoHeatOffset: 'eco_heat_offset',
  filterIntervalMonths: 'filter_replacement_period',
  freeCoolingDayMinTemp: 'free_cooling_daytime_min_temp',
  freeCoolingNightHighLimit: 'free_cooling_night_high_limit',
  freeCoolingNightLowLimit: 'free_cooling_night_low_limit',
  freeCoolingRoomCancelTemp: 'free_cooling_room_cancel_temp',
  freeCoolingStartHour: 'free_cooling_start_time_h',
  freeCoolingStartMinute: 'free_cooling_start_time_m',
  freeCoolingEndHour: 'free_cooling_end_time_h',
  freeCoolingEndMinute: 'free_cooling_end_time_m',
};

class SaveDevice extends Homey.Device {
  async onInit() {
    this.log('Systemair SAVE device initialized:', this.getName());

    // Everything up to and including building the Modbus client must
    // succeed before polling makes sense - if any of it throws (a bad
    // setting, a construction error), surface it the same way a poll
    // failure is surfaced, rather than leaving the device silently stuck
    // at its default capability values with no visible error anywhere.
    try {
      await this._migrateCapabilities();
      this._buildClient();

      this.registerCapabilityListener('ventilation_mode', (value) => this.setMode(value));
      this.registerCapabilityListener('fan_speed', (value) => this.setFanSpeed(value));
      this.registerCapabilityListener('target_temperature', (value) => this._writeRegisterByKey('supply_air_setpoint', value));
      this.registerCapabilityListener('onoff.eco_mode', (value) => this._writeRegisterByKey('eco_mode', value ? 1 : 0));
      this.registerCapabilityListener('onoff.free_cooling', (value) => this._writeRegisterByKey('free_cooling_enable', value ? 1 : 0));
    } catch (err) {
      this._reportPollError('Device initialization failed', err);
      return;
    }

    await this._poll().catch((err) => this._reportPollError('Initial poll failed', err));
    this._schedulePolling();
  }

  /**
   * Surfaces a poll failure directly on the device page (a small warning
   * banner with the actual error text), not just in the app's own console
   * log - which needs the Homey CLI or developer.homey.app to see, and
   * developer.homey.app's "My Apps" only lists apps published under your
   * own developer account, not ones installed from a sideloaded .zip.
   */
  _reportPollError(context, err) {
    this.error(`${context}:`, err.message);
    this.setWarning(err.message).catch(() => {});
  }

  async _migrateCapabilities() {
    for (const cap of CAPABILITIES_TO_ADD) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap).catch((err) => this.error(`Failed to add capability ${cap}:`, err.message));
      }
    }
    for (const cap of CAPABILITIES_TO_REMOVE) {
      if (this.hasCapability(cap)) {
        await this.removeCapability(cap).catch((err) => this.error(`Failed to remove capability ${cap}:`, err.message));
      }
    }
  }

  _buildClient() {
    const settings = this.getSettings();
    this.qvMax = UNIT_MODEL_QV_MAX[settings.unitModel] || null;
    this.client = new ModbusClient({
      host: settings.host,
      port: Number(settings.port) || 502,
      slaveId: Number(settings.slaveId) || 1,
      safeMode: settings.safeMode !== false,
    });
  }

  /**
   * Self-scheduling (setTimeout, not setInterval) so the next poll is only
   * ever queued once the previous one has fully finished - reading all ~98
   * registers one at a time (100ms pacing each) already takes close to the
   * default 10s interval under perfectly healthy conditions, and any real
   * network latency or a retry/backoff cycle pushes a single poll well past
   * it. A plain setInterval would then fire the next poll while the last one
   * was still mid-flight, and since both share the one Modbus TCP connection
   * (modbus-serial only supports a single request in flight), the two polls'
   * requests and responses get interleaved on the wire - which this app has
   * no way to detect as an error (each read just silently returns the wrong
   * register's data, or hangs waiting for a response that was already
   * consumed by the other poll). That's indistinguishable from "stopped
   * updating" from the device page, since it isn't a clean, catchable
   * failure the way a real disconnect is.
   *
   * Only ever updates the shared _pollIntervalMs and, if nothing is
   * currently mid-poll, (re)arms the timer. If a poll IS in flight (e.g.
   * this was called from onSettings while a slow poll is still running),
   * it deliberately does NOT start a second timer - _runPollAndReschedule's
   * own completion handler will pick up the freshly updated interval and
   * schedule from there once that poll actually finishes. Without this,
   * a settings save mid-poll would start a second, overlapping poll the
   * same way the old setInterval bug did.
   */
  _schedulePolling(settingsOverride) {
    const settings = settingsOverride || this.getSettings();
    const requested = Number(settings.pollInterval) || DEFAULT_POLL_INTERVAL_S;
    this._pollIntervalMs = Math.max(requested, MIN_POLL_INTERVAL_S) * 1000;

    if (this._pollInFlight) return;

    if (this._pollTimer) this.homey.clearTimeout(this._pollTimer);
    this._pollTimer = this.homey.setTimeout(() => this._runPollAndReschedule(), this._pollIntervalMs);
  }

  _runPollAndReschedule() {
    this._pollInFlight = true;
    this._poll()
      .catch((err) => this._reportPollError('Poll failed', err))
      .finally(() => {
        this._pollInFlight = false;
        if (this._pollStopped) return; // the device was deleted while this poll was in flight
        this._pollTimer = this.homey.setTimeout(() => this._runPollAndReschedule(), this._pollIntervalMs);
      });
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    const connectionKeys = ['host', 'port', 'slaveId', 'safeMode'];
    if (changedKeys.some((k) => connectionKeys.includes(k)) || changedKeys.includes('unitModel')) {
      // Tear down the old connection in the background - a settings save
      // must never block on network teardown, no matter how the old socket
      // behaves. ModbusClient.close() already avoids modbus-serial's own
      // hang-prone close()/end(), but there's no reason to gate this on it.
      if (this.client) this.client.close().catch(() => {});
      this._buildClient();
    }

    if (changedKeys.includes('pollInterval')) {
      // onSettings runs before the new values are persisted, so schedule
      // against a merged view rather than the stale this.getSettings().
      this._schedulePolling({ ...oldSettings, ...newSettings });
    }

    for (const settingKey of Object.keys(SETTINGS_REGISTER_MAP)) {
      if (changedKeys.includes(settingKey)) {
        const registerKey = SETTINGS_REGISTER_MAP[settingKey];
        await this._writeRegisterByKey(registerKey, Number(newSettings[settingKey]))
          .catch((err) => this.error(`Failed to write ${settingKey} (${registerKey}):`, err.message));
      }
    }
  }

  async onDeleted() {
    this._pollStopped = true; // stop any in-flight poll's completion handler from rescheduling
    if (this._pollTimer) this.homey.clearTimeout(this._pollTimer);
    if (this.client) await this.client.close().catch(() => {});
  }

  async _writeRegisterByKey(key, value) {
    const def = REGISTERS[key];
    if (!def) throw new Error(`Unknown register key: ${key}`);
    await this.client.writeRegister(def, value);
  }

  /**
   * Single entry point for changing mode, used by both the ventilation_mode
   * capability listener and the "Set mode" flow action.
   */
  async setMode(mode) {
    const raw = COMMAND_MODE_OPTIONS[mode];
    if (raw === undefined) throw new Error(`Unsupported mode: ${mode}`);
    await this.client.writeRawAddress(ADDR_MODE_COMMAND, raw);
  }

  /**
   * Single entry point for changing fan speed, used by both the fan_speed
   * capability listener and the "Set fan speed" flow action. Mirrors the
   * reference Home Assistant integration's button behaviour: switching to
   * a manual speed forces Manual mode first, and Stop falls back to Low
   * when the unit doesn't allow a manual stop (fan_manual_stop_allowed_register).
   */
  async setFanSpeed(speed) {
    if (speed === 'stop') {
      const allowedRaw = await this.client.readRegister(REGISTERS.fan_manual_stop_allowed_register).catch(() => 0);
      await this.client.writeRawAddress(ADDR_MODE_COMMAND, COMMAND_MODE_OPTIONS.manual);
      if (allowedRaw === 1) {
        await this.client.writeRawAddress(ADDR_MANUAL_SPEED_COMMAND, MANUAL_SPEED_OPTIONS.stop);
      } else {
        this.log('Manual stop not allowed by the unit - falling back to Low speed.');
        await this.client.writeRawAddress(ADDR_MANUAL_SPEED_COMMAND, MANUAL_SPEED_OPTIONS.low);
        await this._setCapabilitySafely('fan_speed', 'low');
        return;
      }
      return;
    }

    const raw = MANUAL_SPEED_OPTIONS[speed];
    if (raw === undefined) throw new Error(`Unsupported fan speed: ${speed}`);
    await this.client.writeRawAddress(ADDR_MODE_COMMAND, COMMAND_MODE_OPTIONS.manual);
    await this.client.writeRawAddress(ADDR_MANUAL_SPEED_COMMAND, raw);
  }

  /** Resets the filter replacement timer, as if the physical "filter replaced" button was pressed. */
  async resetFilterTimer() {
    await this.client.writeRawAddress(ADDR_FILTER_REPLACEMENT_TIME_L, 0);
    await this.client.writeRawAddress(ADDR_FILTER_REPLACEMENT_TIME_H, 0);
  }

  async _setCapabilitySafely(capabilityId, value) {
    if (value === undefined || value === null || Number.isNaN(value)) return;
    if (!this.hasCapability(capabilityId)) return;
    await this.setCapabilityValue(capabilityId, value).catch((err) => {
      this.error(`Failed to set ${capabilityId}:`, err.message);
    });
  }

  /** Races a promise against a hard deadline - rejects if `promise` hasn't settled by then, without waiting on it further. */
  _withTimeout(promise, ms, message) {
    return new Promise((resolve, reject) => {
      const timer = this.homey.setTimeout(() => reject(new Error(message)), ms);
      promise.then(
        (value) => { this.homey.clearTimeout(timer); resolve(value); },
        (err) => { this.homey.clearTimeout(timer); reject(err); },
      );
    });
  }

  async _poll() {
    let values;
    let errors;
    try {
      ({ values, errors } = await this._withTimeout(this.client.readAll(REGISTERS), POLL_TIMEOUT_MS, `Poll timed out after ${POLL_TIMEOUT_MS / 1000}s`));
    } catch (err) {
      // Whether this was our own watchdog firing or something else, force
      // the connection closed so the *next* poll opens a fresh socket
      // instead of risking reuse of one left in a wedged state.
      await this.client.close().catch(() => {});
      throw err;
    }
    if (Object.keys(errors).length > 0) {
      this.log('Some registers failed to read this cycle:', Object.keys(errors).join(', '));
    }
    // Named explicitly (not just logged) so a stuck/misbehaving device can be
    // diagnosed from the device page alone - e.g. confirming which slave ID
    // is actually being queried, without needing the Homey CLI or
    // developer.homey.app (whose "My Apps" only lists apps published under
    // your own account, not sideloaded ones).
    const target = `${this.client.host}:${this.client.port} (slave ID ${this.client.slaveId})`;
    if (Object.keys(values).length === 0) {
      const firstError = Object.values(errors)[0];
      const reason = firstError
        ? `Could not reach the Systemair unit at ${target} over Modbus: ${firstError}`
        : `Could not reach the Systemair unit at ${target} over Modbus`;
      await this.setUnavailable(reason).catch(() => {});
      return;
    }

    // A running unit never reports every single numeric register as exactly
    // 0 - supply/extract temperature and fan RPM in particular are never
    // all zero at once. Seeing that, with no read errors at all, usually
    // means a Modbus TCP-RTU/RS485 gateway accepted the request but answered
    // with placeholder zeros for the wrong slave/unit ID rather than a
    // genuine "illegal address" error - a silent failure this app can't
    // otherwise tell apart from real data, so it's called out explicitly.
    // Reported live: this specific gateway can also do it transiently,
    // right after a fresh reconnect - real values for a while, then a burst
    // of all-zero cycles a couple of minutes later. So this cycle's values
    // are discarded rather than written over the last known-good ones (which
    // would otherwise flash "0°C / stop / auto" across the whole device for
    // no real reason), and the connection is force-closed so the next poll
    // reconnects from scratch instead of continuing to hammer whatever
    // confused the gateway into this state.
    const numericValues = Object.values(values).filter((v) => typeof v === 'number');
    const allZero = numericValues.length > 0 && numericValues.every((v) => v === 0);
    if (allZero) {
      this.setWarning(
        `Connected to ${target}, but every register read back as 0. Double-check the Modbus slave ID `
        + '(the IAM/SAVE Connect module\'s own settings page shows the correct one) or that the unit is powered on.',
      ).catch(() => {});
      await this.client.close().catch(() => {});
      // Still "available" - the gateway did respond, just with data that
      // isn't trustworthy this cycle (see the comment above). setAvailable()
      // is called explicitly here since the early return below skips the
      // one at the very end of a normal poll.
      await this.setAvailable().catch(() => {});
      return;
    }

    // Temperatures change slowly, so they're pushed on their own, usually
    // slower cadence (temperatureReportIntervalS) rather than every poll -
    // separate from the Modbus read rate, to keep Insights/flows from being
    // spammed with near-identical readings.
    const settings = this.getSettings();
    const reportIntervalS = Math.max(Number(settings.temperatureReportIntervalS) || DEFAULT_TEMPERATURE_REPORT_INTERVAL_S, MIN_POLL_INTERVAL_S);
    const now = Date.now();
    if (!this._lastTemperatureReportAt || (now - this._lastTemperatureReportAt) >= reportIntervalS * 1000) {
      await this._setCapabilitySafely('measure_temperature', values.supply_temperature);
      await this._setCapabilitySafely('measure_temperature.supply', values.supply_temperature);
      await this._setCapabilitySafely('measure_temperature.outdoor', values.outdoor_temperature);
      await this._setCapabilitySafely('measure_temperature.extract', values.extract_temperature);
      await this._setCapabilitySafely('measure_temperature.efficiency', values.efficiency_temperature);
      this._lastTemperatureReportAt = now;
    }
    await this._setCapabilitySafely('measure_humidity', values.relative_moisture_extraction);
    await this._setCapabilitySafely('target_temperature', values.supply_air_setpoint);
    await this._setCapabilitySafely('fan_speed_supply_rpm', values.saf_speed_rpm);
    await this._setCapabilitySafely('fan_speed_extract_rpm', values.eaf_speed_rpm);
    await this._setCapabilitySafely('heat_recovery', values.heat_recovery);

    if (typeof values.supply_air_fan_pwr_fact === 'number') {
      const flowFactor = this.qvMax ? this.qvMax / 100 : 3.0;
      await this._setCapabilitySafely('airflow_supply_estimated', Math.round(values.supply_air_fan_pwr_fact * flowFactor));
    }
    if (typeof values.extractor_fan_pwr_fact === 'number') {
      const flowFactor = this.qvMax ? this.qvMax / 100 : 3.0;
      await this._setCapabilitySafely('airflow_extract_estimated', Math.round(values.extractor_fan_pwr_fact * flowFactor));
    }

    if (typeof values.time_to_filter_replacement === 'number') {
      await this._setCapabilitySafely('filter_days_remaining', Math.round(values.time_to_filter_replacement / 86400));
    }

    const iaqText = { 0: 'economy', 1: 'good', 2: 'improve' }[values.iaq_level];
    if (iaqText) await this._setCapabilitySafely('iaq_level_text', iaqText);

    if (typeof values.eco_mode === 'number') {
      await this._setCapabilitySafely('onoff.eco_mode', values.eco_mode === 1);
    }
    if (typeof values.free_cooling_enable === 'number') {
      await this._setCapabilitySafely('onoff.free_cooling', values.free_cooling_enable === 1);
    }

    // fan_speed: reverse-lookup the current manual speed command register.
    const fanSpeedLabel = MANUAL_SPEED_OPTIONS_INV[values.manual_mode_command_register];
    if (fanSpeedLabel) await this._setCapabilitySafely('fan_speed', fanSpeedLabel);

    // ventilation_mode: only the 7 command-style states are valid for our
    // enum capability - automatic overrides (cooker hood, CDI, pressure
    // guard) aren't in it, so we leave the capability untouched for those.
    const modeLabel = STATUS_MODE_TO_KEY[values.mode_status_register];
    if (modeLabel && COMMAND_MODE_OPTIONS[modeLabel] !== undefined) {
      const previousMode = this.getCapabilityValue('ventilation_mode');
      await this._setCapabilitySafely('ventilation_mode', modeLabel);
      if (previousMode && previousMode !== modeLabel) {
        await this.homey.flow.getDeviceTriggerCard('mode_changed')
          .trigger(this, { mode: modeLabel })
          .catch((err) => this.error('Failed to trigger mode_changed:', err.message));
      }
    }

    // ventilation_mode_text / fan_speed_text: plain-text readouts, always
    // visible among the sensor tiles (unlike the setable ventilation_mode/
    // fan_speed pickers, which Homey surfaces as controls rather than
    // tiles). ventilation_mode_text covers all 13 status codes, including
    // the automatic overrides the enum capability can't represent.
    if (modeLabel) await this._setCapabilitySafely('ventilation_mode_text', modeLabel);
    if (fanSpeedLabel) await this._setCapabilitySafely('fan_speed_text', fanSpeedLabel);

    // Mirror the settings-page fields with live values so they don't show stale defaults.
    const settingsPatch = {};
    for (const [settingKey, registerKey] of Object.entries(SETTINGS_REGISTER_MAP)) {
      if (typeof values[registerKey] === 'number') {
        settingsPatch[settingKey] = values[registerKey];
      }
    }
    if (Object.keys(settingsPatch).length > 0) {
      await this.setSettings(settingsPatch).catch((err) => this.error('Failed to sync settings:', err.message));
    }

    await this.setAvailable().catch(() => {});
    if (!allZero) await this.unsetWarning().catch(() => {});
  }
}

module.exports = SaveDevice;
