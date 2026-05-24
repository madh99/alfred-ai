'use client';

import { useState, useRef } from 'react';
import { useConfig } from '@/context/ConfigContext';

interface Props {
  onClose: () => void;
  onCreated: (projectId: string) => void;
}

interface Stack {
  frontend: string;
  backend: string;
  database: string;
  extras: string[];
  rationale: string;
}

interface PlanItem {
  title: string;
  description?: string;
  priority: 'low' | 'normal' | 'high';
  roadmapMilestone: string;
  roadmapOrder: number;
}

interface Decision {
  choice: string;
  rationale: string;
}

interface ValidatorResult {
  ok: boolean;
  issues: string[];
  suggestions: string[];
}

const FRONTENDS = ['Next.js', 'Vite+React', 'Astro', 'SvelteKit', 'Nuxt', 'Remix', 'None - backend only'];
const BACKENDS = ['Node/Express', 'Hono', 'Fastify', 'FastAPI (Python)', 'Bun', 'None - frontend only'];
const DATABASES = ['SQLite', 'PostgreSQL', 'MongoDB', 'MySQL', 'None'];
const EXTRAS = ['TypeScript', 'Tailwind', 'Auth', 'Docker', 'i18n', 'Testing', 'CI/CD', 'Storybook'];

export function ProjectWizardModal({ onClose, onCreated }: Props) {
  const { client } = useConfig();
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Step 1 — Basics
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [tags, setTags] = useState('');

  // Step 2 — Description (with optional voice)
  const [description, setDescription] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  // Step 3 — Tech-Stack
  const [stackMode, setStackMode] = useState<'suggest' | 'manual'>('suggest');
  const [stack, setStack] = useState<Stack | null>(null);
  const [manualFrontend, setManualFrontend] = useState('Next.js');
  const [manualBackend, setManualBackend] = useState('Node/Express');
  const [manualDatabase, setManualDatabase] = useState('PostgreSQL');
  const [manualExtras, setManualExtras] = useState<string[]>(['TypeScript']);

  // Step 4 — Plan-Review
  const [items, setItems] = useState<PlanItem[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [validator, setValidator] = useState<ValidatorResult | null>(null);

  // Step 5 — Setup (v766)
  const [repoMode, setRepoMode] = useState<'gitlab' | 'github' | 'local'>('local');
  const [scaffoldMode, setScaffoldMode] = useState<'template' | 'agent' | 'none'>('template');
  const [repoVisibility, setRepoVisibility] = useState<'private' | 'public'>('private');

  function slugify(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  }
  function onNameChange(v: string) {
    setName(v);
    if (!slug) setSlug(slugify(v));
  }

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia) { alert('Mikrofon nicht verfügbar.'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      audioChunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        if (blob.size < 1000) { setIsRecording(false); return; }
        setTranscribing(true);
        try {
          const transcript = await client.transcribeAudio(blob);
          if (transcript) setDescription(prev => prev ? prev + ' ' + transcript : transcript);
          else alert('Transkription leer.');
        } catch (err) {
          alert('Transkription fehlgeschlagen: ' + (err instanceof Error ? err.message : String(err)));
        } finally {
          setTranscribing(false);
          setIsRecording(false);
        }
      };
      mr.start();
      mediaRecorderRef.current = mr;
      setIsRecording(true);
    } catch (err) {
      alert('Mikrofon-Zugriff verweigert: ' + (err instanceof Error ? err.message : String(err)));
    }
  }
  function stopRecording() { mediaRecorderRef.current?.stop(); }

  async function goToStep3() {
    if (!description.trim()) { setError('Beschreibung erforderlich'); return; }
    setError(null);
    setStep(3);
  }

  async function suggestStack() {
    setBusy('suggest'); setError(null);
    try {
      const s = await client.wizardSuggestStack(description);
      setStack(s);
    } catch (err) {
      setError('Stack-Vorschlag fehlgeschlagen: ' + (err instanceof Error ? err.message : String(err)));
    } finally { setBusy(null); }
  }

  async function generatePlan() {
    const effectiveStack: Stack = stackMode === 'suggest' && stack
      ? stack
      : {
          frontend: manualFrontend,
          backend: manualBackend,
          database: manualDatabase,
          extras: manualExtras,
          rationale: 'User-gewählt',
        };
    if (!stack) setStack(effectiveStack);
    setBusy('plan'); setError(null);
    try {
      const p = await client.wizardGeneratePlan(description, effectiveStack);
      setItems(p.items);
      setDecisions(p.decisions);
      setStep(4);
      // Validator-Aufruf separat danach
      runValidator(effectiveStack, p.items);
    } catch (err) {
      setError('Plan-Generierung fehlgeschlagen: ' + (err instanceof Error ? err.message : String(err)));
    } finally { setBusy(null); }
  }

  async function runValidator(s: Stack, planItems: PlanItem[]) {
    setBusy('validate');
    try {
      const v = await client.wizardValidate(description, s, planItems.map(it => ({ title: it.title })));
      setValidator(v);
    } catch {
      // non-fatal
      setValidator(null);
    } finally { setBusy(null); }
  }

  function updateItem(idx: number, patch: Partial<PlanItem>) {
    setItems(prev => prev.map((it, i) => i === idx ? { ...it, ...patch } : it));
  }
  function removeItem(idx: number) {
    setItems(prev => prev.filter((_, i) => i !== idx));
  }
  function addItem() {
    setItems(prev => [...prev, { title: '', priority: 'normal', roadmapMilestone: 'Misc', roadmapOrder: prev.length + 1 }]);
  }

  async function create() {
    if (!stack) { setError('Stack fehlt'); return; }
    if (items.filter(it => it.title.trim()).length === 0) { setError('Mindestens ein Open-Item mit Titel'); return; }
    setBusy('create'); setError(null);
    try {
      const r = await client.wizardCreate({
        name: name.trim(),
        slug: slug.trim() || undefined,
        description: description.trim(),
        stack,
        items: items.filter(it => it.title.trim()),
        decisions,
        tags: tags.split(',').map(t => t.trim()).filter(Boolean),
        repoMode,
        scaffoldMode,
        repoVisibility,
      });
      if (!r.ok || !r.projectId) {
        setError(r.reason ?? 'Erstellung fehlgeschlagen');
        return;
      }
      onCreated(r.projectId);
      onClose();
    } catch (err) {
      setError('Erstellung fehlgeschlagen: ' + (err instanceof Error ? err.message : String(err)));
    } finally { setBusy(null); }
  }

  const stepLabels = ['Basics', 'Beschreibung', 'Tech-Stack', 'Plan-Review', 'Setup'];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-lg border border-purple-500/40 bg-[#0f0f0f] p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-purple-300">🪄 Neues Projekt — Wizard</h2>
          <button onClick={onClose} className="px-2 py-1 border border-gray-600 text-gray-300 hover:bg-gray-700/40 rounded text-[11px]">✕</button>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-1 mb-3 text-[10px]">
          {stepLabels.map((label, i) => {
            const stepNum = (i + 1) as 1 | 2 | 3 | 4 | 5;
            const current = stepNum === step;
            const past = stepNum < step;
            return (
              <div key={i} className="flex items-center gap-1 flex-1">
                <div className={`flex-1 text-center px-2 py-1 rounded ${current ? 'bg-purple-600 text-white' : past ? 'bg-emerald-600/30 text-emerald-300' : 'bg-[#1a1a1a] text-gray-500'}`}>
                  {i + 1}. {label}
                </div>
                {i < stepLabels.length - 1 && <span className="text-gray-600">›</span>}
              </div>
            );
          })}
        </div>

        {error && <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-3 py-1.5 rounded mb-2 text-xs">{error}</div>}

        <div className="flex-1 overflow-y-auto pr-1">
          {/* Step 1 — Basics */}
          {step === 1 && (
            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">Projekt-Name *</label>
                <input type="text" value={name} onChange={(e) => onNameChange(e.target.value)} placeholder="z.B. Newsletter-Service"
                  className="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-gray-200" autoFocus />
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">Slug (auto)</label>
                <input type="text" value={slug} onChange={(e) => setSlug(slugify(e.target.value))}
                  className="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-gray-200 font-mono" />
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">Tags (kommagetrennt, optional)</label>
                <input type="text" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="z.B. cms, marketing, internal"
                  className="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-gray-200" />
              </div>
              <div className="text-[10px] text-gray-500">In v764: kein Repo-Create. Das kommt in v765 — der Wizard speichert erstmal nur Metadaten + Roadmap. Du kannst danach manuell repo erstellen oder auf v765 warten.</div>
            </div>
          )}

          {/* Step 2 — Description */}
          {step === 2 && (
            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">Was soll das Projekt sein? Was macht es, für wen? *</label>
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={8}
                  placeholder="Beschreibe ausführlich was das Projekt können soll, welche User-Stories es löst, was die wichtigsten Features sind. Je konkreter, desto besser der LLM-Vorschlag."
                  className="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-gray-200" />
              </div>
              <div className="flex items-center gap-2">
                <button onClick={isRecording ? stopRecording : startRecording} disabled={transcribing}
                  className={`px-3 py-1.5 border rounded text-[11px] ${isRecording ? 'border-red-500/60 text-red-400 bg-red-500/10 animate-pulse' : transcribing ? 'border-amber-500/60 text-amber-400' : 'border-gray-500/40 text-gray-300 hover:bg-gray-500/15'}`}>
                  {transcribing ? '⏳ Transkribiere…' : isRecording ? '⏺ Aufnahme stoppen' : '🎤 Per Sprache diktieren'}
                </button>
                <span className="text-[10px] text-gray-500">Optional — wird per Speech-to-Text ans Textfeld angehängt</span>
              </div>
            </div>
          )}

          {/* Step 3 — Tech-Stack */}
          {step === 3 && (
            <div className="space-y-3 text-xs">
              <div className="flex gap-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" checked={stackMode === 'suggest'} onChange={() => setStackMode('suggest')} />
                  <span className="text-gray-300">Alfred soll vorschlagen (LLM)</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" checked={stackMode === 'manual'} onChange={() => setStackMode('manual')} />
                  <span className="text-gray-300">Ich wähle selbst</span>
                </label>
              </div>

              {stackMode === 'suggest' && (
                <div className="space-y-2">
                  {!stack && (
                    <button onClick={suggestStack} disabled={busy === 'suggest'}
                      className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white rounded text-[11px]">
                      {busy === 'suggest' ? '⏳ LLM denkt nach…' : '🪄 Stack-Vorschlag generieren'}
                    </button>
                  )}
                  {stack && (
                    <div className="border border-purple-500/30 bg-purple-500/5 rounded p-3 space-y-1.5">
                      <div className="grid grid-cols-2 gap-2">
                        <div><span className="text-[10px] text-gray-500 uppercase">Frontend:</span> <span className="text-gray-200">{stack.frontend}</span></div>
                        <div><span className="text-[10px] text-gray-500 uppercase">Backend:</span> <span className="text-gray-200">{stack.backend}</span></div>
                        <div><span className="text-[10px] text-gray-500 uppercase">Database:</span> <span className="text-gray-200">{stack.database}</span></div>
                        <div><span className="text-[10px] text-gray-500 uppercase">Extras:</span> <span className="text-gray-200">{stack.extras.join(', ') || '(keine)'}</span></div>
                      </div>
                      <div className="text-[10px] text-gray-400 italic pt-2 border-t border-purple-500/20">{stack.rationale}</div>
                      <button onClick={suggestStack} className="text-[10px] text-purple-300 hover:text-purple-200 underline">↻ Anderen Vorschlag generieren</button>
                    </div>
                  )}
                </div>
              )}

              {stackMode === 'manual' && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">Frontend</label>
                    <select value={manualFrontend} onChange={(e) => setManualFrontend(e.target.value)} className="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-gray-200">
                      {FRONTENDS.map(f => <option key={f} value={f}>{f}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">Backend</label>
                    <select value={manualBackend} onChange={(e) => setManualBackend(e.target.value)} className="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-gray-200">
                      {BACKENDS.map(f => <option key={f} value={f}>{f}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">Database</label>
                    <select value={manualDatabase} onChange={(e) => setManualDatabase(e.target.value)} className="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-gray-200">
                      {DATABASES.map(f => <option key={f} value={f}>{f}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">Extras</label>
                    <div className="flex flex-wrap gap-1">
                      {EXTRAS.map(ex => (
                        <button key={ex}
                          onClick={() => setManualExtras(prev => prev.includes(ex) ? prev.filter(x => x !== ex) : [...prev, ex])}
                          className={`px-2 py-0.5 text-[10px] rounded border ${manualExtras.includes(ex) ? 'bg-purple-500/20 border-purple-500/60 text-purple-200' : 'border-gray-600 text-gray-400 hover:border-purple-500/40'}`}>
                          {manualExtras.includes(ex) ? '✓ ' : ''}{ex}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Step 4 — Plan-Review */}
          {step === 4 && (
            <div className="space-y-3 text-xs">
              {busy === 'validate' && (
                <div className="bg-blue-500/10 border border-blue-500/30 rounded px-3 py-1.5 text-blue-300">⏳ LLM-Validator prüft Plan…</div>
              )}
              {validator && !validator.ok && (validator.issues.length > 0 || validator.suggestions.length > 0) && (
                <div className="bg-amber-500/10 border border-amber-500/30 rounded p-3 space-y-2">
                  <div className="text-amber-300 font-semibold">⚠️ Validator-Hinweise</div>
                  {validator.issues.length > 0 && (
                    <div>
                      <div className="text-[10px] uppercase text-amber-400 mb-1">Probleme:</div>
                      <ul className="list-disc list-inside text-gray-300 space-y-0.5">
                        {validator.issues.map((iss, i) => <li key={i}>{iss}</li>)}
                      </ul>
                    </div>
                  )}
                  {validator.suggestions.length > 0 && (
                    <div>
                      <div className="text-[10px] uppercase text-amber-400 mb-1">Vorschläge:</div>
                      <ul className="list-disc list-inside text-gray-300 space-y-0.5">
                        {validator.suggestions.map((sug, i) => <li key={i}>{sug}</li>)}
                      </ul>
                    </div>
                  )}
                  <div className="text-[10px] text-gray-500 italic">Du kannst Items unten editieren / löschen / hinzufügen, dann erstellen.</div>
                </div>
              )}
              {validator && validator.ok && (
                <div className="bg-emerald-500/10 border border-emerald-500/30 rounded px-3 py-1.5 text-emerald-300 text-xs">✓ Validator: Plan sieht gut aus</div>
              )}

              <div className="flex items-center justify-between">
                <span className="text-gray-400 font-semibold">Open-Items ({items.length})</span>
                <button onClick={addItem} className="px-2 py-0.5 text-[10px] border border-blue-500/40 text-blue-300 hover:bg-blue-500/10 rounded">+ Eigenes Item</button>
              </div>

              <div className="space-y-1.5">
                {items.map((it, i) => (
                  <div key={i} className="bg-[#0a0a0a] border border-[#1f1f1f] rounded p-2 space-y-1">
                    <div className="flex items-center gap-2">
                      <input type="text" value={it.title} onChange={(e) => updateItem(i, { title: e.target.value })}
                        placeholder="Item-Titel" className="flex-1 bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200" />
                      <select value={it.priority} onChange={(e) => updateItem(i, { priority: e.target.value as PlanItem['priority'] })}
                        className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-1 py-1 text-[10px] text-gray-200">
                        <option value="low">⚪ low</option>
                        <option value="normal">🟡 normal</option>
                        <option value="high">🔴 high</option>
                      </select>
                      <input type="text" value={it.roadmapMilestone} onChange={(e) => updateItem(i, { roadmapMilestone: e.target.value })}
                        placeholder="Milestone" className="w-32 bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-[10px] text-gray-200" />
                      <button onClick={() => removeItem(i)} className="text-red-400 hover:text-red-300 text-[11px]">✕</button>
                    </div>
                    {it.description && (
                      <textarea value={it.description} onChange={(e) => updateItem(i, { description: e.target.value })} rows={2}
                        className="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-[10px] text-gray-400" />
                    )}
                  </div>
                ))}
              </div>

              {decisions.length > 0 && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-gray-400 font-semibold">Entscheidungen ({decisions.length})</summary>
                  <div className="mt-2 space-y-1.5">
                    {decisions.map((d, i) => (
                      <div key={i} className="bg-[#0a0a0a] border border-[#1f1f1f] rounded p-2 text-[11px]">
                        <div className="text-gray-300 font-medium">{d.choice}</div>
                        <div className="text-gray-500 italic mt-0.5">{d.rationale}</div>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}

          {/* Step 5 — Setup (v766) */}
          {step === 5 && (
            <div className="space-y-4 text-xs">
              <div>
                <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-2">Repository</div>
                <div className="space-y-1">
                  <label className="flex items-start gap-2 cursor-pointer p-2 border border-[#1a1a1a] rounded hover:bg-[#1a1a1a]/30">
                    <input type="radio" checked={repoMode === 'local'} onChange={() => setRepoMode('local')} className="mt-0.5" />
                    <div>
                      <div className="text-gray-200">📁 Nur lokal</div>
                      <div className="text-[10px] text-gray-500">Kein Remote-Repo. Du kannst später manuell erstellen.</div>
                    </div>
                  </label>
                  <label className="flex items-start gap-2 cursor-pointer p-2 border border-[#1a1a1a] rounded hover:bg-[#1a1a1a]/30">
                    <input type="radio" checked={repoMode === 'gitlab'} onChange={() => setRepoMode('gitlab')} className="mt-0.5" />
                    <div>
                      <div className="text-gray-200">🦊 GitLab</div>
                      <div className="text-[10px] text-gray-500">Erstellt Repo via codeAgents.forge-Config (muss provider=gitlab haben).</div>
                    </div>
                  </label>
                  <label className="flex items-start gap-2 cursor-pointer p-2 border border-[#1a1a1a] rounded hover:bg-[#1a1a1a]/30">
                    <input type="radio" checked={repoMode === 'github'} onChange={() => setRepoMode('github')} className="mt-0.5" />
                    <div>
                      <div className="text-gray-200">🐙 GitHub</div>
                      <div className="text-[10px] text-gray-500">Erstellt Repo via codeAgents.forge-Config (muss provider=github haben).</div>
                    </div>
                  </label>
                </div>
                {repoMode !== 'local' && (
                  <div className="mt-2 flex items-center gap-3 text-[11px]">
                    <span className="text-gray-500">Sichtbarkeit:</span>
                    <label className="flex items-center gap-1 cursor-pointer"><input type="radio" checked={repoVisibility === 'private'} onChange={() => setRepoVisibility('private')} /> <span className="text-gray-300">🔒 privat</span></label>
                    <label className="flex items-center gap-1 cursor-pointer"><input type="radio" checked={repoVisibility === 'public'} onChange={() => setRepoVisibility('public')} /> <span className="text-gray-300">🌐 public</span></label>
                  </div>
                )}
              </div>

              <div>
                <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-2">Scaffold (Initial-Files)</div>
                <div className="space-y-1">
                  <label className="flex items-start gap-2 cursor-pointer p-2 border border-[#1a1a1a] rounded hover:bg-[#1a1a1a]/30">
                    <input type="radio" checked={scaffoldMode === 'template'} onChange={() => setScaffoldMode('template')} className="mt-0.5" />
                    <div>
                      <div className="text-gray-200">📦 Template (empfohlen)</div>
                      <div className="text-[10px] text-gray-500">README + .gitignore + git init + initial-commit. Schnell, deterministisch.</div>
                    </div>
                  </label>
                  <label className="flex items-start gap-2 cursor-pointer p-2 border border-[#1a1a1a] rounded hover:bg-[#1a1a1a]/30">
                    <input type="radio" checked={scaffoldMode === 'agent'} onChange={() => setScaffoldMode('agent')} className="mt-0.5" />
                    <div>
                      <div className="text-gray-200">🤖 AI-Scaffold (mit Code-Agent)</div>
                      <div className="text-[10px] text-gray-500">Template + Code-Agent läuft im Hintergrund und scaffoldet initiale Struktur (package.json, Configs, Entry-Points). Dauert 5-15min, committed + pusht selbständig.</div>
                    </div>
                  </label>
                  <label className="flex items-start gap-2 cursor-pointer p-2 border border-[#1a1a1a] rounded hover:bg-[#1a1a1a]/30">
                    <input type="radio" checked={scaffoldMode === 'none'} onChange={() => setScaffoldMode('none')} className="mt-0.5" />
                    <div>
                      <div className="text-gray-200">⊘ Kein Scaffold</div>
                      <div className="text-[10px] text-gray-500">Nur Metadaten + Roadmap speichern, kein Code anfassen.</div>
                    </div>
                  </label>
                </div>
              </div>

              <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded p-3 text-[10px] text-gray-400">
                <div className="font-semibold text-gray-300 mb-1">Was passiert beim Erstellen:</div>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>Projekt mit allen Steps-Daten wird in DB persistiert</li>
                  {scaffoldMode !== 'none' && <li>CWD <code className="text-amber-300">~/.alfred/projects/{slug}</code> wird angelegt + git init</li>}
                  {scaffoldMode !== 'none' && <li>README.md + .gitignore (Stack-aware) werden geschrieben + commited</li>}
                  {repoMode !== 'local' && <li>Remote-Repo wird via {repoMode}-API erstellt (Sichtbarkeit: {repoVisibility})</li>}
                  {repoMode !== 'local' && scaffoldMode !== 'none' && <li>Initial-Commit wird zu Remote gepusht</li>}
                  {scaffoldMode === 'agent' && <li className="text-purple-300">Code-Agent läuft im Hintergrund (5-15min) → AI-Scaffold + Auto-Commit{repoMode !== 'local' ? ' + Auto-Push' : ''}</li>}
                </ul>
              </div>
            </div>
          )}
        </div>

        {/* Navigation */}
        <div className="flex justify-between items-center pt-3 mt-3 border-t border-[#1a1a1a]">
          <button onClick={onClose} className="px-3 py-1.5 border border-gray-600 text-gray-300 hover:bg-gray-700/40 rounded text-[11px]">Abbrechen</button>
          <div className="flex gap-2">
            {step > 1 && (
              <button onClick={() => setStep((s) => (s - 1) as 1 | 2 | 3 | 4 | 5)} disabled={!!busy}
                className="px-3 py-1.5 border border-gray-600 text-gray-300 hover:bg-gray-700/40 rounded text-[11px] disabled:opacity-50">← Zurück</button>
            )}
            {step === 1 && (
              <button onClick={() => name.trim() ? setStep(2) : setError('Name erforderlich')}
                className="px-4 py-1.5 bg-purple-600 hover:bg-purple-500 text-white rounded text-[11px]">Weiter →</button>
            )}
            {step === 2 && (
              <button onClick={goToStep3} className="px-4 py-1.5 bg-purple-600 hover:bg-purple-500 text-white rounded text-[11px]">Weiter →</button>
            )}
            {step === 3 && (
              <button onClick={generatePlan} disabled={busy === 'plan' || (stackMode === 'suggest' && !stack)}
                className="px-4 py-1.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white rounded text-[11px]">
                {busy === 'plan' ? '⏳ Plan wird generiert…' : 'Plan generieren →'}
              </button>
            )}
            {step === 4 && (
              <button onClick={() => items.filter(it => it.title.trim()).length === 0 ? setError('Mindestens ein Open-Item') : (setError(null), setStep(5))}
                className="px-4 py-1.5 bg-purple-600 hover:bg-purple-500 text-white rounded text-[11px]">Weiter →</button>
            )}
            {step === 5 && (
              <button onClick={create} disabled={busy === 'create'}
                className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded text-[11px]">
                {busy === 'create' ? '⏳ Erstelle…' : '✓ Projekt erstellen'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
