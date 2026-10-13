'use client';

/**
 * v1439 — Deploy eines Geräte-Projekts im Web (wie in der App). v1443 B15 — je Stufe dev/test/prod ein eigenes Ziel, Hochstufen (der in
 * der Stufe davor grüne Stand), die Projektumgebung der Stufe geht als .env mit. Ziel, Deploy, Hochstufen und Rollback gehen immer zur
 * Bestätigung an den Owner (Telegram/App) — hier wird nur die Anfrage gestellt.
 */
import { useCallback, useEffect, useState } from 'react';
import type { AlfredClient, DeployInfo, DeployStufe } from '@/lib/alfred-client';

const TOKEN: Record<string, string> = { projekt: 'Projekt-Token (Projektumgebung)', gitlab: 'vorhandenes GitLab-Token', github: 'vorhandenes GitHub-Token' };
const STUFEN = ['dev', 'test', 'prod'] as const;
const naechste = (s: string) => (s === 'dev' ? 'test' : s === 'test' ? 'prod' : undefined);
type Aktion = 'ziel' | 'ziel_entfernen' | 'deploy' | 'rollback' | 'hochstufen' | 'remote';

export function GeraeteProjektDeploy({ client, projektId }: { client: AlfredClient; projektId: string }) {
  const [d, setD] = useState<DeployInfo | null>(null);
  const [bearbeiten, setBearbeiten] = useState<string | null>(null);
  const [remoteOffen, setRemoteOffen] = useState(false); // v1444
  const [remote, setRemote] = useState('');
  const [busy, setBusy] = useState(false);
  const [meldung, setMeldung] = useState<{ ok: boolean; text: string } | null>(null);
  const [f, setF] = useState({ host: '', user: '', process_manager: 'pm2', app_port: '', branch: '', env_stage: '', auto_dev: false });

  const laden = useCallback(async () => { setD(await client.geraetProjektDeployInfo(projektId).catch(() => null)); }, [client, projektId]);
  useEffect(() => { void laden(); }, [laden]);

  const senden = async (aktion: Aktion, felder: Record<string, unknown>) => {
    setBusy(true); setMeldung(null);
    const r: { success: boolean; display?: string; error?: string } = await client.geraetProjektDeploy(projektId, aktion, felder).catch((e: Error) => ({ success: false, error: e.message }));
    setBusy(false);
    setMeldung({ ok: r.success, text: r.success ? (r.display ?? 'Gestellt.') : (r.error ?? 'Fehler') });
    if (r.success) { setBearbeiten(null); await laden(); }
  };
  const oeffnen = (s: string, e?: DeployStufe) => {
    const z = e?.ziel;
    setF({ host: z?.host ?? '', user: z?.user ?? '', process_manager: z?.prozess ?? 'pm2', app_port: z?.appPort ? String(z.appPort) : '', branch: z?.branch ?? '', env_stage: z?.envStage ?? '', auto_dev: !!z?.autoDev });
    setBearbeiten(s);
  };

  if (!d || 'error' in d) return null;
  const feld = 'bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1 text-gray-200 text-xs';
  const knopf = 'px-2 py-1 text-xs text-gray-200 border border-[#2a2a2a] rounded hover:bg-[#222] disabled:opacity-40';
  const st = d.stufen ?? {};
  return (
    <div className="bg-[#141414] border border-[#2a2a2a] rounded p-3 space-y-2 text-xs text-gray-300">
      <div className="text-gray-100 text-sm">🚀 Deploy</div>
      <div className="flex items-center gap-2">
        <div className="text-gray-500 flex-1">{d.repoUrl ? <>Repo: {d.repoUrl} · {d.token ? `Token: ${TOKEN[d.token] ?? d.token}` : 'kein Token gefunden'}</> : 'Kein Remote — ohne Remote kein Push und kein Deploy.'}</div>
        <button disabled={busy} onClick={() => setRemoteOffen(!remoteOffen)} className={knopf}>{remoteOffen ? 'Abbrechen' : d.repoUrl ? 'Remote ändern' : 'Remote einrichten'}</button>
      </div>
      {remoteOffen && (
        <div className="space-y-2">
          <input className={`${feld} w-full`} placeholder="Adresse eines vorhandenen Repos, z. B. https://git.lokalkraft.at/madh/projekt.git" value={remote} onChange={x => setRemote(x.target.value)} />
          <div className="flex items-center gap-2">
            <button disabled={busy || !remote.trim()} onClick={() => void senden('remote', { repo: remote.trim() }).then(() => setRemoteOffen(false))} className="px-3 py-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded">Eintragen (zur Bestätigung)</button>
            <button disabled={busy} onClick={() => void senden('remote', { anlegen: true }).then(() => setRemoteOffen(false))} className={knopf}>Neues Repo auf GitLab anlegen</button>
            {d.repoUrl && <button disabled={busy} onClick={() => void senden('remote', { entfernen: true }).then(() => setRemoteOffen(false))} className="text-red-400 hover:text-red-300">Remote entfernen</button>}
          </div>
          <div className="text-gray-500">Danach pusht Alfred den bisherigen Stand einmal, dann nach jeder abgenommenen Etappe.</div>
        </div>
      )}
      {STUFEN.map(s => {
        const e = st[s];
        const l = e?.letzter;
        const n = naechste(s);
        const kannHoch = !!n && !!l?.ok && !!l?.nachher && !!st[n]?.bestaetigt;
        return (
          <div key={s} className="border-t border-[#222] pt-2 space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-gray-100 w-10">{s}</span>
              <span className={`flex-1 ${e ? '' : 'text-gray-500'}`}>{e ? `${e.zielText}${e.bestaetigt ? '' : ' (nicht bestätigt)'}` : 'kein Ziel'}</span>
              <button disabled={busy} onClick={() => (bearbeiten === s ? setBearbeiten(null) : oeffnen(s, e))} className={knopf}>{bearbeiten === s ? 'Abbrechen' : e ? 'Ändern' : 'Festlegen'}</button>
            </div>
            {l && <div className={`whitespace-pre-wrap ${l.ok ? 'text-gray-400' : 'text-red-400'}`}>{l.ok ? '✅' : '❌'} {new Date(l.zeit).toLocaleString('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}{l.nachher ? ` · ${l.nachher.slice(0, 7)}` : ''} · {l.text.split('\n')[0]}</div>}
            {bearbeiten === s && (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2">
                  <input className={`${feld} w-48`} placeholder="Zielrechner, z. B. 192.168.1.96" value={f.host} onChange={x => setF({ ...f, host: x.target.value })} />
                  <input className={`${feld} w-36`} placeholder="SSH-Benutzer (root)" value={f.user} onChange={x => setF({ ...f, user: x.target.value })} />
                  <select className={feld} value={f.process_manager} onChange={x => setF({ ...f, process_manager: x.target.value })}><option value="pm2">pm2</option><option value="systemd">systemd</option><option value="docker-compose">Docker Compose</option></select>
                  <input className={`${feld} w-24`} type="number" placeholder="Port" value={f.app_port} onChange={x => setF({ ...f, app_port: x.target.value })} />
                  <input className={`${feld} w-32`} placeholder="Zweig (optional)" value={f.branch} onChange={x => setF({ ...f, branch: x.target.value })} />
                  <input className={`${feld} w-40`} placeholder={`Umgebung (Standard ${s})`} value={f.env_stage} onChange={x => setF({ ...f, env_stage: x.target.value })} />
                </div>
                {s === 'dev' && <label className="flex items-center gap-2"><input type="checkbox" checked={f.auto_dev} onChange={x => setF({ ...f, auto_dev: x.target.checked })} />Automatisch nach grüner Abnahme aller Etappen</label>}
                <div className="flex items-center gap-2">
                  {e && <button disabled={busy} onClick={() => void senden('ziel_entfernen', { stufe: s })} className="text-red-400 hover:text-red-300">Ziel entfernen</button>}
                  <div className="flex-1" />
                  <button disabled={busy || !f.host.trim()} onClick={() => void senden('ziel', { stufe: s, host: f.host.trim(), user: f.user.trim(), process_manager: f.process_manager, ...(s === 'dev' ? { auto_dev: f.auto_dev } : {}), ...(f.app_port ? { app_port: Number(f.app_port) } : {}), branch: f.branch.trim(), env_stage: f.env_stage.trim() })} className="px-3 py-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded">Zur Bestätigung</button>
                </div>
              </div>
            )}
            {e && bearbeiten !== s && (
              <div className="flex items-center gap-2">
                <button disabled={busy || !e.bestaetigt || !d.repoUrl} onClick={() => void senden('deploy', { stufe: s })} className="px-3 py-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded">Deployen</button>
                {n && <button disabled={busy || !kannHoch} onClick={() => void senden('hochstufen', { von: s, nach: n })} className={knopf}>⬆️ nach {n}</button>}
                <button disabled={busy || !l?.vorher} onClick={() => void senden('rollback', { stufe: s })} className={knopf}>Rollback</button>
              </div>
            )}
          </div>
        );
      })}
      <div className="text-gray-500">Ziel, Deploy, Hochstufen und Rollback brauchen deine Bestätigung. Die Umgebung der Stufe geht als .env aufs Ziel; danach prüft Alfred Status, HTTP und Logs.</div>
      {meldung && <div className={meldung.ok ? 'text-emerald-400' : 'text-red-400'}>{meldung.text}</div>}
    </div>
  );
}
