// Journal fichier : en version installée, la console n'est visible nulle
// part. Les messages de console sont recopiés dans
// %APPDATA%/satella-rgb/logs/satella.log (1 Mo max, puis satella.old.log).

const fs = require('fs');
const path = require('path');
const util = require('util');

const MAX_SIZE = 1024 * 1024;
let dir = null;
let file = null;

function rotate() {
  try {
    if (fs.statSync(file).size > MAX_SIZE) {
      fs.renameSync(file, path.join(dir, 'satella.old.log'));
    }
  } catch { /* pas encore de fichier */ }
}

function write(level, args) {
  if (!file) return;
  const line = `${new Date().toISOString()} [${level}] ${util.format(...args)}\n`;
  try {
    rotate();
    fs.appendFileSync(file, line, 'utf8');
  } catch { /* disque plein ou dossier inaccessible : tant pis */ }
}

function init(logDir) {
  dir = logDir;
  file = path.join(dir, 'satella.log');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  for (const [method, level] of [['log', 'info'], ['info', 'info'], ['warn', 'avert'], ['error', 'ERREUR']]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      write(level, args);
    };
  }
  process.on('uncaughtException', (err) => {
    write('ERREUR', ['Exception non gérée :', err && err.stack ? err.stack : err]);
  });
  process.on('unhandledRejection', (reason) => {
    write('ERREUR', ['Promesse rejetée non gérée :', reason && reason.stack ? reason.stack : reason]);
  });
}

// Fin du journal (pour le diagnostic copiable)
function tail(maxBytes = 32 * 1024) {
  if (!file) return '';
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const text = buf.toString('utf8');
      return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

module.exports = { init, tail, get dir() { return dir; } };
