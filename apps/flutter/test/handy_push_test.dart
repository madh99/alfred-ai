import 'package:flutter_test/flutter_test.dart';
import 'package:alfred_app/handy_push.dart';

/// Phase 5 H2 — Ziel einer angetippten Mitteilung (eigener Schlüssel `alfred` der APNs-Nutzlast).
void main() {
  test('Ziel aus dem Kanal: Art Pflicht, leere Felder werden null', () {
    final z = PushZiel.ausKanal({'art': 'antwort', 'faden': 'f1', 'id': ''})!;
    expect(z.art, 'antwort');
    expect(z.faden, 'f1');
    expect(z.id, isNull);
    expect(PushZiel.ausKanal({'faden': 'f1'}), isNull);
    expect(PushZiel.ausKanal('kein map'), isNull);
    expect(PushZiel.ausKanal(null), isNull);
  });
}
