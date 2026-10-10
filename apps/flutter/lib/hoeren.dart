import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'modell.dart';

/// Meilenstein 4 — Echtzeit-Hören. Dieselbe Kette wie die Terminal-Sitzung (v1250–v1252):
/// Mikrofonstrom (PCM 16 kHz mono 16 Bit) → Satzende lokal (Lautstärke gegen Grundpegel) → Hör-Relais am Server
/// (`/api/geraete/hoeren`, WebSocket mit Gerätetoken, Mistral Realtime bleibt am Server) → Aktivierungswort → Nachricht.
/// Alles hier ist rein und deterministisch; die Schwellen sind die der CLI (`satzende.ts`, `aktivierung.ts`).

// ── Satzende ──────────────────────────────────────────────────────────────────────────────────────────────────────

sealed class SatzendeEreignis { const SatzendeEreignis(); }
class SatzStart extends SatzendeEreignis { const SatzStart(this.audio); final Uint8List audio; }
class SatzEnde extends SatzendeEreignis { const SatzEnde(this.audio, this.dauerMs); final Uint8List audio; final int dauerMs; }
class SatzVerworfen extends SatzendeEreignis { const SatzVerworfen(this.dauerMs); final int dauerMs; }

double rms16(Uint8List rahmen) {
  final n = rahmen.length ~/ 2;
  if (n == 0) return 0;
  final bd = ByteData.sublistView(rahmen);
  var summe = 0.0;
  for (var i = 0; i < n; i++) { final v = bd.getInt16(i * 2, Endian.little).toDouble(); summe += v * v; }
  return sqrt(summe / n);
}

class SatzendeErkenner {
  SatzendeErkenner({this.rate = 16000, this.rahmenMs = 20, this.startRahmen = 3, this.endeMs = 700, this.minDauerMs = 400, this.maxDauerMs = 20000, this.faktor = 3, this.mindestSchwelle = 350, this.vorlaufRahmen = 5})
      : rahmenBytes = (rate * rahmenMs ~/ 1000) * 2;
  final int rate, rahmenMs, startRahmen, endeMs, minDauerMs, maxDauerMs, vorlaufRahmen;
  final double faktor, mindestSchwelle;
  final int rahmenBytes;
  final BytesBuilder _rest = BytesBuilder(copy: false);
  double _grundpegel = 200;
  bool _aktiv = false;
  int _lauteFolge = 0, _stilleMs = 0, _dauerMs = 0;
  final List<Uint8List> _teile = [], _vorlauf = [];

  double get schwelle => max(mindestSchwelle, _grundpegel * faktor);
  bool get spricht => _aktiv;

  List<SatzendeEreignis> schiebe(Uint8List pcm) {
    final e = <SatzendeEreignis>[];
    _rest.add(pcm);
    final daten = _rest.takeBytes();
    var off = 0;
    while (daten.length - off >= rahmenBytes) {
      _verarbeite(Uint8List.fromList(daten.sublist(off, off + rahmenBytes)), e);
      off += rahmenBytes;
    }
    if (off < daten.length) _rest.add(daten.sublist(off));
    return e;
  }

  /// 1.4.1 — offene Äußerung ohne Ereignis verwerfen (Alfred beginnt zu antworten; der Rest wird nicht mehr gehört).
  void zuruecksetzen() { _aktiv = false; _lauteFolge = 0; _teile.clear(); _vorlauf.clear(); _stilleMs = 0; _dauerMs = 0; }

  List<SatzendeEreignis> schliesse() { final e = <SatzendeEreignis>[]; if (_aktiv) _beende(e); return e; }

  void _verarbeite(Uint8List rahmen, List<SatzendeEreignis> e) {
    final pegel = rms16(rahmen);
    final laut = pegel >= schwelle;
    if (!_aktiv) {
      if (laut) {
        _lauteFolge++;
        _vorlauf.add(rahmen);
        if (_lauteFolge >= startRahmen) {
          _aktiv = true; _stilleMs = 0; _dauerMs = _vorlauf.length * rahmenMs;
          _teile..clear()..addAll(_vorlauf); _vorlauf.clear();
          e.add(SatzStart(_verbinde(_teile)));
        }
      } else {
        _lauteFolge = 0;
        _grundpegel = _grundpegel * 0.95 + pegel * 0.05; // Grundpegel nur aus Ruhe lernen, träge
        _vorlauf.add(rahmen);
        if (_vorlauf.length > vorlaufRahmen) _vorlauf.removeAt(0);
      }
      return;
    }
    _teile.add(rahmen);
    _dauerMs += rahmenMs;
    _stilleMs = laut ? 0 : _stilleMs + rahmenMs;
    if (_stilleMs >= endeMs || _dauerMs >= maxDauerMs) _beende(e);
  }

