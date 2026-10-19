import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:alfred_app/konto_menue.dart';

/// 1.47.0 (v1506, D5) — Kontomenü unten links (Owner 19.10.: kein Guthaben, Herkunft erfassen, Budget nur Anzeige).
void main() {
  final antwort = <String, dynamic>{
    'heute': 5.1, 'woche': 20.25, 'monat': 55, 'tagesbudgetUsd': 4,
    'claudeCode': {'heute': 3, 'woche': 3, 'monat': 5},
    'herkunftHeute': [{'herkunft': 'chat', 'kosten': 1.5, 'aufrufe': 8}, {'herkunft': 'claude-code', 'kosten': 3, 'aufrufe': 1}],
    'hintergrundMonat': [{'job': 'kg-pflege', 'kosten': 9}],
    'teuerstesModell': {'modell': 'opus-5-5', 'kosten': 30},
  };

  test('Antwort des Servers wird gelesen; Beträge mit Komma und \$', () {
    final k = KontoKosten.aus(antwort);
    expect(k.heute, 5.1);
    expect(k.tagesbudget, 4);
    expect(k.claudeCodeMonat, 5);
    expect(k.herkunftHeute, [('chat', 1.5), ('claude-code', 3.0)]);
    expect(k.teuerstesModell, 'opus-5-5');
    expect(kostenText(3.1), '3,10 \$');
    expect(kostenText(0.001), '< 0,01 \$');
    expect(kostenText(0), '0,00 \$');
  });

  testWidgets('Menü: Summen, Budget als Anzeige auch darüber, Herkunft, Geräte, Punkte rufen zurück; kein Guthaben', (t) async {
    final gerufen = <String>[];
    t.view.physicalSize = const Size(900, 1200); t.view.devicePixelRatio = 1; // ganzes Menü sichtbar (in der App scrollt es)
    addTearDown(t.view.reset);
    await t.pumpWidget(MaterialApp(home: Scaffold(body: Align(alignment: Alignment.bottomLeft, child: KontoMenue(
      geraet: 'Ubuntu-VM', verbunden: true, versionen: 'App 1.47.0 · Alfred 0.19.0-jarvis.1506',
      kosten: KontoKosten.aus(antwort), geraete: const ['Ubuntu-VM · linux', 'MacBook · macos'],
      aufEinstellungen: () => gerufen.add('einstellungen'), aufBefehle: () => gerufen.add('befehle'), aufKuerzel: () => gerufen.add('kuerzel'),
      updateText: 'Nach Update suchen', aufUpdate: () => gerufen.add('update'),
    )))));
    expect(find.text('5,10 \$'), findsWidgets);
    expect(find.text('20,25 \$'), findsOneWidget);
    expect(find.text('55,00 \$'), findsOneWidget);
    expect(find.text('Tagesbudget: 5,10 \$ von 4,00 \$'), findsOneWidget);
    final balken = t.widget<LinearProgressIndicator>(find.byType(LinearProgressIndicator));
    expect(balken.value, 1.0);
    expect(balken.color, Theme.of(t.element(find.byType(KontoMenue))).colorScheme.primary); // keine Warnfarbe
    expect(find.text('Chat'), findsOneWidget);
    expect(find.text('Claude Code'), findsOneWidget);
    expect(find.textContaining('opus-5-5'), findsOneWidget);
    expect(find.text('MacBook · macos'), findsOneWidget);
    expect(find.textContaining('Guthaben'), findsNothing);
    await t.tap(find.byKey(const Key('konto-einstellungen')));
    await t.tap(find.byKey(const Key('konto-update')));
    await t.tap(find.text('Hilfe: Tastenkürzel'));
    expect(gerufen, ['einstellungen', 'update', 'kuerzel']);
  });

  testWidgets('ohne Daten: Ladehinweis bzw. Fehlertext, ohne Budget keine Budgetzeile', (t) async {
    Widget menue({String? fehler}) => MaterialApp(home: Scaffold(body: KontoMenue(geraet: 'X', verbunden: false, versionen: '', fehler: fehler,
      aufEinstellungen: () {}, aufBefehle: () {}, aufKuerzel: () {}, updateText: 'Nach Update suchen', aufUpdate: () {})));
    await t.pumpWidget(menue());
    expect(find.text('wird geladen …'), findsOneWidget);
    await t.pumpWidget(menue(fehler: 'Kosten nicht geladen: HTTP 403'));
    expect(find.text('Kosten nicht geladen: HTTP 403'), findsOneWidget);
    expect(find.byKey(const Key('konto-budget')), findsNothing);
  });
}
