import 'package:alfred_app/unterhaltung.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('Pegel: Ruhe 0, Sprache mittig, laut 1', () {
    expect(pegelAusRms(50), 0);
    expect(pegelAusRms(3000), closeTo(0.74, 0.02));
    expect(pegelAusRms(20000), 1);
  });

  test('Phasen-Texte, stumm hat Vorrang', () {
    expect(phasenText(UPhase.hoert, stumm: false), 'Ich höre zu …');
    expect(phasenText(UPhase.spricht, stumm: false), 'Antippen unterbricht');
    expect(phasenText(UPhase.denkt, stumm: true), 'Mikrofon stumm');
  });

  testWidgets('Ansicht: Kugel unterbricht, Stumm schaltet, X beendet; Spielt zeigt Sprechen', (t) async {
    final st = UnterhaltungsStand();
    var kugel = 0, stumm = 0, ende = 0;
    var spielt = false;
    await t.pumpWidget(MaterialApp(home: UnterhaltungsAnsicht(stand: st, spielt: () => spielt, stufe: 'Schnell',
      aufKugel: () => kugel++, aufStumm: () { stumm++; st.stumm = !st.stumm; }, aufBeenden: () => ende++)));
    expect(find.text('Ich höre zu …'), findsOneWidget);
    expect(find.text('Unterhaltung · Schnell'), findsOneWidget);
    await t.tap(find.byKey(const Key('unterhaltung-stumm')));
    await t.pump();
    expect(find.text('Mikrofon stumm'), findsOneWidget);
    await t.tap(find.byKey(const Key('unterhaltung-stumm')));
    st.texte(du: 'Wie wird das Wetter?', alfred: 'Morgen sonnig.');
    spielt = true;
    await t.pump();
    expect(find.text('Antippen unterbricht'), findsOneWidget);
    expect(find.text('Wie wird das Wetter?'), findsOneWidget);
    expect(find.text('Morgen sonnig.'), findsOneWidget);
    await t.tap(find.byKey(const Key('kugel')));
    await t.tap(find.byKey(const Key('unterhaltung-ende')));
    expect((kugel, stumm, ende), (1, 2, 1));
  });
}
