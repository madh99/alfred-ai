import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:alfred_app/halte_knopf.dart';

/// 1.53.0+91 — Mikrofonknopf am Handy (Realfall Build 90: Halten zeigte nur die Kurzinfo, keine Aufnahme).
void main() {
  Future<List<String>> aufbauen(WidgetTester t, {bool aktiv = true}) async {
    final ereignisse = <String>[];
    await t.pumpWidget(MaterialApp(home: Scaffold(body: Center(child: HalteKnopf(
      key: const Key('k'), aktiv: aktiv, icon: const Icon(Icons.mic_none),
      aufTipp: () => ereignisse.add('tipp'), aufHalten: () => ereignisse.add('halten'), aufLoslassen: () => ereignisse.add('los'),
    )))));
    return ereignisse;
  }

  testWidgets('kurzer Druck = Tipp (Diktat), kein Halten', (t) async {
    final e = await aufbauen(t);
    await t.tap(find.byKey(const Key('k')));
    await t.pump(const Duration(milliseconds: 500));
    expect(e, ['tipp']);
  });

  testWidgets('Halten: nach 0,4 s Aufnahme, Loslassen sendet — kein zusätzlicher Tipp, keine Kurzinfo', (t) async {
    final e = await aufbauen(t);
    final g = await t.startGesture(t.getCenter(find.byKey(const Key('k'))));
    await t.pump(const Duration(milliseconds: 300));
    expect(e, isEmpty);
    await t.pump(const Duration(milliseconds: 200));
    expect(e, ['halten']);
    await t.pump(const Duration(seconds: 2));
    await g.up();
    await t.pump(const Duration(milliseconds: 500));
    expect(e, ['halten', 'los']);
    expect(find.byType(Tooltip), findsNothing);
  });

  testWidgets('gesperrt (Antwort läuft): Halten startet nichts, Tipp geht durch', (t) async {
    final e = await aufbauen(t, aktiv: false);
    final g = await t.startGesture(t.getCenter(find.byKey(const Key('k'))));
    await t.pump(const Duration(seconds: 1));
    await g.up();
    await t.pump(const Duration(milliseconds: 500));
    expect(e, ['tipp']);
  });
}
