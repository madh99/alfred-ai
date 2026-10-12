import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'markdown.dart';
import 'modell.dart';
import 'stopp_knopf.dart'; // 1.14.1

/// 1.7.0 — Schnellfrage (Owner-Freigabe 11.10., Punkt 4): Strg+Alt+A öffnet über allen Programmen ein kleines Fenster mit
/// nur einer Eingabezeile; die Antwort erscheint darunter. Esc schließt es wieder (das große Fenster bleibt, wie es war),
/// „Im Fenster öffnen" wechselt ins normale Fenster. Die Frage läuft im gerade gewählten Gespräch (Verlauf bleibt vollständig).
class Schnellfrage extends StatelessWidget {
  const Schnellfrage({
    super.key,
    required this.eingabe,
    required this.fokus,
    required this.ziel,
    required this.antwortet,
    required this.status,
    required this.antwort,
    required this.aufSenden,
    required this.aufStopp,
    required this.aufSchliessen,
    required this.aufFensterOeffnen,
  });

  final TextEditingController eingabe;
  final FocusNode fokus;
  /// Name des Gesprächs, in das die Frage geht.
  final String ziel;
  final bool antwortet;
  /// Zwischenstand („… denkt", Werkzeug) oder leer.
  final String status;
  /// Antwort auf die Schnellfrage (wächst beim Streamen), null = noch keine.
  final Eintrag? antwort;
  final VoidCallback aufSenden;
  final VoidCallback aufStopp;
  final VoidCallback aufSchliessen;
  final VoidCallback aufFensterOeffnen;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dim = theme.colorScheme.onSurfaceVariant;
    final a = antwort;
    return CallbackShortcuts(
      bindings: {const SingleActivator(LogicalKeyboardKey.escape): aufSchliessen},
      child: Focus(
        autofocus: true,
        child: Padding(padding: const EdgeInsets.fromLTRB(14, 12, 10, 10), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Icon(Icons.bolt, size: 20, color: theme.colorScheme.primary),
            const SizedBox(width: 8),
            Expanded(child: TextField(
              key: const Key('schnellfrage-eingabe'),
              controller: eingabe,
              focusNode: fokus,
              autofocus: true,
              enabled: !antwortet,
              textInputAction: TextInputAction.send,
              onSubmitted: (_) => aufSenden(),
              style: theme.textTheme.titleMedium,
              decoration: InputDecoration.collapsed(hintText: 'Schnellfrage an Alfred … (Enter senden, Esc schließen)', hintStyle: TextStyle(color: dim)),
            )),
            if (antwortet) StoppKnopf(key: const Key('schnellfrage-stopp'), aufStopp: aufStopp, gefuellt: false), // 1.14.1 mit Lauf-Kreis
            IconButton(tooltip: 'Im Fenster öffnen', onPressed: aufFensterOeffnen, icon: const Icon(Icons.open_in_full, size: 18)),
            IconButton(tooltip: 'Schließen (Esc)', onPressed: aufSchliessen, icon: const Icon(Icons.close, size: 18)),
          ]),
          Padding(padding: const EdgeInsets.only(left: 28, top: 2), child: Text(status.isNotEmpty ? status : '→ $ziel', style: theme.textTheme.labelSmall?.copyWith(color: dim), overflow: TextOverflow.ellipsis)),
          if (a != null) ...[
            const Divider(height: 16),
            Expanded(child: SingleChildScrollView(child: AlfredText(a.text))),
          ],
        ])),
      ),
    );
  }
}
