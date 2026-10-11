import 'package:alfred_app/suche.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// 1.5.0 — Suche im Verlauf (Punkt 4) und Oberflächentest (Punkt 6).
void main() {
  group('Hilfsfunktionen', () {
    test('suchWoerter: Leerraum trennt, ein Zeichen zählt nicht', () {
      expect(suchWoerter('  Rechnung  a aWATTar '), ['Rechnung', 'aWATTar']);
      expect(suchWoerter('x'), isEmpty);
    });

    test('ausschnitt: um den ersten Treffer, mit Auslassungszeichen', () {
      final t = '${'vorne ' * 30}die Rechnung von aWATTar ist da${' hinten' * 60}';
      final a = ausschnitt(t, ['rechnung']);
      expect(a.startsWith('…'), isTrue);
      expect(a.endsWith('…'), isTrue);
      expect(a.contains('Rechnung von aWATTar'), isTrue);
      expect(ausschnitt('kurz\nund\nknapp', ['knapp']), 'kurz und knapp');
    });

    test('markiert: Treffer ohne Rücksicht auf Groß/Klein hervorgehoben', () {
      final s = markiert('Die Rechnung und die RECHNUNG', ['rechnung'], null, const TextStyle(fontWeight: FontWeight.bold));
      final fett = s.children!.whereType<TextSpan>().where((x) => x.style?.fontWeight == FontWeight.bold).map((x) => x.text).toList();
      expect(fett, ['Rechnung', 'RECHNUNG']);
      expect(s.toPlainText(), 'Die Rechnung und die RECHNUNG');
    });
  });

  testWidgets('sucht mit kodierter Anfrage, zeigt Treffer, Antippen öffnet die Fundstelle', (t) async {
    final pfade = <String>[];
    Map<String, dynamic>? geoeffnet;
    String? gemerkt;
    await t.pumpWidget(MaterialApp(home: Scaffold(body: Suche(
      json: (p) async {
        pfade.add(p);
        return {'treffer': [
          {'rolle': 'assistant', 'text': 'Die Rechnung von aWATTar ist geprüft.', 'zeit': '2026-10-10T18:00:00.000Z', 'faden': null, 'gespraech': 'Hauptgespräch'},
          {'rolle': 'user', 'text': 'Wo ist die Rechnung?', 'zeit': '2026-10-09T08:30:00.000Z', 'faden': 'abc', 'gespraech': 'Strom'},
        ]};
      },
      aufOeffnen: (x) => geoeffnet = x,
      aufAnfrage: (q) => gemerkt = q,
    ))));
    await t.enterText(find.byKey(const Key('suche-eingabe')), 'Rechnung aWATTar');
    await t.testTextInput.receiveAction(TextInputAction.search);
    await t.pumpAndSettle();
    expect(pfade.single, '/api/geraete/suche?q=Rechnung+aWATTar&limit=60');
    expect(gemerkt, 'Rechnung aWATTar');
    expect(find.text('2 Treffer'), findsOneWidget);
    expect(find.textContaining('Strom'), findsOneWidget);
    await t.tap(find.byKey(const Key('treffer-1')));
    expect(geoeffnet?['faden'], 'abc');
  });

  testWidgets('zu kurze Anfrage fragt nicht beim Server', (t) async {
    var aufrufe = 0;
    await t.pumpWidget(MaterialApp(home: Scaffold(body: Suche(json: (p) async { aufrufe++; return {}; }, aufOeffnen: (_) {}))));
    await t.enterText(find.byKey(const Key('suche-eingabe')), 'a');
    await t.testTextInput.receiveAction(TextInputAction.search);
    await t.pump();
    expect(aufrufe, 0);
    expect(find.text('Mindestens 2 Zeichen eingeben.'), findsOneWidget);
  });

  testWidgets('Serverfehler wird angezeigt; letzte Anfrage wird beim Zurückkehren wiederholt', (t) async {
    var aufrufe = 0;
    await t.pumpWidget(MaterialApp(home: Scaffold(body: Suche(json: (p) async { aufrufe++; throw Exception('HTTP 500'); }, aufOeffnen: (_) {}, anfang: 'Rechnung'))));
    await t.pumpAndSettle();
    expect(aufrufe, 1);
    expect(find.textContaining('Suche fehlgeschlagen'), findsOneWidget);
  });
}
