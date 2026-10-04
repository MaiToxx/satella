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

test('étape « Ouvrir » : seuls les liens web/courriel et les chemins Windows passent', () => {
  const { openTarget, openTargets, stripOpenSteps } = require('../src/shared/sanitize');
  assert.equal(openTarget('https://discord.com/app'), 'https://discord.com/app');
  assert.equal(openTarget('  mailto:moi@exemple.fr '), 'mailto:moi@exemple.fr');
  assert.equal(openTarget('C:\\Program Files\\OBS\\obs64.exe'), 'C:\\Program Files\\OBS\\obs64.exe');
  assert.equal(openTarget('\\\\serveur\\partage\\doc.pdf'), '\\\\serveur\\partage\\doc.pdf');
  for (const bad of ['javascript:alert(1)', 'file:///C:/x', 'calc.exe', 'ms-settings:display', 'C:\\a\nb', '', null]) {
    assert.equal(openTarget(bad), '', String(bad));
  }
  const macros = [{ id: 'a', steps: [
    { type: 'open', target: 'https://a.fr' },
    { type: 'loop', count: 2, steps: [{ type: 'open', target: 'C:\\b.exe' }, { type: 'delay', ms: 1 }] },
  ] }];
  assert.deepEqual(openTargets(macros), ['https://a.fr', 'C:\\b.exe']);
  const clean = stripOpenSteps(macros);
  assert.deepEqual(openTargets(clean), []);
  assert.equal(clean[0].steps[0].steps.length, 1);
});

test('import : une étape « Ouvrir » invalide est retirée', () => {
  const doc = { format: 'satella', version: 1, kind: 'profile', profile: { name: 'P', macros: [{ id: 'm', steps: [
    { type: 'open', target: 'https://ok.fr' }, { type: 'open', target: 'powershell -c evil' },
  ] }] } };
  const { profile } = parseImport(JSON.stringify(doc), KEYS);
  assert.deepEqual(profile.macros[0].steps.map((s) => s.target), ['https://ok.fr']);
});

test('import : étape « Attendre une touche » et réglages du mode nuit validés', () => {
  const { settingsPatch } = require('../src/shared/sanitize');
  const doc = { format: 'satella', version: 1, kind: 'profile', profile: { name: 'P', macros: [{ id: 'm', steps: [
    { type: 'waitKey', key: 'f8', timeoutMs: 999999999 }, { type: 'waitKey', key: 'inventée' },
  ] }] } };
  const { profile } = parseImport(JSON.stringify(doc), KEYS);
  assert.deepEqual(profile.macros[0].steps, [{ type: 'waitKey', gapMs: 15, key: 'f8', timeoutMs: 600000 }]);
  assert.deepEqual(settingsPatch({
    keyStats: true, nightMode: true, nightFrom: '22:30', nightTo: '24:00', nightAction: 'boom', nightLevel: 1,
  }), { keyStats: true, nightMode: true, nightFrom: '22:30', nightLevel: 5 });
});

test('import : témoins, minuteur, sauvegardes et raccourcis de l’application validés', () => {
  const { settingsPatch } = require('../src/shared/sanitize');
  assert.deepEqual(settingsPatch({
    lockIndicators: true, lockColor: '#FFAA00', timerMinutes: 999, autoBackup: false,
    appShortcuts: { leds: 'Ctrl+Alt+L', timer: 'Ctrl+Alt+<script>', inconnue: 'F9' },
  }), {
    lockIndicators: true, lockColor: '#ffaa00', timerMinutes: 180, autoBackup: false,
    appShortcuts: { leds: 'Ctrl+Alt+L', nextProfile: '', brightUp: '', brightDown: '', stopAll: '', timer: '', palette: '' },
  });
  assert.deepEqual(settingsPatch({ lockColor: 'rouge', appShortcuts: null }), {});
});

test('import : plage horaire des profils validée', () => {
  const doc = (schedule) => ({ format: 'satella', version: 1, kind: 'profile', profile: { name: 'P', schedule } });
  assert.deepEqual(parseImport(JSON.stringify(doc({ from: '09:00', to: '18:30' })), KEYS).profile.schedule,
    { from: '09:00', to: '18:30' });
  for (const bad of [{ from: '9h', to: '18:00' }, { from: '10:00', to: '10:00' }, 'toujours', null]) {
    assert.equal(parseImport(JSON.stringify(doc(bad)), KEYS).profile.schedule, null);
  }
});

