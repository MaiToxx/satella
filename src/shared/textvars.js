// Variables dans le texte tapé (étapes « Texte » des macros, abréviations) :
//   {date} 03/10/2026 · {heure} 14:05 · {jour} samedi · {mois} octobre
//   {annee} 2026 · {presse-papiers} contenu copié · {curseur} position finale
// Une variable inconnue reste telle quelle (accolades comprises).

const VARS = ['date', 'heure', 'jour', 'mois', 'annee', 'presse-papiers', 'curseur'];
const CURSOR = '\u0000';

const pad2 = (n) => String(n).padStart(2, '0');

// Nombre d'appuis sur ← pour remonter un texte (un retour à la ligne
// compte pour un)
const leftPresses = (s) => [...s.replace(/\r\n/g, '\n')].length;

// Remplace les variables. `clipboard` : fonction appelée seulement si le
// texte contient {presse-papiers}. Renvoie { text, back } : `back` = appuis
// sur ← pour placer le curseur à l'endroit de {curseur}.
function expand(template, { now = new Date(), clipboard = () => '' } = {}) {
  const src = String(template || '').replace(/\u0000/g, '');
  if (!src.includes('{')) return { text: src, back: 0 };
  let clip = null;
  let cursorSeen = false;
  const valueOf = (key) => {
    switch (key) {
      case 'date': return `${pad2(now.getDate())}/${pad2(now.getMonth() + 1)}/${now.getFullYear()}`;
      case 'heure': return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
      case 'jour': return now.toLocaleDateString('fr-FR', { weekday: 'long' });
      case 'mois': return now.toLocaleDateString('fr-FR', { month: 'long' });
      case 'annee': return String(now.getFullYear());
      case 'presse-papiers':
        if (clip === null) clip = String(clipboard() || '').replace(/\u0000/g, '').slice(0, 20000);
        return clip;
      case 'curseur':
        if (cursorSeen) return '';
        cursorSeen = true;
        return CURSOR;
      default: return null;
    }
  };
  const out = src.replace(/\{([a-z-]+)\}/gi, (whole, name) => {
    const v = valueOf(name.toLowerCase());
    return v === null ? whole : v;
  });
  const at = out.indexOf(CURSOR);
  if (at < 0) return { text: out, back: 0 };
  const after = out.slice(at + 1);
  return { text: out.slice(0, at) + after, back: leftPresses(after) };
}

module.exports = { expand, VARS };
