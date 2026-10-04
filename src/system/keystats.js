// Statistiques de frappe : nombre d'appuis par jour (jour local AAAA-MM-JJ),
// les 120 derniers jours sont gardés.

const DAYS_KEPT = 120;
const pad2 = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

function countKeyDay(days, date = new Date()) {
  const day = localDay(date);
  if (!days[day]) {
    // Nouveau jour : on oublie les jours trop anciens (comparaison de chaînes
    // AAAA-MM-JJ = ordre chronologique)
    const limit = localDay(new Date(date.getFullYear(), date.getMonth(), date.getDate() - DAYS_KEPT));
    for (const d of Object.keys(days)) if (d < limit) delete days[d];
  }
  days[day] = (days[day] || 0) + 1;
  return days;
}

module.exports = { countKeyDay, localDay, DAYS_KEPT };
