import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'modell.dart';

/// Anhängen an den laufenden Satelliten (Spec §8 „Anhängen statt verbinden"): 127.0.0.1 mit dem Port aus ~/.alfred/ipc.json,
/// erst `hallo` mit Geheimnis, dann JSON-Zeilen: status, ereignis, bestaetigung, konfig. Ohne Satellit keine App —
/// die App ist ein Fenster auf den CLI-Dienst, kein zweiter Satellit.
/// Phase 5 H1 — gemeinsame Schnittstelle: Desktop über den Satelliten (IPC), Handy direkt (handy_verbindung.dart).
abstract class AppVerbindung {
  Future<void> start();
  void stop();
}

class IpcVerbindung implements AppVerbindung {
  IpcVerbindung({required this.aufStatus, required this.aufEreignis, required this.aufBestaetigung, required this.aufKonfig, required this.aufZustand});

  final void Function(SatellitStatus) aufStatus;
  final void Function(String art, String text, DateTime zeit, Anhang? anhang, String? faden) aufEreignis;
  final void Function(Bestaetigung) aufBestaetigung;
  final void Function(Konfig) aufKonfig;
  final void Function(String) aufZustand;

  Socket? _sock;
  bool _laeuft = false;
  Timer? _neu;

  static String heim() => Platform.environment['USERPROFILE'] ?? Platform.environment['HOME'] ?? '.';
  static File datei() => File('${heim()}${Platform.pathSeparator}.alfred${Platform.pathSeparator}ipc.json');

  @override
  Future<void> start() async {
    _laeuft = true;
    await _verbinde();
  }

  @override
  void stop() {
    _laeuft = false;
    _neu?.cancel();
    _sock?.destroy();
    _sock = null;
  }

  void sende(Map<String, Object?> n) {
    try { _sock?.write('${jsonEncode(n)}\n'); } catch (_) {}
  }

  /// 1.59.0 (v1529) — Ablage-Ordner des Satelliten lesen (`arg` null) oder ändern („+ pfad“, „- pfad“). Nur lokal über IPC —
  /// aus dem Chat lässt sich die Liste nicht ändern. Ergebnis: wirksame Ordner und, beim Ändern, die Meldung des Satelliten.
  Completer<Map<String, dynamic>>? _einstellungen;
  Future<({List<String> ordner, bool ok, String? text})> ablageOrdner({String? arg}) async {
    if (_sock == null) throw StateError('Satellit nicht verbunden');
    final c = _einstellungen = Completer<Map<String, dynamic>>();
    sende(arg == null ? {'typ': 'befehl', 'befehl': 'einstellungen'} : {'typ': 'befehl', 'befehl': 'einstellung', 'schluessel': 'ablage', 'arg': arg});
    final n = await c.future.timeout(const Duration(seconds: 5), onTimeout: () => throw StateError('Satellit antwortet nicht — Update des Satelliten abwarten'));
    final liste = (n['liste'] as List<dynamic>? ?? const []).whereType<Map<String, dynamic>>();
    final a = liste.where((e) => e['schluessel'] == 'ablage').firstOrNull;
    if (a == null) throw StateError('Satellit kennt die Ablage-Ordner noch nicht — Update des Satelliten abwarten');
    return (ordner: [for (final x in (a['eintraege'] as List<dynamic>? ?? const [])) '$x'], ok: n['ok'] != false, text: n['text'] as String?);
  }

  Future<void> _verbinde() async {
    if (!_laeuft) return;
    try {
      final f = datei();
      if (!f.existsSync()) { aufZustand('Satellit nicht gestartet (keine ipc.json) — alfred satellit --install'); _spaeter(); return; }
      final info = jsonDecode(f.readAsStringSync()) as Map<String, dynamic>;
      final port = info['port'] as int;
      final geheimnis = info['geheimnis'] as String;
      final sock = await Socket.connect('127.0.0.1', port, timeout: const Duration(seconds: 2));
      _sock = sock;
      sock.write('${jsonEncode({'typ': 'befehl', 'befehl': 'hallo', 'geheimnis': geheimnis})}\n');
      sock.write('${jsonEncode({'typ': 'befehl', 'befehl': 'konfig'})}\n');
      aufZustand('angehängt über IPC');
      sock.cast<List<int>>().transform(utf8.decoder).transform(const LineSplitter()).listen(_zeile, onDone: _getrennt, onError: (_) => _getrennt());
    } catch (e) {
      aufZustand('Satellit nicht erreichbar: $e');
      _spaeter();
    }
  }

  void _getrennt() {
    _sock = null;
    if (!_laeuft) return;
    aufZustand('Verbindung zum Satelliten beendet — neuer Versuch');
    _spaeter();
  }

  void _spaeter() {
    _neu?.cancel();
    _neu = Timer(const Duration(seconds: 3), _verbinde);
  }

  void _zeile(String zeile) {
    if (zeile.trim().isEmpty) return;
    Map<String, dynamic> n;
    try { n = jsonDecode(zeile) as Map<String, dynamic>; } catch (_) { return; }
    switch (n['typ']) {
      case 'status':
        final s = n['status'] as Map<String, dynamic>;
        aufStatus(SatellitStatus(name: '${s['name']}', version: '${s['version']}', verbunden: s['verbunden'] == true, serverVersion: s['serverVersion'] as String?, aktionenLaufend: (s['aktionenLaufend'] as num?)?.toInt() ?? 0));
      case 'ereignis':
        // 1.0.3 — der Satellit schickt UTC („…Z"); ohne toLocal() stand im Verlauf 11:44 statt 13:44 (Realfall Mac 09.10.)
        Anhang? anhang;
        final a = n['anhang'];
        if (a is Map<String, dynamic> && a['base64'] is String) { try { anhang = Anhang(name: '${a['name'] ?? 'anhang'}', mime: '${a['mime'] ?? 'application/octet-stream'}', bytes: base64Decode(a['base64'] as String)); } catch (_) { anhang = null; } } // 1.0.5
        aufEreignis('${n['art']}', '${n['text']}', DateTime.tryParse('${n['zeit']}')?.toLocal() ?? DateTime.now(), anhang, n['faden'] is String && n['faden'] != 'haupt' ? n['faden'] as String : null); // 1.2.0 faden; 1.4.1 „haupt" = Hauptgespräch (Realfall 10.10. 22:49: Foto als „Antwort im Gespräch haupt" statt im Chat)
      case 'bestaetigung':
        final b = n['bestaetigung'] as Map<String, dynamic>;
        aufBestaetigung(Bestaetigung(id: '${b['id']}', text: '${b['description'] ?? ''}', quelle: b['source'] as String?, seit: DateTime.tryParse('${b['createdAt'] ?? ''}')));
      case 'einstellungen': // 1.59.0 (v1529)
        final c = _einstellungen; _einstellungen = null;
        if (c != null && !c.isCompleted) c.complete(n);
      case 'konfig':
        final k = n['konfig'] as Map<String, dynamic>;
        aufKonfig(Konfig(server: '${k['server']}', geraetId: '${k['geraetId']}', token: '${k['token']}', name: '${k['name']}', insecure: k['insecure'] == true, schluessel: [for (final x in (k['schluessel'] as List<dynamic>? ?? const [])) '$x'], aktivierungswort: (k['aktivierungswort'] as String?)?.trim().isNotEmpty == true ? '${k['aktivierungswort']}' : 'Alfred'));
    }
  }
}
