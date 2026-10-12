import 'package:alfred_app/stopp_knopf.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

// 1.14.1 — Owner 12.10.: der Lauf-Kreis, der bis 1.6 um Senden lief, fehlte seit 1.7.0 am Stopp-Knopf
void main() {
  testWidgets('Stopp zeigt den Lauf-Kreis und bricht beim Antippen ab', (t) async {
    var gestoppt = 0;
    await t.pumpWidget(MaterialApp(home: Scaffold(body: Center(child: StoppKnopf(aufStopp: () => gestoppt++)))));
    expect(find.byKey(const Key('stopp-kreis')), findsOneWidget);
    expect(find.byIcon(Icons.stop_rounded), findsOneWidget);
    await t.tap(find.byIcon(Icons.stop_rounded));
    expect(gestoppt, 1);
  });
}
