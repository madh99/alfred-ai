import 'package:flutter_test/flutter_test.dart';
import 'package:alfred_app/faden_liste.dart';

/// 1.41.0 (v1497) — Owner 18.10.: 14 Fäden, die App zeigte nur 12; anheften und archivieren fehlten.
Map<String, dynamic> faden(String id, {String titel = '', bool angeheftet = false, bool archiviert = false}) =>
    {'faden': id, 'titel': titel, 'zeit': '2026-10-18T10:00:00Z', 'anzahl': 1, if (angeheftet) 'angeheftet': true, if (archiviert) 'archiviert': true};

void main() {
  final liste = <Map<String, dynamic>>[
    {'faden': null, 'titel': 'Hauptgespräch', 'zeit': '', 'anzahl': 9},
    faden('p1', titel: 'Angebots-Radar', angeheftet: true),
    for (var i = 1; i <= 14; i++) faden('t$i', titel: 'Faden $i'),
    faden('a1', titel: 'Alt', archiviert: true),
    {'faden': null, 'titel': 'Sitzung', 'zeit': '', 'anzahl': 5, 'archiv': 'sitzung:x'},
  ];

  test('Realfall: 14 Fäden → 12 sichtbar, „Weitere (2)“, Filter angeboten', () {
    final g = fadenGruppen(liste);
    expect(g.angeheftet.map((f) => f['faden']), ['p1']);
    expect(g.gespraeche.length, 12);
    expect(g.weitere, 2);
    expect(g.filterSinnvoll, isTrue);
    expect(g.archiviert.map((f) => f['faden']), ['a1']);
    expect(g.sitzungen.length, 1);
  });

  test('„Weitere“ aufgeklappt zeigt alle', () {
    final g = fadenGruppen(liste, alle: true);
    expect(g.gespraeche.length, 14);
    expect(g.weitere, 0);
  });

  test('Filter sucht im Titel über alle, auch im Archiv', () {
    final g = fadenGruppen(liste, filter: 'faden 1');
    expect(g.gespraeche.map((f) => f['faden']), ['t1', 't10', 't11', 't12', 't13', 't14']);
    expect(fadenGruppen(liste, filter: 'alt').archiviert.length, 1);
    expect(fadenGruppen(liste, filter: 'radar').angeheftet.length, 1);
  });

  test('Löschen mit laufender Rückgängig-Frist blendet den Faden aus', () {
    final g = fadenGruppen(liste, ausgeblendet: {'p1', 't1'});
    expect(g.angeheftet, isEmpty);
    expect(g.gespraeche.any((f) => f['faden'] == 't1'), isFalse);
  });

  test('Titel ohne Inhalt heißt „Gespräch“', () {
    expect(fadenTitelText(faden('x')), 'Gespräch');
    expect(fadenTitelText(faden('x', titel: ' Strom ')), 'Strom');
  });
}
