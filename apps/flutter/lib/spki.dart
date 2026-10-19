/// Phase 5 H1 (Spec Geräte §20.4) — Schlüssel-Pinning: SHA-256 des öffentlichen Schlüssels (SubjectPublicKeyInfo) aus dem
/// DER-Zertifikat. Gepinnt wird der Schlüssel, nicht das Zertifikat: verlängert der Server sein Zertifikat mit demselben
/// Schlüssel (vor dem 23.03.2027), bleiben alle Geräte verbunden. Gleicher Wert wie
/// `openssl x509 -pubkey | openssl pkey -pubin -outform der | openssl dgst -sha256`.
library;

import 'dart:typed_data';

import 'package:crypto/crypto.dart';

class _Tlv {
  const _Tlv(this.tag, this.start, this.inhaltStart, this.ende);
  final int tag, start, inhaltStart, ende;
}

_Tlv _lies(Uint8List d, int pos) {
  if (pos + 2 > d.length) throw const FormatException('DER zu kurz');
  final tag = d[pos];
  var len = d[pos + 1];
  var p = pos + 2;
  if (len & 0x80 != 0) {
    final n = len & 0x7f;
    if (n == 0 || n > 4 || p + n > d.length) throw const FormatException('DER-Länge ungültig');
    len = 0;
    for (var i = 0; i < n; i++) { len = (len << 8) | d[p + i]; }
    p += n;
  }
  if (p + len > d.length) throw const FormatException('DER abgeschnitten');
  return _Tlv(tag, pos, p, p + len);
}

/// Rohbytes der SubjectPublicKeyInfo (Tag + Länge + Inhalt) aus einem X.509-Zertifikat im DER-Format.
Uint8List spkiBytes(Uint8List der) {
  final cert = _lies(der, 0);
  if (cert.tag != 0x30) throw const FormatException('kein Zertifikat');
  final tbs = _lies(der, cert.inhaltStart);
  if (tbs.tag != 0x30) throw const FormatException('tbsCertificate fehlt');
  var p = tbs.inhaltStart;
  var feld = _lies(der, p);
  if (feld.tag == 0xa0) { p = feld.ende; feld = _lies(der, p); } // [0] version (optional)
  // serialNumber, signature, issuer, validity, subject → danach subjectPublicKeyInfo
  for (var i = 0; i < 5; i++) { p = _lies(der, p).ende; }
  final spki = _lies(der, p);
  if (spki.tag != 0x30) throw const FormatException('subjectPublicKeyInfo fehlt');
  return Uint8List.sublistView(der, spki.start, spki.ende);
}

/// SHA-256 der SubjectPublicKeyInfo als Kleinbuchstaben-Hex (64 Zeichen).
String spkiFingerabdruck(Uint8List der) => sha256.convert(spkiBytes(der)).toString();

/// Kurzform für die Anzeige beim Koppeln: erste 4 Blöcke zu je 4 Zeichen, z. B. „75ed 3a0b c4f2 6c96“.
String fingerabdruckKurz(String hex) => [for (var i = 0; i < 16 && i < hex.length; i += 4) hex.substring(i, i + 4)].join(' ');
