# Sun Dimmer (Homey app)

Gradually dims your lights up during the day and down at night, with a
smooth transition around sunrise/sunset instead of an abrupt jump -
inspired by "Chronograph"-style gradual dimming and a Home Assistant
sunset/sunrise dimming dashboard, but wired directly to the sun instead of
a manually-built flow, with its own per-light min/max.

Like the Donut Chart / Power group apps, this picks any dimmable light on
your Homey - not limited to a specific brand.

## Setup

1. Install the app (`npm install && homey app install`).
2. Add a device and choose **Sun Dimmer**, give it a name, and check off
   which lights to include. For each light, set its **min %** (night
   level) and **max %** (day level).
3. Done. The new device appears in your device list with:
   - Two toggles, **"Solnedgang-demping aktiv"** and **"Soloppgang-økning
     aktiv"**, to enable/pause each direction independently.
   - Two read-only tiles, **"Neste solnedgang-demping"** /
     **"Neste soloppgang-økning"**, showing a countdown ("Om 8 timer") to
     when that transition next starts, or "Deaktivert" if its toggle is off.
   - **One live tile per tracked light**, showing its current level (%),
     directly adjustable - dragging it commands that light immediately.
     The schedule will move it again on its next poll (within 30s), so
     this is a live nudge, not a permanent override.
   - **Two more tiles per tracked light, "Min %" and "Max %"**, also
     directly adjustable - this is where you change a light's day/night
     levels day-to-day, without needing to repair the device. (Homey's
     device *Settings* screen can't show a dynamic list with one row per
     light - it's a fixed form, the same for every Sun Dimmer device - so
     these live on the device's own page instead, as capabilities.)
4. In the device's **settings** (the fixed, non-per-light kind), set the
   shared transition time (minutes, used for both directions and every
   light in the group), and how many minutes *before* actual sunset/sunrise
   each transition should start.
5. To add or remove which lights are tracked, open the device's settings
   and choose **Repair** - the same light picker as pairing, pre-filled
   with your current selection. (Changing an existing light's min/max is
   quicker directly on the device page, per above - repair is for changing
   *which* lights are included.)
6. Two flow actions, **"Start solnedgang-demping nå"** / **"Start
   soloppgang-økning nå"**, let you trigger either transition on demand
   (e.g. from a button), running once over the configured transition time
   before returning to following the sun automatically.

## How it works

- **Sunrise → max, sunset → min.** Around sunrise, each light fades from
  its min to its max over the configured transition time; around sunset,
  it fades back from max to min. Outside those two transition windows, the
  light just sits at whichever of the two it last reached. Disabling one
  direction's toggle removes just that ramp (the light holds at the other
  direction's level instead); disabling both holds every light at max
  (manual/flow-action control only).
- `lib/dimSchedule.js` computes the target level for "right now" from
  scratch on every poll - it doesn't track "we're mid-fade, X% through".
  This means it self-heals after an app restart or a missed poll instead
  of needing saved fade state, at the cost of only being as smooth as the
  poll interval (30 seconds). The one exception is a manually-triggered
  transition (the flow actions or a future "start now" button): that
  briefly overrides the sun-clock schedule for one transition length,
  timed from when it was triggered, then hands back to the normal schedule
  automatically.
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
- Editing which lights are tracked after pairing reuses the exact same
  picker UI via Homey's device **repair** flow
  (`driver.onRepair(session, device)`): it pre-fetches the device's
  currently-stored lights so the form opens pre-filled, and saves back to
  the same device instead of creating a new one.
- Each tracked light gets three dynamically-added capabilities -
  `dim.<lightId>` (live level, sanitized since capability instance ids
  can't contain a UUID's hyphens), `light_min.<lightId>`, `light_max.<lightId>`
  - added in `onLightsUpdated()`, which runs after pairing and again after
  every repair save, also removing the three for any light no longer
  tracked. Dragging `light_min`/`light_max` updates that light's stored
  value directly (no repair needed); dragging the live `dim` tile commands
  the real light immediately via the same `homeyApi.devices.setCapabilityValue()`
  the poll loop uses.

## Known limitations

- Only one min/max/transition-time/offset combination is possible per Sun
  Dimmer device, applied to every light in it. If you want different
  settings for different lights, create separate Sun Dimmer devices.
- **Untested against a real Homey.** The scheduling math
  (`lib/dimSchedule.js`) is covered by 32 automated checks (both directions,
  each one individually disabled, offsets, manual override, the countdown
  text formatting), and the device's polling/write logic by 24 more (mocked
  `homeyApi`, using the real `suncalc` output for today) - onoff/dim
  coordination, the disabled-direction behavior, the manual override
  lifecycle, per-light capability add/remove on repair, and the min/max/live
  dim listeners are all covered. `homey app validate --level publish`
  passes. But it has never been paired, repaired, or run against real
  lights yet - in particular, whether Homey's mobile UI renders many
  per-light tiles cleanly on a device with several tracked lights is
  unverified.
- No live/websocket updates - the device polls every 30 seconds rather
  than reacting instantly to something else changing a light's brightness.
