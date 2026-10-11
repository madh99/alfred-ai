import 'dart:io';
import 'dart:typed_data';

/// 1.5.0 — Anhänge aus dem Verlauf auf dem Gerät zwischenspeichern (Owner-Freigabe 11.10., Punkt 2): einmal vom Server
/// geholt, liegen sie unter `~/.alfred/anhaenge/<id>` und erscheinen beim nächsten Start sofort — auch wenn der Server
/// kurz nicht erreichbar ist. Kennungen sind die 32-stelligen Hex-Kennungen des Servers (v1347), nichts anderes wird
/// als Dateiname benutzt. Aufräumen nach derselben Frist wie am Server (Standard 30 Tage).
class AnhangSpeicher {
  AnhangSpeicher(this.verzeichnis);

  /// Standardort neben der übrigen App-Konfiguration (~/.alfred).
  factory AnhangSpeicher.standard() {
    final heim = Platform.environment['USERPROFILE'] ?? Platform.environment['HOME'] ?? '.';
    return AnhangSpeicher(Directory('$heim${Platform.pathSeparator}.alfred${Platform.pathSeparator}anhaenge'));
  }

  final Directory verzeichnis;
  static final _id = RegExp(r'^[0-9a-f]{32}$');

  File? _datei(String id) => _id.hasMatch(id) ? File('${verzeichnis.path}${Platform.pathSeparator}$id') : null;

  /// Inhalt oder null (unbekannt, ungültige Kennung, Lesefehler).
  Future<Uint8List?> lies(String id) async {
    final f = _datei(id);
    if (f == null) return null;
    try { return await f.exists() ? await f.readAsBytes() : null; } catch (_) { return null; }
  }

  /// Ablegen; Fehler (voller Datenträger, Rechte) werden geschluckt — der Speicher ist Komfort.
  Future<void> schreibe(String id, List<int> daten) async {
    final f = _datei(id);
    if (f == null) return;
    try {
      await verzeichnis.create(recursive: true);
      final tmp = File('${f.path}.tmp');
      await tmp.writeAsBytes(daten, flush: true);
      await tmp.rename(f.path); // erst vollständig, dann sichtbar (kein halbes Bild nach Absturz)
    } catch (_) {}
  }

  /// Entfernt Einträge, die älter als `tage` sind; liefert die Anzahl.
  Future<int> aufraeumen({int tage = 30, DateTime? jetzt}) async {
    var n = 0;
    final grenze = (jetzt ?? DateTime.now()).subtract(Duration(days: tage));
    try {
      if (!await verzeichnis.exists()) return 0;
      await for (final e in verzeichnis.list()) {
        if (e is! File) continue;
        final name = e.uri.pathSegments.last;
        if (!_id.hasMatch(name) && !name.endsWith('.tmp')) continue;
        try { if ((await e.lastModified()).isBefore(grenze)) { await e.delete(); n++; } } catch (_) {}
      }
    } catch (_) {}
    return n;
  }
}
