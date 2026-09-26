'use strict';

// The capability summed for the donut: today's energy use (kWh), reset
// daily. This is not a standard Homey capability - meter_power is always a
// lifetime cumulative counter, which made an older device dominate a newer
// one's slice regardless of today's actual usage. meter_kwh_this_day comes
// from the "Power by the Hour" app's virtual "<Device>_Σpower" companion
// devices, which track daily/monthly/yearly deltas for a source device.
const CAPABILITY_ID = 'meter_kwh_this_day';

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
