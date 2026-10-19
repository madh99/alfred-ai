/// 1.45.0 (v1504, D4) — Verlaufsleiste am linken Rand des Chats (Owner 19.10., App-Spec §11): ein Strich je eigener Frage,
/// Darüberfahren zeigt Frage und Antwortanfang, Klick springt hin; Fragen mit Lesezeichen sind hervorgehoben.
library;

import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';

import 'modell.dart';

class LeistenEintrag {
  const LeistenEintrag({required this.index, required this.frage, required this.antwort, required this.schluessel});
  /// Index im Verlauf (ältester = 0)
  final int index;
  final String frage;
  /// Anfang der folgenden Antwort von Alfred (leer, wenn keine kam)
  final String antwort;
  final String schluessel;
}

/// Lesezeichen-Schlüssel einer Nachricht: Prüfsumme des Texts (gleich auf allen Geräten und nach einem Neustart).
String lesezeichenSchluessel(String text) => sha1.convert(utf8.encode(text.trim())).toString().substring(0, 16);

String _kurz(String t, int n) { final s = t.replaceAll(RegExp(r'\s+'), ' ').trim(); return s.length > n ? '${s.substring(0, n - 1)}…' : s; }

/// Eigene Fragen des Verlaufs mit dem Anfang der jeweils folgenden Antwort.
List<LeistenEintrag> leistenEintraege(List<Eintrag> verlauf) {
  final aus = <LeistenEintrag>[];
  for (var i = 0; i < verlauf.length; i++) {
    final e = verlauf[i];
    if (e.art != Art.du || e.text.trim().isEmpty) continue;
    var antwort = '';
    for (var j = i + 1; j < verlauf.length && verlauf[j].art != Art.du; j++) {
      if (verlauf[j].art == Art.alfred && verlauf[j].text.trim().isNotEmpty) { antwort = _kurz(verlauf[j].text, 160); break; }
    }
    aus.add(LeistenEintrag(index: i, frage: _kurz(e.text, 120), antwort: antwort, schluessel: lesezeichenSchluessel(e.text)));
  }
  return aus;
}

/// Lage eines Strichs (0 = oben, 1 = unten) bei [n] Strichen.
double strichLage(int k, int n) => n <= 1 ? 0.5 : k / (n - 1);

class Verlaufsleiste extends StatelessWidget {
  const Verlaufsleiste({super.key, required this.eintraege, required this.markiert, required this.aufSprung});
  final List<LeistenEintrag> eintraege;
  final Set<String> markiert;
  final void Function(int index) aufSprung;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dim = theme.colorScheme.onSurfaceVariant.withValues(alpha: 0.55);
    return LayoutBuilder(builder: (context, c) {
      final h = c.maxHeight - 16;
      return Stack(clipBehavior: Clip.none, children: [
        for (var k = 0; k < eintraege.length; k++)
          Positioned(top: 8 + strichLage(k, eintraege.length) * h - 4, left: 0, child: Tooltip(
            key: Key('leiste-${eintraege[k].index}'),
            waitDuration: const Duration(milliseconds: 150),
            constraints: const BoxConstraints(maxWidth: 340),
            richMessage: TextSpan(children: [
              TextSpan(text: '${markiert.contains(eintraege[k].schluessel) ? '🔖 ' : ''}${eintraege[k].frage}', style: const TextStyle(fontWeight: FontWeight.w600)),
              if (eintraege[k].antwort.isNotEmpty) TextSpan(text: '\n${eintraege[k].antwort}'),
            ]),
            child: InkWell(onTap: () => aufSprung(eintraege[k].index), child: SizedBox(width: 26, height: 9, child: Center(child: Container(
              width: markiert.contains(eintraege[k].schluessel) ? 18 : 11, height: markiert.contains(eintraege[k].schluessel) ? 4 : 2,
              decoration: BoxDecoration(color: markiert.contains(eintraege[k].schluessel) ? theme.colorScheme.primary : dim, borderRadius: BorderRadius.circular(2)),
            )))),
          )),
      ]);
    });
  }
}
