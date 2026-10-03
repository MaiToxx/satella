// Outils communs aux tests : injection d'entrées simulée (aucune frappe
// réelle n'est envoyée), raccourcis globaux factices.

function fakeInput() {
  const log = [];
  const held = new Set();
  const buttons = new Set();
  return {
    log,
    held,
    buttons,
    available: true,
    keyDown(k) { if (k === 'inconnue') throw new Error('Touche inconnue : ' + k); held.add(k); log.push('down ' + k); },
    keyUp(k) { held.delete(k); log.push('up ' + k); },
    keyTap(k) { log.push('tap ' + k); },
    typeText(t) { log.push('text ' + t); },
    typeTextLines(t) { log.push('lines ' + JSON.stringify(t)); },
    mouseButton(b, up) { if (up) buttons.delete(b); else buttons.add(b); log.push((up ? 'mup ' : 'mdown ') + b); },
    mouseClick(b) { log.push('click ' + b); },
    mouseMove(x, y, rel) { log.push(`move ${x},${y}${rel ? ' rel' : ''}`); },
    mouseWheel(d, h) { log.push(`wheel ${d}${h ? ' h' : ''}`); },
  };
}

function fakeShortcuts(taken = []) {
  const registered = new Map();
  return {
    registered,
    unregisterAll() { registered.clear(); },
    register(accel, cb) {
      if (taken.includes(accel) || registered.has(accel)) return false;
      registered.set(accel, cb);
      return true;
    },
  };
}

module.exports = { fakeInput, fakeShortcuts };
