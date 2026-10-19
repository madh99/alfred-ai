import 'package:flutter_test/flutter_test.dart';
import 'package:alfred_app/faden_aktionen.dart';

/// 1.43.0 (v1500, D2) — Kopfzeile und Menü eines Fadens: Export, Dateiname, Zeitplan, Tastenkürzel.
void main() {
  test('Markdown: Titel, Du/Alfred mit Zeit, Werkzeug- und leere Zeilen fallen weg', () {
    final md = fadenAlsMarkdown('finanzapp', [
      {'rolle': 'user', 'text': 'Wie viel Strom?', 'zeit': '2026-10-19T07:08:00Z'},
      {'rolle': 'tool', 'text': 'intern'},
      {'rolle': 'assistant', 'text': '647,35 €', 'zeit': '2026-10-19T07:08:30Z'},
      {'rolle': 'assistant', 'text': '   '},
    ]);
    expect(md.startsWith('# finanzapp\n'), isTrue);
    expect(md, contains('**Du** · 19.10.2026'));
    expect(md, contains('Wie viel Strom?'));
    expect(md, contains('**Alfred**'));
    expect(md, contains('647,35 €'));
    expect(md, isNot(contains('intern')));
    expect('**Alfred**'.allMatches(md).length, 1);
  });

  test('Dateiname: ohne Sonderzeichen und 🔨/↳, Umlaute bleiben, mit Datum, höchstens 60 Zeichen Titel', () {
    final d = DateTime(2026, 10, 19);
    expect(exportDateiname('🔨 Finanz-Backend', d), 'Finanz-Backend 2026-10-19.md');
    expect(exportDateiname('↳ Strom: heuer?/Verbrauch', d), 'Strom heuerVerbrauch 2026-10-19.md');
    expect(exportDateiname('Heizölpreis Österreich', d), 'Heizölpreis Österreich 2026-10-19.md');
    expect(exportDateiname('???', d), 'Gespräch 2026-10-19.md');
    expect(exportDateiname('x' * 100, d).length, 60 + ' 2026-10-19.md'.length);
  });

  test('Zeitplan: täglich und wöchentlich als cron (Sonntag = 0), einmalig als ISO; Fehler → null', () {
    expect(zeitplanAus(rhythmus: 'taeglich', uhrzeit: '8:05'), (art: 'cron', wert: '5 8 * * *'));
    expect(zeitplanAus(rhythmus: 'woechentlich', uhrzeit: '19:30', wochentag: DateTime.monday), (art: 'cron', wert: '30 19 * * 1'));
    expect(zeitplanAus(rhythmus: 'woechentlich', uhrzeit: '19:30', wochentag: DateTime.sunday), (art: 'cron', wert: '30 19 * * 0'));
    final e = zeitplanAus(rhythmus: 'einmalig', uhrzeit: '09:00', datum: DateTime(2026, 10, 20));
    expect(e?.art, 'once');
    expect(DateTime.parse(e!.wert).toLocal(), DateTime(2026, 10, 20, 9, 0));
    expect(zeitplanAus(rhythmus: 'taeglich', uhrzeit: '25:00'), isNull);
    expect(zeitplanAus(rhythmus: 'taeglich', uhrzeit: 'acht'), isNull);
    expect(zeitplanAus(rhythmus: 'einmalig', uhrzeit: '09:00'), isNull);
    expect(zeitplanAus(rhythmus: 'woechentlich', uhrzeit: '09:00'), isNull);
  });

  test('Tastenkürzel: Palette, neuer Chat, Seiten-Chat, archivieren stehen in der Liste', () {
    final k = appKuerzel.map((e) => e.$1).toList();
    expect(k, containsAll(['Strg+K', 'Strg+N', 'Strg+B', 'Strg+,', 'Strg+Alt+R', 'Strg+Alt+P', 'Strg+Alt+S', 'Strg+Umschalt+A']));
  });

  test('1.45.3 Chatbreite: drei Viertel, mindestens 920, höchstens 1440, nie breiter als verfügbar', () {
    expect(chatBreite(1566), closeTo(1174.5, 0.01)); // Owner-Fenster 19.10. (Chatbereich ~1566 px)
    expect(chatBreite(2400), 1440);
    expect(chatBreite(1000), 920);
    expect(chatBreite(700), 700);
  });
}
