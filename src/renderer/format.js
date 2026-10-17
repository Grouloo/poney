// Display formatting shared by the UI (no DOM: also usable from Node tests).

export const fmtNum = (n, digits = 1) =>
  n.toLocaleString('fr-FR', { maximumFractionDigits: digits, minimumFractionDigits: digits });

const pad = (n) => String(n).padStart(2, '0');

/**
 * Human-friendly duration: "3,2 s", "42 s", "2 min 05 s", "1 h 03 min 12 s".
 * Tenths of a second only under 10 s, where they matter.
 */
export function fmtDuration(ms) {
  const safe = Math.max(0, ms || 0);
  if (safe < 10_000) return `${fmtNum(Math.floor(safe / 100) / 10)} s`;
  const total = Math.floor(safe / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h} h ${pad(m)} min ${pad(s)} s`;
  if (m) return `${m} min ${pad(s)} s`;
  return `${s} s`;
}
