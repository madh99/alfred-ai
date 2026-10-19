/// Phase 5 H2 (Spec Geräte §20.6) — Push auf dem Handy: Erlaubnis einholen, APNs-Token an den Server melden
/// (`/api/geraete/push`), Antippen einer Mitteilung öffnet die richtige Stelle. Eigener Kanal zu iOS (AppDelegate.swift),
/// kein Plugin — wie beim Schlüsselbund bleiben die Desktop-Builds unberührt.
library;

import 'package:flutter/services.dart';

/// Was eine angetippte Mitteilung öffnen soll (eigener Schlüssel `alfred` der APNs-Nutzlast).
class PushZiel {
  const PushZiel({required this.art, this.id, this.faden});
  /// bestaetigung | hinweis | antwort
  final String art;
  final String? id;
  final String? faden;

  static PushZiel? ausKanal(Object? a) {
    if (a is! Map) return null;
    final art = a['art'];
    if (art is! String || art.isEmpty) return null;
    String? text(Object? v) => v is String && v.isNotEmpty ? v : null;
    return PushZiel(art: art, id: text(a['id']), faden: text(a['faden']));
  }
}

class HandyPush {
  HandyPush({required this.aufToken, required this.aufGeoeffnet}) {
    _kanal.setMethodCallHandler((c) async {
      if (c.method == 'token' && c.arguments is Map) {
        final m = c.arguments as Map;
        final t = m['token'], u = m['umgebung'];
        if (t is String && u is String) await aufToken(t, u);
      } else if (c.method == 'geoeffnet') {
        final z = PushZiel.ausKanal(c.arguments);
        if (z != null) aufGeoeffnet(z);
      }
      return null;
    });
  }

  static const _kanal = MethodChannel('alfred/push');
  /// neues oder unverändertes Token (sandbox für Debug-Builds, production für TestFlight)
  final Future<void> Function(String token, String umgebung) aufToken;
  final void Function(PushZiel ziel) aufGeoeffnet;

  /// Erlaubnis erfragen (iOS fragt nur beim ersten Mal) und für Mitteilungen anmelden; `false` = abgelehnt.
  Future<bool> anmelden() async {
    try { return await _kanal.invokeMethod<bool>('anmelden') ?? false; } on MissingPluginException { return false; }
  }

  /// Wurde die App durch Antippen einer Mitteilung gestartet? Dann einmalig das Ziel.
  Future<PushZiel?> startZiel() async {
    try { return PushZiel.ausKanal(await _kanal.invokeMethod<Object?>('startZiel')); } on MissingPluginException { return null; }
  }
}