  void _beende(List<SatzendeEreignis> e) {
    final audio = _verbinde(_teile);
    final gesprochenMs = max(0, _dauerMs - _stilleMs);
    _aktiv = false; _lauteFolge = 0; _teile.clear(); _vorlauf.clear(); _stilleMs = 0; _dauerMs = 0;
    if (gesprochenMs < minDauerMs) e.add(SatzVerworfen(gesprochenMs)); else e.add(SatzEnde(audio, gesprochenMs));
  }

  static Uint8List _verbinde(List<Uint8List> teile) { final b = BytesBuilder(copy: false); for (final t in teile) { b.add(t); } return b.takeBytes(); }
}

// ── Aktivierungswort ─────────────────────────────────────────────────────────────────────────────────────────────

enum AktivierungsArt { nachricht, nurWort, stopp, ignoriert }
class Aktivierung { const Aktivierung(this.art, this.text); final AktivierungsArt art; final String text; }

const stoppwoerter = ['stopp', 'stop', 'halt', 'ruhe', 'sei still', 'danke das reicht'];
const _fuellwoerter = ['hey', 'he', 'hallo', 'ok', 'okay', 'du'];

String _normalisiere(String s) => s.toLowerCase().replaceAll(RegExp('[„“"\'’.,!?;:…]+'), ' ').replaceAll(RegExp(r'\s+'), ' ').trim();

int abstand(String a, String b) {
  final m = a.length, n = b.length;
  if (m == 0) return n; if (n == 0) return m;
  var prev = List<int>.generate(n + 1, (j) => j);
  for (var i = 1; i <= m; i++) {
    final cur = List<int>.filled(n + 1, 0)..[0] = i;
    for (var j = 1; j <= n; j++) { cur[j] = [prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1)].reduce(min); }
    prev = cur;
  }
  return prev[n];
}

bool _passtWort(String token, String wort) {
  if (token == wort) return true;
  final toleranz = wort.length >= 6 ? 2 : wort.length >= 4 ? 1 : 0;
  return abstand(token, wort) <= toleranz;
}

Aktivierung pruefeAktivierung(String transkript, String aktivierungswort, bool imGespraechsfenster) {
  final norm = _normalisiere(transkript);
  if (norm.isEmpty) return const Aktivierung(AktivierungsArt.ignoriert, '');
  final wort = _normalisiere(aktivierungswort).isEmpty ? 'alfred' : _normalisiere(aktivierungswort);
  final tokens = norm.split(' ');
  var rest = norm;
  var mitWort = false;
  if (_passtWort(tokens[0], wort)) { mitWort = true; rest = tokens.sublist(1).join(' '); }
  else if (tokens.length > 1 && _fuellwoerter.contains(tokens[0]) && _passtWort(tokens[1], wort)) { mitWort = true; rest = tokens.sublist(2).join(' '); }
  if (!mitWort && !imGespraechsfenster) return Aktivierung(AktivierungsArt.ignoriert, transkript.trim());
  final restNorm = rest.trim();
  if (stoppwoerter.any((w) => restNorm == w || restNorm.startsWith('$w '))) return Aktivierung(AktivierungsArt.stopp, restNorm);
  if (mitWort && restNorm.isEmpty) return const Aktivierung(AktivierungsArt.nurWort, '');
  var original = transkript.trim();
  if (mitWort) {
    final m = RegExp(r'^(?:(?:hey|he|hallo|ok|okay|du)[\s,]+)?[^\s,.!?]+[\s,.!?]*', caseSensitive: false).firstMatch(original);
    if (m != null) original = original.substring(m.end);
    original = original.replaceFirst(RegExp(r'^[\s,.!?]+'), '');
    if (original.isNotEmpty) original = original[0].toUpperCase() + original.substring(1);
  }
  return Aktivierung(AktivierungsArt.nachricht, original);
}

// ── Relais-Client ────────────────────────────────────────────────────────────────────────────────────────────────

class HoerEreignis {
  const HoerEreignis(this.typ, {this.text, this.sekunden, this.grund});
  final String typ; // bereit | delta | fertig | fehler | limit
  final String? text; final num? sekunden; final String? grund;
}

/// Sitzung ↔ Relais: Binär = PCM; JSON {typ:start|ende|schluss}; zurück {typ:bereit|delta|fertig|fehler|limit}.
class HoerClient {
  HoerClient(this.k, this.aufEreignis, this.aufEnde);
  final Konfig k;
  final void Function(HoerEreignis) aufEreignis;
  final void Function(String grund) aufEnde;
  WebSocket? _ws;
  bool _selbstBeendet = false;

