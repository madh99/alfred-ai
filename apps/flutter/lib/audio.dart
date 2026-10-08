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

  bool get nimmtAuf => _datei != null;

  Future<bool> aufnehmen() async {
    if (_datei != null) return true;
    if (!await _rec.hasPermission()) return false;
    final dir = await getTemporaryDirectory();
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
    await _player.play(BytesSource(daten, mimeType: mime));
    await fertig.timeout(const Duration(minutes: 5), onTimeout: () => PlayerState.completed);
  }

  Future<void> abbrechen() async { try { await _player.stop(); } catch (_) {} }

  Future<void> dispose() async { try { await _rec.dispose(); } catch (_) {} try { await _player.dispose(); } catch (_) {} }
}
