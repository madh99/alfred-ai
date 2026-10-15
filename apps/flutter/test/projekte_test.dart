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
    expect(find.textContaining('Die Antwort kommt ins Gespräch zum Projekt'), findsOneWidget);
  });

  testWidgets('1.15.3 angehaltener Lauf: Fortsetzen; wartender Lauf zeigt „wartet auf Gerät"', (t) async {
    Map<String, dynamic>? gesendet;
    Future<Map<String, dynamic>> json(String pfad, {String methode = 'GET', Map<String, dynamic>? koerper}) async {
      if (methode == 'POST') { gesendet = koerper; return {'success': true, 'display': 'Etappe 2 startet neu'}; }
      return {'id': 'p1', 'name': 'Angebots-Radar', 'geraet': 'Ubuntu-VM', 'pfad': '/x', 'pruefBefehle': [], 'offenePunkte': [], 'laeufe': [
        {'id': 'sat-1', 'status': 'angehalten', 'grund': 'Auftrag nicht gestartet: Gerät nicht verbunden', 'ziel': 'SPAR', 'plan': ['A', 'B'], 'erledigt': [], 'nr': 2, 'kostenUsd': 0.61, 'start': '2026-10-12T23:09:00Z'},
        {'id': 'sat-2', 'status': 'laeuft', 'ziel': 'X', 'plan': ['A'], 'erledigt': [], 'nr': 1, 'kostenUsd': 0, 'start': '2026-10-12T22:00:00Z', 'wartetAufGeraet': '2026-10-12T23:00:00Z'}]};
    }
    await t.binding.setSurfaceSize(const Size(1200, 3000));
    await t.pumpWidget(MaterialApp(home: Scaffold(body: ProjektDetail(id: 'p1', json: json, zurueck: () {}))));
    await t.pumpAndSettle();
    expect(find.text('⏳ wartet auf Gerät'), findsOneWidget);
    await t.tap(find.byKey(const Key('fortsetzen-sat-1')));
    await t.pumpAndSettle();
    expect(gesendet, {'aktion': 'fortsetzen', 'lauf': 'sat-1'});
  });

  testWidgets('1.16.0 G1 Etappenbericht aufklappen, Änderungen ansehen', (t) async {
    final gesendet = <Map<String, dynamic>>[];
    Future<Map<String, dynamic>> json(String pfad, {String methode = 'GET', Map<String, dynamic>? koerper}) async {
      if (methode == 'POST') { gesendet.add(koerper!); return {'success': true, 'display': 'abc1234 Etappe 1: Merkliste\n src/merkliste.js | 40 +++'}; }
      return {'id': 'p1', 'name': 'Angebots-Radar', 'geraet': 'Ubuntu-VM', 'pfad': '/x', 'pruefBefehle': ['npm test'], 'offenePunkte': [], 'laeufe': [
        {'id': 'sat-1', 'status': 'fertig', 'ziel': 'Merkliste', 'plan': ['Merkliste speichern'], 'nr': 1, 'kostenUsd': 1.2, 'start': '2026-10-12T20:00:00Z', 'erledigt': [
          {'nr': 1, 'ok': true, 'kostenUsd': 1.2, 'bericht': {'geprueft': true, 'fixVersuche': 0, 'zusammenfassung': 'Merkliste mit Datei-Speicher gebaut, 12 Tests ergänzt.', 'dateien': ['src/merkliste.js', 'tests/merkliste.test.js'], 'dateienAnzahl': 2, 'commit': {'sha': 'abc1234def', 'titel': 'Etappe 1: Merkliste'}, 'abnahme': {'ok': true, 'protokoll': 'ok'}, 'dauerS': 240}}]}]};
    }
    await t.binding.setSurfaceSize(const Size(1200, 3000));
    await t.pumpWidget(MaterialApp(home: Scaffold(body: ProjektDetail(id: 'p1', json: json, zurueck: () {}))));
    await t.pumpAndSettle();
    await t.tap(find.byKey(const Key('etappe-sat-1:0')));
    await t.pumpAndSettle();
    expect(find.textContaining('Merkliste mit Datei-Speicher gebaut'), findsOneWidget);
    expect(find.textContaining('Geänderte Dateien (2): src/merkliste.js, tests/merkliste.test.js'), findsOneWidget);
    expect(find.textContaining('Commit abc1234 · Etappe 1: Merkliste'), findsOneWidget);
    expect(find.textContaining('Abnahme ✅'), findsOneWidget);
    await t.tap(find.byKey(const Key('diff-sat-1:0')));
    await t.pumpAndSettle();
    expect(gesendet.first, {'aktion': 'diff', 'lauf': 'abc1234def'});
    expect(find.textContaining('src/merkliste.js | 40'), findsOneWidget);
  });

  testWidgets('1.16.1 G2 laufende Etappe zeigt die letzten Schritte', (t) async {
    Future<Map<String, dynamic>> json(String pfad, {String methode = 'GET', Map<String, dynamic>? koerper}) async =>
      {'id': 'p1', 'name': 'Angebots-Radar', 'geraet': 'Ubuntu-VM', 'pfad': '/x', 'pruefBefehle': [], 'offenePunkte': [], 'laeufe': [
        {'id': 'sat-1', 'status': 'laeuft', 'ziel': 'SPAR', 'plan': ['A', 'B'], 'erledigt': [], 'nr': 2, 'kostenUsd': 0.6, 'start': '2026-10-12T23:09:00Z', 'live': {'zeit': 'x', 'werkzeuge': 14, 'schritte': ['📖 liest src/quellen/spar.js', '✏️ ändert src/quellen/spar.js', '▶ npm test']}}]};
    await t.binding.setSurfaceSize(const Size(1200, 3000));
    await t.pumpWidget(MaterialApp(home: Scaffold(body: ProjektDetail(id: 'p1', json: json, zurueck: () {}))));
    await t.pump(); await t.pump();
    expect(find.byKey(const Key('live-sat-1')), findsOneWidget);
    expect(find.text('🔨 Claude Code arbeitet · 14 Schritte'), findsOneWidget);
    expect(find.text('✏️ ändert src/quellen/spar.js'), findsOneWidget);
    await t.pumpWidget(const SizedBox()); // Takt beenden
  });

  test('1.17.3 Fortschritt: laufende Etappe statt Zahl der abgenommenen', () {
    final laeuft = Lauf({'id': 'a', 'status': 'laeuft', 'plan': ['x', 'y', 'z'], 'nr': 2, 'erledigt': [{'nr': 1, 'ok': true}]});
    expect(laufFortschritt(laeuft), 'Etappe 2/3 · 1 abgenommen');
    final fertig = Lauf({'id': 'b', 'status': 'fertig', 'plan': ['x', 'y', 'z'], 'nr': 3, 'erledigt': [{'nr': 1, 'ok': true}, {'nr': 2, 'ok': true}, {'nr': 3, 'ok': true}]});
    expect(laufFortschritt(fertig), '3/3 abgenommen');
  });

  testWidgets('1.19.0 Projektregeln: Schalter, Option, eigene Regel', (t) async {
    final gesendet = <Map<String, dynamic>>[];
    var konv = <String, dynamic>{};
    Future<Map<String, dynamic>> json(String pfad, {String methode = 'GET', Map<String, dynamic>? koerper}) async {
      if (methode == 'POST') {
        final a = koerper!['konventionen'] as Map<String, dynamic>; gesendet.add(a);
        if (a['changelog'] == true) konv = {...konv, 'changelog': {'autoUpdate': true, 'format': 'keepachangelog'}};
        if (a['regel'] != null) konv = {...konv, 'regeln': [...((konv['regeln'] as List?) ?? []), a['regel']]};
        return {'success': true};
      }
      return {'id': 'p1', 'name': 'X', 'geraet': 'VM', 'pfad': '/x', 'pruefBefehle': [], 'offenePunkte': [], 'laeufe': [], 'konventionen': konv};
    }
    await t.binding.setSurfaceSize(const Size(1200, 3000));
    await t.pumpWidget(MaterialApp(home: Scaffold(body: ProjektDetail(id: 'p1', json: json, zurueck: () {}))));
    await t.pumpAndSettle();
    await t.tap(find.byKey(const Key('projekt-regeln')));
    await t.pumpAndSettle();
    await t.tap(find.byKey(const Key('regel-changelog')));
    await t.pumpAndSettle();
    expect(gesendet.last, {'changelog': true});
    expect(find.byKey(const Key('regel-changelog-format')), findsOneWidget);
    await t.enterText(find.byKey(const Key('regel-neu')), 'Commits auf Deutsch');
    await t.tap(find.byKey(const Key('regel-dazu')));
    await t.pumpAndSettle();
    expect(gesendet.last, {'regel': 'Commits auf Deutsch'});
    expect(find.textContaining('1. Commits auf Deutsch'), findsOneWidget);
    await t.tap(find.byKey(const Key('regel-weg-0')));
    await t.pumpAndSettle();
    expect(gesendet.last, {'regelEntfernen': '1'});
  });

  testWidgets('1.18.0 Schalter Protokoll im Projekt sendet an/aus', (t) async {
    final gesendet = <Map<String, dynamic>>[];
    var an = true;
    Future<Map<String, dynamic>> json(String pfad, {String methode = 'GET', Map<String, dynamic>? koerper}) async {
      if (methode == 'POST') { gesendet.add(koerper!); an = koerper['text'] == 'an'; return {'success': true, 'display': 'ok'}; }
      return {'id': 'b77431a2-e388', 'name': 'Angebots-Radar', 'geraet': 'Ubuntu-VM', 'pfad': '/x', 'pruefBefehle': [], 'offenePunkte': [], 'laeufe': [], 'protokoll': an};
    }
    await t.binding.setSurfaceSize(const Size(1200, 3000));
    await t.pumpWidget(MaterialApp(home: Scaffold(body: ProjektDetail(id: 'b77431a2-e388', json: json, zurueck: () {}))));
    await t.pumpAndSettle();
    expect(t.widget<SwitchListTile>(find.byKey(const Key('projekt-protokoll'))).value, isTrue);
    await t.tap(find.byKey(const Key('projekt-protokoll')));
    await t.pumpAndSettle();
    expect(gesendet.single, {'aktion': 'protokoll', 'text': 'aus'});
    expect(t.widget<SwitchListTile>(find.byKey(const Key('projekt-protokoll'))).value, isFalse);
    expect(protokollAn({'protokoll': false}), isFalse);
    expect(protokollAn({}), isTrue);
  });

  testWidgets('1.27.0 Schalter Merge Requests sendet an/aus, Hinweis ohne Repository', (t) async {
    final gesendet = <Map<String, dynamic>>[];
    var an = false;
    Future<Map<String, dynamic>> json(String pfad, {String methode = 'GET', Map<String, dynamic>? koerper}) async {
      if (methode == 'POST') { gesendet.add(koerper!); an = koerper['text'] == 'an'; return {'success': true, 'display': 'ok'}; }
      return {'id': 'b77431a2-e388', 'name': 'Angebots-Radar', 'geraet': 'Ubuntu-VM', 'pfad': '/x', 'pruefBefehle': [], 'offenePunkte': [], 'laeufe': [], 'protokoll': true, 'mergeRequests': an, 'repo': null};
    }
    await t.binding.setSurfaceSize(const Size(1200, 3000));
    await t.pumpWidget(MaterialApp(home: Scaffold(body: ProjektDetail(id: 'b77431a2-e388', json: json, zurueck: () {}))));
    await t.pumpAndSettle();
    expect(t.widget<SwitchListTile>(find.byKey(const Key('projekt-merge-requests'))).value, isFalse);
    await t.tap(find.byKey(const Key('projekt-merge-requests')));
    await t.pumpAndSettle();
    expect(gesendet.single, {'aktion': 'merge_requests', 'text': 'an'});
    expect(t.widget<SwitchListTile>(find.byKey(const Key('projekt-merge-requests'))).value, isTrue);
    expect(find.textContaining('Remote fehlt'), findsOneWidget);
    expect(mergeRequestsAn({}), isFalse);
  });

  testWidgets('1.28.0 Endgültig löschen: erst Dialog, dann nur die Anfrage (Bestätigung beim Owner)', (t) async {
    final gesendet = <Map<String, dynamic>>[];
    Future<Map<String, dynamic>> json(String pfad, {String methode = 'GET', Map<String, dynamic>? koerper}) async {
      if (methode == 'POST') { gesendet.add(koerper!); return {'success': true, 'display': 'Endgültiges Löschen von Angebots-Radar zur Bestätigung gestellt'}; }
      return {'id': 'b77431a2-e388', 'name': 'Angebots-Radar', 'geraet': 'Ubuntu-VM', 'pfad': '/x', 'pruefBefehle': [], 'offenePunkte': [], 'laeufe': [], 'protokoll': true};
    }
    await t.binding.setSurfaceSize(const Size(1200, 3000));
    await t.pumpWidget(MaterialApp(home: Scaffold(body: ProjektDetail(id: 'b77431a2-e388', json: json, zurueck: () {}))));
    await t.pumpAndSettle();
    await t.tap(find.byKey(const Key('projekt-loeschen')));
    await t.pumpAndSettle();
    expect(find.text('Projekt endgültig löschen?'), findsOneWidget);
    await t.tap(find.text('Abbrechen'));
    await t.pumpAndSettle();
    expect(gesendet, isEmpty);
    await t.tap(find.byKey(const Key('projekt-loeschen')));
    await t.pumpAndSettle();
    await t.tap(find.byKey(const Key('loeschen-ja')));
    await t.pumpAndSettle();
    expect(gesendet.single, {'aktion': 'loeschen'});
    expect(find.textContaining('zur Bestätigung gestellt'), findsOneWidget);
  });

  testWidgets('1.17.0 G3 Gespräch zum Projekt öffnet den Projektfaden', (t) async {
    String? geoeffnet;
    Future<Map<String, dynamic>> json(String pfad, {String methode = 'GET', Map<String, dynamic>? koerper}) async => {'id': 'b77431a2-e388', 'name': 'Angebots-Radar', 'geraet': 'Ubuntu-VM', 'pfad': '/x', 'pruefBefehle': [], 'offenePunkte': [], 'laeufe': []};
    await t.binding.setSurfaceSize(const Size(1200, 3000));
    await t.pumpWidget(MaterialApp(home: Scaffold(body: ProjektDetail(id: 'b77431a2-e388', json: json, zurueck: () {}, aufGespraech: (f) => geoeffnet = f))));
    await t.pumpAndSettle();
    await t.tap(find.byKey(const Key('projekt-gespraech')));
    expect(geoeffnet, 'projekt-b77431a2');
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
