import 'package:alfred_app/befehle.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// 1.10.0 — B1 Befehlspalette (Strg+K).
void main() {
  final log = <String>[];
  Befehl b(String titel, {String stichworte = '', bool mitText = false}) => Befehl(titel: titel, stichworte: stichworte, mitText: mitText, aktion: (t) => log.add('$titel|$t'));
  final alle = [
    b('Chat'),
    b('Aufgaben & Erinnerungen', stichworte: 'todo reminder'),
    b('Gedächtnis', stichworte: 'memory'),
    b('Gespräch: Strompreise'),
    b('Suche im Verlauf'),
    b('Im Verlauf suchen:', mitText: true),
    b('Als Aufgabe anlegen:', mitText: true),
    b('An Alfred senden:', mitText: true),
  ];

  group('filtereBefehle', () {
    test('ohne Eingabe: alle außer Text-Befehlen, in Listenreihenfolge', () {
      expect(filtereBefehle(alle, '  ').map((x) => x.titel), ['Chat', 'Aufgaben & Erinnerungen', 'Gedächtnis', 'Gespräch: Strompreise', 'Suche im Verlauf']);
    });
    test('Anfang vor Wortanfang vor Teilwort; Umlaute egal; Stichworte zählen', () {
      expect(filtereBefehle(alle, 'ged').first.titel, 'Gedächtnis');
      expect(filtereBefehle(alle, 'gedachtnis').first.titel, 'Gedächtnis');
      expect(filtereBefehle(alle, 'gedaechtnis').first.titel, 'Gedächtnis'); // 1.10.1 — VM-Befund
      expect(filtereBefehle(alle, 'Gedächtnis').first.titel, 'Gedächtnis');
      expect(filtereBefehle(alle, 'gespraech').first.titel, 'Gespräch: Strompreise');
      expect(filtereBefehle(alle, 'todo').first.titel, 'Aufgaben & Erinnerungen');
      expect(filtereBefehle(alle, 'strom').first.titel, 'Gespräch: Strompreise');
      final g = filtereBefehle(alle, 'ge').where((x) => !x.mitText).map((x) => x.titel).toList();
      expect(g.take(2), ['Gedächtnis', 'Gespräch: Strompreise']); // beginnen mit „ge"
    });
    test('mit Text: Text-Befehle immer am Ende, auch ohne Treffer', () {
      expect(filtereBefehle(alle, 'Milch kaufen').map((x) => x.titel), ['Im Verlauf suchen:', 'Als Aufgabe anlegen:', 'An Alfred senden:']); // senden nie vorausgewählt
    });
  });

  testWidgets('Palette: Enter ohne Treffer sucht (sendet nicht); Pfeil runter; Esc schließt ohne Aktion', (t) async {
    log.clear();
    await t.pumpWidget(MaterialApp(home: Scaffold(body: Builder(builder: (ctx) => TextButton(onPressed: () => zeigeBefehlspalette(ctx, alle), child: const Text('auf'))))));
    await t.tap(find.text('auf'));
    await t.pumpAndSettle();
    await t.enterText(find.byKey(const Key('palette-eingabe')), 'Milch kaufen');
    await t.pumpAndSettle();
    expect(find.text('An Alfred senden: „Milch kaufen“'), findsOneWidget);
    await t.testTextInput.receiveAction(TextInputAction.done);
    await t.pumpAndSettle();
    expect(log, ['Im Verlauf suchen:|Milch kaufen']);
    await t.tap(find.text('auf'));
    await t.pumpAndSettle();
    await t.enterText(find.byKey(const Key('palette-eingabe')), 'Milch kaufen');
    await t.pumpAndSettle();
    await t.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await t.pump();
    await t.testTextInput.receiveAction(TextInputAction.done);
    await t.pumpAndSettle();
    expect(log.last, 'Als Aufgabe anlegen:|Milch kaufen');

    await t.tap(find.text('auf'));
    await t.pumpAndSettle();
    await t.enterText(find.byKey(const Key('palette-eingabe')), 'ged');
    await t.pumpAndSettle();
    await t.tap(find.byKey(const Key('befehl-0')));
    await t.pumpAndSettle();
    expect(log.last, 'Gedächtnis|ged');

    await t.tap(find.text('auf'));
    await t.pumpAndSettle();
    await t.sendKeyEvent(LogicalKeyboardKey.escape);
    await t.pumpAndSettle();
    expect(find.byKey(const Key('palette-eingabe')), findsNothing);
    expect(log, hasLength(3));
  });
}
