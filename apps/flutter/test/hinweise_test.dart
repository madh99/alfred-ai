import 'package:alfred_app/hinweise.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('hinweisKurzzeile (1.4.0)', () {
    test('erster Punkt, Anzahl weiterer, Verweis auf die Sammlung', () {
      const t = '💡 **Alfred Insights**\n\n1. **Wallbox** nicht erreichbar seit 18:00.\n2. Zwei Sensoren offline.\n3. Akku Auto 12 %.';
      expect(hinweisKurzzeile(t), '💡 Hinweis: Wallbox nicht erreichbar seit 18:00. (+2) — unter „Hinweise"');
    });
    test('ein einzelner Satz ohne Aufzählung', () {
      expect(hinweisKurzzeile('💡 **Alfred Insights** _(erstellt vor 2h)_\n\nHome Assistant meldet 72 neu nicht verfügbare Entitäten.'),
          '💡 Hinweis: Home Assistant meldet 72 neu nicht verfügbare Entitäten. — unter „Hinweise"');
    });
    test('lange Zeilen werden gekürzt, leerer Text ergibt einen Platzhalter', () {
      expect(hinweisKurzzeile('💡 x\n\n${'a' * 200}').contains('…'), isTrue);
      expect(hinweisKurzzeile('💡 **Alfred Insights**'), '💡 Hinweis von Alfred');
    });
    test('Quellen haben lesbare Namen', () {
      expect(quellenName('reasoning'), 'Alfred');
      expect(quellenName('interests'), 'Interessen');
      expect(quellenName('unbekannt'), 'unbekannt');
    });
  });
}
