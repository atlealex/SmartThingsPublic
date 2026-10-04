# Broadlink Remote (Hold) for Homey Pro

A Homey Pro app that talks **directly** to a Broadlink RM-series device
(RM4 Pro, RM4 mini, RM Pro, RM mini) over the local network, completely
independent of the existing community Broadlink app - built for one specific
gap that app can't cover: **simulating a held-down remote button.**

## Why this exists

Some IR/RF remotes (e.g. several roller-blind motors' "go to favorite
position" button) only trigger that behavior if the receiver sees the
button's signal repeated continuously for a few seconds - a genuine physical
hold, not a single press. The existing Broadlink Homey app's "Send command"
Flow action only sends a learned signal **once**. Repeating that single-send
action from a Flow doesn't reliably reproduce a hold either: Homey's native
Flow delay card only supports whole-second granularity, and sending several
back-to-back with no delay at all can overlap/collide on the RM4 Pro's own
transmit queue.

This app sends the learned signal with its own internal timing loop
(millisecond-precision, not limited by Homey's Flow delay granularity),
so a single Flow action can resend a signal every ~100-300ms for several
seconds - matching what the physical remote itself does while held.

## Setup

1. Install the app (`npm install && homey app install`).
2. Add a device, choose **Broadlink remote** - it discovers RM-series
   devices on your local network automatically (the device must already be
   joined to your WiFi; this app doesn't do the initial AP-mode WiFi setup -
   if it's already working in the existing Broadlink app or Home Assistant,
   it's already on your network and will be found).
3. Done pairing - no codes are learned yet. Open the device's **settings**
   (gear icon) and set **"Signal name"** to whatever you want to call the
   first signal (e.g. "Kjøkken favoritt") - the three buttons on the device
   page (below) always act on whichever name is set there.
4. Use the device page buttons or the Flow actions below to learn and use
   signals.

## Device page buttons

Mirrors the "Learn IR command"/"Learn RF command" buttons the existing
community Broadlink app shows on its own device page - all three act on
whichever signal name is currently set in this device's **settings**
("Signal name"), so you don't need to build a Flow just to test a signal:

- **"Lær inn signal" / "Learn signal"** - press, then immediately press
  (and hold, for a hold-style signal) the physical remote button.
- **"Send signal én gang" / "Send signal once"**
- **"Send signal (hold)"** - uses the "Hold duration"/"Interval between
  resends" settings fields.

To work with a different signal, change "Signal name" in settings first -
e.g. set it to "Opp" to learn/test the up button, then back to "Kjøkken
favoritt" for the hold-style one. Each signal name's learned code is kept
independently; changing the active name doesn't erase anything.

## Flow actions

- **"Lær inn nytt signal" / "Learn new signal"** - args: device, a name you
  choose. Puts the device into learning mode and waits up to 25 seconds.
  Press (and hold, for a hold-style signal) the physical remote button as
  soon as you run this action. Running it again with the same name
  overwrites the old signal.
- **"Send signal" / "Send signal"** - args: device, signal name (picked from
  what's been learned on that device). Sends it once - equivalent to the
  existing Broadlink app's own send action, included here mainly so you
  don't need two separate apps for simple on/off-style buttons.
- **"Send signal (hold)" / "Send signal (hold)"** - args: device, signal
  name, hold duration (seconds, default 3), interval between resends (ms,
  default 200, floor 80). This is the actual point of the app: resends the
  learned signal repeatedly for the given duration.

## How it works

- Uses [`node-broadlink`](https://www.npmjs.com/package/node-broadlink), a
  promise-based reimplementation of Broadlink's local UDP protocol (ported
  from the well-established `python-broadlink` project - the same protocol
  Home Assistant's own Broadlink integration speaks).
- Pairing discovers devices via a local UDP broadcast and stores each one's
  IP, MAC and device-type code - `onInit()` reconstructs a connection from
  that stored info directly (`genDevice()`), without needing to re-broadcast
  on every Homey restart.
- `node-broadlink` itself has **no timeout** on any call - a lost UDP packet
  (device briefly unreachable, a WiFi hiccup) would otherwise leave the
  returned promise pending forever, hanging whatever Flow triggered it.
  Every call into the library is wrapped with a hard timeout
  (`lib/withTimeout.js`) so a Flow action fails fast with a clear error
  instead.
- Learned signals are stored as hex strings in the device's own storage,
  keyed by the name given when learning - `getCommandNames()` feeds the
  autocomplete argument on the "Send signal"/"Send signal (hold)" cards.
- The authenticated AES session (`auth()`) is established once and reused
  across sends rather than re-authenticated on every call.

## Known limitations

- **Cloud-locked devices won't work.** Broadlink's own app can configure a
  device into cloud-only mode, which disables the local protocol this app
  (and `node-broadlink`, and Home Assistant's integration) relies on. If
  pairing finds your device but every send/learn call fails or times out,
  check the official Broadlink app's device settings for a "lock"/cloud-only
  toggle. The app logs a warning during pairing if a discovered device
  reports itself as locked.
- Only RM-series (IR/RF remote) devices are supported - not Broadlink's
  smart plugs, sensors, etc. (those exist in `node-broadlink` too, but
  aren't wired up here since they're outside this app's actual purpose).
- The resend interval is best-effort: actual spacing between sends also
  includes however long each individual UDP round-trip takes, so it won't
  be perfectly metronomic - this matches what the physical remote itself
  does anyway (its own repeat rate isn't perfectly even either).
- Not tested against real hardware from this development session (no local
  network access to a physical RM4 Pro from here) - the Broadlink
  connection logic (auth/learn/send/timeout behavior) is covered by 30
  automated checks against a simulated device, but the very first real
  install is the first time this runs against actual hardware. Expect to
  iterate if pairing or learning doesn't behave as expected on the first
  try.
