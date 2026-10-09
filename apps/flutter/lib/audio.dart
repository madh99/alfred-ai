import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:audioplayers/audioplayers.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

/// Meilenstein 2 — Mikrofon und Wiedergabe. Aufnahme als WAV 16 kHz mono (wie die Terminal-Sitzung), Wiedergabe der
/// Sprachsynthese vom Gehirn (mp3) über audioplayers.
class Audio {
  final AudioRecorder _rec = AudioRecorder();
  final AudioPlayer _player = AudioPlayer();
  String? _datei;
  StreamSubscription<Uint8List>? _strom;
  /// Wiedergabe läuft (Halbduplex beim Zuhören: dann nicht hören, sonst transkribiert Alfred sich selbst).
  bool spielt = false;

  bool get nimmtAuf => _datei != null;
  bool get hoert => _strom != null;

  /// Meilenstein 4 — Mikrofonstrom PCM 16 kHz mono 16 Bit (record.startStream), Blöcke an [aufDaten].
  Future<bool> stromStart(void Function(Uint8List) aufDaten, void Function(String) aufEnde) async {
    if (_strom != null) return true;
    if (!await _rec.hasPermission()) return false;
    final s = await _rec.startStream(const RecordConfig(encoder: AudioEncoder.pcm16bits, sampleRate: 16000, numChannels: 1));
    _strom = s.listen(aufDaten, onError: (Object e) => aufEnde('$e'), onDone: () { if (_strom != null) { _strom = null; aufEnde('Strom zu Ende'); } });
    return true;
  }

  Future<void> stromStop() async {
    final s = _strom; _strom = null;
    if (s == null) return;
    try { await s.cancel(); } catch (_) {}
    try { await _rec.stop(); } catch (_) {}
  }

  Future<bool> aufnehmen() async {
    if (_datei != null) return true;
    if (!await _rec.hasPermission()) return false;
    final dir = await getTemporaryDirectory();
    await dir.create(recursive: true); // macOS: ~/Library/Caches/<bundle> existiert beim ersten Start nicht
    final p = '${dir.path}${Platform.pathSeparator}alfred-aufnahme-${DateTime.now().millisecondsSinceEpoch}.wav';
    await _rec.start(const RecordConfig(encoder: AudioEncoder.wav, sampleRate: 16000, numChannels: 1), path: p);
    _datei = p;
    return true;
  }

  /// Beendet die Aufnahme und liefert die WAV-Bytes (leer, wenn nichts lief).
  Future<Uint8List> stop() async {
    final p = _datei;
    _datei = null;
    if (p == null) return Uint8List(0);
    final pfad = await _rec.stop() ?? p;
    try {
      final f = File(pfad);
      final b = await f.readAsBytes();
      try { await f.delete(); } catch (_) {}
      return b;
    } catch (_) { return Uint8List(0); }
  }

  Future<void> abspielen(Uint8List daten, String mime) async {
    await _player.stop();
    final fertig = _player.onPlayerStateChanged.firstWhere((s) => s == PlayerState.completed || s == PlayerState.stopped);
    spielt = true;
    // M5 (Mac 09.10.): BytesSource legt die Datei unter ~/Library/Caches/<bundle>/ ab, den Ordner gibt es beim ersten Start nicht
    // („PathNotFoundException"). Eigene Datei im Temp-Ordner, danach wieder weg.
    final dir = await getTemporaryDirectory();
    await dir.create(recursive: true); // macOS: ~/Library/Caches/<bundle> existiert beim ersten Start nicht
    final f = File('${dir.path}${Platform.pathSeparator}alfred-ton-${DateTime.now().microsecondsSinceEpoch}.${mime.contains('wav') ? 'wav' : 'mp3'}');
    await f.writeAsBytes(daten, flush: true);
    try {
      await _player.play(DeviceFileSource(f.path, mimeType: mime));
      await fertig.timeout(const Duration(minutes: 5), onTimeout: () => PlayerState.completed);
    } finally { spielt = false; try { await f.delete(); } catch (_) {} }
  }

  Future<void> abbrechen() async { try { await _player.stop(); } catch (_) {} }

  Future<void> dispose() async { try { await _rec.dispose(); } catch (_) {} try { await _player.dispose(); } catch (_) {} }
}

/// Satzgrenzen für die blockweise Sprachausgabe (wie `schneideSaetze` in der Terminal-Sitzung, v1247/v1248):
/// ab `min` Zeichen am nächsten Satzende (. ! ? :) trennen; der Rest bleibt stehen, bis mehr Text kommt.
(List<String>, String) schneideSaetze(String text, {int min = 60}) {
  final bloecke = <String>[];
  var rest = text;
  while (true) {
    Match? schnitt;
    for (final m in RegExp(r'[.!?:]["“”)]*(\s|$)').allMatches(rest)) {
      if (m.end >= min) { schnitt = m; break; }
    }
    if (schnitt == null || schnitt.end >= rest.length && !RegExp(r'\s$').hasMatch(rest) && rest.length < min * 3) break;
    bloecke.add(rest.substring(0, schnitt.end).trim());
    rest = rest.substring(schnitt.end);
    if (rest.trim().isEmpty) { rest = ''; break; }
  }
  return (bloecke, rest);
}

/// Markdown aus dem Vorlesetext entfernen (Fettdruck, Code, Aufzählungszeichen).
String sprechbar(String t) => t.replaceAll('**', '').replaceAll('`', '').replaceAll(RegExp(r'^\s*[-*•]\s+', multiLine: true), '').replaceAll(RegExp(r'^#{1,6}\s+', multiLine: true), '');

/// Blockweise vorlesen: Sätze werden synthetisiert, sobald sie vollständig sind, und der Reihe nach abgespielt;
/// der nächste Block wird schon geholt, während der vorige läuft.
class Vorleser {
  Vorleser(this.synthetisiere, this.audio, {this.beiErstemTon});
  final Future<(List<int>, String)> Function(String) synthetisiere;
  final Audio audio;
  final void Function()? beiErstemTon;
  String _puffer = '';
  Future<void> _wiedergabe = Future.value();
  int bloecke = 0;
  bool _ersterTon = false;
  String? fehler;

  void fuege(String text) {
    _puffer += text;
    final (b, rest) = schneideSaetze(_puffer);
    for (final x in b) { _spiele(x); }
    _puffer = rest;
  }

  void _spiele(String block) {
    final t = sprechbar(block).trim();
    if (t.isEmpty) return;
    bloecke++;
    final synth = synthetisiere(t);
    _wiedergabe = _wiedergabe.then((_) async {
      final (bytes, mime) = await synth;
      if (!_ersterTon) { _ersterTon = true; beiErstemTon?.call(); }
      await audio.abspielen(Uint8List.fromList(bytes), mime);
    }).catchError((e) { fehler ??= '$e'; });
  }

  /// Rest sprechen (oder den ganzen Text, wenn noch nichts lief) und auf die Wiedergabe warten.
  Future<void> schluss({String? ganzerText}) async {
    if (bloecke == 0 && ganzerText != null && ganzerText.trim().isNotEmpty) { _puffer = ''; _spiele(ganzerText); }
    else if (_puffer.trim().isNotEmpty) { _spiele(_puffer); _puffer = ''; }
    await _wiedergabe;
  }
}
