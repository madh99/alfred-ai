import 'dart:async';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:path_provider/path_provider.dart';

import 'server.dart';

/// Phase 4 M6 — Selbstupdate der Desktop-App über den Alfred-Server (`/api/app/update`, v1322), wie beim Satelliten:
/// Server kennt je Plattform den neuesten Installer, die App vergleicht Versionen, lädt mit Prüfsumme in den
/// Temp-Ordner und startet den Installer. Windows: Inno Setup still (/SILENT, schließt die App, startet sie neu).
/// macOS: DMG öffnen (ohne Signatur bleibt es beim Hinüberziehen). Linux: .deb über den Paketmanager öffnen.
class UpdateInfo {
  UpdateInfo({required this.plattform, required this.version, required this.datei, required this.sha256, required this.groesse, required this.url});
  final String plattform, version, datei, sha256, url;
  final int groesse;
}

String plattformName() => Platform.isWindows ? 'windows' : Platform.isMacOS ? 'macos' : 'linux';

/// Versionen wie 1.0.10 vergleichen: Zahlenfolgen numerisch (wie `vergleicheVersion` im Kern). >0 wenn a neuer.
int vergleicheVersion(String a, String b) {
  final za = RegExp(r'\d+').allMatches(a).map((m) => int.parse(m.group(0)!)).toList();
  final zb = RegExp(r'\d+').allMatches(b).map((m) => int.parse(m.group(0)!)).toList();
  for (var i = 0; i < (za.length > zb.length ? za.length : zb.length); i++) {
    final x = i < za.length ? za[i] : -1, y = i < zb.length ? zb[i] : -1;
    if (x != y) return x > y ? 1 : -1;
  }
  return a == b ? 0 : (a.compareTo(b) > 0 ? 1 : -1);
}

class AppUpdate {
  AppUpdate(this.server, this.eigeneVersion);
  final Server server;
  final String eigeneVersion;

  /// Neuere Version beim Server? null = keine oder nicht erreichbar.
  Future<UpdateInfo?> pruefe() async {
    try {
      final j = await server.json('/api/app/update?plattform=${plattformName()}');
      final v = '${j['version'] ?? ''}';
      if (v.isEmpty || vergleicheVersion(v, eigeneVersion) <= 0) return null;
      return UpdateInfo(plattform: '${j['plattform']}', version: v, datei: '${j['datei']}', sha256: '${j['sha256']}'.toLowerCase(), groesse: (j['groesse'] as num?)?.toInt() ?? 0, url: '${j['url']}');
    } catch (_) { return null; }
  }

  /// Installer in den Temp-Ordner laden, Prüfsumme prüfen, Datei zurückgeben.
  Future<File> lade(UpdateInfo u, {void Function(int, int)? fortschritt}) async {
    final dir = await getTemporaryDirectory();
    await dir.create(recursive: true);
    final f = File('${dir.path}${Platform.pathSeparator}${u.datei}');
    final res = await server.hole(u.url);
    if (res.statusCode != 200) throw Exception('HTTP ${res.statusCode} beim Laden des Installers');
    final sink = f.openWrite();
    var geladen = 0;
    final hasher = AccumulatorSink<Digest>();
    final input = sha256.startChunkedConversion(hasher);
    await for (final block in res) { sink.add(block); input.add(block); geladen += block.length; fortschritt?.call(geladen, u.groesse); }
    await sink.close();
    input.close();
    final ist = hasher.events.single.toString();
    if (ist != u.sha256) { try { await f.delete(); } catch (_) {} throw Exception('Prüfsumme stimmt nicht (erwartet ${u.sha256.substring(0, 12)}…, ist ${ist.substring(0, 12)}…)'); }
    return f;
  }

  /// Installer starten. Liefert true, wenn die App sich danach beenden soll (Windows: Setup schließt und startet sie neu).
  Future<bool> installiere(File f) async {
    if (Platform.isWindows) {
      await Process.start(f.path, ['/SILENT', '/CLOSEAPPLICATIONS', '/NORESTART'], mode: ProcessStartMode.detached);
      return true;
    }
    if (Platform.isMacOS) { await Process.start('open', [f.path], mode: ProcessStartMode.detached); return false; }
    await Process.start('xdg-open', [f.path], mode: ProcessStartMode.detached);
    return false;
  }
}

/// Kleiner Sammler für die blockweise SHA-256 (crypto bietet keinen Stream-Sink).
class AccumulatorSink<T> implements Sink<T> {
  final List<T> events = [];
  @override void add(T data) => events.add(data);
  @override void close() {}
}
