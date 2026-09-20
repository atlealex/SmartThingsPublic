'use strict';

const sharp = require('sharp');

const DEFAULT_SIZE = 320;
const DEFAULT_RING_WIDTH = 20;
const DEFAULT_GAP = 8;

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

/**
 * Composites a person's photo into a circle with a colored presence ring
 * around it (green = home, gray = away, matching the Home Assistant avatar
 * cards this app's device tiles are meant to mirror).
 */
async function composeAvatar({ photoBuffer, ringColorHex, size = DEFAULT_SIZE, ringWidth = DEFAULT_RING_WIDTH, gap = DEFAULT_GAP }) {
  const photoSize = size - (ringWidth + gap) * 2;
  const photoOffset = Math.round((size - photoSize) / 2);

  const resizedPhoto = await sharp(photoBuffer)
    .resize(photoSize, photoSize, { fit: 'cover' })
    .toBuffer();

  const circleMask = Buffer.from(
    `<svg width="${photoSize}" height="${photoSize}"><circle cx="${photoSize / 2}" cy="${photoSize / 2}" r="${photoSize / 2}" fill="#fff"/></svg>`,
  );
  const circularPhoto = await sharp(resizedPhoto)
    .composite([{ input: circleMask, blend: 'dest-in' }])
    .png()
    .toBuffer();

  const ringRadius = size / 2 - ringWidth / 2;
  const ringSvg = Buffer.from(
    `<svg width="${size}" height="${size}">`
    + `<circle cx="${size / 2}" cy="${size / 2}" r="${ringRadius}" fill="none" stroke="${ringColorHex}" stroke-width="${ringWidth}"/>`
    + '</svg>',
  );

  return sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      { input: circularPhoto, top: photoOffset, left: photoOffset },
      { input: ringSvg, top: 0, left: 0 },
    ])
    .png()
    .toBuffer();
}

/** Fetches the photo at `photoUrl` and composes the ringed avatar PNG in one call. */
async function buildAvatarFromUrl(photoUrl, ringColorHex) {
  const photoBuffer = await fetchPhotoBuffer(photoUrl);
  return composeAvatar({ photoBuffer, ringColorHex });
}

module.exports = { composeAvatar, buildAvatarFromUrl, fetchPhotoBuffer };
