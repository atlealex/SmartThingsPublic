# Donut Chart (Homey app)

A Homey dashboard widget that shows any devices you pick as a donut/ring
chart of their energy consumption (`meter_power`, kWh), with the total in
the center - inspired by a Home Assistant "consumption breakdown" donut
card.

It's generic on purpose: pick any devices that expose a `meter_power`
capability (heating cables, sockets, EV chargers, etc.) - not hardcoded to
any specific device type. You can add multiple instances of the widget to
your dashboard, each with its own device selection.

## Why `homey:manager:api`

To let the widget pick *any* device on your Homey - not just devices from
this app's own drivers - it uses Homey's official cross-app device access:
[`homey-api`](https://www.npmjs.com/package/homey-api)'s
`HomeyAPI.createAppAPI()`, which requires the `homey:manager:api`
permission. This is the same mechanism the official "Group" app uses to let
you combine devices from any app into one. Homey's own device-picker
component in the widget's setup screen (the `devices` manifest property)
is what actually lists every device/capability on your Homey - the
permission only lets the app's own backend read the values of the devices
you explicitly picked there.

## Setup

1. Install the app (`npm install && homey app install`).
2. On your Homey Dashboard, add the **Donut Chart** widget.
3. In the widget's setup screen, pick the devices to include (only devices
   with a `meter_power` capability will be selectable) and optionally set a
   title.
4. Done - the widget polls each selected device's `meter_power` value every
   60 seconds and re-renders the ring and its radiating device labels.

## How it works

- `app.js` creates one `HomeyAPI` instance in `onInit()`, shared by all
  widget instances.
- `widgets/donut/api.js` exposes a `GET /summary?deviceIds=a,b,c` route:
  looks up those devices via the shared `HomeyAPI`, reads each one's
  `meter_power` value, and returns `{ items: [{id, name, value}], total }`.
- `widgets/donut/public/index.html` is the widget's frontend: on load (and
  every 60s after, and on resize), it calls that route with the device IDs
  from `Homey.getDeviceIds()` and draws an SVG donut - each device's own
  color, a connector line, and its name radiating out from the ring at the
  segment's own angle (pushed apart vertically when small segments would
  otherwise overlap) - matching the reference Home Assistant card's layout.
  The total is shown in the ring's center, formatted with Norwegian number
  formatting.
- **Tap a segment (or its label) to select it**: the selected slice pops
  out and keeps its color, every other segment and label dims to gray, and
  the center switches from the total to that device's `meter_power` value
  (bold) and its percentage of the total - both sized relative to the
  chart, same as the total view. Tap the same segment again (or select
  nothing) to go back to the total view.

## Known limitations

- **Untested against a real Homey.** This is a first build, verified only
  with a mocked `homeyApi.devices.getDevices()` call (7 automated checks)
  and a headless-browser render test against sample data. The widget
  manifest schema and `homey-api` usage were verified against the actual
  Homey CLI's own bundled JSON schema and `homey-api` package source (not
  guessed), but the end-to-end picker → widget → chart flow has not been
  exercised on real hardware yet.
- Only `meter_power` (cumulative kWh) is summed - not `measure_power`
  (instantaneous Watts). A device without `meter_power` can still be picked
  (Homey's filter is a soft hint, not a hard guarantee across every device
  type) but will show as 0.
- On a narrow widget with many devices or long device names, labels on the
  outer edges can run close to (or past) the widget's own border. The
  device labels show only the name (no value/percentage) specifically to
  keep them short and reduce this risk, but very long device names on a
  small widget may still get tight.
- No live/websocket updates - the widget polls every 60 seconds rather than
  reacting instantly to a capability change.
