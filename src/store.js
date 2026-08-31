// Persistance JSON simple (macros, profils, état des LEDs) dans le dossier
// de données utilisateur de l'application.

const fs = require('fs');
const path = require('path');

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  file(name) { return path.join(this.dir, name + '.json'); }

  read(name, fallback) {
    try {
      return JSON.parse(fs.readFileSync(this.file(name), 'utf8'));
    } catch {
      return fallback;
    }
  }

  write(name, data) {
    const tmp = this.file(name) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file(name));
  }
}

module.exports = { Store };
