# Donut Chart & Power group (Homey app)

Two related tools for looking at other devices' power/energy data together,
without needing Home Assistant:

- **Donut Chart**: a Homey Dashboard widget showing any devices you pick as
  a donut/ring chart of their *today's* energy consumption (`meter_kwh_this_day`,
  kWh, reset daily) - inspired by a Home Assistant "consumption breakdown"
  donut card.
- **Power group**: a virtual device that shows up in your normal Homey
  device list. Pick any devices with a `measure_power` capability when you
  add it, and its detail page shows each one's live power (W) as its own
  tile, plus a combined total on the device's own tile in the device list.

Both are generic on purpose: pick any devices (heating cables, sockets, EV
chargers, UniFi access points, a coffee machine, etc.) - neither is
hardcoded to any specific device type.

## Why `homey:manager:api`

To let you pick *any* device on your Homey - not just devices from this
app's own drivers - both features use Homey's official cross-app device
access: [`homey-api`](https://www.npmjs.com/package/homey-api)'s
`HomeyAPI.createAppAPI()`, which requires the `homey:manager:api`
permission. This is the same mechanism the official "Group" app uses to let
you combine devices from any app into one.

- For the **Donut Chart** widget, Homey's own device-picker component in
  the widget's setup screen (the `devices` manifest property) is what lists
  every device/capability - the permission only lets the app's backend read
  the values of the devices you picked there.
- For the **Power group** device, this app's own pairing screen fetches the
  device list itself (via `HomeyAPI`, since there's no built-in device
  picker for driver pairing screens the way there is for widgets) and lets
  you check off which ones to track.

## Setup

**Donut Chart widget:**
1. Install the app (`npm install && homey app install`).
2. Install Athom's **Power by the Hour** app and add each device you want to
   track to it - it creates one virtual `<Device>_Σpower` companion device
   per source, exposing `meter_kwh_this_day` (today's kWh, resets at
   midnight) among others.
3. On your Homey Dashboard, add the **Donut Chart** widget.
4. In the widget's setup screen, pick those `_Σpower` companion devices
   (only devices with a `meter_kwh_this_day` capability are selectable -
   the *original* device, e.g. a heating cable itself, won't show up here)
   and optionally set a title.
5. Done - the widget polls each selected device's `meter_kwh_this_day` value
   every 60 seconds and re-renders the ring and its radiating device labels.

**Power group device:**
1. In Homey, add a device and choose **Power group**.
2. Give it a name and check off which devices to track (only devices with a
   `measure_power` capability are listed).
3. Done - the new device appears in your device list showing the combined
   live power total; open it to see each tracked device's own live power
   reading.

## How it works

- `app.js` creates one `HomeyAPI` instance in `onInit()`, shared by the
  widget and the driver.
- `widgets/donut/api.js` exposes a `GET /summary?deviceIds=a,b,c` route:
  looks up those devices via the shared `HomeyAPI`, reads each one's
  `meter_kwh_this_day` value, and returns `{ items: [{id, name, value}], total }`.
  This capability isn't a standard Homey one - it comes from each source
  device's `_Σpower` companion device, created by the separate "Power by
  the Hour" app, which tracks hourly/daily/monthly/yearly deltas. Using it
  instead of the standard `meter_power` (a lifetime cumulative counter) was
  a deliberate fix: an older device's `meter_power` completely dominated a
  donut next to a newer device that simply hadn't had time to accumulate as
  much yet, even on a day where the newer one used more energy.
- `widgets/donut/public/index.html` is the widget's frontend: on load (and
  every 60s after, and on resize), it calls that route with the device IDs
  from `Homey.getDeviceIds()` and draws an SVG donut - each device's own
  color, a connector line, and its name radiating out from the ring at the
  segment's own angle (pushed apart vertically when small segments would
  otherwise overlap). The total is shown in the ring's center, formatted
  with Norwegian number formatting. Each label is measured against the
  actual widget width and shrunk to an ellipsis (e.g. "U7 Pro Terr…") if it
  would otherwise run past the widget's edge.
- **A single device holding 100% of the total renders as a real ring, not
  nothing.** `donutSegmentPath()` draws each segment as one SVG arc between
  its start and end angle - but a 360° sweep's start and end angles land on
  the exact same point, so a single arc degenerates to zero length and
  nothing appears. This is far more likely now that the chart tracks daily
  (not lifetime) kWh: it's common for only one device to have any nonzero
  usage yet while the rest are still at 0 and get filtered out, leaving
  exactly one item at 100%. Fixed by splitting a full-circle segment into
  two half-arcs instead of one.
- **Tap a segment (or its label) to select it**: the selected slice pops
  out and keeps its color, every other segment and label dims to gray, and
  the center switches from the total to that device's `meter_kwh_this_day`
  value (bold) and its percentage of the total. Tap the same segment again (or
  select nothing) to go back to the total view.
- `drivers/power_group/pair/select_devices.html` fetches the full device
  list (filtered to those with `measure_power`) via a custom `list_devices`
  pairing event handled in `drivers/power_group/driver.js`, and creates the
  device with the checked device IDs saved to its store.
- `drivers/power_group/device.js` reads that stored list in `onInit()`,
  adds one `measure_power.<deviceId>` capability per tracked device
  (sanitizing the id, since capability instance ids can't contain hyphens),
  and polls every 10 seconds: reads each tracked device's live
  `measure_power` via the shared `HomeyAPI`, sets its own capability, and
  sums them into the device's plain `measure_power` (its device-list tile
  value).

## Known limitations

- **The Power group's tracked devices are fixed at pairing time.** There's
  no edit-membership flow yet - to change which devices are tracked,
  delete and re-add the device. If you use this a lot, ask for that to be
  added.
- **The Power group is untested against a real Homey.** Verified with a
  mocked `homeyApi.devices.getDevices()` call (12 automated checks:
  capability creation, id sanitizing, summing, a deleted tracked device,
  and a device temporarily missing its capability), and `homey app
  validate --level publish` passes, but never paired on real hardware yet.
  The Donut Chart widget, by contrast, has been confirmed working on a real
  Homey dashboard.
- Donut Chart only sums `meter_kwh_this_day` (today's kWh, from a "Power by
  the Hour" `_Σpower` companion device) - not `measure_power` (instantaneous
  Watts) or `meter_power` (lifetime kWh); Power group is the reverse (only
  `measure_power`). A device missing the relevant capability shows as 0.
  Without "Power by the Hour" installed and configured for a device, there's
  no way to get a daily-reset kWh figure from Homey's own standard
  capabilities - `meter_power` is always a lifetime counter.
- Neither has live/websocket updates - both poll on an interval (60s for
  the widget, 10s for the Power group device) rather than reacting
  instantly to a capability change.
