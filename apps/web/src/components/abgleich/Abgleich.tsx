'use client';

/**
 * v1494 — Listen-Abgleich wie in der App 1.40.0 (Owner 18.10.: „Vorgang proxmox test-ubuntu war noch offen, nach meinem Klick
 * nicht mehr“). Offene Seiten fragen regelmäßig nach; was zwischendurch anderswo erledigt wurde (Befund weg, in der App oder
 * in Telegram entschieden), verschwindet nicht stumm, sondern steht oben als „Inzwischen erledigt“.
 */
export const ABGLEICH_MS = 45_000;

/** Kennungen aus `vorher`, die im neuen Stand fehlen. */
export function verschwundeneIds(vorher: Map<string, string>, jetzt: Iterable<string>): string[] {
  const j = new Set(jetzt);
  return [...vorher.keys()].filter(k => !j.has(k));
}

export function mitNeuen(bisher: string[], neu: string[], max = 6): string[] {
  const alle = [...bisher, ...neu];
  return alle.length > max ? alle.slice(alle.length - max) : alle;
}

export const kurz = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function AbgleichHinweis({ texte, onSchliessen }: { texte: string[]; onSchliessen: () => void }) {
  if (!texte.length) return null;
  return (
    <div className="flex gap-2 items-start rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-200">
      <span aria-hidden>⟳</span>
      <div className="flex-1">
        <div className="font-medium text-sky-100">Inzwischen erledigt</div>
        {texte.map((t, i) => <div key={i} className="text-sky-200/90">· {t}</div>)}
      </div>
      <button onClick={onSchliessen} className="text-sky-300 hover:text-sky-100" title="Ausblenden">✕</button>
    </div>
  );
}
