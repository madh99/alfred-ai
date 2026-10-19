import 'package:flutter_test/flutter_test.dart';
import 'package:alfred_app/handy_system.dart';
import 'package:alfred_app/handy_verbindung.dart';

/// 1.54.1 — Dateien von Alfred aufs Handy (Owner 19.10.: nie überschreiben, „(1)“; „Alfred“ ist Standard).
void main() {
  test('sicherer Name: keine Pfadanteile, keine Steuerzeichen, nie leer', () {
    expect(sichererName('../../etc/passwd'), 'passwd');
    expect(sichererName(r'C:\Users\x\rechnung.pdf'), 'rechnung.pdf');
    expect(sichererName('a\u0000b:c.txt'), 'a_b_c.txt');
    expect(sichererName('..'), 'datei');
    expect(sichererName(''), 'datei');
  });

  test('freier Name: vorhandene Dateien bekommen „(1)“, „(2)“ …', () {
    final da = {'rechnung.pdf', 'rechnung (1).pdf', 'notiz'};
    expect(freierName('neu.pdf', da.contains), 'neu.pdf');
    expect(freierName('rechnung.pdf', da.contains), 'rechnung (2).pdf');
    expect(freierName('notiz', da.contains), 'notiz (1)');
  });

  test('Manifest: datei_ablegen nennt die Ordner, Standard zuerst, Beschreibung ≤ 300 Zeichen', () {
    final a = handyAktionen(['Alfred', 'Downloads', 'Rechnungen']);
    final d = a.firstWhere((x) => x['name'] == 'datei_ablegen');
    expect(d['autonomie'], 'auto');
    expect('${d['beschreibung']}', contains('Alfred, Downloads, Rechnungen (Standard Alfred)'));
    expect(('${d['beschreibung']}').length, lessThanOrEqualTo(300));
    final lang = handyAktionen(['Alfred', for (var i = 0; i < 40; i++) 'Ordner mit langem Namen $i']);
    expect(('${lang.firstWhere((x) => x['name'] == 'datei_ablegen')['beschreibung']}').length, lessThanOrEqualTo(300));
  });
}
