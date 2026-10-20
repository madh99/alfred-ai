import 'package:alfred_app/geraet_koppeln.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('Desktop-Befehl mit Schlüssel und Kurzform', () {
    expect(koppelBefehl(server: 'https://192.168.1.92:3420', code: '12345678', fingerabdruck: '75ed3a0bc4f26c96aa'), 'alfred pair --server https://192.168.1.92:3420 --code 12345678 --insecure --schluessel 75ed3a0bc4f26c96aa');
    expect(koppelBefehl(server: 'https://s', code: '1'), 'alfred pair --server https://s --code 1 --insecure');
    expect(schluesselKurz('75ed3a0bc4f26c96aa11'), '75ed 3a0b c4f2 6c96');
  });
}
