// Thread dédié au flux temps réel vers le clavier (protocole EVision V2,
// commande 0x12). Tourne hors du processus principal pour ne jamais figer
// l'interface ni le moteur d'effets.
//
// Principes :
// - une seule image « en attente » : si le moteur envoie plus vite que le
//   clavier n'écrit, les images intermédiaires sont remplacées (pas de file) ;
// - seuls les blocs de 54 octets modifiés depuis la dernière écriture sont
//   envoyés (souvent 1 à 3 blocs au lieu de 8) ;
// - chaque paquet attend l'accusé du firmware (régulation de débit, le
//   clavier décroche sinon) ;
// - un entretien périodique évite que le clavier quitte le mode dynamique
//   quand l'image ne change pas.

const { parentPort, workerData } = require('worker_threads');
const HID = require('node-hid');

const KB_CMD_DYNAMIC = 0x12;

let dev = null;
let latest = null;        // dernière image reçue, non écrite
let lastWritten = null;   // dernière image réellement écrite
let paused = false;
let running = true;
let lastWriteAt = 0;

function drain() {
  try {
    for (let i = 0; i < 64; i++) {
      const r = dev.readTimeout(0);
      if (!r || !r.length) break;
    }
  } catch { /* rien à vider */ }
}

function writeChunk(offset, chunk) {
  const buf = new Array(64).fill(0);
  buf[0] = 0x04;
  buf[3] = KB_CMD_DYNAMIC;
  buf[4] = chunk.length;
  buf[5] = offset & 0xff;
  buf[6] = (offset >> 8) & 0xff;
  for (let i = 0; i < chunk.length; i++) buf[8 + i] = chunk[i];
  let sum = 0;
  for (let i = 3; i < 64; i++) sum = (sum + buf[i]) & 0xffff;
  buf[1] = sum & 0xff;
  buf[2] = sum >> 8;
  dev.write(Buffer.from(buf));
  const resp = dev.readTimeout(300);
  if (!resp || !resp.length) throw new Error('clavier muet pendant le flux');
  if (resp[7] !== 0) throw new Error(`erreur firmware ${resp[7]} pendant le flux`);
}

function sameChunk(a, b, start, len) {
  for (let i = start; i < start + len && i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function pump() {
  if (!running) return;
  if (paused || (!latest && Date.now() - lastWriteAt < 700)) {
    setTimeout(pump, 15);
    return;
  }
  try {
    if (latest) {
      const frame = latest;
      latest = null;
      let wrote = 0;
      for (let i = 0; i < frame.length; i += 54) {
        const len = Math.min(54, frame.length - i);
        if (lastWritten && sameChunk(lastWritten, frame, i, len)) continue;
        writeChunk(i, frame.slice(i, i + len));
        wrote++;
      }
      lastWritten = frame;
      if (wrote) lastWriteAt = Date.now();
    } else {
      // Entretien : réécrit le premier bloc pour rester en mode dynamique
      if (lastWritten) {
        writeChunk(0, lastWritten.slice(0, 54));
        lastWriteAt = Date.now();
      }
    }
  } catch (err) {
    parentPort.postMessage({ type: 'error', message: err.message });
    running = false;
    try { dev.close(); } catch { /* déjà fermé */ }
    return;
  }
  setImmediate(pump);
}

parentPort.on('message', (msg) => {
  switch (msg.type) {
    case 'frame':
      latest = msg.data;
      break;
    case 'pause':
      paused = true;
      parentPort.postMessage({ type: 'paused' });
      break;
    case 'resume':
      drain();
      lastWritten = null; // tout réécrire après une pause (l'état a pu changer)
      paused = false;
      break;
    case 'stop':
      running = false;
      try { dev.close(); } catch { /* déjà fermé */ }
      process.exit(0);
      break;
    default:
      break;
  }
});

try {
  dev = new HID.HID(workerData.path);
  drain();
  pump();
} catch (err) {
  parentPort.postMessage({ type: 'error', message: 'ouverture impossible : ' + err.message });
}
