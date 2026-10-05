// Moteur de réglages simulé, pour les tests de bout en bout hors Windows
// (SATELLA_FAKE_TUNING=1) : un portable de jeu Ryzen + Radeon, avec la même
// interface que le moteur Windows et la même mise en forme des lectures.

const {
  BALANCED_PLAN, BOOST_MODES, GPU_PREFS, normalizeProbe, parseDx, formatDx, validExePath,
} = require('./tuning');

function create() {
  const plans = [
    { guid: BALANCED_PLAN, name: 'Utilisation normale' },
    { guid: '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c', name: 'Performances élevées' },
  ];
  let activePlan = BALANCED_PLAN;
  let overlay = 'balanced';
  const boost = { ac: 2, dc: 2 };
  let temp = { bytes: 1288490188, files: 2417 };
  const raw = {
    admin: false,
    gameMode: null,
    dvr: 1,
    capture: 1,
    hags: 1,
    gpuPrefs: {},
    gpus: ['AMD Radeon(TM) Graphics', 'AMD Radeon RX 5600M'],
    maker: 'Dell Inc.',
    model: 'Dell G5 5505',
    battery: true,
    startup: [
      { scope: 'hkcu', name: 'Discord', cmd: 'C:\\Users\\Joueur\\AppData\\Local\\Discord\\Update.exe --processStart Discord.exe', state: -1 },
      { scope: 'hklm', name: 'Dell SupportAssist', cmd: '"C:\\Program Files\\Dell\\SupportAssistAgent\\bin\\SupportAssist.exe" /startup', state: 2 },
      { scope: 'ufolder', name: 'Spotify.lnk', cmd: 'C:\\Users\\Joueur\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Spotify.lnk', state: 3 },
    ],
  };
  const hex = (n) => n.toString(16).padStart(8, '0');
  const planText = () => plans
    .map((p) => `GUID du mode de gestion de l'alimentation : ${p.guid}  (${p.name})${p.guid === activePlan ? ' *' : ''}`)
    .join('\r\n');
  const boostText = () => '  GUID du paramètre d\'alimentation : be337238-0d82-4146-a960-4f3749d470c7\r\n'
    + `    Index de paramètre courant du secteur : 0x${hex(boost.ac)}\r\n`
    + `    Index de paramètre courant de la batterie : 0x${hex(boost.dc)}\r\n`;
  const ok = { ok: true };

  return {
    async probe({ onBattery = false } = {}) {
      return normalizeProbe({ ...raw, plans: planText(), boost: boostText() }, {
        overlay: activePlan === BALANCED_PLAN ? overlay : 'balanced',
        release: '10.0.22631',
        totalmem: 16 * 2 ** 30,
        cpu: 'AMD Ryzen 7 4800H with Radeon Graphics',
        onBattery,
      });
    },
    async setOverlay(id) {
      if (!['efficiency', 'balanced', 'performance'].includes(id)) return { ok: false, error: 'mode inconnu' };
      overlay = id;
      return ok;
    },
    async setBoost(ac, dc) {
      if ((ac !== undefined && ac !== null && !BOOST_MODES.includes(ac))
        || (dc !== undefined && dc !== null && !BOOST_MODES.includes(dc))) return { ok: false, error: 'valeur invalide' };
      if (ac !== undefined && ac !== null) boost.ac = ac;
      if (dc !== undefined && dc !== null) boost.dc = dc;
      return ok;
    },
    async setPlan(guid) {
      if (!plans.some((p) => p.guid === guid)) return { ok: false, error: 'mode inconnu' };
      activePlan = guid;
      return ok;
    },
    async createUltimate() {
      const guid = 'a5f3c2b1-0d1e-4f2a-9b3c-4d5e6f708192';
      plans.push({ guid, name: 'Performances optimales' });
      activePlan = guid;
      return { ok: true, guid };
    },
    async setGameMode(on) { raw.gameMode = on ? 1 : 0; return ok; },
    async setGameDvr(on) { raw.dvr = raw.capture = on ? 1 : 0; return ok; },
    async setHags(on) { raw.hags = on ? 2 : 1; return { ok: true, restart: true }; },
    async setWindowed(on) {
      const cur = parseDx(raw.gpuPrefs.DirectXUserGlobalSettings);
      cur.SwapEffectUpgradeEnable = on ? '1' : '0';
      raw.gpuPrefs.DirectXUserGlobalSettings = formatDx(cur);
      return ok;
    },
    async setGpuPref(exe, pref) {
      if (!validExePath(exe)) return { ok: false, error: 'programme invalide' };
      if (pref === null) { delete raw.gpuPrefs[exe]; return ok; }
      if (!GPU_PREFS.includes(pref)) return { ok: false, error: 'valeur invalide' };
      const cur = parseDx(raw.gpuPrefs[exe]);
      cur.GpuPreference = String(pref);
      raw.gpuPrefs[exe] = formatDx(cur);
      return ok;
    },
    async setStartup(id, enabled) {
      const e = raw.startup.find((s) => `${s.scope}:${s.name}` === id);
      if (!e) return { ok: false, error: 'programme introuvable' };
      e.state = enabled ? 2 : 3;
      return ok;
    },
    async tempInfo() { return { dir: 'C:\\Users\\Joueur\\AppData\\Local\\Temp', ...temp }; },
    async tempClean() {
      const res = { ok: true, freed: temp.bytes, removed: temp.files, failed: 3 };
      temp = { bytes: 0, files: 0 };
      return res;
    },
    // Pas de boîte de dialogue dans les tests : un jeu fictif
    async pickExe() { return 'C:\\Games\\Valorant\\VALORANT.exe'; },
  };
}

module.exports = { create };
