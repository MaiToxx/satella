const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const t = require('../src/system/tuning');
const power = require('../src/system/power');
const fake = require('../src/system/tuning-fake');

const PLANS_FR = [
  'Modes de gestion de l’alimentation existants (* Actif)',
  '-----------------------------------',
  'GUID du mode de gestion de l’alimentation : 381b4222-f694-41f0-9685-d5d57a8bd5c1  (Utilisation normale) *',
  'GUID du mode de gestion de l’alimentation : 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c  (Performances �lev�es)',
  'GUID du mode de gestion de l’alimentation : 11111111-2222-3333-4444-555555555555  (Dell (jeu))',
].join('\r\n');

test('modes de gestion : lecture de powercfg /list (accents perdus compris)', () => {
  const plans = t.parsePlans(PLANS_FR);
  assert.equal(plans.length, 3);
  assert.deepEqual(plans[0], { guid: t.BALANCED_PLAN, name: 'Utilisation normale', active: true });
  assert.equal(plans[1].name, 'Performances élevées'); // nom connu, accents rétablis
  assert.equal(plans[1].active, false);
  assert.equal(plans[2].name, 'Dell (jeu)');
  const en = t.parsePlans('Power Scheme GUID: 381b4222-f694-41f0-9685-d5d57a8bd5c1  (Balanced) *');
  assert.equal(en[0].active, true);
  assert.deepEqual(t.parsePlans('Erreur : accès refusé'), []);
});

test('turbo : valeurs courantes secteur / batterie', () => {
  const out = [
    'GUID du mode de gestion de l’alimentation : 381b4222-f694-41f0-9685-d5d57a8bd5c1  (Utilisation normale)',
    '  GUID du sous-groupe : 54533251-82be-4824-96c1-47b60b740d00  (Gestion de l’alimentation du processeur)',
    '    GUID du paramètre d’alimentation : be337238-0d82-4146-a960-4f3749d470c7  (Mode de performance optimale du processeur)',
    '      Index de paramètre possible : 000',
    '      Nom convivial du paramètre possible : Désactivé',
    '    Index de paramètre courant du secteur : 0x00000002',
    '    Index de paramètre courant de la batterie : 0x00000000',
  ].join('\r\n');
  assert.deepEqual(t.parseBoost(out), { ac: 2, dc: 0 });
  assert.equal(t.parseBoost('Le paramètre est incorrect.'), null);
});

test('préférences DirectX : lecture, fusion, écriture', () => {
  const cur = t.parseDx('SwapEffectUpgradeEnable=1;GpuPreference=1;');
  assert.deepEqual(cur, { SwapEffectUpgradeEnable: '1', GpuPreference: '1' });
  cur.GpuPreference = '2';
  assert.equal(t.formatDx(cur), 'SwapEffectUpgradeEnable=1;GpuPreference=2;');
  assert.deepEqual(t.parseDx(''), {});
  assert.ok(t.validExePath('C:\\Games\\Jeu été\\jeu.exe'));
  assert.ok(!t.validExePath('C:\\Games\\jeu.bat'));
  assert.ok(!t.validExePath('jeu.exe'));
  assert.ok(!t.validExePath('C:\\a"b.exe'));
});

test('démarrage : octet StartupApproved', () => {
  assert.equal(t.startupEnabled(-1), true);
  assert.equal(t.startupEnabled(2), true);
  assert.equal(t.startupEnabled(6), true);
  assert.equal(t.startupEnabled(3), false);
  assert.equal(t.startupData(false), '03' + '00'.repeat(11));
  assert.equal(t.startupData(true).length, 24);
});

test('guillemets façon Windows pour la ligne de commande élevée', () => {
  assert.equal(t.quoteArg('add'), 'add');
  assert.equal(t.quoteArg('HKLM\\Software\\a b'), '"HKLM\\Software\\a b"');
  assert.equal(t.quoteArg('a"b'), '"a\\"b"');
  assert.equal(t.quoteArg('C:\\dossier avec espace\\'), '"C:\\dossier avec espace\\\\"');
  assert.equal(t.quoteArg(''), '""');
});

