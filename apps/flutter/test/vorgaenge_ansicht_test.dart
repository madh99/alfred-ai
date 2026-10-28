import 'package:flutter_test/flutter_test.dart';
import 'package:alfred_app/vorgaenge_ansicht.dart';
import 'package:alfred_app/vorgaenge.dart';

// 1.34.0 — Werte wie im Realfall 16.10. (14 offene Vorgänge, drei zu „Temp Terrasse")
void main() {
  final jetzt = DateTime.parse('2026-10-16T12:00:00Z');
  final offene = <Map<String, dynamic>>[
    {'id': 'a', 'titel': 'Erinnerung: Sensor Temp Terrasse prüfen und Batterie wechseln', 'status': 'offen', 'besitzer': 'alfred'},
    {'id': 'b', 'titel': 'Batteriewechsel-Erinnerung für Temp Terrasse Sensor auf heute setzen', 'status': 'offen', 'besitzer': 'alfred'},
    {'id': 'c', 'titel': 'Wallbox go-echarger_402636 Erreichbarkeit prüfen', 'status': 'wartet', 'besitzer': 'user'},
    {'id': 'd', 'titel': 'MikroTik: 3 Interfaces als "down" gemeldet', 'status': 'offen', 'besitzer': 'user', 'frist': '2026-10-20T00:00:00Z'},
    {'id': 'e', 'titel': 'Domain-Verlängerung bei easyname erinnern', 'status': 'offen', 'besitzer': 'alfred', 'zurueckBis': '2026-10-17T08:00:00Z'},
    {'id': 'f', 'titel': 'Alt zurückgestellt', 'status': 'offen', 'besitzer': 'alfred', 'zurueckBis': '2026-10-15T08:00:00Z'},
  ];

  test('Gruppen: für dich (wartet/Owner, nach Frist), bei Alfred, zurückgestellt nur in der Zukunft', () {
    final g = vorgangGruppen(offene, jetzt);
    expect(g.fuerDich.map((v) => v['id']), ['d', 'c']);
    expect(g.beiAlfred.map((v) => v['id']), ['a', 'b', 'f']);
    expect(g.zurueck.map((v) => v['id']), ['e']);
    // 1.83.0 — Owner 28.10.: Zähler ohne Zurückgestellte, Kopfzeile nennt sie getrennt
    expect(vorgangAktivZahl(offene, jetzt), offene.length - 1);
    expect(vorgangKopfText(offene, jetzt), '${offene.length - 1} offen · 1 zurückgestellt');
    expect(zurueckBis(offene[4], jetzt), isNotNull);
    expect(zurueckBis(offene[5], jetzt), isNull);
  });

  test('ähnliche Vorgänge: die zwei Temp-Terrasse-Erinnerungen, nicht die Wallbox', () {
    final a = aehnlicheVorgaenge(offene);
    expect(a.keys.toSet(), {'a', 'b'});
    expect(a['a'], contains('Batteriewechsel'));
  });
}
