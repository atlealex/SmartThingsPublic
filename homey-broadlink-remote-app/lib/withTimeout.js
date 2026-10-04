'use strict';

/**
 * node-broadlink's Device.sendPacket() waits on a single `socket.once('message', ...)`
 * with no timeout at all - if a UDP packet to/from the device is ever lost (a brief
 * WiFi hiccup, the device being briefly unreachable), the returned promise never
 * settles, which would otherwise hang a Flow action indefinitely. Every call into the
 * library is wrapped with this so a Flow fails fast with a clear error instead.
 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms - no response from the Broadlink device`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { withTimeout };
