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
    await t.tap(find.text('Schritte').first);
    await t.pump();
    expect(find.text('1. Jobs lesen'), findsOneWidget);
    await t.pumpWidget(const SizedBox()); // Takt beenden
  });
}
