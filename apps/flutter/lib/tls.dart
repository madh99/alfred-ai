/// Phase 5 H1 — eine Stelle für die TLS-Prüfung aller Verbindungen zum Gehirn (HTTPS, SSE, WSS, Hören, Transfer).
/// Mit gemerkten Schlüsseln (Handy, später auch Desktop, Spec §20.9 Punkt 4): nur ein Zertifikat mit genau diesem öffentlichen
/// Schlüssel. Ohne gemerkte Schlüssel wie bisher: `insecure` nimmt das selbst signierte Zertifikat des Servers an.
library;

import 'dart:io';

import 'modell.dart';
import 'spki.dart';

/// true = Zertifikat annehmen. Wird nur aufgerufen, wenn die normale Prüfung scheitert (selbst signiert).
bool zertifikatErlaubt(X509Certificate cert, Konfig k) {
  if (k.schluessel.isNotEmpty) {
    try { return k.schluessel.contains(spkiFingerabdruck(cert.der)); } catch (_) { return false; }
  }
  return k.insecure;
}

HttpClient clientFuer(Konfig k) {
  final c = HttpClient();
  c.badCertificateCallback = (cert, host, port) => zertifikatErlaubt(cert, k);
  return c;
}

/// Klartext, wenn ein gepinntes Gerät ein fremdes Zertifikat sieht (Spec §20.4).
const zertifikatUnbekannt = 'Server-Zertifikat unbekannt — neu koppeln';
