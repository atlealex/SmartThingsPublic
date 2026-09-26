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
     **"Neste soloppgang-økning"**, showing a countdown *and* the actual
     clock time the transition starts ("Om 8 timer (kl. 20:22)"), already
     factoring in the configured start-before-sunset/sunrise offset, or
     "Deaktivert" if its toggle is off.
   - Two more read-only tiles, **"Solnedgang"** / **"Soloppgang"**, showing
     the plain astronomical clock time of the next sunset/sunrise itself
     (no offset applied) - so you can see the raw sun times the schedule is
     based on, alongside the actual transition start times above.
   - **A "Nivå" tile per tracked light**, read-only, showing its current
     level (%) with a light-bulb icon (`assets/light_level.svg`, drawn
     half-filled to hint at "level" - the fill is a fixed design, it doesn't
     animate with the actual percentage) instead of Homey's generic
     placeholder square - all of them sit together in one grid so you can
     see every light's live level at a glance, like the Power group app's
     overview.
   - **A separate "– juster" control per light** (found via the dial/slider
     control tab - Homey groups every draggable capability of the same type
     into one shared control with a picker, so this one lives there rather
     than in the grid): drag it to command that light immediately. The
     schedule will move it again on its next poll (within 30s), so this is
     a live nudge, not a permanent override.
   - **Two more tiles per tracked light, "Min %" and "Max %"**, also
     directly adjustable - this is where you change a light's day/night
     levels day-to-day, without needing to repair the device. (Homey's
     device *Settings* screen can't show a dynamic list with one row per
     light - it's a fixed form, the same for every Sun Dimmer device - so
     these live on the device's own page instead, as capabilities.)
4. In the device's **settings** (the fixed, non-per-light kind), set the
   shared transition time (minutes, used for both directions and every
   light in the group), how many minutes *before* actual sunset/sunrise
   each transition should start - or, with a **negative** value, how many
   minutes *after* instead (the light holds at its current level until then,
   e.g. staying bright for a while past actual sunset before dimming down) -
   and the **update interval** (seconds, default 30, 5-300) - how often the
   dim level is recalculated and sent while a transition is in progress.
   Lower values give smoother, more frequent steps; e.g. going from 100% to
   60% over 15 minutes takes 30 steps at the default 30s interval, or 90
   steps at a 10s interval.
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
- **Only lights that are already on get dimmed.** A light someone (or
  something else) switched off - everyone's away, or just a personal
  choice - is left off; the schedule never turns it back on. A light that
  *is* on and reaches a 0% (min=0) target is still turned off, so an
  evening fade-to-off completes naturally. This only governs the automatic
  schedule (and the "start now" flow actions, which follow the same
  target-following logic) - dragging a light's own live "– juster" tile
  is an explicit action and is always honored, including turning a light on.
- `lib/dimSchedule.js` computes the target level for "right now" from
  scratch on every poll - it doesn't track "we're mid-fade, X% through".
  This means it self-heals after an app restart or a missed poll instead
  of needing saved fade state, at the cost of only being as smooth as the
  configured update interval (30 seconds by default, adjustable in
  settings). The one exception is a manually-triggered
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
  include a `duration` option matching the configured update interval so a
  light that supports smooth transitions blends between polls instead of
  stepping.
- A light being dimmed to a target of 0% is turned fully off (`onoff:
  false`) rather than sent `dim: 0`; a light with a non-zero min stays on
  and just gets dim.
- Adding a new fixed (non-per-light) capability to the driver only gives it
  to devices paired *after* that change - Homey doesn't retrofit already-
  paired devices automatically. `onInit()` corrects for this on every boot,
  adding any of the six fixed capabilities (the two toggles and four text
  tiles) an existing device doesn't have yet, so updating the app is enough
  to get new tiles on devices paired before they existed.
- Editing which lights are tracked after pairing reuses the exact same
  picker UI via Homey's device **repair** flow
  (`driver.onRepair(session, device)`): it pre-fetches the device's
  currently-stored lights so the form opens pre-filled, and saves back to
  the same device instead of creating a new one.
- Each tracked light gets four dynamically-added capabilities (instance ids
  sanitized, since a UUID's hyphens aren't valid there) - `dim.<lightId>`
  (setable; the draggable "– juster" control), `light_level.<lightId>`
  (read-only; the "Nivå" overview tile - a custom capability, since the
  standard `dim` capability is always setable and Homey always groups
  setable instances of the same capability into one shared control rather
  than a tile grid), `light_min.<lightId>` and `light_max.<lightId>`. All
  four are added in `onLightsUpdated()`, which runs after pairing and again
  after every repair save, also removing them for any light no longer
  tracked. Dragging `light_min`/`light_max` updates that light's stored
  value directly (no repair needed); dragging `dim` commands the real light
  immediately via the same `homeyApi.devices.setCapabilityValue()` the poll
  loop uses; `light_level` is set alongside `dim` on every poll, as a plain
  0-100 mirror of the same target, purely for the overview.

## Known limitations

- Only one min/max/transition-time/offset combination is possible per Sun
  Dimmer device, applied to every light in it. If you want different
  settings for different lights, create separate Sun Dimmer devices.
- Clock times are rendered using the Homey's own configured timezone
  (`homey.clock.getTimezone()`, e.g. "Europe/Oslo") via `Intl.DateTimeFormat`,
  not the app runtime's own timezone - the two aren't guaranteed to match,
  and a real device showed this: the tiles were consistently 2 hours behind
  the actual wall clock (the runtime was in UTC while the user is in
  CEST/UTC+2). Falls back to the runtime's local time if the timezone is
  missing or unrecognized, rather than throwing.
- The scheduling math (`lib/dimSchedule.js`) and the device's polling/write
  logic (mocked `homeyApi`, using the real `suncalc` output for today) are
  covered by 51 automated checks in total - onoff/dim coordination, the
  disabled-direction behavior, the manual override lifecycle, per-light
  capability add/remove on repair, the min/max/live dim listeners, the
  configurable update interval (default, settings override, the 5s floor,
  rescheduling on settings change, and the dim write's duration), and the
  countdown/clock-time text tiles are all covered. `homey app validate
  --level publish` passes.
- No live/websocket updates - the device polls at the configured update
  interval (30 seconds by default) rather than reacting instantly to
  something else changing a light's brightness.