test('GUID du mode d\'alimentation : conversion aller-retour', () => {
  for (const id of Object.keys(power.OVERLAYS)) {
    const g = power.OVERLAYS[id];
    assert.equal(power.structToGuid(power.guidToStruct(g)), g);
    assert.equal(power.overlayId(g.toUpperCase()), id);
  }
  assert.equal(power.guidToStruct(power.OVERLAYS.performance).Data1, 0xded574b5);
  assert.equal(power.overlayId('3af9b8d9-7c97-431d-ad78-34a8bfea439f'), 'other');
  assert.throws(() => power.guidToStruct('pas-un-guid'));
});

const G5_RAW = {
  admin: false,
  plans: PLANS_FR,
  boost: 'Index de paramètre courant du secteur : 0x00000002\r\nIndex de paramètre courant de la batterie : 0x00000002',
  gameMode: null,
  dvr: 1,
  capture: null,
  hags: 2,
  gpuPrefs: {
    DirectXUserGlobalSettings: 'SwapEffectUpgradeEnable=1;',
    'C:\\Riot Games\\VALORANT\\live\\VALORANT.exe': 'GpuPreference=2;',
    'C:\\Outils\\lent.exe': 'SwapEffectUpgradeEnable=0;',
  },
  gpus: ['AMD Radeon(TM) Graphics', 'AMD Radeon RX 5600M'],
  maker: 'Dell Inc.',
  model: 'Dell G5 5505',
  battery: true,
  startup: { scope: 'ufolder', name: 'Spotify.lnk', cmd: 'C:\\x\\Spotify.lnk', state: 3 }, // un seul : objet, pas tableau
};
const G5_ENV = { overlay: 'balanced', release: '10.0.22631', totalmem: 16 * 2 ** 30, cpu: 'AMD Ryzen 7 4800H with Radeon Graphics' };

test('lecture groupée : état d\'un Dell G5 5505', () => {
  const s = t.normalizeProbe(G5_RAW, G5_ENV);
  assert.equal(s.activePlan, t.BALANCED_PLAN);
  assert.equal(s.overlayUsable, true);
  assert.equal(s.canCreateUltimate, true);
  assert.deepEqual(s.boost, { ac: 2, dc: 2 });
  assert.equal(s.gameMode, true);    // valeur absente = activé
  assert.equal(s.gameDvr, true);
  assert.equal(s.hags, true);
  assert.equal(s.windowed, true);    // Windows 11
  assert.deepEqual(s.gpuApps.map((a) => [a.name, a.pref]), [['lent.exe', 0], ['VALORANT.exe', 2]]);
  assert.equal(s.startup.length, 1);
  assert.deepEqual([s.startup[0].label, s.startup[0].enabled, s.startup[0].machine], ['Spotify', false, false]);
  assert.equal(s.hw.ramGb, 16);
  assert.equal(s.hw.laptop, true);
  assert.equal(s.preset, 'balanced');
  const ids = s.tips.map((x) => x.id);
  for (const id of ['hybrid', 'plug', 'turbo', 'amd', 'dell', 'air', 'dvr']) assert.ok(ids.includes(id), id);
  assert.match(s.tips.find((x) => x.id === 'hybrid').text, /RX 5600M/);
  assert.match(s.tips.find((x) => x.id === 'turbo').text, /AMD Ryzen 7 4800H/);
  // Windows 10 : pas d'optimisation des jeux en fenêtre
  assert.equal(t.normalizeProbe(G5_RAW, { ...G5_ENV, release: '10.0.19045' }).windowed, null);
  // Sonde illisible : état vide mais exploitable
  const empty = t.normalizeProbe(null, {});
  assert.equal(empty.boost, null);
  assert.deepEqual(empty.startup, []);
  assert.equal(empty.preset, null);
});

test('matériel : puces graphiques et processeur', () => {
  const g = t.classifyGpus(['Intel(R) UHD Graphics 630', 'NVIDIA GeForce RTX 3060 Laptop GPU', 'Microsoft Basic Display Adapter']);
  assert.deepEqual(g, { integrated: ['Intel(R) UHD Graphics 630'], dedicated: ['NVIDIA GeForce RTX 3060 Laptop GPU'] });
  assert.equal(t.shortCpu('Intel(R) Core(TM) i7-10750H CPU @ 2.60GHz'), 'Intel Core i7-10750H');
  assert.equal(t.shortCpu('AMD Ryzen 7 5800X 8-Core Processor'), 'AMD Ryzen 7 5800X');
  // PC fixe : pas de conseils de portable
  const desk = t.adviceFor({ hw: { cpu: 'AMD Ryzen 7 5800X 8-Core Processor', gpus: ['NVIDIA GeForce RTX 3070'], laptop: false, ramGb: 32 } });
  assert.deepEqual(desk.map((x) => x.id), ['nvidia']);
});

