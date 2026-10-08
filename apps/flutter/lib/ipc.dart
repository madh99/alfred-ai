import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'modell.dart';

/// Anhängen an den laufenden Satelliten (Spec §8 „Anhängen statt verbinden"): 127.0.0.1 mit dem Port aus ~/.alfred/ipc.json,
/// erst `hallo` mit Geheimnis, dann JSON-Zeilen: status, ereignis, bestaetigung, konfig. Ohne Satellit keine App —
/// die App ist ein Fenster auf den CLI-Dienst, kein zweiter Satellit.
class IpcVerbindung {
  IpcVerbindung({required this.aufStatus, required this.aufEreignis, required this.aufBestaetigung, required this.aufKonfig, required this.aufZustand});

  final void Function(SatellitStatus) aufStatus;
  final void Function(String art, String text, DateTime zeit) aufEreignis;
  final void Function(Bestaetigung) aufBestaetigung;
  final void Function(Konfig) aufKonfig;
  final void Function(String) aufZustand;

  Socket? _sock;
  bool _laeuft = false;
  Timer? _neu;

  static String heim() => Platform.environment['USERPROFILE'] ?? Platform.environment['HOME'] ?? '.';
  static File datei() => File('${heim()}${Platform.pathSeparator}.alfred${Platform.pathSeparator}ipc.json');

  Future<void> start() async {
    _laeuft = true;
    await _verbinde();
  }

  void stop() {
    _laeuft = false;
    _neu?.cancel();
    _sock?.destroy();
    _sock = null;
  }

  void sende(Map<String, Object?> n) {
    try { _sock?.write('${jsonEncode(n)}\n'); } catch (_) {}
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
        aufEreignis('${n['art']}', '${n['text']}', DateTime.tryParse('${n['zeit']}') ?? DateTime.now());
      case 'bestaetigung':
        final b = n['bestaetigung'] as Map<String, dynamic>;
        aufBestaetigung(Bestaetigung(id: '${b['id']}', text: '${b['description'] ?? ''}', quelle: b['source'] as String?, seit: DateTime.tryParse('${b['createdAt'] ?? ''}')));
      case 'konfig':
        final k = n['konfig'] as Map<String, dynamic>;
        aufKonfig(Konfig(server: '${k['server']}', geraetId: '${k['geraetId']}', token: '${k['token']}', name: '${k['name']}', insecure: k['insecure'] == true, aktivierungswort: (k['aktivierungswort'] as String?)?.trim().isNotEmpty == true ? '${k['aktivierungswort']}' : 'Alfred'));
    }
  }
}
