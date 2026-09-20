'use strict';

/**
 * Fetches the photo and returns it as a data: URI, so the widget's <img>
 * never needs to make its own cross-origin request to an arbitrary local
 * network address - Homey's widget webview appears not to allow that
 * (confirmed: the exact same photo URL that Devices themselves can fetch
 * server-side, e.g. for the composited camera image, consistently failed
 * to load when set directly as an <img src> inside the widget).
 */
async function toDataUri(url) {
  if (!url) return '';
  try {
    const res = await fetch(url);
    if (!res.ok) return '';
    const buffer = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    return `data:${contentType};base64,${buffer.toString('base64')}`;
  } catch (err) {
    return '';
  }
}

module.exports = {
  async getPeople({ homey }) {
    const driver = homey.drivers.getDriver('person');
    await driver.ready();

    const devices = driver.getDevices();
    return Promise.all(devices.map(async (device) => ({
      id: device.getData().id,
      name: device.getName(),
      photoUrl: await toDataUri(device.getSetting('photoUrl')),
      home: device.getCapabilityValue('home') === true,
    })));
  },
};