// Moteur Windows avec des commandes simulées : arguments transmis
function recorder(responses = {}) {
  const calls = [];
  const run = async (file, args, opts = {}) => {
    calls.push({ tool: path.basename(file).replace(/\.exe$/i, '').toLowerCase(), args, env: opts.env });
    const r = responses[path.basename(file).toLowerCase()];
    return typeof r === 'function' ? r(args, opts) : (r || { ok: true, code: 0, stdout: '', stderr: '', error: null });
  };
  return { calls, run };
}

const fakePower = { getOverlay: () => 'balanced', setOverlay: (id) => ({ ok: !!power.OVERLAYS[id] }) };

test('moteur Windows : turbo, mode Jeu, préréglage', async () => {
  const rec = recorder();
  const b = t.createWindowsBackend({ run: rec.run, pw: fakePower });
  assert.deepEqual(await b.setBoost(0, 2), { ok: true });
  assert.deepEqual(rec.calls.map((c) => c.args.join(' ')), [
    '/setacvalueindex SCHEME_CURRENT SUB_PROCESSOR PERFBOOSTMODE 0',
    '/setdcvalueindex SCHEME_CURRENT SUB_PROCESSOR PERFBOOSTMODE 2',
    '/setactive SCHEME_CURRENT',
  ]);
  assert.equal((await b.setBoost(9, 0)).ok, false);
  rec.calls.length = 0;
  await b.setGameMode(false);
  assert.deepEqual(rec.calls[0].args, ['add', 'HKCU\\Software\\Microsoft\\GameBar', '/v', 'AutoGameModeEnabled', '/t', 'REG_DWORD', '/d', '0', '/f']);
  rec.calls.length = 0;
  assert.deepEqual(await t.applyPreset(b, 'quiet'), { ok: true });
  assert.equal(rec.calls.filter((c) => c.tool === 'powercfg').length, 3);
  assert.equal((await t.applyPreset(b, 'inconnu')).ok, false);
});

test('moteur Windows : lecture, carte graphique, démarrage élevé', async () => {
  const rec = recorder({
    'powershell.exe': (args, opts) => (opts.env && opts.env.SATELLA_ARGS
      ? { ok: true, code: 0, stdout: '', stderr: '', error: null }
      : { ok: true, code: 0, stdout: '\uFEFF' + JSON.stringify({ ...G5_RAW, startup: [{ scope: 'hklm', name: 'Dell Update', cmd: 'x', state: 2 }] }), stderr: '', error: null }),
  });
  const b = t.createWindowsBackend({ run: rec.run, pw: fakePower });
  const s = await b.probe();
  assert.equal(s.error, undefined);
  assert.equal(s.startup[0].machine, true);
  // La sonde passe en -EncodedCommand (aucun guillemet à échapper)
  const probeCall = rec.calls[0];
  assert.equal(probeCall.tool, 'powershell');
  assert.equal(probeCall.args[probeCall.args.length - 2], '-EncodedCommand');
  assert.equal(Buffer.from(probeCall.args[probeCall.args.length - 1], 'base64').toString('utf16le'), t.PROBE_SCRIPT);

  rec.calls.length = 0;
  const exe = 'C:\\Outils\\lent.exe';
  assert.deepEqual(await b.setGpuPref(exe, 2), { ok: true });
  assert.deepEqual(rec.calls[0].args.slice(-5), ['/t', 'REG_SZ', '/d', 'SwapEffectUpgradeEnable=0;GpuPreference=2;', '/f']);
  assert.equal(rec.calls[0].args[3], exe);
  assert.equal((await b.setGpuPref('lent.exe', 2)).ok, false);
  await b.setGpuPref(exe, null);
  assert.deepEqual(rec.calls[rec.calls.length - 1].args, ['delete', 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences', '/v', exe, '/f']);

  // Entrée commune à tous les utilisateurs, sans droits admin : reg.exe élevé
  rec.calls.length = 0;
  assert.deepEqual(await b.setStartup('hklm:Dell Update', false), { ok: true });
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].tool, 'powershell');
  assert.equal(rec.calls[0].env.SATELLA_ARGS,
    'add HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run /v "Dell Update" /t REG_BINARY /d 030000000000000000000000 /f');
  assert.equal((await b.setStartup('hkcu:Inconnu', true)).ok, false);
});

