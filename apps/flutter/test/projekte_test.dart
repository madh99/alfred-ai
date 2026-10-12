import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:alfred_app/projekte.dart';

// 1.15.0 — Ansicht „Projekte": Läufe mit Etappen-Zeichen, Liste und Weiterarbeiten gegen eine gefälschte API
void main() {
  test('Etappen-Zeichen: abgenommen, läuft, nicht abgenommen, offen', () {
    final l = Lauf({'id': 'sat-1', 'status': 'laeuft', 'ziel': 'Merkliste', 'plan': ['A', 'B', 'C', 'D'], 'nr': 3, 'kostenUsd': 1.2,
      'erledigt': [{'nr': 1, 'ok': true, 'kostenUsd': 1}, {'nr': 2, 'ok': false, 'kostenUsd': 0.2}]});
    expect([for (var i = 0; i < 4; i++) l.zeichen(i)], ['✅', '❌', '▶', '·']);
    expect(l.ok, 1);
    expect(usd(4.726), '4,73 USD');
    expect(zustandText('wartet'), '⏳ wartet auf dich');
  });

  testWidgets('Liste → Detail → Weiterarbeiten schickt nur den Wunsch', (t) async {
    final aufrufe = <String>[];
    Map<String, dynamic>? gesendet;
    Future<Map<String, dynamic>> json(String pfad, {String methode = 'GET', Map<String, dynamic>? koerper}) async {
      aufrufe.add('$methode $pfad');
      if (pfad == '/api/geraete/projekte') return {'projekte': [{'id': 'p1', 'name': 'Angebots-Radar Österreich', 'geraet': 'Ubuntu-VM', 'pfad': '/home/madh/game', 'zustand': 'ruht', 'laeufe': 3, 'kostenUsd': 7.26}]};
      if (methode == 'POST') { gesendet = koerper; return {'success': true, 'display': 'Projekt geplant (2 Etappen)'}; }
      return {'id': 'p1', 'name': 'Angebots-Radar Österreich', 'geraet': 'Ubuntu-VM', 'pfad': '/home/madh/game', 'pruefBefehle': ['npm test'], 'offenePunkte': [],
        'laeufe': [{'id': 'sat-1', 'status': 'fertig', 'ziel': 'Grundgerüst', 'plan': ['A'], 'erledigt': [{'nr': 1, 'ok': true, 'kostenUsd': 4.73}], 'nr': 1, 'kostenUsd': 4.73, 'start': '2026-10-12T16:42:00Z'}]};
    }
    await t.binding.setSurfaceSize(const Size(1200, 3000));
    await t.pumpWidget(MaterialApp(home: Scaffold(body: Projekte(json: json))));
    await t.pumpAndSettle();
    expect(find.text('Angebots-Radar Österreich'), findsOneWidget);
    await t.tap(find.text('Angebots-Radar Österreich'));
    await t.pumpAndSettle();
    expect(find.textContaining('Abnahme: npm test'), findsOneWidget);
    expect(find.textContaining('✅ A'), findsOneWidget);
    await t.enterText(find.byKey(const Key('wunsch-feld')), 'Merkliste teilen');
    await t.tap(find.text('Planen lassen'));
    await t.pumpAndSettle();
    expect(gesendet, {'aktion': 'weiter', 'text': 'Merkliste teilen'});
    expect(find.textContaining('Die Planfrage kommt zur Bestätigung'), findsOneWidget);
    expect(aufrufe, contains('POST /api/geraete/projekte/p1'));
  });

  testWidgets('1.15.2 Frage zum Projekt schickt die Frage', (t) async {
    Map<String, dynamic>? gesendet;
    Future<Map<String, dynamic>> json(String pfad, {String methode = 'GET', Map<String, dynamic>? koerper}) async {
      if (methode == 'POST') { gesendet = koerper; return {'success': true, 'display': 'Frage gestellt'}; }
      return {'id': 'p1', 'name': 'Angebots-Radar', 'geraet': 'Ubuntu-VM', 'pfad': '/x', 'pruefBefehle': [], 'offenePunkte': [], 'laeufe': []};
    }
    await t.binding.setSurfaceSize(const Size(1200, 3000));
    await t.pumpWidget(MaterialApp(home: Scaffold(body: ProjektDetail(id: 'p1', json: json, zurueck: () {}))));
    await t.pumpAndSettle();
    await t.enterText(find.byKey(const Key('frage-feld')), 'Woher kommen die Hofer-Angebote?');
    await t.tap(find.byKey(const Key('fragen')));
    await t.pumpAndSettle();
    expect(gesendet, {'aktion': 'frage', 'text': 'Woher kommen die Hofer-Angebote?'});
    expect(find.textContaining('Die Antwort kommt als Meldung in den Chat'), findsOneWidget);
  });

  testWidgets('1.15.1 offene Planfrage: Freigeben direkt in der Projektansicht', (t) async {
    Map<String, dynamic>? gesendet;
    Future<Map<String, dynamic>> json(String pfad, {String methode = 'GET', Map<String, dynamic>? koerper}) async {
      if (methode == 'POST') { gesendet = koerper; return {'success': true, 'display': 'Freigegeben — es geht weiter.'}; }
      return {'id': 'p1', 'name': 'Angebots-Radar', 'geraet': 'Ubuntu-VM', 'pfad': '/x', 'pruefBefehle': [], 'offenePunkte': [],
        'laeufe': [{'id': 'sat-9', 'status': 'wartet_owner', 'ziel': 'Merkliste teilen', 'plan': ['A'], 'erledigt': [], 'nr': 0, 'kostenUsd': 0, 'start': '2026-10-12T21:00:00Z', 'frage': '🧭 Projekt auf Ubuntu-VM starten?', 'frageArt': 'plan'}]};
    }
    await t.binding.setSurfaceSize(const Size(1200, 3000));
    await t.pumpWidget(MaterialApp(home: Scaffold(body: ProjektDetail(id: 'p1', json: json, zurueck: () {}))));
    await t.pumpAndSettle();
    expect(find.textContaining('Projekt auf Ubuntu-VM starten?'), findsOneWidget);
    await t.tap(find.byKey(const Key('freigeben-sat-9')));
    await t.pumpAndSettle();
    expect(gesendet, {'aktion': 'freigeben', 'lauf': 'sat-9'});
  });
}
