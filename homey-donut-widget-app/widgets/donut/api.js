'use strict';

// The capability summed for the donut. meter_power is Homey's standard
// capability for cumulative energy (kWh), matching what a "total kWh"
// donut chart is meant to show (as opposed to measure_power, which is an
// instantaneous Watt reading).
const CAPABILITY_ID = 'meter_power';

module.exports = {
  async getSummary({ homey, query }) {
    const deviceIds = String(query.deviceIds || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);

    if (deviceIds.length === 0) {
      return { items: [], total: 0 };
    }

    const devices = await homey.app.homeyApi.devices.getDevices();

    const items = deviceIds
      .map((id) => devices[id])
      .filter(Boolean)
      .map((device) => {
        const capability = device.capabilitiesObj && device.capabilitiesObj[CAPABILITY_ID];
        const value = typeof capability?.value === 'number' ? capability.value : 0;
        return { id: device.id, name: device.name, value };
      });

    const total = items.reduce((sum, item) => sum + item.value, 0);

    return { items, total };
  },
};
