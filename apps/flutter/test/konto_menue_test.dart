import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:alfred_app/konto_menue.dart';

/// 1.47.0 (v1506, D5) — Kontomenü unten links (Owner 19.10.: kein Guthaben, Herkunft erfassen, Budget nur Anzeige).
/// 1.48.0 (v1508) — Code-Agenten getrennt, Geräte aufklappbar.
void main() {
  final antwort = <String, dynamic>{
    'heute': 5.6, 'woche': 20.25, 'monat': 55, 'tagesbudgetUsd': 4,
    'agenten': [
      {'agent': 'claude-code', 'heute': 3, 'woche': 3, 'monat': 5},
      {'agent': 'codex', 'heute': 0.5, 'woche': 0.5, 'monat': 0.5},
      {'agent': 'mistral-vibe', 'heute': 0, 'woche': 0, 'monat': 0},
    ],
    'herkunftHeute': [{'herkunft': 'chat', 'kosten': 1.5, 'aufrufe': 8}, {'herkunft': 'agent:claude-code', 'kosten': 3, 'aufrufe': 1}, {'herkunft': 'agent:codex', 'kosten': 0.5, 'aufrufe': 1}],
    'hintergrundMonat': [{'job': 'kg-pflege', 'kosten': 9}],
    'teuerstesModell': {'modell': 'opus-5-5', 'kosten': 30},
  };
  final geraete = [
    KontoGeraet.aus({'name': 'Ubuntu-VM', 'plattform': 'linux', 'online': true, 'hostname': 'ubuntu-vm', 'satellitVersion': '0.19.0-jarvis.1498', 'verbundenSeit': '2026-10-19T10:54:48.781Z', 'gekoppelt': '2026-10-09T08:00:00Z', 'rechte': ['projekt', 'bedienen'], 'aktionen': 24, 'sinne': ['leerlauf'], 'claudeCodeMonat': 3}),
    KontoGeraet.aus({'name': 'Office-VM', 'plattform': 'windows', 'online': false, 'zuletztGesehen': '2026-10-18T20:00:00Z'}),
  ];

  test('Antwort des Servers wird gelesen; Beträge mit Komma und \$; Namen der Agenten', () {
    final k = KontoKosten.aus(antwort);
    expect(k.heute, 5.6);
    expect(k.tagesbudget, 4);
    expect(k.agenten, [('claude-code', 3.0, 5.0), ('codex', 0.5, 0.5), ('mistral-vibe', 0.0, 0.0)]);
    expect(k.teuerstesModell, 'opus-5-5');
    expect(kostenText(3.1), '3,10 \$');
    expect(kostenText(0.001), '< 0,01 \$');
    expect(herkunftName('agent:codex'), 'Codex');
    expect(herkunftName('agent:mistral-vibe'), 'Mistral Vibe');
    expect(herkunftName('hintergrund'), 'Hintergrund');
    expect(geraete.first.aktionen, 24);
    expect(geraete.last.online, isFalse);
  });

  Widget menue(List<String> gerufen) => MaterialApp(home: Scaffold(body: Align(alignment: Alignment.bottomLeft, child: KontoMenue(
    geraet: 'Ubuntu-VM', verbunden: true, versionen: 'App 1.48.0 · Alfred 0.19.0-jarvis.1508',
    kosten: KontoKosten.aus(antwort), geraete: geraete,
    aufEinstellungen: () => gerufen.add('einstellungen'), aufBefehle: () => gerufen.add('befehle'), aufKuerzel: () => gerufen.add('kuerzel'),
    updateText: 'Nach Update suchen', aufUpdate: () => gerufen.add('update'),
  ))));

  testWidgets('Menü: Summen, Budget als Anzeige auch darüber, Herkunft, Agenten getrennt, Punkte rufen zurück; kein Guthaben', (t) async {
    final gerufen = <String>[];
    t.view.physicalSize = const Size(900, 1600); t.view.devicePixelRatio = 1; // ganzes Menü sichtbar (in der App scrollt es)
    addTearDown(t.view.reset);
    await t.pumpWidget(menue(gerufen));
    expect(find.text('20,25 \$'), findsOneWidget);
    expect(find.text('55,00 \$'), findsOneWidget);
    expect(find.text('Tagesbudget: 5,60 \$ von 4,00 \$'), findsOneWidget);
    final balken = t.widget<LinearProgressIndicator>(find.byType(LinearProgressIndicator));
    expect(balken.value, 1.0);
    expect(balken.color, Theme.of(t.element(find.byType(KontoMenue))).colorScheme.primary); // keine Warnfarbe
    expect(find.byKey(const Key('konto-agent-claude-code')), findsOneWidget);
    expect(find.byKey(const Key('konto-agent-codex')), findsOneWidget);
    expect(find.byKey(const Key('konto-agent-mistral-vibe')), findsOneWidget);
    expect(find.descendant(of: find.byKey(const Key('konto-agent-codex')), matching: find.text('Codex')), findsOneWidget);
    expect(find.textContaining('opus-5-5'), findsOneWidget);
    expect(find.textContaining('Guthaben'), findsNothing);
    await t.tap(find.byKey(const Key('konto-einstellungen')));
    await t.tap(find.byKey(const Key('konto-update')));
    await t.tap(find.text('Hilfe: Tastenkürzel'));
    expect(gerufen, ['einstellungen', 'update', 'kuerzel']);
  });

  testWidgets('Geräte: zugeklappt nur Name und Status, aufgeklappt Details', (t) async {
    t.view.physicalSize = const Size(900, 1600); t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    await t.pumpWidget(menue([]));
    expect(find.text('Linux · verbunden'), findsOneWidget);
    expect(find.text('Windows · offline'), findsOneWidget);
    expect(find.text('ubuntu-vm'), findsNothing);
    await t.tap(find.byKey(const Key('konto-geraet-Ubuntu-VM')));
    await t.pumpAndSettle();
    expect(find.text('ubuntu-vm'), findsOneWidget);
    expect(find.text('0.19.0-jarvis.1498'), findsOneWidget);
    expect(find.text('24 Aktionen · Sinne: leerlauf'), findsOneWidget);
    expect(find.text('projekt, bedienen'), findsOneWidget);
    expect(find.text('3,00 \$'), findsWidgets);
    await t.tap(find.byKey(const Key('konto-geraet-Office-VM')));
    await t.pumpAndSettle();
    expect(find.text('Zuletzt gesehen'), findsOneWidget);
  });

  testWidgets('ohne Daten: Ladehinweis bzw. Fehlertext, ohne Budget keine Budgetzeile', (t) async {
    Widget leer({String? fehler}) => MaterialApp(home: Scaffold(body: KontoMenue(geraet: 'X', verbunden: false, versionen: '', fehler: fehler,
      aufEinstellungen: () {}, aufBefehle: () {}, aufKuerzel: () {}, updateText: 'Nach Update suchen', aufUpdate: () {})));
    await t.pumpWidget(leer());
    expect(find.text('wird geladen …'), findsOneWidget);
    await t.pumpWidget(leer(fehler: 'Kosten nicht geladen: HTTP 403'));
    expect(find.text('Kosten nicht geladen: HTTP 403'), findsOneWidget);
    expect(find.byKey(const Key('konto-budget')), findsNothing);
  });
}
