'use strict';

const dgram = require('dgram');
const os = require('os');
const { genDevice } = require('node-broadlink');

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_PORT = 80;

function ipToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

/**
 * Picks which local network interface to send from: the one on the same
 * subnet as the target address when one exists, otherwise the first
 * non-internal IPv4 interface. Needed because unicast (unlike the library's
 * own broadcast discover()) has to be sent from a specific, routable local
 * address rather than every interface at once.
 */
function selectLocalAddress(targetAddress) {
  const interfaces = Object.values(os.networkInterfaces())
    .flat()
    .filter((iface) => iface && iface.family === 'IPv4' && !iface.internal);

  if (interfaces.length === 0) return null;

  const target = ipToInt(targetAddress);
  const sameSubnet = interfaces.find((iface) => {
    const mask = ipToInt(iface.netmask);
    return (ipToInt(iface.address) & mask) === (target & mask);
  });

  return (sameSubnet || interfaces[0]).address;
}

/**
 * Builds the same "hello" discovery packet node-broadlink's own discover()
 * sends - see node_modules/node-broadlink/dist/index.js. Kept identical
 * field-for-field so a device replies to it exactly as it would to a
 * broadcast discovery.
 */
function buildHelloPacket(localAddress, localPort) {
  const address = localAddress.split('.');
  const now = new Date();
  const timezone = now.getTimezoneOffset() / -3600;
  const year = now.getFullYear() - 1900;
  const packet = Buffer.alloc(0x30);

  if (timezone < 0) {
    packet[0x08] = 0xff + timezone - 1;
    packet[0x09] = 0xff;
    packet[0x0a] = 0xff;
    packet[0x0b] = 0xff;
  } else {
    packet[0x08] = timezone;
    packet[0x09] = 0;
    packet[0x0a] = 0;
    packet[0x0b] = 0;
  }
  packet[0x0c] = year & 0xff;
  packet[0x0d] = (year >> 8) & 0xff;
  packet[0x0e] = now.getMinutes();
  packet[0x0f] = now.getHours();
  packet[0x10] = ~~year % 100;
  packet[0x11] = now.getDay();
  packet[0x12] = now.getDay();
  packet[0x13] = now.getMonth();
  packet[0x18] = ~~address[0];
  packet[0x19] = ~~address[1];
  packet[0x1a] = ~~address[2];
  packet[0x1b] = ~~address[3];
  packet[0x1c] = localPort & 0xff;
  packet[0x1d] = (localPort >> 8) & 0xff;
  packet[0x26] = 6;

  const checksum = packet.reduce((acc, b) => acc + b, 0xbeaf) & 0xffff;
  packet[0x20] = checksum & 0xff;
  packet[0x21] = (checksum >> 8) & 0xff;
  return packet;
}

/** Parses a hello response the same way node-broadlink's discover() does, and constructs the proper typed device via genDevice(). */
function parseHelloResponse(msg, rinfo) {
  const deviceType = msg[0x34] | (msg[0x35] << 8);
  const mac = [...msg.subarray(0x3a, 0x40)].reverse();
  const nameSlice = msg.slice(0x40, 0x7e);
  const nullIndex = nameSlice.indexOf(0x00);
  const name = nameSlice.slice(0, nullIndex === -1 ? nameSlice.length : nullIndex).toString('utf8');
  const isLocked = !!msg[0x7f];
  return genDevice(deviceType, rinfo, mac, name, isLocked);
}

/**
 * Discovers a single Broadlink device by sending the discovery packet
 * directly (unicast) to its IP address instead of broadcasting it to the
 * whole subnet. Exists because plain broadcast discovery (node-broadlink's
 * own discover()) found zero devices on this network even when the target
 * device was confirmed reachable - likely broadcast/multicast traffic being
 * filtered by network equipment, which doesn't affect direct unicast.
 *
 * @returns {Promise<object|null>} the discovered device (as genDevice()
 *   returns it), or null if it didn't respond within timeoutMs.
 */
function discoverByAddress(address, timeoutMs = DEFAULT_TIMEOUT_MS, discoverIpPort = DEFAULT_PORT) {
  return new Promise((resolve, reject) => {
    const localAddress = selectLocalAddress(address);
    if (!localAddress) {
      reject(new Error('No local network interface found to discover from'));
      return;
    }

    const socket = dgram.createSocket('udp4');
    let settled = false;
    let timer = null;

    const finish = (result, error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(result);
    };

    socket.once('error', (err) => finish(null, err));

    socket.once('listening', () => {
      const localPort = socket.address().port;
      const packet = buildHelloPacket(localAddress, localPort);
      socket.send(packet, 0, packet.length, discoverIpPort, address, (err) => {
        if (err) finish(null, err);
      });
    });

    socket.on('message', (msg, rinfo) => {
      if (rinfo.address !== address) return; // ignore replies from other devices on a shared segment
      try {
        finish(parseHelloResponse(msg, rinfo));
      } catch (err) {
        finish(null, err);
      }
    });

    socket.bind({ address: localAddress });

    timer = setTimeout(() => finish(null), timeoutMs);
  });
}

module.exports = { discoverByAddress, selectLocalAddress, buildHelloPacket, parseHelloResponse };
