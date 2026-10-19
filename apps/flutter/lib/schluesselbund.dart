/// Phase 5 H1 (Spec Geräte §20.4) — Kopplung im Schlüsselbund des Handys. Eigener Kanal zum iOS-Schlüsselbund
/// (ios/Runner/AppDelegate.swift) statt Plugin: ein Plugin brächte Windows (ATL) und Linux (libsecret) neue Bauabhängigkeiten,
/// obwohl der Desktop den Schlüsselbund nicht braucht. Android (H4) bekommt denselben Kanal über den Keystore.
library;

import 'package:flutter/services.dart';

abstract class Schluesselbund {
  Future<String?> lesen(String schluessel);
  Future<void> schreiben(String schluessel, String wert);
  Future<void> loeschen(String schluessel);
}

class GeraeteSchluesselbund implements Schluesselbund {
  const GeraeteSchluesselbund();
  static const _kanal = MethodChannel('alfred/schluesselbund');

  @override
  Future<String?> lesen(String schluessel) => _kanal.invokeMethod<String>('lesen', {'schluessel': schluessel});

  @override
  Future<void> schreiben(String schluessel, String wert) async {
    final ok = await _kanal.invokeMethod<bool>('schreiben', {'schluessel': schluessel, 'wert': wert});
    if (ok != true) throw Exception('Schlüsselbund: Speichern fehlgeschlagen');
  }

  @override
  Future<void> loeschen(String schluessel) => _kanal.invokeMethod<bool>('loeschen', {'schluessel': schluessel});
}
