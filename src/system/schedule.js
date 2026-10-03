// Plages horaires quotidiennes (mode nuit) : « HH:MM »-« HH:MM », y compris
// à cheval sur minuit (23:00 -> 07:00).

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

module.exports = { inTimeWindow, toMinutes };
