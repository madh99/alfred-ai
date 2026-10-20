// 1.70.0 — neue Lage: Logik-Tests immer; Rendern mit echten Daten nur, wenn ALFRED_LAGE_JSON/ALFRED_VORGAENGE_JSON gesetzt sind
// (Dateien vom Server, nicht im Repo). Layout-Fehler (Überlauf) schlagen im Test als Fehler an.
import 'dart:convert';
import 'dart:io';

import 'package:alfred_app/kacheln.dart';
import 'package:alfred_app/modell.dart';
import 'package:alfred_app/server.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class _FalscherServer extends Server {
  _FalscherServer(this.daten) : super(Konfig(server: 'https://x', geraetId: 'g', token: 't', name: 'Test', insecure: true));
  final Map<String, Map<String, dynamic>> daten;
  @override
  Future<Map<String, dynamic>> json(String pfad, {String methode = 'GET', Map<String, dynamic>? koerper}) async {
    for (final e in daten.entries) { if (pfad.startsWith(e.key)) return e.value; }
    throw Exception('HTTP 404');
  }
}

void main() {
  test('Gesamtzustand und Modell-Ampel', () {
    expect(gesamtZustand({}).ampel, Ampel.ok);
    expect(gesamtZustand({'befunde': {'offen': [{}, {}]}}).text, '2 Befunde');
    final z = gesamtZustand({'puls': [{'tier': 'default', 'gestoertSeit': '2026-10-20T10:00:00Z'}], 'offen': [{}]});
    expect(z.ampel, Ampel.bad);
    expect(z.text, '1 Modell gestört · 1 Wächter-Meldung');
    expect(pulsAmpel({'letzterErfolg': '2026-10-20T10:00:00Z'}), Ampel.ok);
    expect(pulsAmpel({'letzterErfolg': '2026-10-20T10:00:00Z', 'letzterFehler': '2026-10-20T11:00:00Z'}), Ampel.bad);
    expect(vorZeit('2026-10-20T10:00:00Z', jetzt: DateTime.parse('2026-10-20T10:30:00Z')), 'vor 30 min');
  });

  testWidgets('Vorgänge fallen aus → Lage bleibt sichtbar', (t) async {
    final s = _FalscherServer({'/api/lebenszeichen': {'lage': {'text': 'Befunde: 2 offen', 'stand': DateTime.now().toIso8601String()}, 'befunde': {'offen': [], 'erledigt24h': []}}});
    await t.pumpWidget(MaterialApp(home: Scaffold(body: Kacheln(server: s))));
    await t.pumpAndSettle();
    expect(find.text('Lage'), findsOneWidget);
    expect(find.textContaining('HTTP 404'), findsOneWidget); // Fehler nur bei den Vorgängen
  });

  final lz = Platform.environment['ALFRED_LAGE_JSON'], vg = Platform.environment['ALFRED_VORGAENGE_JSON'];
  for (final breite in [390.0, 1200.0]) {
    testWidgets('echte Daten rendern ohne Überlauf ($breite px)', (t) async {
      final s = _FalscherServer({
        '/api/lebenszeichen': jsonDecode(File(lz!).readAsStringSync()) as Map<String, dynamic>,
        '/api/vorgaenge': jsonDecode(File(vg!).readAsStringSync()) as Map<String, dynamic>,
      });
      t.view.physicalSize = Size(breite, 2400); t.view.devicePixelRatio = 1;
      addTearDown(t.view.reset);
      await t.pumpWidget(MaterialApp(home: Scaffold(body: Kacheln(server: s, bestaetigungen: 2))));
      await t.pumpAndSettle();
      expect(find.text('Braucht dich'), findsOneWidget);
      // alles aufklappen, was aufklappbar ist
      final n = find.byType(ExpansionTile).evaluate().length;
      for (var i = 0; i < n; i++) {
        final kopf = find.descendant(of: find.byType(ExpansionTile).at(i), matching: find.byType(ListTile)).first;
        await t.ensureVisible(kopf); await t.pumpAndSettle();
        await t.tap(kopf, warnIfMissed: false); await t.pumpAndSettle();
      }
      expect(t.takeException(), isNull);
    }, skip: lz == null || vg == null);
  }
}
