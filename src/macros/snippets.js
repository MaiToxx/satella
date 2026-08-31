// Expansion de texte : taper une abréviation (par exemple « ;mail ») la
// remplace aussitôt par le texte complet, dans n'importe quelle application.
// Alimenté par l'écoute clavier globale ; le remplacement efface
// l'abréviation (retours arrière) puis tape le texte en Unicode.

const input = require('./input');

// Nom de touche Satella -> caractère tapé (base QWERTY, sans majuscules :
// la correspondance des abréviations ignore la casse)
const CHAR_MAP = {
  a: 'a', b: 'b', c: 'c', d: 'd', e: 'e', f: 'f', g: 'g', h: 'h', i: 'i',
  j: 'j', k: 'k', l: 'l', m: 'm', n: 'n', o: 'o', p: 'p', q: 'q', r: 'r',
  s: 's', t: 't', u: 'u', v: 'v', w: 'w', x: 'x', y: 'y', z: 'z',
  0: '0', 1: '1', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  np0: '0', np1: '1', np2: '2', np3: '3', np4: '4', np5: '5', np6: '6',
  np7: '7', np8: '8', np9: '9',
  semicolon: ';', comma: ',', period: '.', slash: '/', quote: "'",
  minus: '-', equal: '=', lbracket: '[', rbracket: ']', backslash: '\\',
  grave: '`', space: ' ', npdecimal: '.', npdivide: '/', npmultiply: '*',
  npsubtract: '-', npadd: '+',
};

class SnippetEngine {
  constructor() {
    this.snippets = [];
    this.buffer = '';
    this.expanding = false;
  }

  setSnippets(list) {
    this.snippets = (list || []).filter((s) => s.enabled && s.abbr && s.abbr.length >= 2);
    this.buffer = '';
  }

  get active() { return this.snippets.length > 0; }

  // Une frappe physique (nom de touche Satella, appui uniquement)
  feed(key) {
    if (this.expanding || !this.active) return;
    if (key === 'backspace') {
      this.buffer = this.buffer.slice(0, -1);
      return;
    }
    if (key === 'lshift' || key === 'rshift') return; // majuscules : sans effet
    const ch = CHAR_MAP[key];
    if (ch === undefined) {
      this.buffer = ''; // flèche, Ctrl, Entrée... : nouvelle saisie
      return;
    }
    this.buffer = (this.buffer + ch).slice(-64);
    const lower = this.buffer.toLowerCase();
    const hit = this.snippets.find((s) => lower.endsWith(s.abbr.toLowerCase()));
    if (hit) this.expand(hit);
  }

  expand(snippet) {
    if (!input.available) return;
    this.expanding = true;
    this.buffer = '';
    // Petite pause : laisser l'application recevoir la dernière frappe
    setTimeout(() => {
      try {
        for (let i = 0; i < snippet.abbr.length; i++) input.keyTap('backspace');
        const lines = String(snippet.text || '').split(/\r?\n/);
        lines.forEach((line, idx) => {
          if (line) input.typeText(line);
          if (idx < lines.length - 1) input.keyTap('enter');
        });
      } catch { /* application fermée entre-temps */ }
      // Les frappes injectées repassent par l'écoute globale : on attend
      // qu'elles soient écoulées avant de réécouter
      setTimeout(() => { this.expanding = false; }, 200);
    }, 30);
  }
}

module.exports = { SnippetEngine };
