import 'package:alfred_app/galerie.dart';
import 'package:alfred_app/modell.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'anhang_ansicht_test.dart' show png;

/// 1.5.0 — Übersicht der Anhänge (Punkt 4), Oberflächentest (Punkt 6).
void main() {
  final idBild = 'a' * 32, idPdf = 'b' * 32;
  Map<String, dynamic> antwort() => {'anhaenge': [
    {'id': idBild, 'name': 'foto.png', 'mime': 'image/png', 'groesse': png.length, 'zeit': '2026-10-11T08:00:00.000Z', 'faden': null},
    {'id': idPdf, 'name': 'rechnung.pdf', 'mime': 'application/pdf', 'groesse': 4096, 'zeit': '2026-10-10T08:00:00.000Z', 'faden': 'abc'},
  ]};

  testWidgets('Bilder als Kacheln, Dateien als Zeilen; Inhalt je Kennung nur einmal geladen', (t) async {
    final geladen = <String>[];
    String? gespraech = 'nie';
    await t.pumpWidget(MaterialApp(home: Scaffold(body: Galerie(
      json: (p) async { expect(p, '/api/geraete/anhaenge?limit=200'); return antwort(); },
      lade: (v) async { geladen.add('${v['id']}'); return Anhang(name: '${v['name']}', mime: '${v['mime']}', bytes: v['mime'] == 'image/png' ? png : [1, 2]); },
      aufOeffnen: (_) {}, aufSpeichern: (_) {}, aufGespraech: (f) => gespraech = f,
    ))));
    await t.pumpAndSettle();
    expect(find.byKey(Key('bild-$idBild')), findsOneWidget);
    expect(find.byKey(Key('datei-$idPdf')), findsOneWidget);
    expect(find.text('rechnung.pdf'), findsOneWidget);
    expect(geladen, [idBild]); // Dateien erst beim Öffnen/Speichern
    // Neuzeichnen lädt nicht erneut
    await t.pump(); await t.pump();
    expect(geladen, [idBild]);
    await t.tap(find.byTooltip('Gespräch öffnen'));
    expect(gespraech, 'abc');
  });

  testWidgets('Speichern einer Datei lädt sie und reicht sie weiter', (t) async {
    Anhang? gespeichert;
    await t.pumpWidget(MaterialApp(home: Scaffold(body: Galerie(
      json: (p) async => antwort(),
      lade: (v) async => Anhang(name: '${v['name']}', mime: '${v['mime']}', bytes: v['mime'] == 'image/png' ? png : [1, 2]),
      aufOeffnen: (_) {}, aufSpeichern: (a) => gespeichert = a,
    ))));
    await t.pumpAndSettle();
    await t.tap(find.byTooltip('Speichern'));
    await t.pumpAndSettle();
    expect(gespeichert?.name, 'rechnung.pdf');
  });

  testWidgets('leere Ablage und Fehler werden angezeigt', (t) async {
    await t.pumpWidget(MaterialApp(home: Scaffold(body: Galerie(json: (p) async => {'anhaenge': []}, lade: (_) async => null, aufOeffnen: (_) {}, aufSpeichern: (_) {}))));
    await t.pumpAndSettle();
    expect(find.text('Noch keine Anhänge abgelegt.'), findsOneWidget);
    await t.pumpWidget(MaterialApp(home: Scaffold(body: Galerie(key: const Key('zwei'), json: (p) async => throw Exception('HTTP 403'), lade: (_) async => null, aufOeffnen: (_) {}, aufSpeichern: (_) {}))));
    await t.pumpAndSettle();
    expect(find.textContaining('Anhänge nicht geladen'), findsOneWidget);
  });
}
