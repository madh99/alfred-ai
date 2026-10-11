import 'package:alfred_app/modell.dart';
import 'package:alfred_app/schnellfrage.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// 1.7.0 — Schnellfrage (Punkt 4) und Stopp (Punkt 5) als Oberflächentest.
void main() {
  Widget bau({required TextEditingController c, bool antwortet = false, String status = '', Eintrag? antwort, VoidCallback? senden, VoidCallback? stopp, VoidCallback? schliessen, VoidCallback? fenster}) =>
      MaterialApp(home: Scaffold(body: Schnellfrage(
        eingabe: c, fokus: FocusNode(), ziel: 'Hauptgespräch', antwortet: antwortet, status: status, antwort: antwort,
        aufSenden: senden ?? () {}, aufStopp: stopp ?? () {}, aufSchliessen: schliessen ?? () {}, aufFensterOeffnen: fenster ?? () {},
      )));

  testWidgets('Enter sendet, Ziel wird angezeigt, ohne Antwort kein Antwortbereich', (t) async {
    final c = TextEditingController();
    var gesendet = 0;
    await t.pumpWidget(bau(c: c, senden: () => gesendet++));
    expect(find.text('→ Hauptgespräch'), findsOneWidget);
    await t.enterText(find.byKey(const Key('schnellfrage-eingabe')), 'Wie spät ist es?');
    await t.testTextInput.receiveAction(TextInputAction.send);
    expect(gesendet, 1);
    expect(c.text, 'Wie spät ist es?');
    expect(find.byType(Divider), findsNothing);
    expect(find.byKey(const Key('schnellfrage-stopp')), findsNothing);
  });

  testWidgets('während der Antwort: Status, Stopp-Knopf, Antworttext mit Markdown', (t) async {
    var gestoppt = 0;
    await t.pumpWidget(bau(c: TextEditingController(), antwortet: true, status: '… denkt', antwort: Eintrag(Art.alfred, 'Es ist **11:30** Uhr.'), stopp: () => gestoppt++));
    expect(find.text('… denkt'), findsOneWidget);
    expect(find.textContaining('11:30', findRichText: true), findsOneWidget);
    await t.tap(find.byKey(const Key('schnellfrage-stopp')));
    expect(gestoppt, 1);
  });

  testWidgets('Esc schließt, „Im Fenster öffnen" wechselt ins Fenster', (t) async {
    var zu = 0, fenster = 0;
    await t.pumpWidget(bau(c: TextEditingController(), schliessen: () => zu++, fenster: () => fenster++));
    await t.pump();
    await t.sendKeyEvent(LogicalKeyboardKey.escape);
    expect(zu, 1);
    await t.tap(find.byTooltip('Im Fenster öffnen'));
    expect(fenster, 1);
  });
}
