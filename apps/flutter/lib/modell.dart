/// Phase 4 — Datenmodell der Desktop-App (Spec docs/specs/2026-10-07-flutter-app-phase4.md, Meilenstein 1).
/// Dieselben Begriffe wie in der Terminal-Sitzung: Verlauf, Bestätigungen, Satellitenstatus.
enum Art { du, alfred, satellit, bestaetigung, hinweis, fehler }

class Eintrag {
  Eintrag(this.art, this.text, {DateTime? zeit}) : zeit = zeit ?? DateTime.now();
  final Art art;
  String text;
  final DateTime zeit;
}

class Bestaetigung {
  Bestaetigung({required this.id, required this.text, this.quelle, this.seit});
  final String id;
  final String text;
  final String? quelle;
  final DateTime? seit;
}

class SatellitStatus {
  SatellitStatus({required this.name, required this.version, required this.verbunden, this.serverVersion, this.aktionenLaufend = 0});
  final String name;
  final String version;
  final bool verbunden;
  final String? serverVersion;
  final int aktionenLaufend;
}

class Konfig {
  Konfig({required this.server, required this.geraetId, required this.token, required this.name, required this.insecure, this.aktivierungswort = 'Alfred'});
  final String server;
  final String geraetId;
  final String token;
  final String name;
  final bool insecure;
  /// Meilenstein 4 — Wort, mit dem eine Äußerung an Alfred beginnt (GeraetKonfig.aktivierungswort, v1309).
  final String aktivierungswort;
}