  Future<void> verbinde() async {
    final url = '${k.server.replaceFirst(RegExp('^http', caseSensitive: false), 'ws')}/api/geraete/hoeren';
    final client = HttpClient();
    if (k.insecure) client.badCertificateCallback = (cert, host, port) => true;
    final ws = await WebSocket.connect(url, headers: {'Authorization': 'Bearer ${k.token}'}, customClient: client).timeout(const Duration(seconds: 15));
    _ws = ws;
    final bereit = Completer<void>();
    ws.listen((raw) {
      if (raw is! String) return;
      Map<String, dynamic> j;
      try { j = jsonDecode(raw) as Map<String, dynamic>; } catch (_) { return; }
      final e = HoerEreignis('${j['typ']}', text: j['text'] as String?, sekunden: j['sekunden'] as num?, grund: j['grund'] as String?);
      if (e.typ == 'bereit' && !bereit.isCompleted) bereit.complete();
      aufEreignis(e);
    }, onDone: () { if (!bereit.isCompleted) bereit.completeError(StateError('Relais geschlossen (${ws.closeCode})')); else if (!_selbstBeendet) aufEnde('geschlossen (${ws.closeCode})'); },
       onError: (Object err) { if (!bereit.isCompleted) bereit.completeError(err); else if (!_selbstBeendet) aufEnde('$err'); });
    await bereit.future.timeout(const Duration(seconds: 10));
  }

  bool get offen => _ws != null && _ws!.readyState == WebSocket.open;
  void start() => _json({'typ': 'start'});
  void audio(Uint8List pcm) { if (offen) _ws!.add(pcm); }
  void ende() => _json({'typ': 'ende'});
  void schluss() { _selbstBeendet = true; _json({'typ': 'schluss'}); try { _ws?.close(); } catch (_) {} }
  void _json(Map<String, Object> n) { if (offen) _ws!.add(jsonEncode(n)); }
}

/// WAV (16 Bit, mono/stereo, beliebige Rate) → PCM 16 kHz mono; für Beweisläufe mit `--hoertest <wav>`.
Uint8List wavZuPcm16k(Uint8List wav) {
  if (wav.length < 44 || String.fromCharCodes(wav.sublist(0, 4)) != 'RIFF') throw const FormatException('keine WAV-Datei');
  final bd = ByteData.sublistView(wav);
  final rate = bd.getUint32(24, Endian.little); final kanaele = bd.getUint16(22, Endian.little);
  var daten = Uint8List.sublistView(wav, 44);
  if (kanaele == 2) {
    final m = Uint8List(daten.length ~/ 2); final q = ByteData.sublistView(daten); final o = ByteData.sublistView(m);
    for (var i = 0; i + 3 < daten.length; i += 4) { o.setInt16(i ~/ 2, ((q.getInt16(i, Endian.little) + q.getInt16(i + 2, Endian.little)) / 2).round(), Endian.little); }
    daten = m;
  }
  if (rate == 16000) return daten;
  final n = daten.length ~/ 2; final m = (n * 16000 / rate).floor(); final out = Uint8List(m * 2);
  final q = ByteData.sublistView(daten); final o = ByteData.sublistView(out);
  for (var i = 0; i < m; i++) {
    final pos = i * rate / 16000; final a = pos.floor(); final b = min(a + 1, n - 1); final f = pos - a;
    o.setInt16(i * 2, (q.getInt16(a * 2, Endian.little) * (1 - f) + q.getInt16(b * 2, Endian.little) * f).round(), Endian.little);
  }
  return out;
}

/// 1.4.0 — PCM 16 kHz mono 16 Bit → WAV (für den Ersatzweg über /api/transcribe, wenn das Relais nicht liefert).
Uint8List pcmZuWav(Uint8List pcm, {int rate = 16000}) {
  final b = ByteData(44 + pcm.length);
  void s(int o, String t) { for (var i = 0; i < t.length; i++) { b.setUint8(o + i, t.codeUnitAt(i)); } }
  s(0, 'RIFF'); b.setUint32(4, 36 + pcm.length, Endian.little); s(8, 'WAVE');
  s(12, 'fmt '); b.setUint32(16, 16, Endian.little); b.setUint16(20, 1, Endian.little); b.setUint16(22, 1, Endian.little);
  b.setUint32(24, rate, Endian.little); b.setUint32(28, rate * 2, Endian.little); b.setUint16(32, 2, Endian.little); b.setUint16(34, 16, Endian.little);
  s(36, 'data'); b.setUint32(40, pcm.length, Endian.little);
  final out = b.buffer.asUint8List(); out.setRange(44, 44 + pcm.length, pcm);
  return out;
}
