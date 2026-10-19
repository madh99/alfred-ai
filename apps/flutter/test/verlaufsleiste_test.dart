import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:alfred_app/modell.dart';
import 'package:alfred_app/verlaufsleiste.dart';

/// 1.45.0/1.45.2 (v1504, D4) — Verlaufsleiste: Striche dicht in der Mitte, Karte beim Darüberfahren (Frage, Antwortanfang,
/// 🔖), Klick springt hin, gerade sichtbare Frage hervorgehoben. Owner 19.10. 11:40: „funktioniert aber nicht“.
void main() {
  final verlauf = [
    Eintrag(Art.du, 'Wie viel Strom heuer?'),
    Eintrag(Art.hinweis, 'Verlauf geladen'),
    Eintrag(Art.alfred, '647,35 € von Jänner bis September.'),
    Eintrag(Art.du, 'Und der Verbrauch?'),
    Eintrag(Art.alfred, 'Er sinkt seit März deutlich.'),
    Eintrag(Art.du, 'Danke'),
  ];

  test('je eigene Frage ein Eintrag mit folgender Antwort, letzte Frage ohne Antwort', () {
    final l = leistenEintraege(verlauf);
    expect(l.map((e) => e.index), [0, 3, 5]);
    expect(l.first.antwort, '647,35 € von Jänner bis September.');
    expect(l.last.antwort, '');
  });

  test('Lesezeichen-Schlüssel: gleich bei gleichem Text, sonst verschieden', () {
    expect(lesezeichenSchluessel(' Danke \n'), lesezeichenSchluessel('Danke'));
    expect(lesezeichenSchluessel('Danke'), isNot(lesezeichenSchluessel('Danke!')));
  });

  test('Strichabstand: 7 px wie im Vorbild, bei vielen Fragen enger, nie unter 2 px', () {
    expect(strichAbstand(10, 600), 7);
    expect(strichAbstand(200, 600), 3);
    expect(strichAbstand(1000, 600), 2);
  });

  testWidgets('springeZu findet einen Eintrag weit oben in einer langen umgekehrten Liste', (t) async {
    final scroll = ScrollController();
    final schluessel = List.generate(300, (_) => GlobalKey());
    await t.pumpWidget(MaterialApp(home: Scaffold(body: SizedBox(height: 600, child: ListView.builder(
      controller: scroll, reverse: true, itemCount: 300,
      itemBuilder: (_, ri) => KeyedSubtree(key: schluessel[ri], child: SizedBox(height: 40.0 + (ri % 7) * 30, child: Text('Eintrag $ri'))),
    )))));
    for (final ri in [250, 120, 3, 299]) {
      // Bilder im Test selbst antreiben (springeZu wartet je Versuch auf das nächste Bild und scrollt 250 ms)
      bool? ok;
      springeZu(scroll, schluessel[ri], ri / 300).then((v) => ok = v);
      for (var i = 0; i < 1500 && ok == null; i++) { await t.pump(const Duration(milliseconds: 50)); }
      expect(ok, isTrue, reason: 'Eintrag $ri');
      expect(find.text('Eintrag $ri'), findsOneWidget);
    }
  });

  testWidgets('Darüberfahren zeigt die Karte mit Frage und Antwortanfang; 🔖 und Klick rufen zurück', (t) async {
    final spruenge = <int>[];
    final gemerkt = <String>[];
    final l = leistenEintraege(verlauf);
    await t.pumpWidget(MaterialApp(home: Scaffold(body: Row(children: [
      SizedBox(width: 30, height: 400, child: Verlaufsleiste(eintraege: l, markiert: const {}, aufSprung: spruenge.add, aktuell: 3, aufLesezeichen: (e) => gemerkt.add(e.frage))),
      const Expanded(child: SizedBox()),
    ]))));
    final maus = await t.createGesture(kind: PointerDeviceKind.mouse);
    await maus.addPointer(location: Offset.zero);
    await maus.moveTo(t.getCenter(find.byKey(const Key('leiste-0'))));
    await t.pumpAndSettle();
    expect(find.byKey(const Key('leiste-karte')), findsOneWidget);
    expect(find.text('Wie viel Strom heuer?'), findsOneWidget);
    expect(find.text('647,35 € von Jänner bis September.'), findsOneWidget);
    await t.tap(find.byKey(const Key('leiste-lesezeichen')));
    expect(gemerkt, ['Wie viel Strom heuer?']);
    await t.tap(find.byKey(const Key('leiste-3')));
    expect(spruenge, [3]);
  });
}