test('moteur Windows : matériel lu une seule fois, texte échappé en ASCII', async () => {
  const rec = recorder({
    'powershell.exe': (args, opts) => {
      const light = opts.env && opts.env.SATELLA_LIGHT === '1';
      const raw = light ? { ...G5_RAW, gpus: undefined, maker: undefined, model: undefined, battery: undefined } : G5_RAW;
      // Sortie de la sonde : accents échappés (é...), indépendante de la console
      const ascii = JSON.stringify(raw).replace(/[^\x00-\x7f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
      return { ok: true, code: 0, stdout: ascii, stderr: '', error: null };
    },
  });
  const b = t.createWindowsBackend({ run: rec.run, pw: fakePower });
  const first = await b.probe();
  const second = await b.probe();
  assert.equal(rec.calls[0].env, undefined);
  assert.equal(rec.calls[1].env.SATELLA_LIGHT, '1');
  assert.equal(second.hw.model, 'Dell G5 5505');
  assert.deepEqual(second.hw.gpus, first.hw.gpus);
  assert.equal(second.plans[1].name, 'Performances élevées');
});

test('moteur Windows : confirmation refusée, sonde illisible', async () => {
  const rec = recorder({
    'powershell.exe': (args, opts) => (opts.env && opts.env.SATELLA_ARGS
      ? { ok: false, code: 1223, stdout: '', stderr: '', error: 'Command failed' }
      : { ok: false, code: 1, stdout: '', stderr: 'PowerShell introuvable', error: 'PowerShell introuvable' }),
  });
  const b = t.createWindowsBackend({ run: rec.run, pw: fakePower });
  const s = await b.probe();
  assert.match(s.error, /impossible/);
  const r = await b.setHags(true);
  assert.deepEqual(r, { ok: false, error: 'autorisation refusée' });
});

test('fichiers temporaires : seuls les anciens sont supprimés', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'satella-tmp-'));
  try {
    const old = Date.now() / 1000 - 3 * 86400;
    fs.mkdirSync(path.join(dir, 'vieux', 'sous'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'vieux', 'sous', 'a.tmp'), 'x'.repeat(1000));
    fs.utimesSync(path.join(dir, 'vieux', 'sous', 'a.tmp'), old, old);
    fs.writeFileSync(path.join(dir, 'b.log'), 'y'.repeat(500));
    fs.utimesSync(path.join(dir, 'b.log'), old, old);
    fs.writeFileSync(path.join(dir, 'recent.tmp'), 'z'.repeat(300));
    const info = await t.tempInfo(dir);
    assert.deepEqual([info.bytes, info.files], [1500, 2]);
    const res = await t.tempClean(dir);
    assert.deepEqual([res.freed, res.removed, res.failed], [1500, 2, 0]);
    assert.deepEqual(fs.readdirSync(dir), ['recent.tmp']); // dossiers vidés retirés, racine gardée
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('moteur simulé : même forme que le moteur Windows', async () => {
  const b = fake.create();
  let s = await b.probe();
  assert.equal(s.preset, 'balanced');
  await t.applyPreset(b, 'game');
  s = await b.probe();
  assert.equal(s.preset, 'game');
  assert.equal(s.overlay, 'performance');
  await b.setGpuPref('C:\\Games\\Valorant\\VALORANT.exe', 2);
  await b.setStartup('ufolder:Spotify.lnk', true);
  s = await b.probe();
  assert.equal(s.gpuApps[0].pref, 2);
  assert.equal(s.startup.find((x) => x.label === 'Spotify').enabled, true);
  await b.createUltimate();
  s = await b.probe();
  assert.equal(s.canCreateUltimate, false);
  assert.equal(s.overlayUsable, false);
});
