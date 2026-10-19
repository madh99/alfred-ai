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

  // 1.42.0 (v1499, D1) — Owner 19.10.: Projekte mit ihren Fäden getrennt von den Gesprächen; „finanzapp“ unter „Finanz-Backend“
  group('Projekte', () {
    final projekte = [
      {'id': 'p-fin', 'name': 'Finanz-Backend', 'aktualisiert': '2026-10-19T07:08:00Z'},
      {'id': 'p-hei', 'name': 'Heizölpreis Österreich', 'aktualisiert': '2026-10-16T18:58:00Z'},
      {'id': 'p-leer', 'name': 'Ohne Faden', 'aktualisiert': '2026-10-10T10:00:00Z'},
    ];
    Map<String, dynamic> pf(String id, String titel, String projekt, String name) => {'faden': id, 'titel': titel, 'zeit': '', 'anzahl': 1, 'projekt': {'id': projekt, 'name': name}};
    final liste = <Map<String, dynamic>>[
      {'faden': null, 'titel': 'Hauptgespräch', 'zeit': '', 'anzahl': 9},
      pf('mvcisfqj', 'finanzapp', 'p-fin', 'Finanz-Backend'),
      pf('projekt-6445e598', '🔨 Finanz-Backend', 'p-fin', 'Finanz-Backend'),
      pf('projekt-cd0677ce', '🔨 Heizölpreis', 'p-hei', 'Heizölpreis Österreich'),
      faden('t1', titel: 'Strom heuer'),
      faden('a1', titel: 'Alt', archiviert: true),
    ];

    test('Projekte in Server-Reihenfolge, Projektfaden zuerst, ohne Projektfäden in den Gesprächen', () {
      final g = fadenGruppen(liste, projekte: projekte);
      expect(g.projekte.map((p) => p.name), ['Finanz-Backend', 'Heizölpreis Österreich', 'Ohne Faden']);
      expect(g.projekte.first.faeden.map((f) => f['faden']), ['projekt-6445e598', 'mvcisfqj']);
      expect(g.gespraeche.map((f) => f['faden']), ['t1']);
      expect(g.projekte.last.faeden, isEmpty);
    });

    test('höchstens 5 Fäden je Projekt, „Weitere“ klappt auf', () {
      final viele = [for (var i = 0; i < 8; i++) pf('f$i', 'Faden $i', 'p-fin', 'Finanz-Backend')];
      final g = fadenGruppen(viele, projekte: projekte);
      expect(g.projekte.first.faeden.length, 5);
      expect(g.projekte.first.weitere, 3);
      expect(fadenGruppen(viele, projekte: projekte, offeneProjekte: {'p-fin'}).projekte.first.faeden.length, 8);
    });

    test('Filter findet Projektname und Fadentitel; Projekte ohne Treffer fallen weg', () {
      final g = fadenGruppen(liste, projekte: projekte, filter: 'finanzapp');
      expect(g.projekte.map((p) => p.name), ['Finanz-Backend']);
      expect(g.projekte.first.faeden.map((f) => f['faden']), ['mvcisfqj']);
      expect(fadenGruppen(liste, projekte: projekte, filter: 'heizöl').projekte.first.faeden.length, 1);
    });

    test('Projekt nur aus einem Faden bekannt (ältere Projektliste) erscheint trotzdem', () {
      final g = fadenGruppen(liste);
      expect(g.projekte.map((p) => p.id), ['p-fin', 'p-hei']);
    });

    test('archivierte Fäden bleiben im Archiv, Projektfaden erkennbar', () {
      expect(fadenGruppen(liste, projekte: projekte).archiviert.map((f) => f['faden']), ['a1']);
      expect(istProjektFaden(liste[2]), isTrue);
      expect(fadenProjektId(liste[1]), 'p-fin');
      expect(fadenProjektId(liste[4]), isNull);
    });
  });
}
