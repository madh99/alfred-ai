'use client';

interface Props {
  onChoice: (choice: 'wizard' | 'manual') => void;
  onClose: () => void;
}

/**
 * v764 — Beim Klick auf "Neues Projekt" öffnet sich erst diese Auswahl.
 * Wizard-Pfad führt durch LLM-gestützte Bootstrap-Schritte, Manuell ist der bestehende Form.
 */
export function NewProjectChoiceModal({ onChoice, onClose }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg border border-blue-500/40 bg-[#0f0f0f] p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-blue-300">Neues Projekt — wie willst du anlegen?</h2>
          <button onClick={onClose} className="px-2 py-1 border border-gray-600 text-gray-300 hover:bg-gray-700/40 rounded text-[11px]">✕</button>
        </div>

        <div className="grid grid-cols-1 gap-3">
          <button
            onClick={() => onChoice('wizard')}
            className="flex items-start gap-3 p-4 border border-purple-500/40 hover:bg-purple-500/10 rounded text-left transition-colors"
          >
            <div className="text-3xl">🪄</div>
            <div className="flex-1">
              <div className="text-sm font-semibold text-purple-300 mb-1">Mit Wizard (empfohlen)</div>
              <div className="text-[11px] text-gray-400">Beschreibe was das Projekt sein soll, Alfred schlägt Tech-Stack + Roadmap vor. Plan wird vom LLM kritisch geprüft bevor du übernimmst.</div>
            </div>
          </button>

          <button
            onClick={() => onChoice('manual')}
            className="flex items-start gap-3 p-4 border border-gray-500/40 hover:bg-gray-500/10 rounded text-left transition-colors"
          >
            <div className="text-3xl">✏️</div>
            <div className="flex-1">
              <div className="text-sm font-semibold text-gray-300 mb-1">Manuell</div>
              <div className="text-[11px] text-gray-400">Klassisches Formular — Name + Slug + Repo-URL. Du befüllst Roadmap später selbst.</div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
