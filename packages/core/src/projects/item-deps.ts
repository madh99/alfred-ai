/**
 * v875 — Item-Abhängigkeiten: Zyklen-Prüfung + Blockiert-Logik.
 *
 * dependsOn ist ein flaches JSON-Array von Item-IDs desselben Projekts.
 * Beim Setzen wird ein Zyklus (A→B→A, auch transitiv) verhindert; beim
 * Abarbeiten werden blockierte Items übersprungen.
 */
export interface DepItem {
  id: string;
  status?: string;
  dependsOn?: string[];
}

/**
 * Würde das Setzen von `newDeps` auf `itemId` einen Zyklus erzeugen?
 * Folgt dependsOn-Kanten ab den neuen Abhängigkeiten — wird `itemId`
 * erreicht, ist es ein Zyklus. Selbst-Referenz zählt ebenfalls.
 */
export function wouldCreateDependencyCycle(items: DepItem[], itemId: string, newDeps: string[]): boolean {
  if (newDeps.includes(itemId)) return true;
  const byId = new Map(items.map(i => [i.id, i]));
  const visited = new Set<string>();
  const stack = [...newDeps];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === itemId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const deps = byId.get(current)?.dependsOn ?? [];
    for (const d of deps) stack.push(d);
  }
  return false;
}

/**
 * Ist das Item durch unerledigte Abhängigkeiten blockiert?
 * Eine Abhängigkeit blockiert, solange sie nicht done/cancelled ist.
 * Unbekannte IDs (gelöschte Items) blockieren NICHT — sonst wäre ein
 * Item nach dem Löschen seiner Abhängigkeit für immer gesperrt.
 */
export function isItemBlocked(item: DepItem, allItems: DepItem[]): boolean {
  const deps = item.dependsOn ?? [];
  if (deps.length === 0) return false;
  const byId = new Map(allItems.map(i => [i.id, i]));
  return deps.some(depId => {
    const dep = byId.get(depId);
    if (!dep) return false; // gelöscht/unbekannt → blockiert nicht
    return dep.status !== 'done' && dep.status !== 'cancelled';
  });
}

/** IDs der Items, die `item` aktuell blockieren (für UI-Badge/Hinweise). */
export function blockingItemIds(item: DepItem, allItems: DepItem[]): string[] {
  const deps = item.dependsOn ?? [];
  if (deps.length === 0) return [];
  const byId = new Map(allItems.map(i => [i.id, i]));
  return deps.filter(depId => {
    const dep = byId.get(depId);
    if (!dep) return false;
    return dep.status !== 'done' && dep.status !== 'cancelled';
  });
}
