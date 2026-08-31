// Détection USB/HID des périphériques branchés (node-hid).
// Sert au diagnostic : repérer le clavier SURMEN GS98 et la souris
// Risophy PC365A, leurs identifiants VID/PID et interfaces disponibles.

let HID = null;
let hidError = null;
try {
  HID = require('node-hid');
} catch (err) {
  hidError = err;
}

function listDevices() {
  if (!HID) return { available: false, error: hidError && hidError.message, devices: [] };
  let devices = [];
  try {
    devices = HID.devices();
  } catch (err) {
    return { available: true, error: err.message, devices: [] };
  }

  const seen = new Map();
  for (const d of devices) {
    const key = `${d.vendorId}:${d.productId}`;
    if (!seen.has(key)) {
      seen.set(key, {
        vendorId: d.vendorId,
        productId: d.productId,
        vid: '0x' + d.vendorId.toString(16).padStart(4, '0'),
        pid: '0x' + d.productId.toString(16).padStart(4, '0'),
        manufacturer: d.manufacturer || '',
        product: d.product || '',
        interfaces: [],
      });
    }
    seen.get(key).interfaces.push({
      interface: d.interface,
      usagePage: d.usagePage,
      usage: d.usage,
      path: d.path,
    });
  }

  const result = [...seen.values()];
  for (const dev of result) {
    const text = `${dev.manufacturer} ${dev.product}`.toLowerCase();
    dev.looksLikeKeyboard = dev.interfaces.some((i) => i.usagePage === 1 && i.usage === 6) || /keyboard|clavier/.test(text);
    dev.looksLikeMouse = dev.interfaces.some((i) => i.usagePage === 1 && i.usage === 2) || /mouse|souris/.test(text);
    // Interface "vendor" (usagePage >= 0xFF00) = canal probable de contrôle RGB
    dev.hasVendorInterface = dev.interfaces.some((i) => (i.usagePage || 0) >= 0xff00);
    dev.isLikelyTarget = /surmen|gs98|risophy|pc365/.test(text);
  }
  return { available: true, error: null, devices: result };
}

module.exports = { listDevices };
