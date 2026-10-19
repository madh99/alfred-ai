/// Phase 5 H1 (Spec Geräte §20.3/20.4) — das Handy hat keinen Satelliten: es koppelt selbst (Code + Schlüssel-Pinning), merkt
/// sich die Kopplung im Schlüsselbund (iOS) bzw. Keystore (Android) und hält die WSS-Verbindung zum Gehirn nur, solange die App
/// vorne ist. Ereignisse (Nachricht, Bestätigung, Gespräch, Arbeit) gehen an dieselben Rückrufe wie beim Satelliten-IPC.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/widgets.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'ipc.dart';
import 'modell.dart';
import 'plattform.dart';
import 'spki.dart';
import 'tls.dart';

/// Kopplungsdaten (im Schlüsselbund, nie in einer Datei).
class Kopplung {
  const Kopplung({required this.server, required this.geraetId, required this.token, required this.name, required this.schluessel});
  final String server, geraetId, token, name;
  final List<String> schluessel;

  Map<String, Object> zuJson() => {'server': server, 'geraetId': geraetId, 'token': token, 'name': name, 'schluessel': schluessel};
  static Kopplung? ausJson(String? s) {
    if (s == null || s.isEmpty) return null;
    try {
      final j = jsonDecode(s) as Map<String, dynamic>;
      final pins = [for (final x in (j['schluessel'] as List? ?? const [])) '$x'].where((x) => RegExp(r'^[0-9a-f]{64}$').hasMatch(x)).toList();
      if (pins.isEmpty) return null; // ohne Schlüssel keine Verbindung (kein insecure auf dem Handy)
      return Kopplung(server: '${j['server']}', geraetId: '${j['geraetId']}', token: '${j['token']}', name: '${j['name']}', schluessel: pins);
    } catch (_) { return null; }
  }

  Konfig get konfig => Konfig(server: server, geraetId: geraetId, token: token, name: name, insecure: false, schluessel: schluessel);
}

/// Inhalt des Kopplungs-QR aus der Web-Kachel „Geräte“: {server, code, spki} (JSON). null = kein gültiger Inhalt.
({String server, String code, String? spki})? qrInhalt(String text) {
  try {
    final j = jsonDecode(text.trim()) as Map<String, dynamic>;
    final server = '${j['server'] ?? ''}'.trim();
    final code = '${j['code'] ?? ''}'.trim();
    final spki = ((j['fingerabdruck'] ?? j['spki']) as String?)?.toLowerCase(); // Spec §20.4: {server, code, fingerabdruck}
    if (!RegExp(r'^https://').hasMatch(server) || code.isEmpty) return null;
    return (server: server.replaceAll(RegExp(r'/+$'), ''), code: code, spki: spki != null && RegExp(r'^[0-9a-f]{64}$').hasMatch(spki) ? spki : null);
  } catch (_) { return null; }
}

/// Schlüssel-Fingerabdruck des Servers holen (vor der Kopplung, noch ohne Vertrauen).
Future<String> serverSchluessel(String server) async {
  final u = Uri.parse(server);
  String? fp;
  final s = await SecureSocket.connect(u.host, u.hasPort ? u.port : 443, timeout: const Duration(seconds: 8), onBadCertificate: (c) { fp = spkiFingerabdruck(c.der); return true; });
  fp ??= s.peerCertificate == null ? null : spkiFingerabdruck(s.peerCertificate!.der);
  s.destroy();
  if (fp == null) throw const HandshakeException('kein Zertifikat');
  return fp!;
}

/// Mit Code koppeln — nur über eine Verbindung, die genau den Schlüssel [spki] zeigt. Liefert die Kopplung oder wirft den Grund.
Future<Kopplung> koppeln({required String server, required String code, required String name, required String spki, required String version}) async {
  final konfig = Konfig(server: server, geraetId: '', token: '', name: name, insecure: false, schluessel: [spki]);
  final c = clientFuer(konfig);
  try {
    final req = await c.postUrl(Uri.parse('$server/api/geraete/pair')).timeout(const Duration(seconds: 15));
    req.headers.contentType = ContentType.json;
    req.add(utf8.encode(jsonEncode({'code': code, 'name': name, 'manifest': {'protokoll': 1, 'plattform': handyPlattform, 'hostname': name, 'satellitVersion': 'app-$version', 'aktionen': <Object>[], 'sinne': <Object>[]}})));
    final res = await req.close();
    final j = jsonDecode(await res.transform(utf8.decoder).join()) as Map<String, dynamic>;
    if (j['ok'] != true) throw Exception('${j['grund'] ?? 'Kopplung abgelehnt (HTTP ${res.statusCode})'}');
    return Kopplung(server: server, geraetId: '${j['id']}', token: '${j['token']}', name: '${j['name'] ?? name}', schluessel: [spki]);
  } on HandshakeException { throw Exception(zertifikatUnbekannt); }
  finally { c.close(); }
}

