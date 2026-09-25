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

    this._buildClient();

    this.registerCapabilityListener('ventilation_mode', (value) => this.setMode(value));
    this.registerCapabilityListener('fan_speed', (value) => this.setFanSpeed(value));
    this.registerCapabilityListener('target_temperature', (value) => this._writeRegisterByKey('supply_air_setpoint', value));
    this.registerCapabilityListener('onoff.eco_mode', (value) => this._writeRegisterByKey('eco_mode', value ? 1 : 0));
    this.registerCapabilityListener('onoff.free_cooling', (value) => this._writeRegisterByKey('free_cooling_enable', value ? 1 : 0));

    await this._poll().catch((err) => this.error('Initial poll failed:', err.message));
    this._schedulePolling();
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

  _schedulePolling(settingsOverride) {
    if (this._pollTimer) this.homey.clearInterval(this._pollTimer);
    const settings = settingsOverride || this.getSettings();
    const requested = Number(settings.pollInterval) || DEFAULT_POLL_INTERVAL_S;
    const intervalS = Math.max(requested, MIN_POLL_INTERVAL_S);
    this._pollTimer = this.homey.setInterval(() => {
      this._poll().catch((err) => this.error('Poll failed:', err.message));
    }, intervalS * 1000);
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    const connectionKeys = ['host', 'port', 'slaveId', 'safeMode'];
    if (changedKeys.some((k) => connectionKeys.includes(k)) || changedKeys.includes('unitModel')) {
      if (this.client) await this.client.close().catch(() => {});
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
    if (this._pollTimer) this.homey.clearInterval(this._pollTimer);
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

  async _poll() {
    const { values, errors } = await this.client.readAll(REGISTERS);
    if (Object.keys(errors).length > 0) {
      this.log('Some registers failed to read this cycle:', Object.keys(errors).join(', '));
    }
    if (Object.keys(values).length === 0) {
      await this.setUnavailable('Could not reach the Systemair unit over Modbus').catch(() => {});
      return;
    }

    await this._setCapabilitySafely('measure_temperature.supply', values.supply_temperature);
    await this._setCapabilitySafely('measure_temperature.outdoor', values.outdoor_temperature);
    await this._setCapabilitySafely('measure_temperature.extract', values.extract_temperature);
    await this._setCapabilitySafely('measure_temperature.efficiency', values.efficiency_temperature);
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

    const seasonText = { 0: 'summer', 1: 'winter' }[values.summer_winter_operation];
    if (seasonText) await this._setCapabilitySafely('active_season', seasonText);

    if (typeof values.eco_mode === 'number') {
      await this._setCapabilitySafely('onoff.eco_mode', values.eco_mode === 1);
    }
    if (typeof values.free_cooling_enable === 'number') {
      await this._setCapabilitySafely('onoff.free_cooling', values.free_cooling_enable === 1);
    }

    await this._setAlarmSafely('alarm_generic.a_alarm', values.a_alarm);
    await this._setAlarmSafely('alarm_generic.b_alarm', values.b_alarm);
    await this._setAlarmSafely('alarm_generic.c_alarm', values.c_alarm);
    await this._setAlarmSafely('alarm_generic.filter_alarm', values.filter_alarm);
    await this._setAlarmSafely('alarm_generic.filter_warning', values.filter_warning_alarm);

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
  }

  async _setAlarmSafely(capabilityId, rawValue) {
    if (typeof rawValue !== 'number') return;
    await this._setCapabilitySafely(capabilityId, rawValue === 1);
  }
}

module.exports = SaveDevice;
