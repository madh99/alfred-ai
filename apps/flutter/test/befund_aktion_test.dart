import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:alfred_app/befunde.dart';

// 1.35.0 — Befund-Aktionen (Server v1481)
void main() {
  test('Befund liest Vorgang und „nicht stummschaltbar"', () {
    final b = Befund({'id': 'b1', 'quelle': 'haus', 'titel': 'Rauch Gang', 'vorgang': true, 'vorgangId': 'v1', 'nieStumm': true});
    expect(b.vorgangId, 'v1');
    expect(b.nieStumm, isTrue);
    expect(Befund({'id': 'b2', 'quelle': 'infra', 'titel': 'AC Mesh'}).nieStumm, isFalse);
  });

  testWidgets('Dialog: Sicherheitsbefund ohne „Nicht mehr melden", mit „Vorgang öffnen"', (t) async {
    final aufrufe = <String>[];
    await t.pumpWidget(MaterialApp(home: Builder(builder: (ctx) => TextButton(onPressed: () => zeigeBefund(ctx, b: {'id': 'b1', 'quelle': 'haus', 'titel': 'Rauch Gang', 'detail': 'Melder Gang meldet Rauch', 'vorgang': true, 'nieStumm': true}, json: (p, {methode = 'GET', koerper}) async { aufrufe.add(p); return {}; }, aufMeldung: (_) {}, aufVorgaenge: () {}), child: const Text('auf')))));
    await t.tap(find.text('auf'));
    await t.pumpAndSettle();
    expect(find.text('Melder Gang meldet Rauch'), findsOneWidget);
    expect(find.text('Vorgang öffnen'), findsOneWidget);
    expect(find.text('Vorgang daraus'), findsNothing);
    final menue = t.widget<PopupMenuButton<int>>(find.byType(PopupMenuButton<int>));
    expect(menue.enabled, isFalse);
  });
}
