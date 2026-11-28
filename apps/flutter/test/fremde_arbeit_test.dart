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

  test('unlesbar oder unbekannt: übergangen; hängengebliebene nach 30 min weg (1.87.0: Server-Abgleich ist maßgeblich)', () {
    final m = <String, FremdeArbeit>{};
    expect(fremdeArbeitAnwenden(m, '{kaputt', null, 'pc', t0), isNull);
    expect(fremdeArbeitAnwenden(m, e('status', text: 'x'), null, 'pc', t0), isNull);
    fremdeArbeitAnwenden(m, e('start', frage: 'q'), 'f', 'pc', t0);
    expect(fremdeArbeitAufraeumen(m, t0.add(const Duration(minutes: 29))), isFalse);
    expect(fremdeArbeitAufraeumen(m, t0.add(const Duration(minutes: 31))), isTrue);
    expect(m, isEmpty);
  });

  test('1.87.0: seit, Modell, Kosten und Runde aus den Ereignissen; Metazeile', () {
    final m = <String, FremdeArbeit>{};
    fremdeArbeitAnwenden(m, jsonEncode({'arbeit': 'a1', 'phase': 'start', 'von': 'owner:faden:infra', 'kanal': 'API', 'frage': 'Plan', 'seit': '2026-10-11T13:00:00.000Z'}), 'infra', 'pc', t0);
    fremdeArbeitAnwenden(m, jsonEncode({'arbeit': 'a1', 'phase': 'status', 'von': 'owner:faden:infra', 'text': 'Infrastruktur', 'modell': 'gpt-6.2-sol', 'kostenUsd': 1.27, 'runde': 4}), 'infra', 'pc', t0);
    final a = m['a1']!;
    expect(a.seit, DateTime.parse('2026-10-11T13:00:00.000Z').toLocal());
    expect(a.status, 'Infrastruktur');
    final zeile = arbeitMetaZeile(a, a.seit!.add(const Duration(minutes: 6, seconds: 40)));
    expect(zeile, contains('(6 min)'));
    expect(zeile, contains('gpt-6.2-sol · 1,27 \$ · Runde 4'));
  });

  test('1.87.0: Abgleich mit dem Server nimmt verpasste Läufe auf und entfernt beendete; eigene und Projekte bleiben unberührt', () {
    final m = <String, FremdeArbeit>{};
    m['alt'] = FremdeArbeit(id: 'alt', faden: null, kanal: 'Telegram', frage: 'x', zuletzt: t0);
    m['proj'] = FremdeArbeit(id: 'proj', faden: null, kanal: 'PC', frage: 'Bau', zuletzt: t0, projekt: 'p1');
    final server = [
      {'arbeit': 'neu', 'faden': 'infra', 'von': 'owner:faden:infra', 'kanal': 'API', 'frage': 'Synapse', 'seit': '2026-10-11T13:00:00.000Z', 'status': 'plant', 'modell': 'gpt-6.2-sol', 'kostenUsd': 0.5},
      {'arbeit': 'meins', 'faden': null, 'von': 'sitzung:pc:haupt', 'kanal': 'PC', 'frage': 'eigen'},
    ];
    expect(fremdeArbeitAbgleich(m, server, 'pc', t0), isTrue);
    expect(m.keys.toSet(), {'neu', 'proj'});
    expect(m['neu']!.faden, 'infra');
    expect(m['neu']!.kostenUsd, 0.5);
    expect(fremdeArbeitAbgleich(m, server, 'pc', t0), isFalse); // unverändert
    expect(fremdeArbeitAbgleich(m, 'kaputt', 'pc', t0), isFalse);
  });

  test('1.87.0: laufender Change aus dem Server-Stand', () {
    final c = LaufenderChange.aus({'id': 'f996c656-7c09', 'titel': 'Synapse', 'phase': 'laeuft', 'schritt': 12, 'schritte': 15, 'schrittSeit': '2026-10-11T13:00:00.000Z', 'zeitlimitS': 155, 'aktiv': true})!;
    expect(changeZeile(c, c.schrittSeit!.add(const Duration(seconds: 22))), 'Schritt 12/15 · seit 22 s (Limit 2 min) · läuft');
    expect(LaufenderChange.aus({'titel': 'ohne id'}), isNull);
    expect(changeZeile(LaufenderChange.aus({'id': 'x', 'phase': 'angehalten', 'schritt': 5, 'schritte': 15})!, t0), 'Schritt 5/15 · angehalten');
  });
}
