import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:alfred_app/abgleich.dart';
import 'package:alfred_app/vorgaenge_ansicht.dart';

// 1.40.0 — Realfall 18.10. 11:00/11:03: „proxmox: test-ubuntu RAM“ war am Server schon von selbst erledigt, die offene Ansicht
// zeigte ihn weiter und ließ ihn erst beim nächsten Klick verschwinden.
void main() {
  test('verschwunden und mitNeuen', () {
    expect(verschwunden({'a': 'A', 'b': 'B', 'c': 'C'}, ['a', 'c']), ['B']);
    expect(verschwunden({'a': 'A'}, ['a', 'neu']), isEmpty);
    expect(mitNeuen(['1', '2'], ['3'], max: 2), ['2', '3']);
  });

  testWidgets('offene Vorgänge-Ansicht gleicht regelmäßig ab und nennt, was inzwischen erledigt wurde', (t) async {
    var runde = 0;
    final hb = {'id': 'hb', 'titel': 'Hausbatterie: SoC 19 %', 'status': 'offen', 'besitzer': 'user'};
    final px = {'id': 'px', 'titel': 'proxmox: test-ubuntu RAM usage 95.1%', 'status': 'offen', 'besitzer': 'user'};
    Future<Map<String, dynamic>> json(String pfad, {String methode = 'GET', Map<String, dynamic>? koerper}) async {
      runde++;
      return runde == 1
          ? {'offene': [hb, px], 'abgeschlossene': [], 'schritte': []}
          : {'offene': [hb], 'abgeschlossene': [{...px, 'status': 'erledigt', 'ergebnis': 'von selbst erledigt: im Weltmodell nicht mehr auffällig'}], 'schritte': []};
    }
    await t.binding.setSurfaceSize(const Size(1000, 1400));
    await t.pumpWidget(MaterialApp(home: Scaffold(body: VorgaengeAnsicht(json: json, aufMeldung: (_) {}))));
    await t.pumpAndSettle();
    expect(find.textContaining('proxmox: test-ubuntu'), findsOneWidget);
    expect(find.byKey(const Key('abgleich-hinweis')), findsNothing);
    await t.pump(abgleichTakt);
    await t.pumpAndSettle();
    expect(find.byKey(const Key('abgleich-hinweis')), findsOneWidget);
    expect(find.textContaining('proxmox: test-ubuntu RAM usage 95.1% — von selbst erledigt'), findsOneWidget);
    await t.tap(find.byKey(const Key('abgleich-schliessen')));
    await t.pumpAndSettle();
    expect(find.byKey(const Key('abgleich-hinweis')), findsNothing);
    await t.pumpWidget(const SizedBox()); // Ansicht weg → Takt beendet
  });
}
