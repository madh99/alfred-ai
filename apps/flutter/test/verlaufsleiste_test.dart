import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:alfred_app/modell.dart';
import 'package:alfred_app/verlaufsleiste.dart';

/// 1.45.0 (v1504, D4) — Verlaufsleiste: ein Strich je eigener Frage, Vorschau mit Antwortanfang, Sprung, Lesezeichen.
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
    expect(l[1].antwort, 'Er sinkt seit März deutlich.');
    expect(l.last.antwort, '');
  });

  test('Lesezeichen-Schlüssel: gleich bei gleichem Text (auch mit Leerraum), sonst verschieden', () {
    expect(lesezeichenSchluessel(' Danke \n'), lesezeichenSchluessel('Danke'));
    expect(lesezeichenSchluessel('Danke'), isNot(lesezeichenSchluessel('Danke!')));
    expect(lesezeichenSchluessel('x'), hasLength(16));
  });

  test('Strichlage von oben nach unten, ein einzelner Strich in der Mitte', () {
    expect(strichLage(0, 3), 0);
    expect(strichLage(1, 3), 0.5);
    expect(strichLage(2, 3), 1);
    expect(strichLage(0, 1), 0.5);
  });

  testWidgets('Klick auf einen Strich springt zur Nachricht; Lesezeichen sind breiter', (t) async {
    final spruenge = <int>[];
    final l = leistenEintraege(verlauf);
    await t.pumpWidget(MaterialApp(home: Scaffold(body: SizedBox(width: 40, height: 300, child: Verlaufsleiste(eintraege: l, markiert: {l[1].schluessel}, aufSprung: spruenge.add)))));
    await t.tap(find.byKey(const Key('leiste-3')));
    expect(spruenge, [3]);
    final breiten = t.widgetList<Container>(find.descendant(of: find.byType(Verlaufsleiste), matching: find.byType(Container))).map((c) => c.constraints?.maxWidth).toList();
    expect(breiten.where((b) => b == 18).length, 1);
  });
}
