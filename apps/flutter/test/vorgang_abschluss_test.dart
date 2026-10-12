import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:alfred_app/vorgaenge.dart';

// 1.13.0 — Spec „Entscheiden statt Abhaken" E1: „Was war es?" / „Und künftig?", Alfreds Vorschlag vorausgewählt
void main() {
  test('Vorauswahl: Alfreds Vorschlag erst beim dritten „kein Problem", nie bei Sicherheitsbefunden', () {
    expect(kuenftigVorauswahl(art: 'kein_problem', befund: true, nieStumm: false, keinProblemBisher: 2), 'stumm');
    expect(kuenftigVorauswahl(art: 'kein_problem', befund: true, nieStumm: false, keinProblemBisher: 1), 'wie_heute');
    expect(kuenftigVorauswahl(art: 'kein_problem', befund: true, nieStumm: true, keinProblemBisher: 5), 'wie_heute');
    expect(kuenftigVorauswahl(art: 'behoben', befund: true, nieStumm: false, keinProblemBisher: 5), 'wie_heute');
    expect(kuenftigVorauswahl(art: 'kein_problem', befund: false, nieStumm: false, keinProblemBisher: 5), 'wie_heute');
  });

  test('Anfragekörper: leere Felder fallen weg, Tage nur bei „nicht mehr melden"', () {
    expect(abschlussKoerper(art: 'behoben', ursache: ' Batterie leer ', massnahme: '', kuenftig: 'wie_heute'),
        {'ergebnis': {'art': 'behoben', 'ursache': 'Batterie leer'}, 'kuenftig': {'art': 'wie_heute'}});
    expect(abschlussKoerper(art: 'kein_problem', text: 'Herbst', kuenftig: 'stumm', tage: 90),
        {'ergebnis': {'art': 'kein_problem', 'text': 'Herbst'}, 'kuenftig': {'art': 'stumm', 'tage': 90}});
  });

  Future<Map<String, dynamic>?> oeffne(WidgetTester t, Map<String, dynamic> v) async {
    Map<String, dynamic>? gesendet;
    await t.pumpWidget(MaterialApp(home: Scaffold(body: Builder(builder: (ctx) => TextButton(onPressed: () => zeigeVorgang(ctx, v: v, schritte: const [], aufMeldung: (_) {},
        json: (pfad, {methode = 'GET', koerper}) async { gesendet = koerper; return {'ok': true}; }), child: const Text('auf'))))));
    await t.tap(find.text('auf'));
    await t.pumpAndSettle();
    return gesendet;
  }

  testWidgets('Befund-Vorgang: „Kein Problem" → „Und künftig?" mit Vorschlag vorausgewählt, Abschließen sendet beides', (t) async {
    Map<String, dynamic>? gesendet;
    await t.pumpWidget(MaterialApp(home: Scaffold(body: Builder(builder: (ctx) => TextButton(onPressed: () => zeigeVorgang(ctx,
        v: {'id': 'v1', 'titel': 'Hausbatterie: SoC 47 %', 'status': 'offen', 'befund': {'quelle': 'energie', 'gegenstand': 'hausbatterie:baseline'}, 'nieStumm': false, 'keinProblemBisher': 2},
        schritte: const [], aufMeldung: (_) {}, json: (pfad, {methode = 'GET', koerper}) async { gesendet = koerper; return {'ok': true, 'regel': 'Hausbatterie: nicht melden bis 11.11.'}; }), child: const Text('auf'))))));
    await t.tap(find.text('auf'));
    await t.pumpAndSettle();
    expect(find.text('Und künftig, wenn dieser Befund wieder auftritt?'), findsNothing);
    final abschliessen = find.widgetWithText(FilledButton, 'Abschließen');
    expect(t.widget<FilledButton>(abschliessen).onPressed, isNull); // erst nach „Was war es?"
    await t.tap(find.text('Kein Problem'));
    await t.pumpAndSettle();
    expect(find.textContaining('Alfreds Vorschlag'), findsOneWidget);
    await t.enterText(find.widgetWithText(TextField, 'Warum ist es kein Problem?'), 'Herbst, wenig PV');
    await t.tap(abschliessen);
    await t.pumpAndSettle();
    expect(gesendet, {'ergebnis': {'art': 'kein_problem', 'text': 'Herbst, wenig PV'}, 'kuenftig': {'art': 'stumm', 'tage': 30}});
  });

  testWidgets('Sicherheitsbefund: „Nicht mehr melden" gesperrt; Vorgang ohne Befund: kein „Und künftig?"', (t) async {
    await oeffne(t, {'id': 'v2', 'titel': 'Rauch Gang', 'status': 'offen', 'befund': {'quelle': 'haus', 'gegenstand': 'haus:rauch:x'}, 'nieStumm': true, 'keinProblemBisher': 5});
    await t.tap(find.text('Kein Problem'));
    await t.pumpAndSettle();
    expect(t.widget<ChoiceChip>(find.widgetWithText(ChoiceChip, 'Nicht mehr melden')).onSelected, isNull);
    await t.tap(find.text('Abbrechen'));
    await t.pumpAndSettle();
    await oeffne(t, {'id': 'v3', 'titel': 'E-Mail beantworten', 'status': 'offen'});
    await t.tap(find.text('Behoben'));
    await t.pumpAndSettle();
    expect(find.widgetWithText(TextField, 'Ursache'), findsOneWidget);
    expect(find.text('Und künftig, wenn dieser Befund wieder auftritt?'), findsNothing);
  });
}
