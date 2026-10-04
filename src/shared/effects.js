// Réglages personnalisables de chaque effet du clavier : d'où viennent les
// couleurs et les paramètres propres à l'effet (densité, largeur...).
// Chargeable côté main (require) et côté interface (balise <script>).
//
// Les réglages choisis sont rangés dans l'état du clavier, effet par effet :
//   keyboard.fx = { fire: { colors: 'duo', height: 140 }, rain: { density: 300 } }
// Un réglage absent garde sa valeur par défaut.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SATELLA_EFFECTS = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // Sources de couleur possibles
  const COLOR_MODES = {
    base: 'Couleur unique',
    duo: 'Deux couleurs',
    palette: 'Palette',
    rainbow: 'Arc-en-ciel',
    fire: 'Flammes',
    gauge: 'Vert → rouge',
    heat: 'Bleu → rouge',
    screen: 'Couleurs de l\'écran',
  };

  const pct = (id, label, def, min, max) => ({ id, label, def, min, max, step: 5, unit: '%' });

  // Pour chaque effet : sources de couleur proposées (la première est celle
  // par défaut) et paramètres. `native` : réglages que le clavier sait
  // exécuter lui-même ; au-delà, Satella calcule l'effet et le diffuse.
  const EFFECT_SETTINGS = {
    static: { colors: ['base'], params: [] },
    breathing: {
      colors: ['base', 'palette', 'rainbow'],
      params: [pct('depth', 'Profondeur', 92, 20, 100)],
      native: true,
    },
    wave: {
      colors: ['rainbow', 'palette', 'duo'],
      params: [pct('width', 'Largeur des bandes', 100, 25, 300)],
      native: true,
    },
    rainbow: { colors: ['rainbow', 'palette'], params: [], native: true },
    reactive: {
      colors: ['base', 'rainbow', 'palette'],
      params: [
        pct('fade', 'Durée de la lueur', 100, 20, 400),
        { id: 'spread', label: 'Rayon', def: 0, min: 0, max: 3, step: 1, unit: ' touche(s)' },
      ],
      native: true,
    },
    ripple: {
      colors: ['base', 'rainbow', 'palette'],
      params: [pct('width', 'Épaisseur de l\'onde', 100, 40, 300), pct('reach', 'Portée', 100, 30, 300)],
    },
    sparkle: {
      colors: ['base', 'rainbow', 'palette'],
      params: [pct('density', 'Densité', 100, 10, 600)],
      native: true,
    },
    fire: {
      colors: ['fire', 'duo', 'palette'],
      params: [pct('height', 'Hauteur des flammes', 100, 30, 200)],
    },
    rain: {
      colors: ['base', 'rainbow', 'palette'],
      params: [pct('density', 'Densité', 100, 20, 500), pct('length', 'Longueur des gouttes', 100, 30, 300)],
    },
    scanner: {
      colors: ['base', 'duo', 'rainbow', 'palette'],
      params: [pct('width', 'Largeur du faisceau', 100, 40, 400)],
    },
    spiral: {
      colors: ['rainbow', 'palette', 'duo'],
      params: [{ id: 'arms', label: 'Nombre de bras', def: 1, min: 1, max: 6, step: 1, unit: '' }],
    },
    disco: {
      colors: ['rainbow', 'palette', 'base'],
      params: [pct('density', 'Touches allumées', 42, 10, 90)],
    },
    gradient: {
      colors: ['duo', 'palette'],
      params: [pct('width', 'Largeur', 100, 25, 300)],
    },
    palette: {
      colors: ['palette'],
      params: [pct('width', 'Largeur', 100, 25, 300)],
    },
    sysmon: { colors: ['gauge', 'duo'], params: [] },
    audio: {
      colors: ['duo', 'rainbow', 'palette'],
      params: [pct('gain', 'Sensibilité', 100, 50, 300)],
    },
    screen: { colors: ['screen'], params: [pct('saturation', 'Saturation', 100, 0, 200)] },
    heatmap: { colors: ['heat', 'duo'], params: [] },
    off: { colors: [], params: [] },
  };

  // Réglages effectifs d'un effet (valeurs par défaut complétées)
  function fxSettings(state, effect) {
    const def = EFFECT_SETTINGS[effect];
    if (!def) return { colors: 'base' };
    const saved = state && state.fx && state.fx[effect] ? state.fx[effect] : {};
    const out = { colors: def.colors.includes(saved.colors) ? saved.colors : (def.colors[0] || 'base') };
    for (const p of def.params) {
      const v = Number(saved[p.id]);
      out[p.id] = Number.isFinite(v) ? Math.max(p.min, Math.min(p.max, v)) : p.def;
    }
    return out;
  }

  // L'effet est-il réglé comme le clavier sait le faire seul ? Sinon,
  // Satella le calcule et le diffuse en continu (mode dynamique).
  function isNativeCompatible(state, effect = state && state.effect) {
    const def = EFFECT_SETTINGS[effect];
    if (!def || !def.native) return true;
    const s = fxSettings(state, effect);
    return s.colors === def.colors[0] && def.params.every((p) => s[p.id] === p.def);
  }

  // Validation des réglages (fichiers importés, état enregistré)
  function sanitizeFx(v) {
    const out = {};
    if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
    for (const [effect, def] of Object.entries(EFFECT_SETTINGS)) {
      const src = v[effect];
      if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
      const o = {};
      if (def.colors.includes(src.colors)) o.colors = src.colors;
      for (const p of def.params) {
        const n = Number(src[p.id]);
        if (typeof src[p.id] === 'number' && Number.isFinite(n)) o[p.id] = Math.round(Math.max(p.min, Math.min(p.max, n)));
      }
      if (Object.keys(o).length) out[effect] = o;
    }
    return out;
  }

  return { COLOR_MODES, EFFECT_SETTINGS, fxSettings, isNativeCompatible, sanitizeFx };
});
