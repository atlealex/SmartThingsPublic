# Sun Dimmer (Homey app)

Gradually dims your lights up during the day and down at night, with a
smooth transition around sunrise/sunset instead of an abrupt jump -
inspired by "Chronograph"-style gradual dimming, but wired directly to the
sun instead of a manually-built flow, and with its own per-light min/max.

Like the Donut Chart / Power group apps, this picks any dimmable light on
your Homey - not limited to a specific brand.

## Setup

1. Install the app (`npm install && homey app install`).
2. Add a device and choose **Sun Dimmer**.
3. Give it a name, set the transition time (minutes - used for both the
   sunset and sunrise transition, same for every light in the group), and
   check off which lights to include. For each light, set its **min %**
   (night level) and **max %** (day level).
4. Done. The new device appears in your device list with an on/off toggle
   ("Automation enabled") you can use to pause it without deleting it.

## How it works

- **Sunrise → max, sunset → min.** Around sunrise, each light fades from
  its min to its max over the configured transition time; around sunset,
  it fades back from max to min. Outside those two transition windows, the
  light just sits at whichever of the two it last reached.
- `lib/dimSchedule.js` computes the target level for "right now" from
  scratch on every poll - it doesn't track "we're mid-fade, X% through".
  This means it self-heals after an app restart or a missed poll instead
  of needing saved fade state, at the cost of only being as smooth as the
  poll interval (30 seconds).
- Sunrise/sunset times come from [`suncalc`](https://www.npmjs.com/package/suncalc)
  (a small, dependency-free astronomical calculation library - not a Homey
  API, since the Homey Apps SDK has no direct sunrise/sunset method; sun
  events are otherwise only available as flow triggers from Homey's own Sun
  app), computed from your Homey's own location
  (`homey.geolocation.getLatitude/getLongitude`, needing the
  `homey:manager:geolocation` permission).
- Writing to other apps' lights uses the same `homey-api` /
  `HomeyAPI.createAppAPI()` mechanism as the other two apps
  (`homey:manager:api`): `devices.getDevices()` to read each light's
  current `onoff`/`dim` state, `devices.setCapabilityValue()` to update it.
  A light already at its exact target isn't rewritten, and `dim` writes
  include a `duration` option matching the poll interval so a light that
  supports smooth transitions blends between polls instead of stepping.
- A light being dimmed to a target of 0% is turned fully off (`onoff:
  false`) rather than sent `dim: 0`; a light with a non-zero min stays on
  and just gets dim.

## Known limitations

- **The set of tracked lights, and each one's min/max, are fixed at
  pairing time.** There's no edit-membership flow yet - to change which
  lights are included or their min/max, delete and re-add the device.
- **Untested against a real Homey.** The scheduling math
  (`lib/dimSchedule.js`) is covered by 14 automated checks against known
  clock times, and the device's polling/write logic by 13 more (mocked
  `homeyApi`, using the real `suncalc` output for today so the tests stay
  meaningful) - onoff/dim coordination, skipping a redundant write, a
  deleted tracked light, and the pause toggle are all covered. `homey app
  validate --level publish` passes. But it has never been paired or run
  against real lights yet.
- Only one min/max/transition-time combination is possible per Sun Dimmer
  device, applied to every light in it. If you want different transition
  times for different lights, create separate Sun Dimmer devices.
- No live/websocket updates - the device polls every 30 seconds rather
  than reacting instantly to something else changing a light's brightness.
