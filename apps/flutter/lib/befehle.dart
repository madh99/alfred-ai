/// 1.10.0 — B1 (Owner-Freigabe 11.10.): Befehlspalette mit Strg+K (macOS ⌘K). Ansichten, Gespräche und Aktionen per
/// Tastatur; mit eingetipptem Text zusätzlich „senden", „im Verlauf suchen", „als Aufgabe anlegen". Pfeiltasten wählen,
/// Enter führt aus, Esc schließt. Die Liste der Befehle baut die Sitzung (sie kennt Zustand und Gespräche).
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

class Befehl {
  const Befehl({required this.titel, required this.aktion, this.icon = Icons.chevron_right, this.untertitel, this.stichworte = '', this.mitText = false});
  final String titel;
  final String? untertitel;
  final IconData icon;
  /// Zusätzliche Suchwörter (Synonyme), werden nicht angezeigt.
  final String stichworte;
  /// Befehl braucht den eingetippten Text (z. B. „Senden: …") — erscheint nur, wenn Text da ist, und passt immer.
  final bool mitText;
  final void Function(String text) aktion;
}

/// Zwei Schreibweisen gelten gleich: „Gedächtnis" = „gedachtnis" = „gedaechtnis" (VM-Befund 1.10.0: ae fand nichts).
String _norm(String s) => s.toLowerCase().replaceAll('ä', 'a').replaceAll('ö', 'o').replaceAll('ü', 'u').replaceAll('ß', 'ss');
String _normE(String s) => s.toLowerCase().replaceAll('ä', 'ae').replaceAll('ö', 'oe').replaceAll('ü', 'ue').replaceAll('ß', 'ss');
bool _enthaelt(String heu, String wort) => _norm(heu).contains(_norm(wort)) || _normE(heu).contains(_normE(wort));

/// Treffer für die Eingabe: jedes Wort muss im Titel oder in den Stichworten vorkommen. Titel, die mit der Eingabe
/// beginnen, zuerst; dann Wortanfänge; sonst Reihenfolge der Liste. Befehle mit Text stehen bei Text immer am Ende —
/// in Listenreihenfolge; die Sitzung stellt „senden" zuletzt, damit Enter ohne Treffer nie etwas an Alfred schickt.
List<Befehl> filtereBefehle(List<Befehl> alle, String eingabe) {
  final roh = eingabe.trim();
  if (roh.isEmpty) return alle.where((b) => !b.mitText).toList();
  final woerter = roh.split(RegExp(r'\s+'));
  bool beginnt(String t, String w) => _norm(t).startsWith(_norm(w)) || _normE(t).startsWith(_normE(w));
  bool wortAnfang(String t, String w) => RegExp('(^|[\\s:„(/-])${RegExp.escape(_norm(w))}').hasMatch(_norm(t)) || RegExp('(^|[\\s:„(/-])${RegExp.escape(_normE(w))}').hasMatch(_normE(t));
  int rang(Befehl b) {
    if (beginnt(b.titel, roh)) return 0;
    if (woerter.every((w) => wortAnfang(b.titel, w))) return 1;
    return 2;
  }
  final treffer = <(int, int, Befehl)>[];
  for (var i = 0; i < alle.length; i++) {
    final b = alle[i];
    if (b.mitText) continue;
    final heu = '${b.titel} ${b.stichworte}';
    if (woerter.every((w) => _enthaelt(heu, w))) treffer.add((rang(b), i, b));
  }
  treffer.sort((a, b) => a.$1 != b.$1 ? a.$1 - b.$1 : a.$2 - b.$2);
  return [...treffer.map((t) => t.$3), ...alle.where((b) => b.mitText)];
}

/// Palette öffnen; führt den gewählten Befehl nach dem Schließen aus.
Future<void> zeigeBefehlspalette(BuildContext context, List<Befehl> befehle) async {
  final r = await showDialog<(Befehl, String)>(context: context, barrierColor: Colors.black26, builder: (_) => _Palette(befehle: befehle));
  if (r != null) r.$1.aktion(r.$2.trim());
}

class _Palette extends StatefulWidget {
  const _Palette({required this.befehle});
  final List<Befehl> befehle;
  @override
  State<_Palette> createState() => _PaletteState();
}

class _PaletteState extends State<_Palette> {
  final eingabe = TextEditingController();
  final liste = ScrollController();
  int wahl = 0;
  late List<Befehl> treffer = filtereBefehle(widget.befehle, '');

  @override
  void dispose() { eingabe.dispose(); liste.dispose(); super.dispose(); }

  void _neu(String q) => setState(() { treffer = filtereBefehle(widget.befehle, q); wahl = 0; });

  void _ausfuehren() { if (treffer.isNotEmpty) Navigator.pop(context, (treffer[wahl], eingabe.text)); }

  KeyEventResult _taste(FocusNode _, KeyEvent e) {
    if (e is! KeyDownEvent && e is! KeyRepeatEvent) return KeyEventResult.ignored;
    if (e.logicalKey == LogicalKeyboardKey.arrowDown || e.logicalKey == LogicalKeyboardKey.arrowUp) {
      if (treffer.isEmpty) return KeyEventResult.handled;
      setState(() => wahl = (wahl + (e.logicalKey == LogicalKeyboardKey.arrowDown ? 1 : -1)) % treffer.length);
      final y = wahl * 52.0;
      if (liste.hasClients && (y < liste.offset || y > liste.offset + 52 * 7)) liste.jumpTo((y - 52 * 3).clamp(0, liste.position.maxScrollExtent));
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final text = eingabe.text.trim();
    return Align(alignment: const Alignment(0, -0.6), child: Material(
      elevation: 12, borderRadius: BorderRadius.circular(12), color: theme.colorScheme.surface,
      child: SizedBox(width: 600, child: Column(mainAxisSize: MainAxisSize.min, children: [
        Focus(onKeyEvent: _taste, child: TextField(
          key: const Key('palette-eingabe'),
          controller: eingabe, autofocus: true, onChanged: _neu, onSubmitted: (_) => _ausfuehren(),
          decoration: const InputDecoration(prefixIcon: Icon(Icons.keyboard_command_key), hintText: 'Befehl, Gespräch oder Text …', border: InputBorder.none, contentPadding: EdgeInsets.all(16)),
        )),
        const Divider(height: 1),
        ConstrainedBox(constraints: const BoxConstraints(maxHeight: 52.0 * 8), child: treffer.isEmpty
            ? Padding(padding: const EdgeInsets.all(16), child: Text('Kein Befehl passt.', style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.onSurfaceVariant)))
            : ListView.builder(controller: liste, shrinkWrap: true, itemCount: treffer.length, itemExtent: 52, itemBuilder: (_, i) {
                final b = treffer[i];
                final titel = b.mitText ? '${b.titel} „${text.length > 50 ? '${text.substring(0, 50)}…' : text}“' : b.titel;
                return ListTile(
                  key: Key('befehl-$i'),
                  dense: true, selected: i == wahl, selectedTileColor: theme.colorScheme.secondaryContainer,
                  leading: Icon(b.icon, size: 20), title: Text(titel, maxLines: 1, overflow: TextOverflow.ellipsis),
                  subtitle: b.untertitel == null ? null : Text(b.untertitel!, maxLines: 1, overflow: TextOverflow.ellipsis),
                  onTap: () { wahl = i; _ausfuehren(); },
                );
              })),
        Padding(padding: const EdgeInsets.fromLTRB(16, 6, 16, 8), child: Text('↑↓ wählen · Enter ausführen · Esc schließen', style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.onSurfaceVariant))),
      ])),
    ));
  }
}
