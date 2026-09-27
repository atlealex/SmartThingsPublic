# Wake Clock (Homey app)

A tiny virtual "wake alarm" device with one job: hold an easy-to-change wake-up
time and fire a Flow trigger at that time every day - so changing when you
get up for work doesn't mean editing a Flow.

## Setup

1. Add a "Wake alarm" device (Devices → Add device → Wake Clock).
2. Add the **Vekkerklokke** widget to your dashboard and pick that device -
   tap the time to change it with your phone's native time picker, and use
   the toggle to pause the alarm without deleting it.
3. Build a Flow: **When** "Wake time is reached" (this device) → **Then**
   turn on your lights (or whatever else you want to happen).

The alarm repeats every day at the stored time until you turn it off. You
can also change the time from a Flow action ("Set wake time to ...") if you
want another automation to adjust it (e.g. a different time on weekends).

## How it works

- The device stores the wake time as `HH:MM` in a custom `alarm_time`
  capability, shown read-only on the device tile itself (edit it from the
  widget or a Flow instead - a raw text field on the tile isn't a nice way
  to enter a time).
- On init, on every time change, and on every enable/disable, the device
  (re)schedules a single `setTimeout` for the next occurrence of that time
  (today if it hasn't passed yet, otherwise tomorrow).
- When it fires, it triggers the `wake_time_reached` Flow card and
  immediately re-arms itself for the same time the next day.

## Development

```
npm install
homey app validate --level publish
homey app run     # or: homey app install
```