test('export / import d’une macro seule', () => {
  const { makeExport } = require('../src/shared/sanitize');
  const file = makeExport('macro', { id: 'x', name: 'Ma macro', enabled: true, steps: [{ type: 'keyTap', key: 'f8' }, { type: 'evil' }] }, '1.10.0');
  const res = parseImport(file, KEYS);
  assert.equal(res.kind, 'macro');
  assert.equal(res.macro.name, 'Ma macro');
  assert.deepEqual(res.macro.steps.map((s) => s.type), ['keyTap']);
  assert.throws(() => parseImport(JSON.stringify({ format: 'satella', version: 1, kind: 'macro', macro: 'x' }), KEYS), /macro invalide/);
});

test('import : étapes « Charger un profil » / « Effet clavier » et palette de la vague validées', () => {
  const doc = { format: 'satella', version: 1, kind: 'profile', profile: { name: 'P',
    ledState: { keyboard: { effect: 'palette', palette: ['#FF0000', 'rouge', '#00ff00', '#0000ff'] } },
    macros: [{ id: 'm', steps: [
      { type: 'profile', name: '  Jeu  ' }, { type: 'profile', name: '' },
      { type: 'effect', effect: 'fire', color: '#00FF00' }, { type: 'effect', effect: 'inventé' },
    ] }] } };
  const { profile } = parseImport(JSON.stringify(doc), KEYS);
  assert.deepEqual(profile.macros[0].steps, [
    { type: 'profile', gapMs: 15, name: 'Jeu' },
    { type: 'effect', gapMs: 15, effect: 'fire', color: '#00ff00' },
  ]);
  assert.equal(profile.ledState.keyboard.effect, 'palette');
  assert.deepEqual(profile.ledState.keyboard.palette, ['#ff0000', '#00ff00', '#0000ff']);
  const one = parseImport(JSON.stringify({ ...doc, profile: { name: 'Q', ledState: { keyboard: { palette: ['#123456'] } } } }), KEYS);
  assert.equal(one.profile.ledState.keyboard.palette.length, 3, 'palette par défaut si moins de 2 couleurs');
});

test('turbo : mode « tant que maintenu » validé, conflit déclencheur = cible repéré', () => {
  const { turbo, turboHoldConflict } = require('../src/shared/sanitize');
  const t = turbo({ id: 't1', target: { type: 'mouse', button: 'left' }, mode: 'hold', hold: { type: 'mouse', button: 'x2' } }, KEYS);
  assert.equal(t.mode, 'hold');
  assert.deepEqual(t.hold, { type: 'mouse', button: 'x2' });
  assert.equal(turboHoldConflict(t), false);
  const legacy = turbo({ id: 't2', accelerator: 'F9' }, KEYS);
  assert.equal(legacy.mode, 'toggle', 'anciens turbos : raccourci marche / arrêt');
  assert.deepEqual(legacy.hold, { type: 'mouse', button: 'x1' });
  const bad = turbo({ id: 't3', target: { type: 'mouse', button: 'right' }, mode: 'hold', hold: { type: 'mouse', button: 'right' } }, KEYS);
  assert.equal(turboHoldConflict(bad), true);
  const key = turbo({ id: 't4', target: { type: 'key', key: 'f8' }, mode: 'hold', hold: { type: 'key', key: 'f8' } }, KEYS);
  assert.equal(turboHoldConflict(key), true);
  assert.equal(turbo({ id: 't5', mode: 'hold', hold: { type: 'key', key: 'inventée' } }, KEYS).hold.type, 'mouse');
});

test('import : option « sans abréviations » d’un profil', () => {
  const doc = (noSnippets) => JSON.stringify({ format: 'satella', version: 1, kind: 'profile', profile: { name: 'Jeu', noSnippets } });
  assert.equal(parseImport(doc(true), KEYS).profile.noSnippets, true);
  assert.equal(parseImport(doc('oui'), KEYS).profile.noSnippets, false);
});
