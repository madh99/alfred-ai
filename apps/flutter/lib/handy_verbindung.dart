/// Phase 5 H1 (Spec Geräte §20.3/20.4) — das Handy hat keinen Satelliten: es koppelt selbst (Code + Schlüssel-Pinning), merkt
/// sich die Kopplung im Schlüsselbund (iOS) bzw. Keystore (Android) und hält die WSS-Verbindung zum Gehirn nur, solange die App
/// vorne ist. Ereignisse (Nachricht, Bestätigung, Gespräch, Arbeit) gehen an dieselben Rückrufe wie beim Satelliten-IPC.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'schluesselbund.dart';
import 'handy_system.dart';

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

/// 1.54.0 — Aktionen, die das Handy anbietet (Spec Autonomie: „auto“, harmlos). Ist die App im Hintergrund, nimmt der Server
/// sie an und stellt sie per Mitteilung zu (Ablage + „Zum Kopieren antippen“).
const handyAktionen = [
  {'name': 'zwischenablage_setzen', 'beschreibung': 'Legt Text in die Zwischenablage dieses Handys („kopier mir das aufs Handy“). Ist die App im Hintergrund, kommt eine Mitteilung „Zum Kopieren antippen“.', 'autonomie': 'auto',
   'parameter': {'text': {'type': 'string', 'description': 'Text'}, 'vertraulich': {'type': 'boolean', 'description': 'true bei Passwort/Token: bleibt auf diesem Gerät, verfällt nach 2 min'}}},
];

