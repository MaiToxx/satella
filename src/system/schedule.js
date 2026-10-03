// Plages horaires quotidiennes (mode nuit, profils programmés) :
// « HH:MM »-« HH:MM », y compris à cheval sur minuit (23:00 -> 07:00).

function toMinutes(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
  if (!m) return null;
  const h = +m[1];
  const min = +m[2];
  return h > 23 || min > 59 ? null : h * 60 + min;
}

function inTimeWindow(from, to, date = new Date()) {
  const a = toMinutes(from);
  const b = toMinutes(to);
  if (a === null || b === null || a === b) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  return a < b ? now >= a && now < b : now >= a || now < b;
}

// Profil voulu par la bascule automatique : celui lié à l'application au
// premier plan, sinon celui dont la plage horaire est en cours, sinon le
// profil par défaut. { profile, reason: 'app' | 'schedule' | 'default' } ou null
function autoProfileFor(profiles, exe, date = new Date()) {
  const match = exe ? profiles.find((p) => (p.apps || []).includes(exe)) : null;
  if (match) return { profile: match, reason: 'app' };
  const timed = profiles.find((p) => p.schedule && inTimeWindow(p.schedule.from, p.schedule.to, date));
  if (timed) return { profile: timed, reason: 'schedule' };
  const def = profiles.find((p) => p.isDefault);
  return def ? { profile: def, reason: 'default' } : null;
}

module.exports = { inTimeWindow, toMinutes, autoProfileFor };
