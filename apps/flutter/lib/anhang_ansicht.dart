import 'package:flutter/material.dart';

import 'modell.dart';

/// 1.0.5 — Anhang in einer Antwort: Bilder als Vorschau (Klick öffnet), Dateien als Zeile mit Öffnen/Speichern.
/// 1.5.0 — als eigenes Widget (testbar, Punkt 6); Sprachnachrichten mit „Abspielen".
/// Flacker-Schutz (1.4.2): `Image.memory` bekommt immer dieselbe `Anhang.daten`-Instanz und `gaplessPlayback`.
class AnhangAnsicht extends StatelessWidget {
  const AnhangAnsicht(this.anhang, {super.key, required this.aufOeffnen, required this.aufSpeichern, this.aufAbspielen});

  final Anhang anhang;
  final void Function(Anhang) aufOeffnen;
  final void Function(Anhang) aufSpeichern;
  final void Function(Anhang)? aufAbspielen;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final a = anhang;
    final kb = (a.bytes.length / 1024).round();
    // 1.5.0 — Wrap statt Row: mit „Abspielen" oder langen Dateinamen lief die Zeile über den Rand (Oberflächentest)
    final knoepfe = Wrap(crossAxisAlignment: WrapCrossAlignment.center, spacing: 4, children: [
      Text('${a.name} · $kb KB', style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
      if (a.istTon && aufAbspielen != null) TextButton.icon(onPressed: () => aufAbspielen!(a), icon: const Icon(Icons.play_arrow, size: 16), label: const Text('Abspielen')),
      TextButton.icon(onPressed: () => aufOeffnen(a), icon: const Icon(Icons.open_in_new, size: 16), label: const Text('Öffnen')),
      TextButton.icon(onPressed: () => aufSpeichern(a), icon: const Icon(Icons.download, size: 16), label: const Text('Speichern')),
    ]);
    if (!a.istBild) {
      return Padding(padding: const EdgeInsets.only(top: 6), child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [Padding(padding: const EdgeInsets.only(top: 8), child: Icon(a.istTon ? Icons.graphic_eq : Icons.attach_file, size: 18)), const SizedBox(width: 4), Expanded(child: knoepfe)]));
    }
    return Padding(padding: const EdgeInsets.only(top: 8), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      InkWell(onTap: () => aufOeffnen(a), child: ClipRRect(borderRadius: BorderRadius.circular(8), child: ConstrainedBox(constraints: const BoxConstraints(maxHeight: 360, maxWidth: 640), child: Image.memory(a.daten, fit: BoxFit.contain, gaplessPlayback: true, errorBuilder: (_, __, ___) => const Text('(Bild nicht darstellbar)'))))),
      knoepfe,
    ]));
  }
}
