import 'dart:convert';

import 'package:alfred_app/fremde_arbeit.dart';
import 'package:flutter_test/flutter_test.dart';

/// 1.11.0 — Alfred arbeitet an einer Anfrage aus Telegram/anderem Gerät (Server v1354).
void main() {
  final t0 = DateTime(2026, 10, 11, 15);
  String e(String phase, {String von = '5060785419', String? text, String? frage, String id = 'a1'}) =>
      jsonEncode({'arbeit': id, 'phase': phase, 'von': von, 'kanal': 'Telegram', 'text': text, 'frage': frage});

  test('start → status → ende; Frage, Kanal und Faden bleiben', () {
    final m = <String, FremdeArbeit>{};
    final s = fremdeArbeitAnwenden(m, e('start', frage: 'Wie ist das Wetter?'), null, 'pc', t0);
    expect(s?.$1, 'start');
    expect(s?.$2.frage, 'Wie ist das Wetter?');
    expect(s?.$2.kanal, 'Telegram');
    expect(s?.$2.faden, isNull);
    expect(fremdeArbeitAnwenden(m, e('status', text: 'Wetter abfragen'), null, 'pc', t0)?.$2.status, 'Wetter abfragen');
    expect(fremdeArbeitAnwenden(m, e('ende'), null, 'pc', t0)?.$1, 'ende');
    expect(m, isEmpty);
    expect(fremdeArbeitAnwenden(m, e('ende'), null, 'pc', t0), isNull); // doppeltes Ende
  });

  test('eigene Anfragen dieses Geräts (auch aus einem anderen Faden) werden übergangen, fremde Geräte nicht', () {
    final m = <String, FremdeArbeit>{};
    expect(fremdeArbeitAnwenden(m, e('start', von: 'sitzung:pc:haupt'), null, 'pc', t0), isNull);
    expect(fremdeArbeitAnwenden(m, e('start', von: 'sitzung:pc:strom'), 'strom', 'pc', t0), isNull);
    expect(fremdeArbeitAnwenden(m, e('start', von: 'sitzung:mac:haupt'), null, 'pc', t0)?.$1, 'start');
  });

  test('unlesbar oder unbekannt: übergangen; hängengebliebene nach 10 min weg', () {
    final m = <String, FremdeArbeit>{};
    expect(fremdeArbeitAnwenden(m, '{kaputt', null, 'pc', t0), isNull);
    expect(fremdeArbeitAnwenden(m, e('status', text: 'x'), null, 'pc', t0), isNull);
    fremdeArbeitAnwenden(m, e('start', frage: 'q'), 'f', 'pc', t0);
    expect(fremdeArbeitAufraeumen(m, t0.add(const Duration(minutes: 9))), isFalse);
    expect(fremdeArbeitAufraeumen(m, t0.add(const Duration(minutes: 11))), isTrue);
    expect(m, isEmpty);
  });
}
