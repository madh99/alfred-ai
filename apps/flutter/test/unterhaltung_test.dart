import 'dart:math';
import 'dart:typed_data';

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

  group('1.60.0 G3 ins Wort fallen', () {
    Uint8List block(int ms) => Uint8List(ms * 32); // Inhalt egal, der Pegel kommt als rms
    test('anhaltend laut unterbricht, kurz oder leise nicht', () {
      final e = InsWortErkenner();
      for (var i = 0; i < 10; i++) { expect(e.schiebe(block(20), 800), false); } // Echo-Rest unter 1500
      for (var i = 0; i < 5; i++) { expect(e.schiebe(block(20), 4000), false); } // 100 ms Husten
      for (var i = 0; i < 10; i++) { expect(e.schiebe(block(20), 300), false); } // baut ab
      var ausgeloest = false;
      for (var i = 0; i < 30 && !ausgeloest; i++) { ausgeloest = e.schiebe(block(20), 4000); }
      expect(ausgeloest, true);
      expect(e.nimmVorlauf().length, lessThanOrEqualTo(700 * 32 + 20 * 32)); // höchstens 0,7 s Vorlauf
      expect(e.nimmVorlauf().length, 0);
    });
    test('hohe Sprechschwelle (lauter Raum) hebt die Grenze', () {
      final e = InsWortErkenner();
      var ausgeloest = false;
      for (var i = 0; i < 40; i++) { ausgeloest = ausgeloest || e.schiebe(block(20), 3000, schwelle: 2000); }
      expect(ausgeloest, false); // Grenze 4000
    });
    test('Phasentext mit ins Wort fallen', () {
      expect(phasenText(UPhase.spricht, stumm: false, insWort: true), 'Sprich einfach dazwischen');
    });
  });

  group('1.68.0 Kugel', () {
    Uint8List ton(double hz, {int ms = 200, double amp = 6000}) {
      final n = 16 * ms; final b = ByteData(n * 2);
      for (var i = 0; i < n; i++) { b.setInt16(i * 2, (amp * sin(2 * pi * hz * i / 16000)).round(), Endian.little); }
      return b.buffer.asUint8List();
    }
    test('Bänder: tiefer Ton → tief, hoher Ton → hoch', () {
      final (t1, _, h1) = Baender().schiebe(ton(150));
      final (t2, _, h2) = Baender().schiebe(ton(5000));
      expect(t1, greaterThan(h1));
      expect(h2, greaterThan(t2));
      expect(Baender().schiebe(Uint8List(0)), (0.0, 0.0, 0.0));
    });
    test('Stimmung nach festen Regeln: Warnung vor Erledigt', () {
      expect(stimmungAus('Der Access Point ist offline.'), Stimmung.warnung);
      expect(stimmungAus('✅ Erledigt, die Datei ist abgelegt.'), Stimmung.erledigt);
      expect(stimmungAus('Fehler beim Speichern, aber Rest erledigt'), Stimmung.warnung);
      expect(stimmungAus('Morgen wird es sonnig.'), Stimmung.neutral);
      final st = UnterhaltungsStand()..texte(alfred: 'Achtung: Störung im WLAN');
      expect(st.stimmung, Stimmung.warnung);
      st.texte(alfred: '');
      expect(st.stimmung, Stimmung.neutral);
    });
  });
}
