import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:alfred_app/faden_karte.dart';
import 'package:alfred_app/projekte.dart' show Lauf;

/// 1.44.0 (v1501, D3) — angeheftete Zusammenfassung: Projektkarte (Stand, Prüfungen, Änderungen, Schnellaktionen)
/// und Fadenkarte (Zusammenfassung auf Klick, offene Bestätigungen).
Map<String, dynamic> lauf({String status = 'fertig', List<Map<String, dynamic>> erledigt = const []}) => {
  'id': 'sat-1', 'status': status, 'ziel': 'Admin-UI', 'plan': ['Plan', 'Bau', 'Test'], 'erledigt': erledigt, 'nr': 3, 'kostenUsd': 1.25,
};

void main() {
  final erledigt = [
    {'nr': 1, 'ok': true, 'bericht': {'commit': {'sha': 'aaaaaaa111', 'titel': 'Plan'}, 'dateien': ['a.ts'], 'abnahme': {'ok': true}}},
    {'nr': 2, 'ok': true, 'bericht': {'commit': {'sha': 'bbbbbbb222', 'titel': 'Admin-Routen'}, 'dateien': ['src/admin.ts', 'src/cli.ts'], 'abnahme': {'ok': false}}},
  ];

  test('letzter Commit und letzte Prüfung kommen aus der jüngsten Etappe mit Bericht', () {
    final l = [Lauf(lauf(erledigt: erledigt))];
    final c = letzterCommit(l)!;
    expect(c.$1, 'bbbbbbb222');
    expect(c.$2, 'Admin-Routen');
    expect(c.$3, ['src/admin.ts', 'src/cli.ts']);
    expect(letztePruefung(l), '❌ rot');
    expect(letzterCommit([Lauf(lauf())]), isNull);
    expect(letztePruefung([Lauf(lauf())]), isNull);
  });

  testWidgets('Projektkarte: Name, Stand, Änderungen, dev und Ordner/Terminal nur auf diesem Rechner', (t) async {
    final abrufe = <String>[];
    Future<Map<String, dynamic>> json(String pfad, {String methode = 'GET', Map<String, dynamic>? koerper}) async {
      abrufe.add('$methode $pfad ${koerper ?? ''}');
      return {'name': 'Finanz-Backend', 'geraet': 'Ubuntu-VM', 'pfad': '/home/madh/claudecode/finanz-backend', 'laeufe': [lauf(erledigt: erledigt)], 'dev': {'aktiv': true, 'zuletzt': {'ok': true, 'url': 'https://192.168.1.178:3020'}}};
    }
    var ansicht = 0;
    await t.pumpWidget(MaterialApp(home: Scaffold(body: SingleChildScrollView(child: ProjektKarte(json: json, projektId: 'p1', dieserRechner: 'PC-madh', aufProjektansicht: () => ansicht++, aufMeldung: (_) {})))));
    await t.pumpAndSettle();
    expect(find.text('Finanz-Backend'), findsOneWidget);
    expect(find.textContaining('fertig'), findsOneWidget);
    expect(find.text('Prüfungen: ❌ rot'), findsOneWidget);
    expect(find.byKey(const Key('karte-aenderungen')), findsOneWidget);
    expect(find.text('dev öffnen'), findsOneWidget);
    expect(find.text('dev neu starten'), findsOneWidget);
    expect(find.text('Ordner'), findsNothing); // Projekt liegt auf der Ubuntu-VM, nicht auf PC-madh
    await t.tap(find.text('Projektansicht'));
    expect(ansicht, 1);
    expect(abrufe.first, startsWith('GET /api/geraete/projekte/p1'));
  });

  testWidgets('Projektkarte auf dem Rechner des Projekts zeigt Ordner und Terminal', (t) async {
    Future<Map<String, dynamic>> json(String pfad, {String methode = 'GET', Map<String, dynamic>? koerper}) async =>
        {'name': 'X', 'geraet': 'Ubuntu-VM', 'pfad': '/home/madh/x', 'laeufe': [], 'dev': {'aktiv': false}};
    await t.pumpWidget(MaterialApp(home: Scaffold(body: SingleChildScrollView(child: ProjektKarte(json: json, projektId: 'p1', dieserRechner: 'Ubuntu-VM', aufProjektansicht: () {}, aufMeldung: (_) {})))));
    await t.pumpAndSettle();
    expect(find.text('Ordner'), findsOneWidget);
    expect(find.text('Terminal'), findsOneWidget);
    expect(find.text('dev starten'), findsOneWidget);
    expect(find.text('Noch kein Lauf.'), findsOneWidget);
  });

  testWidgets('Fadenkarte: erst ohne Zusammenfassung, Klick fasst zusammen (POST), Bestätigungen des Fadens', (t) async {
    final methoden = <String>[];
    var zusammengefasst = false;
    Future<Map<String, dynamic>> json(String pfad, {String methode = 'GET', Map<String, dynamic>? koerper}) async {
      methoden.add('$methode $pfad');
      if (methode == 'POST') zusammengefasst = true;
      return {
        'anzahl': 30,
        if (zusammengefasst) ...{'text': '• Strom 2026: 647,35 €', 'stand': '2026-10-19T08:00:00Z', 'standAnzahl': 28},
        'bestaetigungen': [{'id': 'c1', 'text': 'Projekt Finanz-Backend: Etappe 3 starten?'}],
      };
    }
    await t.pumpWidget(MaterialApp(home: Scaffold(body: SingleChildScrollView(child: FadenKarte(json: json, faden: 'mvcisfqj', aufBestaetigungen: () {})))));
    await t.pumpAndSettle();
    expect(find.textContaining('Noch keine Zusammenfassung'), findsOneWidget);
    expect(find.textContaining('Etappe 3 starten'), findsOneWidget);
    await t.tap(find.byKey(const Key('karte-zusammenfassen')));
    await t.pumpAndSettle();
    expect(find.textContaining('647,35'), findsOneWidget);
    expect(find.textContaining('2 neue Nachrichten seither'), findsOneWidget);
    expect(methoden, ['GET /api/geraete/faeden/mvcisfqj/zusammenfassung', 'POST /api/geraete/faeden/mvcisfqj/zusammenfassung']);
  });
}
