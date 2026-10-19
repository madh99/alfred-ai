import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:alfred_app/handy_verbindung.dart';
import 'package:alfred_app/kopplung.dart';

/// Phase 5 H1 — Kopplung auf dem Handy: QR-Inhalt, Schlüsselvergleich, Koppeln nur mit passendem Schlüssel.
void main() {
  const spki = '75ed3a0bc4f26c967e5b0b12b637865b936cc22c852b465d86224dc0b4fe63c5';
  final qr = jsonEncode({'server': 'https://192.168.1.92:3420/', 'code': '12345678', 'fingerabdruck': spki});

  test('QR-Inhalt: https-Server, Code, Schlüssel; Unsinn → null', () {
    final q = qrInhalt(qr)!;
    expect(q.server, 'https://192.168.1.92:3420');
    expect(q.code, '12345678');
    expect(q.spki, spki);
    expect(qrInhalt('{"server":"http://x","code":"1"}'), isNull);
    expect(qrInhalt('kein json'), isNull);
  });

  test('Kopplung im Schlüsselbund nur mit gültigem Schlüssel', () {
    const k = Kopplung(server: 'https://s', geraetId: 'g', token: 't', name: 'iPhone', schluessel: [spki]);
    expect(Kopplung.ausJson(jsonEncode(k.zuJson()))!.konfig.schluessel, [spki]);
    expect(Kopplung.ausJson(jsonEncode({...k.zuJson(), 'schluessel': ['kurz']})), isNull); // ohne Pinning keine Kopplung
  });

  Future<void> aufbauen(WidgetTester t, {required String serverSchluessel, required List<String> gekoppelt, String? automatisch}) async {
    await t.binding.setSurfaceSize(const Size(500, 1100));
    await t.pumpWidget(MaterialApp(home: KopplungsAnsicht(version: '1.52.0', automatisch: automatisch,
      schluesselHolen: (_) async => serverSchluessel,
      koppelnMit: ({required server, required code, required name, required spki, required version}) async { gekoppelt.add('$server|$code|$name|$spki'); return Kopplung(server: server, geraetId: 'g1', token: 't', name: name, schluessel: [spki]); },
      aufGekoppelt: (_) async {})));
  }

  testWidgets('QR passt: Fingerabdruck „stimmt“, Koppeln schickt Server, Code, Name und Schlüssel', (t) async {
    final gekoppelt = <String>[];
    await aufbauen(t, serverSchluessel: spki, gekoppelt: gekoppelt);
    await t.enterText(find.byKey(const Key('kopplung-qr')), qr);
    await t.enterText(find.byKey(const Key('kopplung-name')), 'iPhone Markus');
    await t.tap(find.byKey(const Key('kopplung-pruefen')));
    await t.pumpAndSettle();
    expect(find.text('75ed 3a0b c4f2 6c96'), findsOneWidget);
    expect(find.text('✓ stimmt mit dem QR überein'), findsOneWidget);
    await t.tap(find.byKey(const Key('kopplung-koppeln')));
    await t.pumpAndSettle();
    expect(gekoppelt, ['https://192.168.1.92:3420|12345678|iPhone Markus|$spki']);
  });

  testWidgets('fremder Schlüssel: Abbruch mit Klartext, kein Koppeln', (t) async {
    final gekoppelt = <String>[];
    await aufbauen(t, serverSchluessel: 'f' * 64, gekoppelt: gekoppelt);
    await t.enterText(find.byKey(const Key('kopplung-qr')), qr);
    await t.tap(find.byKey(const Key('kopplung-pruefen')));
    await t.pumpAndSettle();
    expect(find.textContaining('Server-Zertifikat unbekannt — neu koppeln'), findsOneWidget);
    expect(find.byKey(const Key('kopplung-koppeln')), findsNothing);
    expect(gekoppelt, isEmpty);
  });

  testWidgets('Beweislauf: automatisch prüfen und koppeln, Name aus dem Inhalt', (t) async {
    final gekoppelt = <String>[];
    await aufbauen(t, serverSchluessel: spki, gekoppelt: gekoppelt, automatisch: jsonEncode({...jsonDecode(qr) as Map, 'name': 'iPhone Simulator'}));
    await t.pumpAndSettle();
    expect(gekoppelt, ['https://192.168.1.92:3420|12345678|iPhone Simulator|$spki']);
  });
}
