'use strict';

const suncalc = require('suncalc');
const { formatClockTime } = require('../../lib/dimSchedule');

module.exports = {
  async getSunTimes({ homey }) {
    const lat = homey.geolocation.getLatitude();
    const lon = homey.geolocation.getLongitude();
    let timeZone;
    try {
      timeZone = homey.clock.getTimezone();
    } catch (err) {
      timeZone = undefined;
    }

    const now = new Date();
    const times = suncalc.getTimes(now, lat, lon);

    return {
      now: now.toISOString(),
      dawn: times.dawn.toISOString(),
      sunrise: times.sunrise.toISOString(),
      solarNoon: times.solarNoon.toISOString(),
      sunset: times.sunset.toISOString(),
      dusk: times.dusk.toISOString(),
      dawnText: formatClockTime(times.dawn, timeZone),
      sunriseText: formatClockTime(times.sunrise, timeZone),
      solarNoonText: formatClockTime(times.solarNoon, timeZone),
      sunsetText: formatClockTime(times.sunset, timeZone),
      duskText: formatClockTime(times.dusk, timeZone),
    };
  },
};
