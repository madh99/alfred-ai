/**
 * v1937 — Block 26.10. (Owner 23.11. „ok“): Interessen-Themen werden nicht mehr einzeln je Tag gemeldet (872 liefen ohne Reaktion ab),
 * sondern sonntags als eine Wochenübersicht aus den still abgelegten Themen-Digests („<Thema>: <n> neue Beiträge“).
 */
export function interessenWochenText(titel: string[]): string {
  const summe = new Map<string, number>();
  for (const t of titel) {
    const m = t.match(/^(.+?):\s*(\d+)\s+neue Beiträge/);
    if (!m) continue;
    summe.set(m[1]!.trim(), (summe.get(m[1]!.trim()) ?? 0) + Number(m[2]));
  }
  if (!summe.size) return '';
  const zeilen = [...summe].sort((a, b) => b[1] - a[1]).map(([thema, n]) => `- ${thema} — ${n} neue Beiträge`);
  return `📡 Interessen — Wochenübersicht (${summe.size} Themen)\n\n${zeilen.join('\n')}\n\nDetails je Thema in der Interessen-Ansicht.`;
}
