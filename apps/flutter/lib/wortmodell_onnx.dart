/// Aktivierungswort, Laufzeit (1.3.0, Owner-Ok 10.10.2026 nach Lauf 7: 89 % Treffer, 1/1 138 Fehlauslösungen, Dauerton 0/h):
/// drei ONNX-Modelle aus den Assets — Mel-Spektrogramm und Sprach-Einbettung von openWakeWord (Apache-2.0) und der
/// selbst trainierte Kopf (`tools/wakeword/oww.py`). Rechnung je Hop (80 ms = 1 280 Samples), exakt wie `tools/wakeword/ref.py`:
/// Mel über die letzten 12 640 Samples (76 Frames à 10 ms), Mel/10 + 2, Einbettung (96 Werte), Ring der letzten 16
/// Einbettungen, Kopf → Logit → Sigmoid. Das Modell ist zustandsbehaftet (Ring); [WortErkenner] ruft es alle 80 ms mit
/// seinem 1,5-s-Fenster, davon zählt nur der jüngste Teil.
library;

import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter/services.dart' show rootBundle;
import 'package:onnxruntime/onnxruntime.dart';

import 'aktivierungswort.dart';

class OnnxWortModell implements WortModell {
  OnnxWortModell._(this._mel, this._emb, this._kopf);

  static const melSamples = (76 + 3) * 160; // 12 640
  static const ring = 16;
  static bool _envBereit = false;

  final OrtSession _mel, _emb, _kopf;
  final List<Float32List> _ring = [];
  final _run = OrtRunOptions();
  int aufrufe = 0;
  int msGesamt = 0;

  /// Modelle aus den Assets laden (einmal je App-Lauf; ~2,8 MB).
  static Future<OnnxWortModell> lade() async {
    if (!_envBereit) { OrtEnv.instance.init(); _envBereit = true; }
    final opt = OrtSessionOptions()..setIntraOpNumThreads(1)..setSessionGraphOptimizationLevel(GraphOptimizationLevel.ortEnableAll);
    Future<OrtSession> s(String name) async => OrtSession.fromBuffer((await rootBundle.load('assets/wakeword/$name')).buffer.asUint8List(), opt);
    return OnnxWortModell._(await s('melspectrogram.onnx'), await s('embedding_model.onnx'), await s('oww-kopf.onnx'));
  }

  @override
  Future<double> wahrscheinlichkeit(Float32List pcm) async {
    final t0 = DateTime.now();
    // Eingabe des Mel-Modells: int16-Werte als float (−32768…32767), die letzten 12 640 Samples
    final n = math.min(melSamples, pcm.length);
    final x = Float32List(melSamples);
    for (var i = 0; i < n; i++) { x[melSamples - n + i] = pcm[pcm.length - n + i] * 32768.0; }
    final tx = OrtValueTensor.createTensorWithDataList(x, [1, melSamples]);
    final melOut = _mel.run(_run, {'input': tx});
    tx.release();
    final mel = _flach(melOut.first!.value); // 76 × 32
    for (final o in melOut) { o?.release(); }
    final m = Float32List(76 * 32);
    final frames = mel.length ~/ 32;
    for (var f = 0; f < 76; f++) { for (var k = 0; k < 32; k++) { final src = f < frames ? mel[f * 32 + k] : 0.0; m[f * 32 + k] = src / 10 + 2; } }
    final tm = OrtValueTensor.createTensorWithDataList(m, [1, 76, 32, 1]);
    final embOut = _emb.run(_run, {'input_1': tm});
    tm.release();
    final e = Float32List.fromList(_flach(embOut.first!.value));
    for (final o in embOut) { o?.release(); }
    _ring.add(e);
    if (_ring.length > ring) _ring.removeAt(0);
    double p = 0;
    if (_ring.length == ring) {
      final r = Float32List(ring * 96);
      for (var i = 0; i < ring; i++) { r.setRange(i * 96, (i + 1) * 96, _ring[i]); }
      final tr = OrtValueTensor.createTensorWithDataList(r, [1, ring, 96]);
      final out = _kopf.run(_run, {'emb': tr});
      tr.release();
      final logit = _flach(out.first!.value).first;
      for (final o in out) { o?.release(); }
      p = 1 / (1 + math.exp(-logit));
    }
    aufrufe++; msGesamt += DateTime.now().difference(t0).inMilliseconds;
    return p;
  }

  /// Ring leeren (neuer Hörlauf).
  void zuruecksetzen() => _ring.clear();

  double get msJeAufruf => aufrufe == 0 ? 0 : msGesamt / aufrufe;

  void schliesse() { _mel.release(); _emb.release(); _kopf.release(); _run.release(); }

  /// Verschachtelte Listen der Laufzeit (z. B. [1][1][76][32]) in eine flache Liste von double.
  static List<double> _flach(Object? v) {
    final out = <double>[];
    void geh(Object? x) {
      if (x is num) { out.add(x.toDouble()); }
      else if (x is List) { for (final y in x) { geh(y); } }
    }
    geh(v);
    return out;
  }
}
