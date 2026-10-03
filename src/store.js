// Persistance JSON simple (macros, profils, état des LEDs) dans le dossier
// de données utilisateur de l'application.
//
// - cache mémoire : les lectures répétées ne touchent pas le disque ;
// - écriture atomique (fichier temporaire puis renommage) avec une copie
//   .bak de la version précédente ;
// - un fichier illisible n'est jamais écrasé en silence : il est mis de
//   côté (.corrupt-<date>.json) et la copie .bak prend le relais ;
// - writeLater() regroupe les écritures rapprochées (curseurs).

const fs = require('fs');
const path = require('path');

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

class Store {
  constructor(dir, { log = () => {} } = {}) {
    this.dir = dir;
    this.log = log;
    this.cache = new Map();
    this.pending = new Map(); // nom -> minuteur d'écriture différée
    fs.mkdirSync(dir, { recursive: true });
  }

  file(name) { return path.join(this.dir, name + '.json'); }

  // Lit un fichier JSON ; renvoie undefined s'il n'existe pas, lève une
  // erreur s'il est illisible.
  _load(file) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return undefined;
      throw err;
    }
    return JSON.parse(text);
  }

  read(name, fallback) {
    if (this.cache.has(name)) return clone(this.cache.get(name));
    const file = this.file(name);
    let data;
    try {
      data = this._load(file);
    } catch (err) {
      // Fichier corrompu : le mettre de côté, puis essayer la sauvegarde
      const aside = path.join(this.dir, `${name}.corrupt-${Date.now()}.json`);
      try { fs.renameSync(file, aside); } catch { /* lecture seule ? */ }
      this.log(`Fichier ${name}.json illisible (${err.message}), mis de côté : ${aside}`);
      try {
        data = this._load(file + '.bak');
        if (data !== undefined) this.log(`${name}.json restauré depuis la copie de sauvegarde`);
      } catch { data = undefined; }
    }
    if (data === undefined) return fallback;
    this.cache.set(name, data);
    return clone(data);
  }

  write(name, data) {
    clearTimeout(this.pending.get(name));
    this.pending.delete(name);
    this.cache.set(name, clone(data));
    this._flushOne(name);
  }

  // Écriture différée : la donnée est figée tout de suite (cache), le
  // disque n'est touché qu'après `ms` sans nouvelle écriture.
  writeLater(name, data, ms = 500) {
    this.cache.set(name, clone(data));
    clearTimeout(this.pending.get(name));
    this.pending.set(name, setTimeout(() => {
      this.pending.delete(name);
      this._flushOne(name);
    }, ms));
  }

  _flushOne(name) {
    const file = this.file(name);
    const tmp = file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.cache.get(name), null, 2), 'utf8');
      if (fs.existsSync(file)) {
        try { fs.copyFileSync(file, file + '.bak'); } catch { /* best effort */ }
      }
      fs.renameSync(tmp, file);
    } catch (err) {
      this.log(`Écriture de ${name}.json impossible : ${err.message}`);
    }
  }

  // Écrit immédiatement tout ce qui attend (à la fermeture de l'app)
  flush() {
    for (const [name, timer] of this.pending) {
      clearTimeout(timer);
      this._flushOne(name);
    }
    this.pending.clear();
  }
}

module.exports = { Store };
