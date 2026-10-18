import 'package:flutter/material.dart';

/// 1.40.0 — Listen-Abgleich (Owner 18.10.: „Vorgang proxmox test-ubuntu war noch offen, nach meinem Klick nicht mehr“).
/// Die Ansichten luden nur beim Öffnen und nach eigenen Aktionen; was der Server inzwischen selbst erledigt hatte (Befund weg,
/// anderswo bestätigt), verschwand erst beim nächsten Klick — wie „alles mit geschlossen“. Jetzt fragen offene Ansichten
/// regelmäßig nach, und was zwischendurch verschwunden ist, wird genannt.
const abgleichTakt = Duration(seconds: 45);

/// Einträge (Kennung → Anzeigetext), die im neuen Stand fehlen.
List<String> verschwunden(Map<String, String> vorher, Iterable<String> jetztIds) {
  final jetzt = jetztIds.toSet();
  return [for (final e in vorher.entries) if (!jetzt.contains(e.key)) e.value];
}

/// Bisherige Meldungen plus neue, höchstens die letzten [max].
List<String> mitNeuen(List<String> bisher, List<String> neu, {int max = 6}) {
  final alle = [...bisher, ...neu];
  return alle.length > max ? alle.sublist(alle.length - max) : alle;
}

/// Kleine Zeile oben in der Ansicht: was inzwischen anderswo erledigt wurde.
class AbgleichHinweis extends StatelessWidget {
  const AbgleichHinweis({super.key, required this.texte, required this.schliessen});
  final List<String> texte;
  final VoidCallback schliessen;
  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Padding(padding: const EdgeInsets.fromLTRB(20, 12, 20, 0), child: Container(
      key: const Key('abgleich-hinweis'),
      padding: const EdgeInsets.fromLTRB(12, 8, 4, 8),
      decoration: BoxDecoration(color: t.colorScheme.secondaryContainer.withValues(alpha: 0.5), borderRadius: BorderRadius.circular(10)),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Padding(padding: const EdgeInsets.only(top: 2), child: Icon(Icons.sync, size: 18, color: t.colorScheme.secondary)),
        const SizedBox(width: 8),
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Inzwischen erledigt', style: t.textTheme.labelLarge),
          for (final x in texte) Text('· $x', style: t.textTheme.bodySmall),
        ])),
        IconButton(key: const Key('abgleich-schliessen'), tooltip: 'Ausblenden', visualDensity: VisualDensity.compact, onPressed: schliessen, icon: const Icon(Icons.close, size: 18)),
      ]),
    ));
  }
}
