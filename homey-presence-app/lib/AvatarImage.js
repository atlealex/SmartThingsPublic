'use strict';

const Jimp = require('jimp');

const DEFAULT_SIZE = 320;
const DEFAULT_RING_WIDTH = 20;
const DEFAULT_GAP = 8;
const SUPERSAMPLE = 2; // render at 2x then downscale, for smoother circular edges

async function fetchPhotoBuffer(url) {
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    const cause = err.cause ? ` (${err.cause.code || err.cause.message || err.cause})` : '';
    throw new Error(`Could not fetch photo (${url}): ${err.message}${cause}`);
  }
  if (!res.ok) {
    throw new Error(`Could not fetch photo (${url}): HTTP ${res.status} ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function parseHexColor(hex) {
  const clean = hex.replace('#', '');
  return {
    r: parseInt(clean.substring(0, 2), 16),
    g: parseInt(clean.substring(2, 4), 16),
    b: parseInt(clean.substring(4, 6), 16),
  };
}

/**
 * Composites a person's photo into a circle with a colored presence ring
 * around it (green = home, gray = away, matching the Home Assistant avatar
 * cards this app's device tiles are meant to mirror).
 *
 * Uses jimp (pure JavaScript, no native binaries) rather than sharp -
 * sharp's platform-specific compiled binary was fetched for whatever OS
 * `npm install` happened to run on (typically a Windows dev PC), not for
 * the Homey Pro's actual Linux/ARM runtime, which would crash the app at
 * image-generation time. Jimp runs identically everywhere.
 */
async function composeAvatar({ photoBuffer, ringColorHex, size = DEFAULT_SIZE, ringWidth = DEFAULT_RING_WIDTH, gap = DEFAULT_GAP }) {
  const scale = SUPERSAMPLE;
  const bigSize = size * scale;
  const bigRingWidth = ringWidth * scale;
  const bigGap = gap * scale;
  const photoSize = bigSize - (bigRingWidth + bigGap) * 2;
  const photoOffset = Math.round((bigSize - photoSize) / 2);

  const photo = await Jimp.read(photoBuffer);
  photo.cover(photoSize, photoSize);
  photo.circle();

  const canvas = new Jimp(bigSize, bigSize, 0x00000000);
  canvas.composite(photo, photoOffset, photoOffset);

  const { r, g, b } = parseHexColor(ringColorHex);
  const cx = bigSize / 2;
  const cy = bigSize / 2;
  const outerRadius = bigSize / 2;
  const innerRadius = outerRadius - bigRingWidth;
  canvas.scan(0, 0, bigSize, bigSize, function drawRingPixel(x, y, idx) {
    const dx = x - cx;
    const dy = y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= outerRadius && dist >= innerRadius) {
      this.bitmap.data[idx] = r;
      this.bitmap.data[idx + 1] = g;
      this.bitmap.data[idx + 2] = b;
      this.bitmap.data[idx + 3] = 255;
    }
  });

  canvas.resize(size, size);
  return canvas.getBufferAsync(Jimp.MIME_PNG);
}

/** Fetches the photo at `photoUrl` and composes the ringed avatar PNG in one call. */
async function buildAvatarFromUrl(photoUrl, ringColorHex) {
  const photoBuffer = await fetchPhotoBuffer(photoUrl);
  return composeAvatar({ photoBuffer, ringColorHex });
}

module.exports = { composeAvatar, buildAvatarFromUrl, fetchPhotoBuffer };
