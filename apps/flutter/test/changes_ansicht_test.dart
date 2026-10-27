import 'package:alfred_app/changes_ansicht.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

// 1.75.0 — Changes-Ansicht (Owner 22.10.): Gruppen nach Status/Laufphase, Zähler, Knöpfe füllen nur die Eingabe vor
final _jetzt = DateTime.utc(2026, 10, 22, 22, 0);

Map<String, dynamic> _daten() => {
  'vorhaben': [
    {'id': 'v1', 'titel': 'Dockerhost aufteilen', 'changes': [
      {'id': '27cf0e2b-aaaa', 'titel': 'Übergangssicherung', 'status': 'in_progress', 'phase': 'laeuft', 'schritte': 2, 'risiko': 'low', 'erstellt': '2026-10-22T21:19:00Z',
        'lauf': {'schritt': 2, 'schrittTitel': 'Übergangsjob anlegen', 'fertig': 1, 'start': '2026-10-22T21:21:42Z', 'schrittListe': [{'nr': 1, 'titel': 'Jobs lesen', 'art': 'lesen', 'ok': true}, {'nr': 2, 'titel': 'Übergangsjob anlegen', 'art': 'aendern', 'ok': null}]}},
      {'id': 'f94cb2cd-bbbb', 'titel': 'pgAdmin umziehen', 'status': 'in_progress', 'phase': 'angehalten', 'schritte': 5, 'erstellt': '2026-10-22T19:42:00Z',
        'lauf': {'schritt': 5, 'schrittTitel': 'Container starten', 'fertig': 4, 'grund': 'Permission denied', 'schrittListe': []}},
      {'id': 'e1843faa-cccc', 'titel': 'pgAdmin alt', 'status': 'rolled_back', 'phase': 'fertig', 'schritte': 3, 'erstellt': '2026-10-01T10:00:00Z', 'lauf': {'ende': '2026-10-01T11:00:00Z'}},
    ]},
  ],
  'ohneVorhaben': [
    {'id': '5530203e-dddd', 'titel': 'Feste IP', 'status': 'submitted', 'schritte': 2, 'erstellt': '2026-10-22T21:19:05Z'},
    {'id': '8b9e0728-eeee', 'titel': 'Alte Sicherungen löschen', 'status': 'completed', 'phase': 'fertig', 'schritte': 4, 'erstellt': '2026-10-22T20:51:00Z', 'lauf': {'fertig': 4, 'ende': '2026-10-22T20:53:47Z'}},
    {'id': 'aaaa0000-ffff', 'titel': 'Entwurf', 'status': 'draft', 'schritte': 1, 'erstellt': '2026-10-22T20:00:00Z'},
    {'id': 'bbbb0000-ffff', 'titel': 'Freigegeben', 'status': 'approved', 'schritte': 1, 'erstellt': '2026-10-22T20:00:00Z'},
  ],
};

