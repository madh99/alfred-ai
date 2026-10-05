/**
 * v1200 — Rücknahme-Hinweis für automatisch ausgeführte Aktionen (Jarvis Schicht 3).
 *
 * Spezifikation, Abschnitt Risiken: „Autonomie ohne Rückweg: `auto` nur für Aktionen
 * mit dokumentiertem Undo; jede Auto-Aktion im Ausführungsgedächtnis mit Rücknahme-
 * Hinweis." Deterministisch je Skill und Aktion, mit der Kennung aus dem Skill-
 * Ergebnis, damit der Owner (oder Alfred auf Zuruf) die Aktion gezielt zurücknimmt.
 */
export function ruecknahmeHinweis(skill: string, aktion: string | undefined, params: Record<string, unknown> | undefined, data: unknown): string | undefined {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const id = (k: string) => (typeof d[k] === 'string' && d[k] ? ` ${k}=${String(d[k])}` : '');
  const a = (aktion ?? '').toLowerCase();
  switch (skill) {
    case 'reminder':
      if (/^(set|create|add)$/.test(a)) return `Erinnerung löschen: reminder/cancel${id('reminderId')}`;
      if (a === 'snooze') return `Snooze aufheben: reminder/update${id('reminderId')}`;
      if (a === 'update') return `Erinnerung erneut anpassen: reminder/update${id('reminderId')}`;
      break;
    case 'todo':
      if (/^(create|add)$/.test(a)) return `Todo löschen: todo/delete${id('todoId')}`;
      if (a === 'complete') return `Todo wieder öffnen: todo/reopen${id('todoId')}`;
      if (/^(note|add_note|update)$/.test(a)) return `Todo bearbeiten: todo/update${id('todoId')}`;
      break;
    case 'note':
      return `Notiz löschen: note/delete${id('noteId')}`;
    case 'memory': {
      const key = typeof params?.key === 'string' ? ` key=${params.key}` : '';
      return `Memory löschen: memory/delete${key}`;
    }
    case 'watch':
      if (/^(create|add)$/.test(a)) return `Watch löschen: watch/delete${id('watchId')}`;
      if (/^(enable|resume)$/.test(a)) return `Watch pausieren: watch/pause${id('watchId')}`;
      if (a === 'pause') return `Watch fortsetzen: watch/resume${id('watchId')}`;
      if (a === 'update') return `Watch erneut anpassen: watch/update${id('watchId')}`;
      break;
    case 'document':
      if (/^(store|save|upload|add)$/.test(a)) return `Dokument löschen: document/delete${id('documentId')}`;
      if (a === 'tag') return `Tag entfernen: document/untag${id('documentId')}`;
      break;
    case 'insights':
      if (a === 'dismiss') return 'Insight wieder öffnen: insights/reopen';
      if (a === 'snooze') return 'Snooze aufheben: insights/reopen';
      break;
    case 'goals':
      return `Ziel anpassen: goals/update${id('goalId')}`;
  }
  return undefined;
}
