'use client';

import { useState } from 'react';
import { useConfig } from '@/context/ConfigContext';
import type { Project, ProjectConventions } from '@/lib/alfred-client';

interface Props {
  project: Project;
  onSaved?: (p: Project) => void;
}

/**
 * v663a — Project Conventions: opt-in Rules für README/CHANGELOG/Versioning/
 * Commits/Branching. Project-Agent respektiert diese bei Phase-Commits.
 */
export function ProjectConventionsView({ project, onSaved }: Props) {
  const { client } = useConfig();
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const conv: ProjectConventions = project.conventions ?? {};

  // Form-State
  const [readmeAuto, setReadmeAuto] = useState(conv.readme?.autoUpdate ?? false);
  const [readmeTemplate, setReadmeTemplate] = useState(conv.readme?.template ?? 'default');
  const [changelogAuto, setChangelogAuto] = useState(conv.changelog?.autoUpdate ?? false);
  const [changelogFormat, setChangelogFormat] = useState(conv.changelog?.format ?? 'keepachangelog');
  const [commitsConv, setCommitsConv] = useState(conv.commits?.convention ?? 'free');
  const [scopePolicy, setScopePolicy] = useState(conv.commits?.scopePolicy ?? 'optional');
  const [branching, setBranching] = useState(conv.branching?.strategy ?? 'main-only');
  const [prTarget, setPrTarget] = useState(conv.branching?.prTarget ?? 'main');
  const [versioning, setVersioning] = useState(conv.versioning?.scheme ?? 'semver');
  const [autoTag, setAutoTag] = useState(conv.versioning?.autoTag ?? false);

  async function save() {
    if (!client) return;
    setSaving(true);
    try {
      const newConv: ProjectConventions = {
        readme: { autoUpdate: readmeAuto, template: readmeTemplate as 'default' | 'minimal' | 'custom' },
        changelog: { autoUpdate: changelogAuto, format: changelogFormat as 'keepachangelog' | 'free' },
        commits: { convention: commitsConv as 'free' | 'conventional', scopePolicy: scopePolicy as 'required' | 'optional' | 'forbidden' },
        branching: { strategy: branching as 'main-only' | 'feature-branches' | 'gitflow', prTarget: prTarget || undefined },
        versioning: { scheme: versioning as 'semver' | 'date' | 'custom', autoTag },
      };
      const updated = await client.updateProject(project.id, { conventions: newConv });
      if (updated) {
        onSaved?.(updated);
      }
    } finally {
      setSaving(false);
    }
  }

  // Welche Features sind aktiviert (für die Badge-Zeile)
  const activeBadges: string[] = [];
  if (readmeAuto) activeBadges.push('README-Auto');
  if (changelogAuto) activeBadges.push('CHANGELOG-Auto');
  if (commitsConv === 'conventional') activeBadges.push('Conventional Commits');
  if (branching !== 'main-only') activeBadges.push(`Branch: ${branching}`);
  if (autoTag) activeBadges.push('Auto-Tag');

  if (!expanded) {
    return (
      <div className="pt-2 border-t border-[#222]">
        <button
          onClick={() => setExpanded(true)}
          className="w-full text-left flex items-center gap-2 text-sm font-semibold text-gray-400 hover:text-gray-200"
        >
          <span>▸</span>
          <span>⚙️ Conventions</span>
          {activeBadges.length > 0 ? (
            <span className="text-[10px] text-emerald-400 font-normal">{activeBadges.length} aktiv</span>
          ) : (
            <span className="text-[10px] text-gray-600 font-normal">— alle deaktiviert</span>
          )}
        </button>
      </div>
    );
  }

  return (
    <div className="pt-2 border-t border-[#222]">
      <button
        onClick={() => setExpanded(false)}
        className="w-full text-left flex items-center gap-2 text-sm font-semibold text-gray-400 hover:text-gray-200 mb-3"
      >
        <span>▾</span>
        <span>⚙️ Conventions</span>
      </button>

      <div className="space-y-3 bg-[#0f0f0f] border border-[#222] rounded p-3 text-xs">
        {/* README */}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">README</div>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-1.5 text-gray-300">
              <input type="checkbox" checked={readmeAuto} onChange={(e) => setReadmeAuto(e.target.checked)} />
              Auto-Update bei Project-Agent-Commits
            </label>
            <select
              value={readmeTemplate}
              onChange={(e) => setReadmeTemplate(e.target.value as 'default' | 'minimal' | 'custom')}
              disabled={!readmeAuto}
              className="bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-0.5 text-gray-200 disabled:opacity-40"
            >
              <option value="default">default (Features/Setup/Usage)</option>
              <option value="minimal">minimal (Titel + Beschreibung)</option>
              <option value="custom">custom (Alfred greift nicht ein)</option>
            </select>
          </div>
        </div>

        {/* CHANGELOG */}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">CHANGELOG</div>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-1.5 text-gray-300">
              <input type="checkbox" checked={changelogAuto} onChange={(e) => setChangelogAuto(e.target.checked)} />
              Auto-Update bei Phase-Commits
            </label>
            <select
              value={changelogFormat}
              onChange={(e) => setChangelogFormat(e.target.value as 'keepachangelog' | 'free')}
              disabled={!changelogAuto}
              className="bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-0.5 text-gray-200 disabled:opacity-40"
            >
              <option value="keepachangelog">Keep a Changelog 1.1.0</option>
              <option value="free">Freies Format</option>
            </select>
          </div>
        </div>

        {/* Commits */}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Commits</div>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-1.5 text-gray-300">
              Style:
              <select
                value={commitsConv}
                onChange={(e) => setCommitsConv(e.target.value as 'free' | 'conventional')}
                className="bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-0.5 text-gray-200"
              >
                <option value="free">Free</option>
                <option value="conventional">Conventional (feat:/fix:/...)</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-gray-300">
              Scope:
              <select
                value={scopePolicy}
                onChange={(e) => setScopePolicy(e.target.value as 'required' | 'optional' | 'forbidden')}
                disabled={commitsConv !== 'conventional'}
                className="bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-0.5 text-gray-200 disabled:opacity-40"
              >
                <option value="required">required</option>
                <option value="optional">optional</option>
                <option value="forbidden">forbidden</option>
              </select>
            </label>
          </div>
        </div>

        {/* Branching */}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Branching</div>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-1.5 text-gray-300">
              Strategy:
              <select
                value={branching}
                onChange={(e) => setBranching(e.target.value as 'main-only' | 'feature-branches' | 'gitflow')}
                className="bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-0.5 text-gray-200"
              >
                <option value="main-only">main-only (direkt commits)</option>
                <option value="feature-branches">feature-branches (pro Session)</option>
                <option value="gitflow">gitflow (main/develop/feature)</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-gray-300">
              PR-Target:
              <input
                value={prTarget}
                onChange={(e) => setPrTarget(e.target.value)}
                placeholder="main"
                className="bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-0.5 text-gray-200 font-mono w-24"
              />
            </label>
          </div>
          {/* v867 — vorher war prTarget ein toter Schalter (von keinem Code konsumiert) */}
          <div className="mt-1 text-[10px] text-gray-600">
            PR-Target dient als Fallback für den Deploy-Branch (wenn default_branch des Projekts leer ist):
            Project-Agent warnt beim Start und verweigert Hauptbranch-Pushes auf den falschen Branch.
          </div>
        </div>

        {/* Versioning */}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Versioning</div>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-1.5 text-gray-300">
              Scheme:
              <select
                value={versioning}
                onChange={(e) => setVersioning(e.target.value as 'semver' | 'date' | 'custom')}
                className="bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-0.5 text-gray-200"
              >
                <option value="semver">SemVer (X.Y.Z)</option>
                <option value="date">Date (YYYY.MM.DD)</option>
                <option value="custom">Custom (kein Auto)</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-gray-300">
              <input type="checkbox" checked={autoTag} onChange={(e) => setAutoTag(e.target.checked)} disabled={versioning === 'custom'} />
              Auto-Tag bei erfolgreichem Build
            </label>
          </div>
        </div>

        <div className="flex justify-end pt-2 border-t border-[#222]">
          <button
            onClick={save}
            disabled={saving}
            className="px-3 py-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded text-xs"
          >{saving ? '…' : 'Speichern'}</button>
        </div>
      </div>
    </div>
  );
}