void main() {
  test('Gruppen: läuft, braucht dich, Freigabe, freigegeben, Planung, abgeschlossen nur 7 Tage', () {
    final g = changeGruppen(changesFlach(_daten()), _jetzt);
    expect(g.laeuft.map((c) => c['titel']), ['Übergangssicherung']);
    expect(g.laeuft.first['vorhabenTitel'], 'Dockerhost aufteilen');
    expect(g.brauchtDich.map((c) => c['titel']), ['pgAdmin umziehen']);
    expect(g.freigabe.map((c) => c['titel']), ['Feste IP']);
    expect(g.freigegeben.map((c) => c['titel']), ['Freigegeben']);
    expect(g.planung.map((c) => c['titel']), ['Entwurf']);
    expect(g.erledigt.map((c) => c['titel']), ['Alte Sicherungen löschen']); // der Rückweg vom 01.10. ist älter als 7 Tage
    expect(changesZahl(_daten(), _jetzt), 3);
  });

  test('Statustexte', () {
    expect(changeStatusText({'status': 'in_progress', 'phase': 'rueckweg'}), 'Rückweg läuft');
    expect(changeStatusText({'status': 'in_progress', 'phase': 'angehalten'}), 'angehalten');
    expect(changeStatusText({'status': 'submitted'}), 'wartet auf Freigabe');
    expect(changeStatusText({'status': 'rolled_back', 'phase': 'fertig'}), 'zurückgenommen');
  });

  testWidgets('Ansicht zeigt Laufstand; Knöpfe füllen nur die Eingabe vor', (t) async {
    final vorgefuellt = <String>[];
    var zurFreigabe = 0, anzahl = -1;
    await t.pumpWidget(MaterialApp(home: Scaffold(body: ChangesAnsicht(
      json: (p, {methode = 'GET', koerper}) async { expect(p, '/api/geraete/changes'); return _daten(); },
      aufNachfragen: vorgefuellt.add, aufBestaetigungen: () => zurFreigabe++, aufAnzahl: (n) => anzahl = n, jetzt: () => _jetzt))));
    await t.pump();
    expect(find.text('Läuft gerade (1)'), findsOneWidget);
    expect(find.text('Braucht dich (1)'), findsOneWidget);
    expect(find.text('Schritt 2 von 2: Übergangsjob anlegen'), findsOneWidget);
    expect(find.text('Permission denied'), findsOneWidget);
    expect(anzahl, 3);
    await t.tap(find.text('Wiederholen …'));
    expect(vorgefuellt, ['Change f94cb2cd Schritt wiederholen']);
    await t.tap(find.text('Zur Freigabe'));
    expect(zurFreigabe, 1);
    // 1.79.0 — Ändern lassen: angehalten ab dem Haltepunkt, wartend auf Freigabe ganz
    await t.tap(find.byKey(const Key('aendern-f94cb2cd')));
    await t.tap(find.byKey(const Key('aendern-5530203e')));
    expect(vorgefuellt.sublist(1), ['Change f94cb2cd ab Schritt 5 ändern: ', 'Change 5530203e ändern: ']);
    expect(find.byKey(const Key('aendern-27cf0e2b')), findsNothing); // läuft gerade
    await t.tap(find.text('Schritte').first);
    await t.pump();
    expect(find.text('1. Jobs lesen'), findsOneWidget);
    await t.pumpWidget(const SizedBox()); // Takt beenden
  });

  testWidgets('1.76.0: vorgeschlagene Architektur zeigt eine Karte; Annehmen füllt nur die Eingabe vor und zählt mit', (t) async {
    final d = _daten();
    (d['vorhaben'] as List).add({'id': 'cf82f3f2-9859', 'titel': 'Dockerhost auf neue Docker-VMs aufteilen', 'status': 'architektur_vorgeschlagen', 'architekturVersion': 6, 'changes': []});
    expect(architekturWartet(d).length, 1);
    expect(changesZahl(d, _jetzt), 4);
    expect(architekturSaetze(architekturWartet(d).first).annehmen, 'Vorhaben cf82f3f2: Architektur Version 6 annehmen');
    final vorgefuellt = <String>[];
    await t.pumpWidget(MaterialApp(home: Scaffold(body: ChangesAnsicht(
      json: (p, {methode = 'GET', koerper}) async => d, aufNachfragen: vorgefuellt.add, jetzt: () => _jetzt))));
    await t.pump();
    expect(find.text('Architektur wartet auf dich (1)'), findsOneWidget);
    expect(find.text('Fassung 6'), findsOneWidget);
    await t.tap(find.text('Annehmen …'));
    await t.tap(find.text('Überarbeiten …'));
    expect(vorgefuellt, ['Vorhaben cf82f3f2: Architektur Version 6 annehmen', 'Vorhaben cf82f3f2: Architektur Version 6 überarbeiten — ']);
    await t.pumpWidget(const SizedBox());
  });

  testWidgets('1.77.0: „Fassung ansehen“ zeigt die Änderungen gegenüber der angenommenen Fassung und den ganzen Text', (t) async {
    t.view.physicalSize = const Size(1400, 1000); t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    final d = _daten();
    (d['vorhaben'] as List).add({'id': 'cf82f3f2-9859', 'titel': 'Dockerhost aufteilen', 'status': 'architektur_vorgeschlagen', 'architekturVersion': 8, 'changes': []});
    final fassung = {
      'vorhaben': {'id': 'cf82f3f2-9859', 'architekturVersion': 8},
      'fassung': {'version': 8, 'inhalt': '# Zielarchitektur (Version 8)\n\nWeb zieht nach docker-web-01.'},
      'basis': {'version': 6, 'angenommen': true},
      'unterschied': [
        {'art': 'abschnitt', 'zeile': '## Netze'},
        {'art': 'weg', 'zeile': '| 826 | frei |'},
        {'art': 'neu', 'zeile': '| 826 | Docker-Web |'},
      ],
    };
    final abgerufen = <String>[], vorgefuellt = <String>[];
    expect(fassungVergleichTitel(fassung), 'Neu gegenüber Fassung 6 (von dir angenommen)');
    await t.pumpWidget(MaterialApp(home: Scaffold(body: ChangesAnsicht(
      json: (p, {methode = 'GET', koerper}) async { abgerufen.add(p); return p.startsWith('/api/geraete/vorhaben/') ? fassung : d; },
      aufNachfragen: vorgefuellt.add, jetzt: () => _jetzt))));
    await t.pump();
    await t.tap(find.text('Fassung ansehen'));
    await t.pumpAndSettle();
    expect(abgerufen, contains('/api/geraete/vorhaben/cf82f3f2-9859'));
    expect(find.text('Neu gegenüber Fassung 6 (von dir angenommen)'), findsOneWidget);
    expect(find.text('Netze'), findsOneWidget);
    expect(find.text('+ | 826 | Docker-Web |'), findsOneWidget);
    expect(find.text('− | 826 | frei |'), findsOneWidget);
    await t.tap(find.text('Ganze Fassung'));
    await t.pumpAndSettle();
    expect(find.textContaining('Web zieht nach docker-web-01.', findRichText: true), findsWidgets);
    await t.tap(find.widgetWithText(FilledButton, 'Annehmen …').last);
    await t.pumpAndSettle();
    expect(vorgefuellt, ['Vorhaben cf82f3f2: Architektur Version 8 annehmen']);
    await t.pumpWidget(const SizedBox());
  });
}
