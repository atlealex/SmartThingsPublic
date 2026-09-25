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
- Active season (summer / winter, from the unit's own compensation logic)
- Mode and Fan mode status text - plain-text readouts of the unit's own
  status/speed registers, always visible among the sensor tiles (unlike the
  controllable ventilation_mode/fan_speed pickers, which Homey surfaces as
  controls rather than tiles). Mode text also covers automatic-override
  states (cooker hood, CDI, pressure guard) that the mode picker can't
  represent.
- Days remaining until filter replacement
- Alarms: A-alarm, B-alarm, C-alarm, filter alarm, filter warning

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
