import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:alfred_app/spki.dart';

/// Phase 5 H1 — Schlüssel-Pinning: Fingerabdruck des öffentlichen Schlüssels aus dem echten Server-Zertifikat (.92, 19.10.).
/// Erwartung unabhängig mit openssl berechnet (`x509 -pubkey | pkey -pubin -outform der | dgst -sha256`), Spec §20.2.
void main() {
  final der = Uint8List.fromList(File('test/daten/server-cert.der').readAsBytesSync());

  test('SPKI-Fingerabdruck wie openssl', () {
    expect(spkiFingerabdruck(der), '75ed3a0bc4f26c967e5b0b12b637865b936cc22c852b465d86224dc0b4fe63c5');
    expect(fingerabdruckKurz(spkiFingerabdruck(der)), '75ed 3a0b c4f2 6c96');
  });

  test('kaputtes Zertifikat → FormatException statt falschem Wert', () {
    expect(() => spkiFingerabdruck(Uint8List.fromList([0x30, 0x82, 0x01])), throwsFormatException);
    expect(() => spkiFingerabdruck(Uint8List.sublistView(der, 0, 100)), throwsFormatException);
  });
}
