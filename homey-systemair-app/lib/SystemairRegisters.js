'use strict';

/**
 * Systemair SAVE Modbus register map, ported directly from the real,
 * working Home Assistant integration this mirrors:
 * https://github.com/Howard0000/home-assistant-systemair-modbus
 * (custom_components/systemair_modbus/models/save.py)
 *
 * All addresses are Modbus CLIENT offsets (PDF register number - 1),
 * matching that source exactly - not re-derived from Systemair's own PDF,
 * to avoid introducing an off-by-one error.
 */

// key -> { address, inputType: 'holding'|'input', dataType: 'int16'|'uint16'|'uint32', scale, unit }
const REGISTERS = {
  // --- Auto / demand-control diagnostics ---
  demand_supply_fan_speed: { address: 1002, inputType: 'input', dataType: 'uint16' },
  demand_active_controller: { address: 1003, inputType: 'input', dataType: 'uint16' },
  demand_extract_fan_speed: { address: 1006, inputType: 'input', dataType: 'uint16' },
  demand_control_enabled: { address: 1060, inputType: 'input', dataType: 'uint16' },
  auto_mode_source: { address: 1061, inputType: 'input', dataType: 'uint16' },

  // --- Modes and time settings ---
  summer_winter_operation: { address: 1038, inputType: 'input', dataType: 'uint16' },
  holiday_mode_duration: { address: 1100, inputType: 'holding', dataType: 'uint16', unit: 'days' },
  away_mode_duration: { address: 1101, inputType: 'holding', dataType: 'uint16', unit: 'h' },
  fireplace_mode_duration: { address: 1102, inputType: 'holding', dataType: 'uint16', unit: 'min' },
  refresh_mode_duration: { address: 1103, inputType: 'holding', dataType: 'uint16', unit: 'min' },
  crowded_mode_duration: { address: 1104, inputType: 'holding', dataType: 'uint16', unit: 'h' },
  countdown_mode_time: { address: 1110, inputType: 'input', dataType: 'uint32', unit: 's' },

  // --- System status ---
  iaq_level: { address: 1122, inputType: 'input', dataType: 'uint16' },
  manual_mode_command_register: { address: 1130, inputType: 'holding', dataType: 'uint16' },
  mode_status_register: { address: 1160, inputType: 'input', dataType: 'uint16' },
  mode_command_register: { address: 1161, inputType: 'holding', dataType: 'uint16' },

  // --- CDI speeds ---
  saf_speed_holiday: { address: 1220, inputType: 'input', dataType: 'uint16', unit: 'rpm' },
  eaf_speed_holiday: { address: 1221, inputType: 'input', dataType: 'uint16', unit: 'rpm' },
  saf_speed_cooker_hood: { address: 1222, inputType: 'input', dataType: 'uint16', unit: 'rpm' },
  eaf_speed_cooker_hood: { address: 1223, inputType: 'input', dataType: 'uint16', unit: 'rpm' },
  saf_speed_vacuumcleaner: { address: 1224, inputType: 'input', dataType: 'uint16', unit: 'rpm' },
  eaf_speed_vacuumcleaner: { address: 1225, inputType: 'input', dataType: 'uint16', unit: 'rpm' },

  // --- Outdoor compensation ---
  fan_speed_comp_winter: { address: 1251, inputType: 'holding', dataType: 'uint16', unit: '%' },
  fan_speed_comp_checked: { address: 1252, inputType: 'holding', dataType: 'int16', scale: 0.1, unit: '°C' },
  fan_speed_comp_winter_max_temp: { address: 1253, inputType: 'holding', dataType: 'int16', scale: 0.1, unit: '°C' },
  fan_speed_comp_read: { address: 1254, inputType: 'input', dataType: 'uint16', unit: '%' },
  fan_speed_comp_winter_start_temp: { address: 1255, inputType: 'holding', dataType: 'int16', scale: 0.1, unit: '°C' },
  fan_speed_comp_summer_start_temp: { address: 1256, inputType: 'holding', dataType: 'int16', scale: 0.1, unit: '°C' },
  fan_speed_comp_max_temp: { address: 1257, inputType: 'holding', dataType: 'int16', scale: 0.1, unit: '°C' },
  fan_speed_comp_summer: { address: 1258, inputType: 'holding', dataType: 'uint16', unit: '%' },

  // --- Fan level status ---
  saf_speed_low_status: { address: 1302, inputType: 'input', dataType: 'uint16', unit: 'rpm' },
  eaf_speed_low_status: { address: 1303, inputType: 'input', dataType: 'uint16', unit: 'rpm' },

  // --- Permissions ---
  fan_manual_stop_allowed_register: { address: 1352, inputType: 'holding', dataType: 'uint16' },

  // --- Fan limits (RPM) ---
  saf_speed_minimum_rpm: { address: 1410, inputType: 'holding', dataType: 'uint16', unit: 'rpm' },
  eaf_speed_minimum_rpm: { address: 1411, inputType: 'holding', dataType: 'uint16', unit: 'rpm' },
  saf_speed_low_rpm: { address: 1412, inputType: 'holding', dataType: 'uint16', unit: 'rpm' },
  eaf_speed_low_rpm: { address: 1413, inputType: 'holding', dataType: 'uint16', unit: 'rpm' },
  saf_speed_normal: { address: 1414, inputType: 'holding', dataType: 'uint16', unit: 'rpm' },
  eaf_speed_normal: { address: 1415, inputType: 'holding', dataType: 'uint16', unit: 'rpm' },
  saf_speed_high: { address: 1416, inputType: 'holding', dataType: 'uint16', unit: 'rpm' },
  eaf_speed_high: { address: 1417, inputType: 'holding', dataType: 'uint16', unit: 'rpm' },
  saf_speed_maximum: { address: 1418, inputType: 'holding', dataType: 'uint16', unit: 'rpm' },
  eaf_speed_maximum: { address: 1419, inputType: 'holding', dataType: 'uint16', unit: 'rpm' },

  // --- Temperature settings ---
  supply_air_setpoint: { address: 2000, inputType: 'holding', dataType: 'uint16', scale: 0.1, unit: '°C' },
  exhaust_air_sp: { address: 2012, inputType: 'holding', dataType: 'uint16', scale: 0.1, unit: '°C' },
  exhaust_air_min_sp: { address: 2020, inputType: 'holding', dataType: 'uint16', scale: 0.1, unit: '°C' },
  exhaust_air_max_sp: { address: 2021, inputType: 'holding', dataType: 'uint16', scale: 0.1, unit: '°C' },
  supply_air_room_exhaust_reg: { address: 2030, inputType: 'holding', dataType: 'uint16' },

  // --- Heating and humidity ---
  heater_from_satc: { address: 2113, inputType: 'input', dataType: 'uint16', unit: '%' },
  triac_after_manual_override: { address: 2148, inputType: 'input', dataType: 'uint16', unit: '%' },
  heating_active: { address: 3102, inputType: 'input', dataType: 'uint16' },
  moisture_extraction_sp: { address: 2202, inputType: 'holding', dataType: 'uint16', unit: '%' },
  calculated_moisture_extraction: { address: 2210, inputType: 'holding', dataType: 'uint16', unit: '%' },
  calculated_moisture_intake: { address: 2211, inputType: 'holding', dataType: 'uint16', unit: '%' },

  // --- Eco ---
  eco_heat_offset: { address: 2503, inputType: 'holding', dataType: 'uint16', scale: 0.1, unit: '°C' },
  eco_mode: { address: 2504, inputType: 'holding', dataType: 'uint16' },
  eco_function_active: { address: 2505, inputType: 'input', dataType: 'uint16' },
  eco_mode_active: { address: 2520, inputType: 'input', dataType: 'uint16' },

  // --- Free cooling ---
  free_cooling_enable: { address: 4100, inputType: 'holding', dataType: 'uint16' },
  free_cooling_daytime_min_temp: { address: 4101, inputType: 'holding', dataType: 'int16', scale: 0.1, unit: '°C' },
  free_cooling_night_high_limit: { address: 4102, inputType: 'holding', dataType: 'int16', scale: 0.1, unit: '°C' },
  free_cooling_night_low_limit: { address: 4103, inputType: 'holding', dataType: 'int16', scale: 0.1, unit: '°C' },
  free_cooling_room_cancel_temp: { address: 4104, inputType: 'holding', dataType: 'int16', scale: 0.1, unit: '°C' },
  free_cooling_start_time_h: { address: 4105, inputType: 'holding', dataType: 'uint16' },
  free_cooling_start_time_m: { address: 4106, inputType: 'holding', dataType: 'uint16' },
  free_cooling_end_time_h: { address: 4107, inputType: 'holding', dataType: 'uint16' },
  free_cooling_end_time_m: { address: 4108, inputType: 'holding', dataType: 'uint16' },
  free_cooling_function_active: { address: 3101, inputType: 'input', dataType: 'uint16' },
  free_cooling_active: { address: 4110, inputType: 'input', dataType: 'uint16' },
  free_cooling_min_speed_saf: { address: 4111, inputType: 'holding', dataType: 'uint16' },
  free_cooling_min_speed_eaf: { address: 4112, inputType: 'holding', dataType: 'uint16' },
  free_cooling_state: { address: 4113, inputType: 'input', dataType: 'uint16' },
  free_cooling_heater_block_counter: { address: 4118, inputType: 'input', dataType: 'uint16', unit: 's' },
  free_cooling_reliable_temperatures: { address: 4119, inputType: 'input', dataType: 'uint16' },

  // --- Filter ---
  filter_replacement_period: { address: 7000, inputType: 'holding', dataType: 'uint16', unit: 'months' },
  time_to_filter_replacement: { address: 7004, inputType: 'input', dataType: 'uint32', unit: 's' },
  filter_replacement_time: { address: 7001, inputType: 'input', dataType: 'uint32', unit: 's' },

  // --- Sensors ---
  digital_ui_1: { address: 12020, inputType: 'input', dataType: 'uint16' },
  outdoor_temperature: { address: 12101, inputType: 'input', dataType: 'int16', scale: 0.1, unit: '°C' },
  supply_temperature: { address: 12102, inputType: 'input', dataType: 'int16', scale: 0.1, unit: '°C' },
  efficiency_temperature: { address: 12106, inputType: 'input', dataType: 'int16', scale: 0.1, unit: '°C' },
  overheat_temperature: { address: 12107, inputType: 'input', dataType: 'int16', scale: 0.1, unit: '°C' },
  relative_moisture_extraction: { address: 12135, inputType: 'input', dataType: 'uint16', unit: '%' },
  saf_speed_rpm: { address: 12400, inputType: 'input', dataType: 'uint16', unit: 'rpm' },
  eaf_speed_rpm: { address: 12401, inputType: 'input', dataType: 'uint16', unit: 'rpm' },
  extract_temperature: { address: 12543, inputType: 'input', dataType: 'int16', scale: 0.1, unit: '°C' },

  // --- Outputs and alarms ---
  supply_air_fan_pwr_fact: { address: 14000, inputType: 'input', dataType: 'uint16', unit: '%' },
  extractor_fan_pwr_fact: { address: 14001, inputType: 'input', dataType: 'uint16', unit: '%' },
  heater_y1_analog_output: { address: 14100, inputType: 'input', dataType: 'uint16', unit: '%' },
  heat_recovery: { address: 14102, inputType: 'input', dataType: 'uint16', unit: '%' },
  triac_control_signal: { address: 14380, inputType: 'input', dataType: 'uint16' },
  filter_alarm: { address: 15141, inputType: 'input', dataType: 'uint16' },
  supply_air_temp_low_alarm: { address: 15176, inputType: 'input', dataType: 'uint16' },
  filter_warning_alarm: { address: 15543, inputType: 'input', dataType: 'uint16' },
  filter_warning_alarm_delay_counter: { address: 15548, inputType: 'input', dataType: 'uint16' },
  a_alarm: { address: 15900, inputType: 'input', dataType: 'uint16' },
  b_alarm: { address: 15901, inputType: 'input', dataType: 'uint16' },
  c_alarm: { address: 15902, inputType: 'input', dataType: 'uint16' },
};