/// 1.54.0 H3 — Server über keinen Weg erreichbar (außerhalb des Heim-WLANs ohne VPN).
const serverUnerreichbar = 'Server nicht erreichbar — außerhalb des Heim-WLANs das VPN einschalten';

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
  HandyVerbindung({required this.aufStatus, required this.aufEreignis, required this.aufBestaetigung, required this.aufKonfig, required this.aufZustand, required this.version, this.aufHinweis, Schluesselbund? speicher})
      : _speicher = speicher ?? const GeraeteSchluesselbund();

  final void Function(SatellitStatus) aufStatus;
  final void Function(String art, String text, DateTime zeit, Anhang? anhang, String? faden) aufEreignis;
  final void Function(Bestaetigung) aufBestaetigung;
  final void Function(Konfig) aufKonfig;
  /// 1.54.0 — kurzer Hinweis im Verlauf (z. B. „in die Zwischenablage gelegt“)
  final void Function(String)? aufHinweis;
  final void Function(String) aufZustand;
  final String Function() version;
  final Schluesselbund _speicher;
  static const _schluessel = 'alfred_kopplung';

  Kopplung? kopplung;
  WebSocket? _ws;
  Timer? _puls, _spaeter, _sinneTakt;
  static const _netz = MethodChannel('alfred/netz');
  bool _laeuft = false, _vorne = true, _verbunden = false;
  AppLifecycleListener? _leben;
  int _rueckzug = 2;

  Future<Kopplung?> ladeKopplung() async { try { return Kopplung.ausJson(await _speicher.lesen(_schluessel)); } catch (_) { return null; } }
  Future<void> speichere(Kopplung k) async { await _speicher.schreiben(_schluessel, jsonEncode(k.zuJson())); kopplung = k; }
  Future<void> vergiss() async { try { await _speicher.loeschen(_schluessel); } catch (_) {} kopplung = null; }

  @override
  Future<void> start() async {
    _laeuft = true;
    _netz.setMethodCallHandler((c) async { if (c.method == 'geaendert') jetztVerbinden(); return null; }); // 1.54.0 H3
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
  void stop() { _laeuft = false; _verbunden = false; _trenne(); _leben?.dispose(); _leben = null; } // beim Abbau keine Statusmeldung mehr (Oberfläche ist weg)

  void _trenne() {
    _puls?.cancel(); _puls = null; _spaeter?.cancel(); _sinneTakt?.cancel(); _sinneTakt = null;
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
      final ws = await WebSocket.connect('${k.server.replaceFirst(RegExp('^http', caseSensitive: false), 'ws')}/api/geraete/ws', customClient: c).timeout(const Duration(seconds: 6)); // 1.54.0 H3 — Mobilfunk: nicht lange hängen
      if (!_laeuft || !_vorne) { ws.close(); return; }
      _ws = ws;
      _sende({'typ': 'hallo', 'geraetId': k.geraetId, 'token': k.token, 'manifest': {'protokoll': 1, 'plattform': handyPlattform, 'hostname': k.name, 'satellitVersion': 'app-${version()}', 'aktionen': handyAktionen, 'sinne': const ['akku', 'netz', 'audio', 'fokus', 'system']}});
      _puls = Timer.periodic(const Duration(seconds: 30), (_) => _sende({'typ': 'puls'}));
      _sinneTakt?.cancel(); _sinneTakt = Timer.periodic(const Duration(seconds: 60), (_) => _sinneSenden()); // 1.54.0 — solange die App offen ist
      ws.listen((raw) => _nachricht('$raw'), onDone: () => _getrennt(ws), onError: (_) => _getrennt(ws), cancelOnError: true);
      aufZustand('verbunden mit dem Gehirn');
    } on HandshakeException {
      aufZustand(zertifikatUnbekannt); // falscher Schlüssel: nicht im Sekundentakt wiederholen
      _spaeterVerbinden(60);
    } catch (e) {
      // 1.54.0 H3 — nicht erreichbar (kein Weg ins Heimnetz) klar benennen; andere Fehler wie bisher
      aufZustand(e is TimeoutException || e is SocketException ? serverUnerreichbar : 'Gehirn nicht erreichbar: $e');
      _spaeterVerbinden(_rueckzug);
      _rueckzug = min(_rueckzug * 2, 60);
    }
  }

  void _getrennt(WebSocket ws) {
    if (_ws != ws) return;
    _ws = null; _puls?.cancel(); _puls = null;
    _sinneTakt?.cancel(); _sinneTakt = null;
    if (_verbunden) { _verbunden = false; _status(false); }
    if (_laeuft && _vorne) _spaeterVerbinden(_rueckzug);
  }

  /// 1.54.0 — Sinne des Handys, nur solange die App offen ist: Owner in der App (Leerlauf 0), Akku, Netzweg, Audio-Ausgang,
  /// Fokus, Modell, System, Speicher (als „Laufwerk“, damit „Speicher fast voll“ wie am Desktop greift).
  Future<void> _sinneSenden() async {
    if (_ws == null) return;
    final z = await handyZustand();
    final werte = <String, Object?>{'leerlaufSek': 0};
    for (final k in ['akkuProzent', 'akkuLaedt', 'netz', 'audio', 'fokus', 'modell', 'system']) { if (z[k] != null) werte[k] = z[k]; }
    final frei = z['speicherFreiGb'], gesamt = z['speicherGesamtGb'];
    if (frei is num && gesamt is num && gesamt > 0) werte['laufwerke'] = [{'name': 'Speicher', 'freiGb': frei.round(), 'gesamtGb': gesamt.round()}];
    _sende({'typ': 'sinne', 'werte': werte});
  }

  /// 1.54.0 — Aktion vom Gehirn ausführen und das Ergebnis im Format des Satelliten melden.
  Future<void> _aktion(Map<String, dynamic> n) async {
    final id = '${n['id'] ?? ''}'; final start = DateTime.now();
    final params = n['params'] is Map ? Map<String, dynamic>.from(n['params'] as Map) : <String, dynamic>{};
    Map<String, Object?> ergebnis;
    if (n['aktion'] == 'zwischenablage_setzen' && params['text'] is String && (params['text'] as String).isNotEmpty) {
      final vertraulich = params['vertraulich'] == true;
      final ok = await handyKopieren(params['text'] as String, vertraulich: vertraulich);
      ergebnis = ok ? {'success': true, 'display': 'Liegt in der Zwischenablage von ${kopplung?.name ?? 'diesem Handy'}${vertraulich ? ' (nur dieses Gerät, verfällt nach 2 min)' : ''}.'} : {'success': false, 'error': 'Zwischenablage nicht gesetzt'};
      if (ok) aufHinweis?.call('📋 Alfred hat ${vertraulich ? 'vertraulichen ' : ''}Text in die Zwischenablage gelegt.');
    } else {
      ergebnis = {'success': false, 'error': 'Aktion auf dem Handy unbekannt: ${n['aktion']}'};
    }
    _sende({'typ': 'aktion_ergebnis', 'id': id, 'zeit': DateTime.now().toUtc().toIso8601String(), 'version': 1, ...ergebnis, 'dauerMs': DateTime.now().difference(start).inMilliseconds});
  }

  /// 1.54.0 H3 — Netzwechsel (iOS-Netzwächter) oder Knopf „Erneut verbinden“: alte Verbindung sofort trennen, Wartezeit
  /// zurücksetzen und gleich neu verbinden (kurze Pause, damit ein VPN bei Bedarf zuerst steht).
  void jetztVerbinden({Duration pause = const Duration(milliseconds: 800)}) {
    if (!_laeuft || !_vorne) return;
    _rueckzug = 2; _spaeter?.cancel();
    final ws = _ws;
    if (ws != null) {
      _ws = null; _puls?.cancel(); _puls = null;
      try { ws.close(); } catch (_) {}
      if (_verbunden) { _verbunden = false; _status(false); }
    }
    aufZustand('verbinde …');
    _spaeter = Timer(pause, _verbinde);
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
        _sinneSenden(); // 1.54.0 — gleich beim Verbinden: Owner ist in der App
        // §20.4 — angekündigter nächster Schlüssel kommt nur über diese schon geprüfte Verbindung
        final naechster = (n['naechsterSchluessel'] as String?)?.toLowerCase();
        final k = kopplung;
        if (k != null && naechster != null && RegExp(r'^[0-9a-f]{64}$').hasMatch(naechster) && !k.schluessel.contains(naechster)) {
          await speichere(Kopplung(server: k.server, geraetId: k.geraetId, token: k.token, name: k.name, schluessel: [...k.schluessel, naechster]));
        }
      case 'aktion': // 1.54.0 — Aktionen des Handys (heute: zwischenablage_setzen)
        await _aktion(n);
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
