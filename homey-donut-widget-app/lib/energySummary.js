'use strict';

// Maps each selectable period to the "Power by the Hour" capability it
// reads from a source device, and the capability this group device writes
// the summed total to.
const METRIC_SOURCE_CAPABILITY = {
  hour: 'meter_kwh_this_hour',
  day: 'meter_kwh_this_day',
  month: 'meter_kwh_this_month',
  year: 'meter_kwh_this_year',
};

const METRIC_GROUP_CAPABILITY = {
  hour: 'measure_kwh_hour',
  day: 'measure_kwh_day',
  month: 'measure_kwh_month',
  year: 'measure_kwh_year',
};

const ALL_METRICS = Object.keys(METRIC_SOURCE_CAPABILITY);

/**
 * Sums one metric's value across a set of tracked devices.
 * @param {Object} devices - keyed by device id, as returned by homeyApi.devices.getDevices()
 * @param {string[]} trackedDeviceIds
 * @param {'hour'|'day'|'month'|'year'} metric
 * @returns {{ total: number, anyFound: boolean }}
 */
function sumMetric(devices, trackedDeviceIds, metric) {
  const sourceCapability = METRIC_SOURCE_CAPABILITY[metric];
  let total = 0;
  let anyFound = false;

  for (const deviceId of trackedDeviceIds) {
    const device = devices[deviceId];
    if (!device) continue;
    anyFound = true;

    const capability = device.capabilitiesObj && device.capabilitiesObj[sourceCapability];
    const value = typeof capability?.value === 'number' ? capability.value : 0;
    total += value;
  }

  return { total, anyFound };
}

module.exports = {
  ALL_METRICS,
  METRIC_SOURCE_CAPABILITY,
  METRIC_GROUP_CAPABILITY,
  sumMetric,
};
