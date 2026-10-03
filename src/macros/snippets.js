// Expansion de texte : taper une abréviation (par exemple « ;mail ») la
// remplace aussitôt par le texte complet, dans n'importe quelle application.
// Alimenté par l'écoute clavier globale ; le remplacement efface
// l'abréviation (retours arrière) puis tape le texte en Unicode.
//
// Les caractères sont lus selon la disposition clavier active (AZERTY,
// accents, AltGr, touches mortes) ; sans les API Windows, repli sur une
// table QWERTY sans majuscules.

const input = require('./input');
const { VK } = require('./keys');
const layout = require('../system/keyboard-layout');

// Nom de touche Satella -> caractère tapé (repli QWERTY, sans majuscules :
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

// Touches qui ne tapent rien seules : sans effet sur la saisie en cours
const MODIFIERS = new Set(['lshift', 'rshift', 'lctrl', 'rctrl', 'lalt', 'ralt',
  'lwin', 'rwin', 'capslock', 'numlock', 'fn']);

class SnippetEngine {
  constructor({ translate = layout.translate, combineDead = layout.combineDead, typer = input } = {}) {
    this.snippets = [];
    this.buffer = '';
    this.dead = null;      // touche morte en attente (« ^ » avant « e »)
    this.expanding = false;
    this.translate = translate;
    this.combineDead = combineDead;
    this.typer = typer;
  }

  setSnippets(list) {
    this.snippets = (list || []).filter((s) => s.enabled && s.abbr && [...s.abbr].length >= 2);
    this.reset();
  }

  get active() { return this.snippets.length > 0; }

  // Nouvelle saisie (clic, changement de fenêtre, touche de navigation...)
  reset() {
    this.buffer = '';
    this.dead = null;
  }

  // Caractère(s) tapé(s) par la touche, '' si rien encore (touche morte),
  // null si la touche interrompt la saisie.
  charFor(key, mods) {
    const res = this.translate ? this.translate(VK[key], mods) : null;
    if (!res) {
      const ch = CHAR_MAP[key];
      return ch === undefined ? null : ch;
    }
    if (res.dead !== undefined) {
      if (this.dead) {
        const out = this.combineDead(this.dead, res.dead);
        this.dead = null;
        return out;
      }
      this.dead = res.dead;
      return '';
    }
    let text = res.text;
    if (!text || /[\u0000-\u001f\u007f]/.test(text)) {
      this.dead = null;
      return null; // Entrée, Tab, Échap, flèches...
    }
    if (this.dead) {
      text = this.combineDead(this.dead, text);
      this.dead = null;
    }
    return text;
  }

  // Une frappe physique (nom de touche Satella, appui uniquement)
  feed(key, mods = {}) {
    if (this.expanding || !this.active) return;
    if (key === 'backspace') {
      this.buffer = [...this.buffer].slice(0, -1).join('');
      this.dead = null;
      return;
    }
    if (MODIFIERS.has(key)) return;
    if ((mods.ctrl && !mods.alt) || mods.meta) {
      this.reset(); // raccourci (Ctrl+C...) : pas de la saisie
      return;
    }
    const ch = this.charFor(key, mods);
    if (ch === null) {
      this.reset();
      return;
    }
    if (!ch) return;
    this.buffer = [...(this.buffer + ch)].slice(-64).join('');
    const lower = this.buffer.toLowerCase();
    const hit = this.snippets.find((s) => lower.endsWith(s.abbr.toLowerCase()));
    if (hit) this.expand(hit);
  }

  expand(snippet) {
    if (!this.typer.available) return;
    this.expanding = true;
    this.reset();
    // Petite pause : laisser l'application recevoir la dernière frappe
    setTimeout(() => {
      try {
        const count = [...snippet.abbr].length;
        for (let i = 0; i < count; i++) this.typer.keyTap('backspace');
        this.typer.typeTextLines(String(snippet.text || ''));
      } catch { /* application fermée entre-temps */ }
      // Les frappes injectées repassent par l'écoute globale : on attend
      // qu'elles soient écoulées avant de réécouter
      setTimeout(() => { this.expanding = false; }, 200);
    }, 30);
  }
}

module.exports = { SnippetEngine, CHAR_MAP };
