/**
 * Lazily load the QR encoder.
 *
 * `qrcode` is only needed while a channel provisions a bot (scan to bind), yet
 * six channel RPC modules used to import it eagerly at Host startup. The
 * package is small in bytes but large enough once PNG tables and its canvas
 * helpers initialize, so it is loaded on the first QR request and reused.
 */
let loading;

function load() {
  loading ??= import('qrcode').then((module) => module.default ?? module);
  return loading;
}

/** Render QR text as a data URL. */
export async function qrToDataUrl(text, options) {
  return (await load()).toDataURL(text, options);
}

/** Render QR text as an image buffer. */
export async function qrToBuffer(text, options) {
  return (await load()).toBuffer(text, options);
}