// Standalone single-register addresses referenced directly by name (mode/speed commands, filter reset).
const ADDR_MODE_STATUS = 1160;
const ADDR_MODE_COMMAND = 1161;
const ADDR_MANUAL_SPEED_COMMAND = 1130;
const ADDR_FILTER_REPLACEMENT_TIME_L = 7001;
const ADDR_FILTER_REPLACEMENT_TIME_H = 7002;

const COMMAND_MODE_OPTIONS = {
  auto: 1,
  manual: 2,
  party: 3,
  boost: 4,
  fireplace: 5,
  away: 6,
  holiday: 7,
};

const STATUS_MODE_TO_KEY = {
  0: 'auto',
  1: 'manual',
  2: 'party',
  3: 'boost',
  4: 'fireplace',
  5: 'away',
  6: 'holiday',
  7: 'cooker_hood',
  8: 'vacuum_cleaner',
  9: 'cdi1',
  10: 'cdi2',
  11: 'cdi3',
  12: 'pressure_guard',
};

const MANUAL_SPEED_OPTIONS = {
  stop: 0,
  low: 2,
  normal: 3,
  high: 4,
};

const FREE_COOLING_MIN_SPEED_OPTIONS = {
  normal: 3,
  high: 4,
  maximum: 5,
};

// Nominal max air flow (qv_max, m³/h) per unit model - used only for the
// *estimated* air flow rate derived sensors (fan % * qv_max / 100).
const UNIT_MODEL_QV_MAX = {
  'VSR 150/B': 169,
  'VSR 200/B': 284,
  'VSR 300': 368,
  'VSR 400': 615,
  'VSR 500': 609,
  'VSR 700': 870,
  'VTR 100/B': 150,
  'VTR 150/B': 268,
  'VTR 250/B': 307,
  'VTR 275/B': 316,
  'VTR 300': 368,
  'VTR 350/B': 504,
  'VTR 500': 572,
  'VTR 700': 951,
};

module.exports = {
  REGISTERS,
  ADDR_MODE_STATUS,
  ADDR_MODE_COMMAND,
  ADDR_MANUAL_SPEED_COMMAND,
  ADDR_FILTER_REPLACEMENT_TIME_L,
  ADDR_FILTER_REPLACEMENT_TIME_H,
  COMMAND_MODE_OPTIONS,
  STATUS_MODE_TO_KEY,
  MANUAL_SPEED_OPTIONS,
  FREE_COOLING_MIN_SPEED_OPTIONS,
  UNIT_MODEL_QV_MAX,
};
