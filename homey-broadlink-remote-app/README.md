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
2. Add a device, choose **Broadlink remote** - pairing first tries an
   automatic network-wide search (the device must already be joined to your
   WiFi; this app doesn't do the initial AP-mode WiFi setup - if it's already
   working in the existing Broadlink app or Home Assistant, it's already on
   your network). If that finds nothing within a few seconds - some
   networks/access points block this kind of broadcast traffic - the pairing
   screen instead asks for the device's **IP address** and searches directly
   by that instead (see "How discovery works" below). Find the IP address the
   same way you'd look up any device's IP on your router or access point's
   client list (by its MAC address or name).
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
- Pairing stores each found device's IP, MAC and device-type code -
  `onInit()` reconstructs a connection from that stored info directly
  (`genDevice()`), without needing to re-discover on every Homey restart.

### How discovery works

Broadlink devices normally announce themselves by replying to a UDP packet
*broadcast* to the whole local subnet (`discover()` in `node-broadlink`).
On some networks this broadcast traffic never reaches the device - commonly
because an access point or managed switch filters it for security reasons -
so pairing would find nothing even though the device is online and otherwise
reachable.

To work around this, pairing (`drivers/remote/pair/start.html` +
`onPair()` in `drivers/remote/driver.js`) tries the normal broadcast search
first, and if that comes back empty, falls back to asking for the device's
IP address and sending the exact same discovery packet directly
(*unicast*) to that one address instead (`lib/discoverByAddress.js`). Most
networks that block broadcast still deliver ordinary unicast traffic fine,
since it isn't flooded to every device on the segment. The packet format and
response parsing are identical to `node-broadlink`'s own broadcast
discovery - only the destination address differs - and the resulting device
object is built with the same `genDevice()` the library itself uses, so
everything downstream (auth, send, learn) works the same regardless of which
discovery path found it.
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
  connection and discovery logic (auth/learn/send/timeout/discovery
  behavior) is covered by around 49 automated checks against simulated
  devices and network responses, but the very first real install is the
  first time this runs against actual hardware. Expect to iterate if pairing
  or learning doesn't behave as expected on the first try.