class HandyVerbindung implements AppVerbindung {
  HandyVerbindung({required this.aufStatus, required this.aufEreignis, required this.aufBestaetigung, required this.aufKonfig, required this.aufZustand, required this.version, FlutterSecureStorage? speicher})
      : _speicher = speicher ?? const FlutterSecureStorage();

  final void Function(SatellitStatus) aufStatus;
  final void Function(String art, String text, DateTime zeit, Anhang? anhang, String? faden) aufEreignis;
  final void Function(Bestaetigung) aufBestaetigung;
  final void Function(Konfig) aufKonfig;
  final void Function(String) aufZustand;
  final String Function() version;
  final FlutterSecureStorage _speicher;
  static const _schluessel = 'alfred_kopplung';

  Kopplung? kopplung;
  WebSocket? _ws;
  Timer? _puls, _spaeter;
  bool _laeuft = false, _vorne = true, _verbunden = false;
  AppLifecycleListener? _leben;
  int _rueckzug = 2;

  Future<Kopplung?> ladeKopplung() async { try { return Kopplung.ausJson(await _speicher.read(key: _schluessel)); } catch (_) { return null; } }
  Future<void> speichere(Kopplung k) async { await _speicher.write(key: _schluessel, value: jsonEncode(k.zuJson())); kopplung = k; }
  Future<void> vergiss() async { try { await _speicher.delete(key: _schluessel); } catch (_) {} kopplung = null; }

  @override
  Future<void> start() async {
    _laeuft = true;
    _leben ??= AppLifecycleListener(
      onResume: () { _vorne = true; _verbinde(); },
      onInactive: () {},
      onHide: () { _vorne = false; _trenne(); }, // iOS: im Hintergrund keine Verbindung (Spec §20.3) — Push weckt (H2)
    );
    kopplung ??= await ladeKopplung();
    final k = kopplung;
    if (k == null) { aufZustand('nicht gekoppelt'); return; }
    aufKonfig(k.konfig);
    await _verbinde();
  }

  /// Nach dem Koppeln: Kopplung merken und verbinden.
  Future<void> gekoppelt(Kopplung k) async { await speichere(k); aufKonfig(k.konfig); _rueckzug = 2; await _verbinde(); }

  @override
  void stop() { _laeuft = false; _trenne(); _leben?.dispose(); _leben = null; }

  void _trenne() {
    _puls?.cancel(); _puls = null; _spaeter?.cancel();
    final ws = _ws; _ws = null;
    try { ws?.close(); } catch (_) {}
    if (_verbunden) { _verbunden = false; _status(false); }
  }

  void _status(bool verbunden, [String? serverVersion]) {
    final k = kopplung;
    aufStatus(SatellitStatus(name: k?.name ?? 'Handy', version: 'app-${version()}', verbunden: verbunden, serverVersion: serverVersion));
  }

  void _sende(Map<String, Object?> n) {
    try { _ws?.add(jsonEncode({'id': '${DateTime.now().microsecondsSinceEpoch}-${Random().nextInt(1 << 30)}', 'zeit': DateTime.now().toUtc().toIso8601String(), 'version': 1, ...n})); } catch (_) {}
  }

