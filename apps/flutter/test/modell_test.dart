import 'package:alfred_app/modell.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('gekuerzt (1.2.8, eingeklappte lange Nachrichten)', () {
    test('höchstens 8 Zeilen', () {
      final t = List.generate(20, (i) => 'Zeile $i').join('\n');
      final g = gekuerzt(t);
      expect(g.split('\n').length, 8);
      expect(g.endsWith(' …'), isTrue);
      expect(g.contains('Zeile 7'), isTrue);
      expect(g.contains('Zeile 8'), isFalse);
    });

    test('höchstens 500 Zeichen bei einer langen Zeile', () {
      final g = gekuerzt('x' * 3000);
      expect(g.length, 502);
    });

    test('Eintrag ist standardmäßig nicht aufgeklappt', () {
      final e = Eintrag(Art.du, 'hallo');
      expect(e.aufgeklappt, isFalse);
      e.aufgeklappt = true;
      expect(e.aufgeklappt, isTrue);
    });
  });
}
