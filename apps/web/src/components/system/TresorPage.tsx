'use client';

/**
 * I4c (Owner 22.10.2026, 5b-5) — Tresor: Geheimnisse für Infrastruktur-Changes. Werte gehen direkt an den Server (AES-256-GCM,
 * eigener Schlüssel), nie über das Modell, und kommen nie zurück. Alfred setzt sie nur im Ausführungsmotor eines freigegebenen Changes ein.
 */
import { useEffect, useState, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';

const feld = 'w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded px-3 py-2 text-sm text-gray-200';

export function TresorPage() {
  const { client } = useConfig();
  const [eintraege, setEintraege] = useState<Array<{ name: string; herkunft: string; zweck?: string; geaendert: string }>>([]);
  const [protokoll, setProtokoll] = useState<Array<{ name: string; art: string; wofuer?: string; zeit: string }>>([]);
  const [meldung, setMeldung] = useState<{ ok: boolean; text: string } | null>(null);
  const [f, setF] = useState({ name: '', wert: '', zweck: '' });

  const laden = useCallback(async () => {
    if (!client) return;
    const x = await client.tresor().catch(() => null);
    if (x?.error) setMeldung({ ok: false, text: x.error });
    setEintraege(x?.eintraege ?? []); setProtokoll(x?.protokoll ?? []);
  }, [client]);
  useEffect(() => { void laden(); }, [laden]);

  const setzen = async () => {
    if (!client) return;
    const x = await client.tresorAktion({ action: 'setzen', name: f.name.trim(), wert: f.wert, zweck: f.zweck.trim() || undefined }).catch((e: Error): { ok?: boolean; error?: string } => ({ error: e.message }));
    setMeldung(x.ok ? { ok: true, text: `„${f.name.trim()}“ gespeichert.` } : { ok: false, text: x.error ?? 'Fehler' });
    if (x.ok) { setF({ name: '', wert: '', zweck: '' }); await laden(); }
  };
  const entfernen = async (name: string) => {
    if (!client || !confirm(`Tresor-Eintrag „${name}“ entfernen? Changes, die ihn brauchen, können dann nicht mehr laufen.`)) return;
    const x = await client.tresorAktion({ action: 'entfernen', name }).catch((e: Error): { ok?: boolean; error?: string } => ({ error: e.message }));
    setMeldung(x.ok ? { ok: true, text: `„${name}“ entfernt.` } : { ok: false, text: x.error ?? 'nicht gefunden' });
    await laden();
  };

  return (
    <div className="p-6 max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-100">Tresor</h1>
        <p className="text-sm text-gray-500 mt-1">Passwörter und Schlüssel für Infrastruktur-Changes. Der Wert geht direkt verschlüsselt an den Server — Alfreds Modell sieht ihn nie, er wird nie angezeigt. In Changes steht nur der Name (<code>{'{{geheimdatei:name}}'}</code> bzw. <code>{'{{geheim:name}}'}</code>).</p>
      </div>
      {meldung && <div className={`text-sm rounded px-3 py-2 ${meldung.ok ? 'bg-green-500/10 text-green-300' : 'bg-red-500/10 text-red-300'}`}>{meldung.text}</div>}
      <section className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
        <h2 className="text-sm font-semibold text-gray-300 mb-2">Einträge ({eintraege.length})</h2>
        {eintraege.length === 0 && <p className="text-xs text-gray-500">Leer.</p>}
        {eintraege.map(e => (
          <div key={e.name} className="flex items-center justify-between text-sm py-1 border-t border-[#1f1f1f]">
            <span className="text-gray-200"><strong>{e.name}</strong> <span className="text-gray-500">· {e.herkunft}{e.zweck ? ` · ${e.zweck}` : ''} · {new Date(e.geaendert).toLocaleString('de-AT')}</span></span>
            <button onClick={() => void entfernen(e.name)} className="text-xs text-red-400 hover:text-red-300">entfernen</button>
          </div>
        ))}
      </section>
      <section className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4 space-y-2">
        <h2 className="text-sm font-semibold text-gray-300">Wert hinterlegen oder ersetzen</h2>
        <input className={feld} placeholder="Name, z. B. matrix-db-passwort (Kleinbuchstaben, Ziffern, . _ -)" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} autoComplete="off" />
        <textarea className={`${feld} font-mono h-24`} placeholder="Wert (auch mehrzeilig, z. B. eine .env-Datei)" value={f.wert} onChange={e => setF({ ...f, wert: e.target.value })} autoComplete="off" spellCheck={false} />
        <input className={feld} placeholder="Zweck (optional)" value={f.zweck} onChange={e => setF({ ...f, zweck: e.target.value })} />
        <button disabled={!f.name.trim() || !f.wert} onClick={() => void setzen()} className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50">Speichern</button>
      </section>
      <section className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
        <h2 className="text-sm font-semibold text-gray-300 mb-2">Zugriffe (ohne Werte)</h2>
        {protokoll.length === 0 && <p className="text-xs text-gray-500">Keine.</p>}
        {protokoll.map((p, i) => <div key={i} className="text-xs text-gray-400 py-0.5">{new Date(p.zeit).toLocaleString('de-AT')} · {p.name} · {p.art}{p.wofuer ? ` · ${p.wofuer}` : ''}</div>)}
      </section>
    </div>
  );
}