  Future<void> _verbinde() async {
    final k = kopplung;
    if (!_laeuft || !_vorne || k == null || _ws != null) return;
    final c = clientFuer(k.konfig);
    try {
      final ws = await WebSocket.connect('${k.server.replaceFirst(RegExp('^http', caseSensitive: false), 'ws')}/api/geraete/ws', customClient: c).timeout(const Duration(seconds: 10));
      if (!_laeuft || !_vorne) { ws.close(); return; }
      _ws = ws;
      _sende({'typ': 'hallo', 'geraetId': k.geraetId, 'token': k.token, 'manifest': {'protokoll': 1, 'plattform': handyPlattform, 'hostname': k.name, 'satellitVersion': 'app-${version()}', 'aktionen': <Object>[], 'sinne': <Object>[]}});
      _puls = Timer.periodic(const Duration(seconds: 30), (_) => _sende({'typ': 'puls'}));
      ws.listen((raw) => _nachricht('$raw'), onDone: () => _getrennt(ws), onError: (_) => _getrennt(ws), cancelOnError: true);
      aufZustand('verbunden mit dem Gehirn');
    } on HandshakeException {
      aufZustand(zertifikatUnbekannt); // falscher Schlüssel: nicht im Sekundentakt wiederholen
      _spaeterVerbinden(60);
    } catch (e) {
      aufZustand('Gehirn nicht erreichbar: ${e is TimeoutException ? 'Zeitüberschreitung' : e}');
      _spaeterVerbinden(_rueckzug);
      _rueckzug = min(_rueckzug * 2, 60);
    }
  }

  void _getrennt(WebSocket ws) {
    if (_ws != ws) return;
    _ws = null; _puls?.cancel(); _puls = null;
    if (_verbunden) { _verbunden = false; _status(false); }
    if (_laeuft && _vorne) _spaeterVerbinden(_rueckzug);
  }

  void _spaeterVerbinden(int sekunden) { _spaeter?.cancel(); _spaeter = Timer(Duration(seconds: sekunden), _verbinde); }

  Future<void> _nachricht(String raw) async {
    Map<String, dynamic> n;
    try { n = jsonDecode(raw) as Map<String, dynamic>; } catch (_) { return; }
    final faden = n['faden'] is String && n['faden'] != 'haupt' ? n['faden'] as String : null;
    switch (n['typ']) {
      case 'willkommen':
        _verbunden = true; _rueckzug = 2;
        _status(true, n['serverVersion'] as String?);
        // §20.4 — angekündigter nächster Schlüssel kommt nur über diese schon geprüfte Verbindung
        final naechster = (n['naechsterSchluessel'] as String?)?.toLowerCase();
        final k = kopplung;
        if (k != null && naechster != null && RegExp(r'^[0-9a-f]{64}$').hasMatch(naechster) && !k.schluessel.contains(naechster)) {
          await speichere(Kopplung(server: k.server, geraetId: k.geraetId, token: k.token, name: k.name, schluessel: [...k.schluessel, naechster]));
        }
      case 'bestaetigung':
        final b = n['bestaetigung'];
        if (b is Map<String, dynamic>) aufBestaetigung(Bestaetigung(id: '${b['id']}', text: '${b['description'] ?? ''}', quelle: b['source'] as String?, seit: DateTime.tryParse('${b['createdAt'] ?? ''}')));
      case 'gespraech':
        aufEreignis('gespraech', '${n['von'] ?? ''}', DateTime.now(), null, faden);
      case 'arbeit':
        aufEreignis('arbeit', jsonEncode({'arbeit': n['arbeit'], 'phase': n['phase'], 'von': n['von'], 'kanal': n['kanal'], 'text': n['text'], 'frage': n['frage'], if (n['projekt'] is String) 'projekt': n['projekt']}), DateTime.now(), null, faden);
      case 'nachricht':
        Anhang? anhang;
        final a = n['anhang'];
        if (a is Map<String, dynamic> && a['base64'] is String) { try { anhang = Anhang(name: '${a['name'] ?? 'anhang'}', mime: '${a['mime'] ?? 'application/octet-stream'}', bytes: base64Decode(a['base64'] as String)); } catch (_) {} }
        final text = '${n['text'] ?? ''}';
        if (text.isNotEmpty || anhang != null) aufEreignis('nachricht', text, DateTime.now(), anhang, faden);
      case 'abgemeldet':
        await vergiss();
        _trenne();
        aufZustand('Gerät wurde abgemeldet — bitte neu koppeln');
      case 'fehler':
        aufZustand('Gehirn meldet: ${n['grund'] ?? 'Fehler'}');
    }
  }
}
