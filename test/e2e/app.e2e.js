// Test de bout en bout : l'application est lancée pour de vrai (Electron)
// et pilotée comme par un utilisateur, sans matériel. Dossier de données
// temporaire (SATELLA_USER_DATA) : les vraies données ne sont jamais touchées.
//   npm run test:e2e            (Linux : xvfb-run -a npm run test:e2e)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

let electron = null;
try {
  electron = require('playwright-core')._electron;
} catch { /* dépendance de développement absente */ }

const APP = path.resolve(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

function launch(dataDir) {
  return electron.launch({
    executablePath: require('electron'),
    args: [APP, '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, SATELLA_USER_DATA: dataDir },
  });
}

async function firstPage(app) {
  const page = await app.firstWindow();
  await page.waitForSelector('.kb-key', { state: 'attached' });
  await sleep(600);
  return page;
}

// Glisser-déposer HTML5 réaliste (déplacements progressifs de la souris)
async function drag(page, from, to) {
  await to.scrollIntoViewIfNeeded();
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(a.x + 5 + ((b.x + 30 - a.x) * i) / 12, a.y + ((b.y + 10 - a.y) * i) / 12);
  }
  await page.mouse.up();
  await sleep(200);
}

test('parcours complet de l’interface', { skip: !electron && 'playwright-core absent', timeout: 240000 }, async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'satella-e2e-'));
  const failures = [];
  const check = (name, cond, extra = '') => { if (!cond) failures.push(`${name}${extra ? ' — ' + extra : ''}`); };

  const app = await launch(data);
  const page = await firstPage(app);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  try {
    // ---- Instance unique ----
    const second = await launch(data).catch(() => null);
    if (second) {
      const code = await new Promise((r) => {
        second.process().on('exit', (c) => r(c));
        setTimeout(() => r('vivante'), 8000);
      });
      check('une deuxième instance quitte aussitôt', code !== 'vivante');
      if (code === 'vivante') await second.close();
    }

    // ---- Macros : étapes, boucles imbriquées, annuler/rétablir ----
    await page.click('.nav-btn[data-page="macros"]');
    await page.click('#macro-new');
    await page.fill('#me-name', '<img src=x onerror="window.__xss=1">Test');
    await page.click('#me-add-bar button:has-text("Touche")');
    await page.selectOption('#sf-key', 'a');
    await page.click('#sf-ok');
    await page.click('#me-add-bar button:has-text("Boucle")');
    await page.fill('#sf-count', '3');
    await page.click('#sf-ok');
    await page.click('.add-row .add-step-bar button:has-text("Boucle")');
    await page.click('#sf-ok');
    await page.click('.add-row >> nth=0 >> .add-step-bar button:has-text("Texte")');
    await page.fill('#sf-text', 'ligne 1\nligne 2 <b>gras</b>');
    await page.click('#sf-ok');
    check('étapes ajoutées, boucle imbriquée comprise', (await page.textContent('#me-steps-count')) === '4');
    const indents = await page.evaluate(() => [...document.querySelectorAll('#me-steps .step-row:not(.add-row)')]
      .map((r) => r.style.marginLeft || '0'));
    check('indentation par niveau', JSON.stringify(indents) === '["0","0","28px","56px"]', JSON.stringify(indents));
    check('indicateur « non sauvegardé »', (await page.textContent('#me-unsaved')).includes('non sauvegard'));
    await page.keyboard.press('Control+z');
    check('Ctrl+Z annule', (await page.textContent('#me-steps-count')) === '3');
    await page.keyboard.press('Control+y');
    check('Ctrl+Y rétablit', (await page.textContent('#me-steps-count')) === '4');
    check('nom hostile affiché comme du texte', (await page.evaluate(() => window.__xss)) === undefined
      && (await page.textContent('.macro-item .m-name')).includes('<img src=x'));
    const descs = await page.evaluate(() => [...document.querySelectorAll('.s-desc')].map((e) => e.textContent).join('|'));
    check('texte d’étape échappé', descs.includes('<b>gras</b>'), descs);

    // Glisser-déposer : la touche à la fin de la boucle externe
    await drag(page, page.locator('#me-steps .step-row:not(.add-row) .s-grip').first(),
      page.locator('#me-steps .add-row').last());
    const order = await page.evaluate(() => [...document.querySelectorAll('#me-steps .step-row:not(.add-row) .s-type')]
      .map((e) => e.textContent));
    check('glisser-déposer', order[0] === 'Boucle', JSON.stringify(order));

    // Étape « Ouvrir » : cible refusée, puis lien valide joué via l'ouvreur
    await page.click('#me-add-bar button:has-text("Ouvrir")');
    await page.fill('#sf-target', 'powershell -c evil');
    await page.click('#sf-ok');
    check('cible « Ouvrir » invalide refusée', (await page.textContent('#toast')).includes('Indique un lien'));
    await page.fill('#sf-target', 'https://example.com/satella');
    await page.click('#sf-ok');
    await app.evaluate(({ shell }) => {
      global.__opened = [];
      shell.openExternal = async (u) => { global.__opened.push(u); };
    });
    await page.click('#macro-new');
    await page.fill('#me-name', 'Ouvrir seulement');
    await page.click('#me-add-bar button:has-text("Ouvrir")');
    await page.fill('#sf-target', 'https://example.com/seul');
    await page.click('#sf-ok');
    await page.click('#me-play');
    await sleep(400);
    const opened = await app.evaluate(() => global.__opened);
    check('macro « Ouvrir » jouée sans injection de touches', JSON.stringify(opened) === '["https://example.com/seul"]',
      JSON.stringify(opened));
    // Étape « Effet clavier » : jouée sans injection, l'effet et la couleur changent
    await page.click('#me-add-bar button:has-text("Effet clavier")');
    await page.selectOption('#sf-effect', 'fire');
    await page.check('#sf-color-on');
    await page.fill('#sf-color', '#ff3300');
    await page.click('#sf-ok');
    await page.click('#me-play');
    await sleep(400);
    const fxState = await page.evaluate(async () => (await window.satella.init()).ledState.keyboard);
    check('étape « Effet clavier »', fxState.effect === 'fire' && fxState.baseColor === '#ff3300',
      `${fxState.effect} ${fxState.baseColor}`);
    // Étape « Charger un profil » : description, puis annulée (Ctrl+Z)
    const stepsBefore = await page.locator('#me-steps .step-row:not(.add-row)').count();
    await page.click('#me-add-bar button:has-text("Charger un profil")');
    await page.fill('#sf-profile', 'Soirée');
    await page.click('#sf-ok');
    check('étape « Charger un profil »', (await page.evaluate(() => [...document.querySelectorAll('.s-desc')]
      .map((e) => e.textContent).pop())) === 'Profil « Soirée »');
    await page.keyboard.press('Control+z');
    check('étape « Charger un profil » annulée', (await page.locator('#me-steps .step-row:not(.add-row)').count()) === stepsBefore);
    // Étape « Attendre une touche »
    await page.click('#me-add-bar button:has-text("Attendre touche")');
    await page.selectOption('#sf-key', 'f8');
    await page.fill('#sf-timeout', '2.5');
    await page.click('#sf-ok');
    const waitDesc = await page.evaluate(() => [...document.querySelectorAll('.s-desc')].map((e) => e.textContent).pop());
    check('étape « Attendre une touche »', waitDesc === 'Attendre F8 (2.5 s max)', waitDesc);
    await page.click('#me-save');
    await page.locator('.macro-item', { hasText: 'onerror' }).click();

    // Tester une macro non sauvegardée : l'erreur remonte (pas d'injection ici)
    await page.click('#me-play');
    await sleep(300);
    const t = await page.textContent('#toast');
    check('« Tester » joue le brouillon', t.includes('Lecture impossible') && !t.includes('introuvable'), t);

    // Déclencheur + doublon signalé
    await page.click('#me-trigger');
    await page.keyboard.press('Control+Alt+KeyK');
    await page.click('#me-save');
    await sleep(300);
    check('sauvegarde', (await page.textContent('#me-unsaved')) === '');
    await page.click('#macro-new');
    await page.fill('#me-name', 'Doublon');
    await page.click('#me-trigger');
    await page.keyboard.press('Control+Alt+KeyK');
    await sleep(100);
    check('doublon signalé à la saisie', (await page.textContent('#toast')).includes('déjà utilisé'));
    await page.click('#me-save');
    await sleep(400);
    check('raccourci refusé signalé', (await page.locator('.macro-item.active .m-warn').count()) === 1);

    // Cycle impossible à créer
    await page.click('#me-add-bar button:has-text("Exécuter macro")');
    await page.selectOption('#sf-macro', { label: '<img src=x onerror="window.__xss=1">Test' });
    await page.click('#sf-ok');
    await page.click('#me-save');
    await sleep(200);
    await page.locator('.macro-item', { hasText: 'onerror' }).click();
    await page.click('#me-add-bar button:has-text("Exécuter macro")');
    const proposed = await page.evaluate(() => [...document.querySelectorAll('#sf-macro option')].map((o) => o.textContent));
    check('cycle A -> B -> A impossible', !proposed.includes('Doublon'), JSON.stringify(proposed));
    await page.click('#sf-cancel');

    // ---- Profils ----
    await page.click('.nav-btn[data-page="profiles"]');
    await page.fill('#profile-name', 'Bureau');
    await page.click('#profile-save');
    await sleep(300);
    check('profil sauvegardé actif', (await page.locator('.profile-row.active').count()) === 1
      && (await page.textContent('.side-profile')).includes('Bureau'));
    await page.click('.nav-btn[data-page="keyboard"]');
    await page.click('#kb-effects button[data-fx="rainbow"]');
    await sleep(1300);
    let prof = await page.evaluate(() => window.satella.profiles.list());
    check('profil actif mis à jour en continu', prof.profiles[0].ledState.keyboard.effect === 'rainbow');

    // Calque
    await page.click('.kb-key[data-id="w"]');
    await page.click('.kb-key[data-id="a"]', { modifiers: ['Control'] });
    await page.click('#kb-overlay-add');
    await sleep(1300);
    prof = await page.evaluate(() => window.satella.profiles.list());
    check('calque enregistré', Object.keys(prof.profiles[0].ledState.keyboard.overlay || {}).sort().join() === 'a,w');
    check('repère du calque', (await page.locator('.kb-key.in-overlay').count()) === 2);

    // Effets logiciels
    await page.click('#kb-effects button[data-fx="sysmon"]');
    await sleep(1500);
    check('jauge système dessinée', !!(await page.evaluate(() =>
      document.querySelector('.kb-key[data-id="f1"] .led').style.background)));
    await page.click('#kb-effects button[data-fx="screen"]');
    await sleep(2500);
    const frames = await page.evaluate(() => window.__satellaScreen.framesSent);
    check('ambiance écran : capture en cours', frames >= 5, `${frames} images`);
    await page.click('#kb-effects button[data-fx="static"]');
    await sleep(400);
    const f1 = await page.evaluate(() => window.__satellaScreen.framesSent);
    await sleep(500);
    check('ambiance écran : capture arrêtée en changeant d’effet',
      (await page.evaluate(() => window.__satellaScreen.framesSent)) === f1);

    // Coloration : couleur récente, annuler / rétablir, préréglage
    const led = (id) => page.evaluate((k) => document.querySelector(`.kb-key[data-id="${k}"] .led`).style.background, id);
    check('couleur récente mémorisée', (await page.locator('#kb-recent .swatch').count()) >= 1);
    // (le sélecteur de couleur change aussi la couleur de base : on la
    // remet en vert ensuite pour distinguer la touche peinte du reste)
    await page.fill('#kb-color', '#ff0000');
    await page.click('.kb-key[data-id="q"]');
    await page.click('#kb-apply');
    await page.click('#kb-swatches .swatch >> nth=3'); // #2ee88a
    await sleep(300);
    const painted = await led('q');
    await page.click('#kb-wrap', { position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+z');
    await sleep(300);
    const undone = await led('q');
    await page.keyboard.press('Control+y');
    await sleep(300);
    check('annuler / rétablir la coloration', painted === 'rgb(255, 0, 0)' && undone === 'rgb(46, 232, 138)'
      && (await led('q')) === painted, `${painted} / ${undone}`);
    await page.selectOption('#kb-preset', 'rows');
    await sleep(300);
    check('préréglage « rangées arc-en-ciel »', (await led('esc')) !== (await led('lctrl')));

    // Carte de chaleur : comptage à activer depuis l'effet
    await page.click('#kb-effects button[data-fx="heatmap"]');
    await page.click('#kb-fx-hint button');
    await sleep(300);
    check('carte de chaleur : comptage activé', (await page.evaluate(() => window.satella.settings.get())).keyStats === true
      && (await page.locator('#kb-fx-hint button').count()) === 0);
    await page.click('#kb-effects button[data-fx="static"]');

    // Vague de couleurs : palette modifiable
    await page.click('#kb-effects button[data-fx="palette"]');
    await sleep(200);
    check('vague de couleurs : éditeur', (await page.locator('#kb-palette .pal-chip').count()) === 3
      && await page.isVisible('#kb-dir-group'));
    await page.click('#pal-add');
    check('vague de couleurs : couleur ajoutée', (await page.locator('#kb-palette .pal-chip').count()) === 4);
    await page.selectOption('#pal-preset', '1'); // Océan
    await sleep(200);
    const pal = await page.evaluate(async () => (await window.satella.init()).ledState.keyboard.palette);
    check('vague de couleurs : palette toute prête', JSON.stringify(pal) === '["#003cff","#00c2ff","#00ffd0"]', JSON.stringify(pal));
    await page.click('#kb-effects button[data-fx="static"]');

    // Renommage, réglages mis de côté avant un autre profil
    await page.click('.nav-btn[data-page="profiles"]');
    await page.click('.p-rename');
    await page.fill('#ask-input', 'Bureau perso');
    await page.click('#ask-ok');
    await sleep(300);
    check('renommage du profil actif', (await page.textContent('.side-profile')).includes('Bureau perso'));
    await page.click('.profile-row[data-name="Bureau perso"] .p-dup');
    await sleep(300);
    check('profil dupliqué', (await page.locator('.profile-row[data-name="Bureau perso (copie)"]').count()) === 1);
    await page.click('.profile-row[data-name="Bureau perso (copie)"] .p-del');
    await sleep(300);
    await page.fill('#profile-name', 'Jeu');
    await page.click('#profile-save');
    await sleep(200);
    await page.click('.profile-row.active .p-del');
    await sleep(300);
    check('suppression de profil annulable', (await page.textContent('#toast')).includes('supprimé')
      && (await page.locator('#toast .toast-action').count()) === 1);
    await page.click('#toast .toast-action');
    await sleep(300);
    check('suppression de profil annulée', (await page.locator('.profile-row[data-name="Jeu"]').count()) === 1);
    await page.click('.profile-row[data-name="Jeu"] .p-del');
    await sleep(300);
    await page.click('.nav-btn[data-page="keyboard"]');
    await page.click('#kb-effects button[data-fx="fire"]');
    await sleep(300);
    await page.click('.nav-btn[data-page="profiles"]');
    await page.click('.profile-row .p-load');
    await sleep(500);
    prof = await page.evaluate(() => window.satella.profiles.list());
    const backup = prof.profiles.find((p) => p.name === 'Réglages non sauvegardés');
    check('réglages hors profil mis de côté', backup && backup.ledState.keyboard.effect === 'fire');
    check('profil chargé actif', prof.active === 'Bureau perso');

    // Profil programmé : appliqué automatiquement pendant sa plage horaire
    const timedName = await page.getAttribute('.profile-row:not(.active)', 'data-name');
    const timedRow = `.profile-row[data-name="${timedName}"]`;
    await page.fill(`${timedRow} .p-sched-from`, hhmm(new Date(Date.now() - 3600e3)));
    await page.fill(`${timedRow} .p-sched-to`, hhmm(new Date(Date.now() + 3600e3)));
    await page.check(`${timedRow} .p-sched-on`);
    await sleep(3800);
    prof = await page.evaluate(() => window.satella.profiles.list());
    const timed = prof.profiles.find((p) => p.name === timedName);
    check('profil programmé appliqué pendant sa plage', prof.active === timedName && !!timed.schedule,
      `${prof.active} / ${JSON.stringify(timed && timed.schedule)}`);
    check('horaire affiché sur le profil', (await page.textContent(timedRow)).includes(timed.schedule.from));
    await page.uncheck(`${timedRow} .p-sched-on`);
    await sleep(300);
    await page.click('.profile-row[data-name="Bureau perso"] .p-load');
    await sleep(400);
    prof = await page.evaluate(() => window.satella.profiles.list());
    check('horaire retiré', prof.active === 'Bureau perso' && !prof.profiles.find((p) => p.name === timedName).schedule);

    // ---- Export / import (boîtes de dialogue simulées) ----
    const file = path.join(data, 'export-test.satella');
    await app.evaluate(({ dialog }, f) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: f });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
      global.__boxes = [];
      dialog.showMessageBox = async (w, o) => { global.__boxes.push((o || w).message); return { response: 0 }; };
    }, file);
    await page.click('.profile-row.active .p-export');
    await sleep(300);
    const exported = JSON.parse(fs.readFileSync(file, 'utf8'));
    check('export d’un profil', exported.format === 'satella' && exported.kind === 'profile');
    exported.profile.name = 'Importé <script>';
    exported.profile.isDefault = true;
    exported.profile.macros[0].name = '<img src=x onerror="window.__xss2=1">';
    exported.profile.macros[0].steps.push({ type: 'evil' }, { type: 'open', target: 'https://piege.example' });
    fs.writeFileSync(file, JSON.stringify(exported));
    await page.click('#data-import');
    await sleep(400);
    prof = await page.evaluate(() => window.satella.profiles.list());
    const imp = prof.profiles.find((p) => p.name === 'Importé <script>');
    const boxes = await app.evaluate(() => global.__boxes);
    check('import : confirmation pour les étapes « Ouvrir »', boxes.some((m) => m.includes('ouvrent des programmes')));
    check('import nettoyé (étapes « Ouvrir » retirées sur demande)', imp && !imp.isDefault
      && !JSON.stringify(imp.macros).includes('"open"') && !JSON.stringify(imp.macros).includes('evil'));
    check('aucun script exécuté à l’import', (await page.evaluate(() => window.__xss2)) === undefined);
    await page.click('#data-export-all');
    await sleep(300);
    check('sauvegarde complète', JSON.parse(fs.readFileSync(file, 'utf8')).kind === 'backup');
    await page.click('#data-import');
    await sleep(600);
    check('restauration', (await page.textContent('#toast')).includes('restaurée'));

    // Macro seule : export, import (copie renommée), suppression annulable, recherche
    await page.click('.nav-btn[data-page="macros"]');
    await page.click('.macro-item >> nth=0');
    const firstMacro = await page.inputValue('#me-name');
    await page.click('#me-export');
    await sleep(300);
    check('export d’une macro', JSON.parse(fs.readFileSync(file, 'utf8')).kind === 'macro');
    const macroCount = await page.locator('.macro-item').count();
    await page.click('.nav-btn[data-page="profiles"]');
    await page.click('#data-import');
    await sleep(500);
    check('import d’une macro', (await page.locator('.macro-item').count()) === macroCount + 1
      && (await page.inputValue('#me-name')) === `${firstMacro} (2)`, await page.inputValue('#me-name'));
    await page.click('#me-delete');
    await sleep(300);
    check('macro supprimée', (await page.locator('.macro-item').count()) === macroCount);
    await page.click('#toast .toast-action');
    await sleep(400);
    check('suppression de macro annulée', (await page.locator('.macro-item').count()) === macroCount + 1
      && (await page.inputValue('#me-name')) === `${firstMacro} (2)`);
    await page.click('#me-delete');
    await sleep(300);
    await page.fill('#macro-search', 'zzz');
    check('recherche de macro sans résultat', (await page.textContent('#macro-list')).includes('Aucune macro ne correspond'));
    await page.fill('#macro-search', firstMacro.slice(0, 4));
    check('recherche de macro', (await page.locator('.macro-item').count()) >= 1);
    await page.fill('#macro-search', '');

    // ---- Palette de commandes (Ctrl+K) ----
    await page.keyboard.press('Control+k');
    await sleep(200);
    check('palette ouverte', await page.isVisible('#palette-input'));
    await page.fill('#palette-input', 'effet tourbi');
    await sleep(100);
    check('palette filtrée', (await page.locator('.pal-item').count()) === 1, await page.textContent('#palette-list'));
    await page.keyboard.press('Enter');
    await sleep(300);
    check('palette : effet appliqué', !(await page.isVisible('#palette-backdrop'))
      && (await page.getAttribute('#kb-effects button.active', 'data-fx')) === 'spiral');
    await page.click('#palette-open');
    await page.fill('#palette-input', 'charger bureau');
    await page.keyboard.press('Enter');
    await sleep(400);
    check('palette : profil chargé', (await page.evaluate(() => window.satella.profiles.list())).active === 'Bureau perso');
    // Rechargé juste après une retouche : la retouche est gardée, à l'écran comme dans le profil
    check('profil rechargé juste après une retouche', (await page.getAttribute('#kb-effects button.active', 'data-fx')) === 'spiral'
      && (await page.evaluate(async () => (await window.satella.init()).ledState.keyboard.effect)) === 'spiral');
    await page.keyboard.press('Control+k');
    await page.fill('#palette-input', 'zzz introuvable');
    check('palette : aucun résultat', (await page.textContent('#palette-list')).includes('Aucun résultat'));
    await page.keyboard.press('Escape');
    check('palette fermée par Échap', !(await page.isVisible('#palette-backdrop')));
    await page.evaluate(() => window.satella.runAction('palette'));
    await sleep(300);
    check('palette ouverte par la commande globale', await page.isVisible('#palette-input'));
    await page.keyboard.press('Escape');

    // ---- Glisser-déposer : superposition, fichiers refusés ----
    const dropFile = async (name) => {
      const dt = await page.evaluateHandle((n) => {
        const d = new DataTransfer();
        d.items.add(new File(['{}'], n));
        return d;
      }, name);
      await page.dispatchEvent('body', 'dragenter', { dataTransfer: dt });
      const shown = await page.isVisible('#drop-overlay');
      await page.dispatchEvent('body', 'drop', { dataTransfer: dt });
      await sleep(300);
      return shown;
    };
    check('glisser-déposer : superposition affichée', await dropFile('notes.txt'));
    check('glisser-déposer : fichier non .satella refusé', (await page.textContent('#toast')).includes('Seuls les fichiers')
      && !(await page.isVisible('#drop-overlay')));
    await dropFile('sans-chemin.satella');
    check('glisser-déposer : fichier sans chemin refusé', (await page.textContent('#toast')).includes('Import impossible'));

    // ---- Minuteur (Accueil) : barre F1-F12 sur l'aperçu, arrêt ----
    await page.click('.nav-btn[data-page="home"]');
    await page.click('[data-timer="5"]');
    await sleep(400);
    const timerLeft = await page.textContent('#timer-left');
    check('minuteur lancé', /^0[45]:\d\d$/.test(timerLeft) && (await page.isVisible('#timer-stop')), timerLeft);
    check('durée du minuteur retenue', (await page.evaluate(() => window.satella.settings.get())).timerMinutes === 5);
    await page.click('.nav-btn[data-page="keyboard"]');
    await sleep(300);
    const rgbOf = (css) => (css.match(/\d+/g) || []).map(Number);
    const [tr, tg, tb] = rgbOf(await led('f1'));
    check('minuteur : F1 en vert sur l’aperçu', tg > 100 && tg > tr && tg > tb, await led('f1'));
    await page.click('.nav-btn[data-page="home"]');
    await page.click('#timer-stop');
    await sleep(300);
    check('minuteur arrêté', (await page.textContent('#timer-left')) === '--:--'
      && !(await page.evaluate(() => window.satella.timer.get())).running);

    // ---- Paramètres, diagnostic, extinction ----
    await page.click('.nav-btn[data-page="settings"]');
    await page.click('#set-offlock + span');
    await page.click('#set-flash + span');
    await page.click('#set-autoinstall + span');
    await page.click('#set-night + span');
    await page.fill('#set-night-from', '22:15');
    await page.locator('#set-night-from').dispatchEvent('change');
    await page.selectOption('#set-night-action', 'dim');
    await sleep(300);
    const st = await page.evaluate(() => window.satella.settings.get());
    check('réglages enregistrés', st.offOnLock && st.flashOnMacro && st.autoInstallUpdates);
    check('mode nuit enregistré', st.nightMode && st.nightFrom === '22:15' && st.nightAction === 'dim'
      && !(await page.locator('#set-night-level').isDisabled()), JSON.stringify([st.nightMode, st.nightFrom, st.nightAction]));
    check('statistiques affichées', (await page.textContent('#set-stats-info')).length > 0);
    await page.click('#set-stats-open');
    await sleep(300);
    check('statistiques détaillées', (await page.locator('#modal .stat-tile').count()) === 4
      && (await page.locator('#modal svg.chart >> nth=0').locator('.hit').count()) === 30
      && (await page.locator('#modal svg.chart >> nth=1').locator('.hit').count()) === 24);
    await page.click('#stats-close');
    check('statistiques fermées', !(await page.isVisible('#modal-backdrop'))
      && !(await page.evaluate(() => document.getElementById('modal').classList.contains('wide'))));

    // Thème clair puis retour au sombre
    await page.selectOption('#set-theme', 'light');
    await sleep(200);
    check('thème clair', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light'
      && (await page.evaluate(() => window.satella.settings.get())).theme === 'light');
    await page.selectOption('#set-theme', 'dark');
    await sleep(200);
    check('thème sombre', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');

    // Mode nuit « éteindre » sur la plage en cours : « rallumer » tient
    // jusqu'à la fin de la plage
    const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    await page.evaluate((r) => window.satella.settings.set(r), {
      nightMode: true, nightAction: 'off',
      nightFrom: hm(new Date(Date.now() - 3600e3)), nightTo: hm(new Date(Date.now() + 3600e3)),
    });
    await sleep(300);
    check('mode nuit : LED éteintes pendant la plage', (await page.textContent('#leds-toggle')).includes('rallumer'));
    await page.click('#leds-toggle');
    await sleep(300);
    await page.evaluate(() => window.satella.settings.set({})); // nouveau passage du mode nuit
    await sleep(300);
    check('mode nuit : « rallumer » l’emporte jusqu’à la fin de la plage',
      !(await page.textContent('#leds-toggle')).includes('rallumer'));
    await page.evaluate(() => window.satella.settings.set({ nightMode: false }));
    await sleep(200);

    // Témoins Verr. Maj / Verr. Num
    await page.click('#set-locks + span');
    await page.fill('#set-lock-color', '#ff8800');
    await sleep(300);
    const stLocks = await page.evaluate(() => window.satella.settings.get());
    check('témoins enregistrés', stLocks.lockIndicators === true && stLocks.lockColor === '#ff8800');
    check('témoins : disponibilité signalée', (await page.isVisible('#set-locks-warn')) === (process.platform !== 'win32'));

    // Raccourcis de l'application
    await page.click('.app-sc-row[data-id="leds"] .trigger-input');
    await page.keyboard.press('Control+Alt+KeyL');
    await sleep(400);
    check('raccourci de l’application enregistré',
      (await page.evaluate(() => window.satella.settings.get())).appShortcuts.leds === 'Ctrl+Alt+L');
    await page.click('.app-sc-row[data-id="nextProfile"] .trigger-input');
    await page.keyboard.press('Control+Alt+KeyK'); // déjà pris par une macro
    await sleep(500);
    check('raccourci de l’application en conflit signalé',
      (await page.locator('.app-sc-row[data-id="nextProfile"] .warn-text').count()) === 1);
    await page.click('.app-sc-row[data-id="nextProfile"] .sc-clear');
    await sleep(300);
    check('raccourci de l’application effacé', (await page.inputValue('.app-sc-row[data-id="nextProfile"] .trigger-input')) === ''
      && (await page.locator('.app-sc-row[data-id="nextProfile"] .warn-text').count()) === 0);

    // Sauvegardes automatiques : création, liste, restauration
    await page.click('#backup-now');
    await sleep(400);
    const bdir = path.join(data, 'satella-data', 'sauvegardes');
    check('sauvegarde créée et listée', (await page.locator('.backup-item').count()) >= 1
      && fs.readdirSync(bdir).some((n) => /^sauvegarde-.*\.satella$/.test(n)));
    await page.click('.backup-item .b-restore >> nth=0');
    await sleep(600);
    check('restauration d’une sauvegarde automatique', (await page.textContent('#toast')).includes('restaurée'));
    check('sauvegarde : nom hors du dossier refusé',
      (await page.evaluate(() => window.satella.backups.restore('../settings.json'))).ok === false);
    await page.click('#diag-copy');
    await sleep(300);
    const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
    check('diagnostic copié', clip.includes('Satella') && clip.includes('Fin du journal'));
    await page.click('#leds-toggle');
    await sleep(200);
    check('extinction des LED', (await page.textContent('#leds-toggle')).includes('rallumer'));
    await page.click('#leds-toggle');

    // Turbo en conflit avec une macro
    await page.click('.nav-btn[data-page="macros"]');
    await page.click('#turbo-add');
    await sleep(200);
    await page.click('.tb-accel');
    await page.keyboard.press('Control+Alt+KeyK');
    await sleep(500);
    check('conflit turbo / macro signalé', (await page.locator('.turbo-row .warn-text').count()) === 1);

    check('aucune erreur JavaScript', errors.length === 0, errors.join(' | '));
  } finally {
    await app.close();
  }

  // ---- Redémarrage : persistance, journal, « quoi de neuf » ----
  const metaFile = path.join(data, 'satella-data', 'app-meta.json');
  fs.writeFileSync(metaFile, JSON.stringify({ lastVersion: '1.0.0' }));
  const app2 = await launch(data);
  try {
    const page2 = await firstPage(app2);
    const p2 = await page2.evaluate(() => window.satella.profiles.list());
    check('profil actif conservé au redémarrage', !!p2.active);
    await sleep(500);
    const modal = await page2.textContent('#modal');
    check('« quoi de neuf » après une mise à jour', /quoi de neuf/i.test(modal) && modal.includes('Nouveautés'), modal.slice(0, 80));
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    const version = require(path.join(APP, 'package.json')).version;
    check('version notée', meta.lastVersion === version);
    check('journal écrit', fs.readFileSync(path.join(data, 'logs', 'satella.log'), 'utf8').includes('Satella'));
  } finally {
    await app2.close();
  }

  fs.rmSync(data, { recursive: true, force: true });
  assert.deepEqual(failures, []);
});
