# Systemair Ventilation (Homey app)

Talks directly to a Systemair SAVE ventilation unit (VSR/VTR series) over
Modbus TCP, through its **IAM** (Internet Access Module, marketed as "SAVE
Connect"). No cloud account, no Home Assistant required — just the unit's
IP address on your local network.

Built for a Systemair **VSR 300**, but the register map covers the whole
SAVE family, and the unit model is just a setting used to estimate air flow
(m³/h) from fan power %.

## Why this exists

This app's register map, gateway-quirk handling, and control write-sequences
are ported directly from the real, working, community-maintained Home
Assistant integration
[Howard0000/home-assistant-systemair-modbus](https://github.com/Howard0000/home-assistant-systemair-modbus),
not re-derived from Systemair's own register PDF. That source's register
addresses are documented as Modbus client offsets (PDF register number − 1),
and that convention carries over unchanged here.

## Setup

1. Find the IP address of your Systemair IAM / SAVE Connect module (check
   your router's DHCP client list, or the unit's own display/app).
2. In Homey, add a device under "Systemair SAVE unit" and enter that IP
   address. Defaults: port `502`, Modbus slave ID `1`.
3. Pick your unit model (only used to estimate air flow rate from fan power).
4. Done — the app polls the unit every 10 seconds by default (configurable
   down to 5s or up to 3600s via the "Poll interval" connection setting).

### Modbus gateway "safe mode"

Systemair's IAM module often rejects Modbus function code 04 (read input
registers) with an "Illegal function" error. This app defaults to **safe
mode** (device setting, on by default): every register is read via function
code 03 (read holding registers) instead, regardless of its nominal type,
with conservative batching and pacing between requests. Leave this on unless
you have a reason to believe your gateway handles FC04 correctly.

## What it exposes

**Sensors**
- Supply, extract, outdoor and heat-exchanger-efficiency temperature, plus a
  plain "Temperature" capability (mirroring supply air temperature) so
  Homey's built-in round thermostat dial for target temperature shows a
  "current temperature" readout under the setpoint
- Humidity (relative moisture extraction)
- Supply/extract fan speed (RPM) and estimated air flow (m³/h)
- Heat recovery (%)
- Indoor air quality level (economy / good / improve)
- Mode and Fan mode status text - plain-text readouts of the unit's own
  status/speed registers, always visible among the sensor tiles (unlike the
  controllable ventilation_mode/fan_speed pickers, which Homey surfaces as
  controls rather than tiles). Mode text also covers automatic-override
  states (cooker hood, CDI, pressure guard) that the mode picker can't
  represent.
- Days remaining until filter replacement

**Controls**
- Ventilation mode: Auto, Manual, Party, Boost, Fireplace, Away, Holiday
- Fan speed (manual mode): Stop, Low, Normal, High
- Target supply air temperature
- Eco mode on/off
- Free cooling on/off
- "Filter replaced" action (resets the filter timer)

**Settings** (mirrored live from the unit, editable)
- Poll interval (Modbus read rate) and a separate temperature report
  interval (how often measured temperatures get pushed to capabilities/
  Insights/flows - kept independent so slow-changing temperatures don't
  spam Insights graphs or flow triggers at the same rate as fan/mode control)
- Mode durations: Holiday (days), Away (hours), Party (hours), Refresh (minutes)
- Eco heat offset, filter replacement interval (months)
- Free cooling thresholds and daily time window

**Flow cards**
- Trigger: ventilation mode changed
- Condition: ventilation mode is / is not X
- Actions: set mode, set fan speed, mark filter as replaced

## Known limitations

- **Untested against real hardware.** This is a first build, written by
  porting the reference Home Assistant integration's logic and verified
  only with a mocked Modbus client. Expect to need a few rounds of
  adjustment once it talks to a real VSR 300/IAM — please report anything
  that looks wrong (a stuck value, a control that doesn't take effect,
  connection errors) so it can be fixed.
- **If nothing ever updates after pairing** (every tile stuck at its
  default — 0°C, 0%, "auto", "stop"), the device page itself now shows the
  actual error as a small warning banner (via `setWarning()`), so you don't
  need the Homey CLI or developer.homey.app to see what's failing — the
  latter's "My Apps" only lists apps published under your own developer
  account, not ones installed from a sideloaded .zip. Common causes: Modbus
  TCP not enabled on the IAM/SAVE Connect module's own web interface (often
  off by default), a wrong IP/slave ID, or a firewall blocking port 502
  between Homey and the unit. As of 1.0.7 the exact host/port/slave ID being
  queried is named directly in that message, so a slave-ID mismatch is
  visible without any extra tooling.
