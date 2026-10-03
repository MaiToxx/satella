const test = require('node:test');
const assert = require('node:assert/strict');
const { parseImport, makeExport } = require('../src/shared/sanitize');
const { VK } = require('../src/macros/keys');

const KEYS = Object.keys(VK);

test('un fichier qui n’est pas un export Satella est refusé', () => {
  assert.throws(() => parseImport('pas du json', KEYS), /JSON invalide/);
  assert.throws(() => parseImport('{"format":"autre"}', KEYS), /pas un fichier Satella/);
  assert.throws(() => parseImport('{"format":"satella","version":99,"kind":"profile"}', KEYS), /plus récente/);
});

test('un profil importé est nettoyé', () => {
  const doc = {
    format: 'satella', version: 1, kind: 'profile',
    profile: {
      name: '  Jeu <b>  ',
      isDefault: true,
      apps: ['Game.EXE', 'pas-un-exe', '../../evil.exe'],
      ledState: { keyboard: { effect: 'hack', baseColor: 'red', speed: 900, colors: { a: '#FF0000', 'x y': '#00ff00', b: 'bleu' } } },
      macros: [{
        id: 'ok_1', name: 'M', trigger: { accelerator: 'Ctrl+<script>' },
        options: { repeat: -5, speed: 99, holdMs: 5000 },
        steps: [
          { type: 'keyTap', key: 'a', modifiers: ['lctrl', 'rien'] },
          { type: 'keyTap', key: 'touche_inventée' },
          { type: 'evil' },
          { type: 'text', value: 'x'.repeat(20000) },
          { type: 'loop', count: 3, steps: [{ type: 'delay', ms: 1e9 }] },
        ],
      }],
    },
  };
  const { kind, profile } = parseImport(JSON.stringify(doc), KEYS);
  assert.equal(kind, 'profile');
  assert.equal(profile.name, 'Jeu <b>');      // le texte reste du texte (échappé à l'affichage)
  assert.equal(profile.isDefault, false);     // un import ne devient jamais profil par défaut
  assert.deepEqual(profile.apps, ['game.exe']);
  assert.equal(profile.ledState.keyboard.effect, 'static');
  assert.equal(profile.ledState.keyboard.baseColor, '#00a8ff');
  assert.equal(profile.ledState.keyboard.speed, 100);
  assert.deepEqual(profile.ledState.keyboard.colors, { a: '#ff0000' });
  const m = profile.macros[0];
  assert.equal(m.trigger, null);
  assert.equal(m.options.repeat, 1);
  assert.equal(m.options.speed, 4);
  assert.equal(m.options.holdMs, 1000);
  assert.deepEqual(m.steps.map((s) => s.type), ['keyTap', 'text', 'loop']);
  assert.deepEqual(m.steps[0].modifiers, ['lctrl']);
  assert.equal(m.steps[1].value.length, 10000);
  assert.equal(m.steps[2].steps[0].ms, 600000);
});

test('sauvegarde complète : aller-retour et un seul profil par défaut', () => {
  const data = {
    macros: [{ id: 'a', name: 'A', steps: [{ type: 'delay', ms: 10 }] }],
    profiles: [
      { name: 'P1', isDefault: true, ledState: {}, macros: [] },
      { name: 'P2', isDefault: true, ledState: {}, macros: [] },
      { name: 'P1', ledState: {}, macros: [] },
    ],
    snippets: [{ abbr: ';m', text: 'mail' }],
    turbos: [{ target: { type: 'key', key: 'space' }, cps: 500, accelerator: 'F8' }],
    settings: { idleMinutes: 500, launchAtStartup: true, ledsEnabled: false },
    keymap: { esc: 0, a: 300, b: 'x' },
    ledState: { keyboard: { effect: 'fire' } },
  };
  const { kind, data: d } = parseImport(makeExport('backup', data, '1.5.0'), KEYS);
  assert.equal(kind, 'backup');
  assert.deepEqual(d.profiles.map((p) => [p.name, p.isDefault]), [['P1', true], ['P2', false]]);
  assert.equal(d.turbos[0].cps, 50);
  assert.deepEqual(d.settings, { idleMinutes: 60, ledsEnabled: false }); // pas de lancement au démarrage importé
  assert.deepEqual(d.keymap, { esc: 0 });
  assert.equal(d.ledState.keyboard.effect, 'fire');
  assert.equal(d.snippets[0].abbr, ';m');
});
