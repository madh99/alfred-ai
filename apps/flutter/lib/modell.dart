import 'dart:typed_data';
/// Phase 4 — Datenmodell der Desktop-App (Spec docs/specs/2026-10-07-flutter-app-phase4.md, Meilenstein 1).
/// Dieselben Begriffe wie in der Terminal-Sitzung: Verlauf, Bestätigungen, Satellitenstatus.
enum Art { du, alfred, satellit, bestaetigung, hinweis, fehler }

/// 1.1.0 — Bereiche der Oberfläche (Symbolleiste links).
enum Ansicht { chat, kacheln, hinweise, einstellungen }

class Eintrag {
  Eintrag(this.art, this.text, {DateTime? zeit, List<Anhang>? anhaenge}) : zeit = zeit ?? DateTime.now(), anhaenge = anhaenge ?? [];
  final Art art;
  String text;
  final DateTime zeit;
  /// 1.0.5 — Bilder und Dateien, die mit der Antwort kommen (Kamerafoto, Bildschirmfoto, geholte Datei).
  final List<Anhang> anhaenge;
  /// 1.2.8 — lange eigene Nachricht vom Benutzer aufgeklappt (Einklappen in main.dart `_eingeklappt`).
  bool aufgeklappt = false;
}

class Anhang {
  Anhang({required this.name, required this.mime, required this.bytes});
  final String name;
  final String mime;
  final List<int> bytes;
  bool get istBild => mime.startsWith('image/');
  /// 1.4.2 — einmal umgewandelt und wiederverwendet: eine neue Kopie je Zeichnen war für Flutter jedes Mal ein neues Bild
  /// (neu dekodiert) → das Foto flackerte, während beim Mitschreiben mehrmals pro Sekunde neu gezeichnet wurde.
  late final Uint8List daten = bytes is Uint8List ? bytes as Uint8List : Uint8List.fromList(bytes);
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

/// 1.2.8 — Anfang einer langen Nachricht für die eingeklappte Darstellung: höchstens 8 Zeilen oder 500 Zeichen.
String gekuerzt(String text) {
  final zeilen = text.split('\n');
  var t = zeilen.take(8).join('\n');
  if (t.length > 500) t = t.substring(0, 500);
  return '$t …';
}