- **If every value reads back as exactly 0 even though the device shows as
  available** (no error at all), that almost always means the Modbus
  TCP-RTU/RS485 gateway accepted the request but answered with placeholder
  zeros for the wrong slave/unit ID, rather than a genuine error — a real
  unit never reports every register (temperatures, fan RPM, mode) as 0 at
  once. As of 1.0.7 this is called out as a device warning naming the
  slave ID in use. Check your IAM/SAVE Connect module's own settings page
  for the Modbus unit ID it actually expects (it isn't always `1`) and
  match it in this device's "Modbus slave ID" setting.
- `ventilation_mode` only reflects the 7 user-selectable modes. The unit can
  also report automatic-override states (cooker hood, vacuum cleaner, CDI
  1-3, pressure guard) that aren't in this list — the capability simply
  keeps its last value while one of those is active, rather than showing
  something misleading.
- Manual "Stop" is only honored if the unit's `fan_manual_stop_allowed`
  register says so; otherwise the app falls back to Low speed, matching the
  reference integration's behavior.
- Air flow (m³/h) is an estimate from fan power % and the selected unit
  model's nominal max flow — not a direct sensor reading.

- **If saving the device's Settings page times out** (e.g. after changing the
  IP, port, or Modbus slave ID), this was a real bug fixed in 1.0.8: closing
  the old connection before opening the new one used to wait for the remote
  side to also finish closing its end of the TCP connection - something some
  Modbus TCP gateways don't do promptly (or at all) while a request was in
  flight, hanging the settings save indefinitely. The old connection is now
  torn down immediately instead of waiting on the gateway.
- **If the device just silently stops updating with no error or warning
  shown at all** (as opposed to a clean "unavailable" or all-zero warning -
  both already reported clearly), this was a real bug fixed in 1.1.0:
  polling used a plain `setInterval`, which fires on a fixed clock
  regardless of whether the previous poll actually finished. Reading all
  ~98 registers one at a time (100ms pacing each) already takes close to
  the default 10s interval under perfectly healthy conditions, so any real
  network latency or a retry/backoff cycle could push a single poll cycle
  past the next tick - starting a second, overlapping poll on the *same*
  Modbus TCP connection (modbus-serial only supports one request in flight
  at a time). The two polls' requests and responses then get interleaved
  on the wire, which isn't a clean, catchable error - each read just
  silently gets the wrong register's data or hangs waiting for a response
  already consumed by the other poll, indistinguishable from "stopped
  updating" from the device page. Polling now self-schedules (the next
  poll is only ever queued once the previous one has fully finished,
  success or failure) instead of running on a fixed clock, so overlapping
  polls can no longer happen, including when a settings save reschedules
  the interval while a poll is still in flight.
- **If updates still stopped after running fine for a while** (a real
  follow-up case, fixed in 1.1.1): serializing polls (above) closed the
  overlap bug, but also meant a single read that hangs completely rather
  than failing cleanly - the underlying `modbus-serial` library not
  respecting its own timeout in some edge case, for instance - would leave
  that one `_poll()` call permanently unresolved, which permanently halted
  the self-scheduling chain (nothing was ever there to schedule the *next*
  poll). A 45-second watchdog now races the whole read cycle: if it isn't
  done by then, that cycle is treated as a normal failure (reported the
  same way as any other poll error) and the connection is force-closed so
  the next attempt opens a fresh socket instead of risking reuse of one
  left in a wedged state.
- **If the device flashes to `0 °C` / `stop` / `auto` across every tile for
  a cycle or two, then recovers** (a real follow-up case, fixed in 1.1.2):
  this specific gateway can answer the first request or two right after a
  fresh TCP reconnect with placeholder all-zero data instead of a real
  value *or* a clean error - not a one-off, it was seen recurring every
  couple of minutes. Two changes address this: `connect()` now pauses
  briefly (`connectSettleMs`, 250ms by default) right after the TCP
  handshake before the first register is read, giving the gateway a moment
  to actually be ready; and an all-zero cycle's readings are now discarded
  rather than written over the last known-good values (which used to flash
  the whole device to zeros for no real reason), while still force-closing
  the connection so the *next* poll reconnects (and gets its own settle
  pause) instead of continuing on whatever confused the gateway.

## Development

```
npm install
homey app validate --level publish
homey app run     # or: homey app install
```

If you installed an earlier copy of this app before this note was added and
saw `homey app install` fail with a "Missing File" error, delete
`node_modules/` and `package-lock.json` and run `npm install` again — a
committed `.npmrc` now skips `modbus-serial`'s optional `serialport`
dependency (a large native-binding package tree only needed for serial/RTU
connections, which this app never uses since it only talks Modbus **TCP**).
