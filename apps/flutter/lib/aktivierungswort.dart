/// Aktivierungswort in der App (Owner-Freigabe 09.10.2026 19:30): eigenes Modell aus `tools/wakeword/`
/// (ONNX, Eingabe `pcm` float32 [1, 24000] = 1,5 s bei 16 kHz im Bereich −1…1, Ausgabe `p` = Wahrscheinlichkeit).
///
/// Dieser Baustein ist laufzeit-unabhängig: [WortModell] kapselt die Inferenz (ONNX Runtime kommt dazu, sobald das
/// Modell die Messung auf den echten Aufnahmen besteht; Tests nutzen ein Fake-Modell). [WortErkenner] bekommt den
/// Mikrofonstrom als PCM 16 kHz mono 16 Bit (wie `Audio.strom`), hält ein Ringfenster von 1,5 s, fragt das Modell
/// alle [hopMs] ab und meldet einen Treffer erst nach [treffer] aufeinanderfolgenden Fenstern über der Schwelle,
/// danach gilt eine Sperre von [sperreMs] gegen Doppelauslösung.
library;

import 'dart:async';
import 'dart:typed_data';

abstract class WortModell {
  /// Wahrscheinlichkeit 0…1, dass das Fenster das Aktivierungswort enthält.
  Future<double> wahrscheinlichkeit(Float32List pcm);
}

class WortTreffer {
  const WortTreffer(this.wahrscheinlichkeit, this.zeit);
  final double wahrscheinlichkeit;
  final DateTime zeit;
}

class WortErkenner {
  WortErkenner(this.modell, {this.schwelle = 0.7, this.hopMs = 200, this.fensterSamples = 24000, this.sperreMs = 2000, this.treffer = 2, DateTime Function()? uhr})
      : _uhr = uhr ?? DateTime.now,
        _fenster = Float32List(fensterSamples),
        _hopSamples = 16000 * hopMs ~/ 1000;

  final WortModell modell;
  final double schwelle;
  final int hopMs;
  final int fensterSamples;
  final int sperreMs;
  final int treffer;
  final DateTime Function() _uhr;

  final Float32List _fenster; // Ringfenster, _pos = Schreibposition
  int _pos = 0;
  int _gefuellt = 0;
  int _seitHop = 0;
  final int _hopSamples;
  int _folge = 0;
  /// Sperre in Audiozeit (Samples), nicht Wanduhr — sonst deckt sie beim Beweislauf (63 s Audio in 0,2 s) die ganze Datei ab (1.3.0).
  int _samples = 0;
  int _gesperrtBisSample = -1;
  bool _laeuft = false;
  int _ausgelassen = 0;

  /// Anzahl Modellabfragen (Beweisläufe, Tests).
  int abfragen = 0;
  /// Fenster, die übersprungen wurden, weil die vorige Abfrage noch lief (Modell zu langsam für den Hop).
  int get ausgelassen => _ausgelassen;

  final _treffer = StreamController<WortTreffer>.broadcast();
  Stream<WortTreffer> get treffer$ => _treffer.stream;

  /// Mikrofonblock PCM 16 Bit little-endian, 16 kHz mono.
  Future<void> verarbeite(Uint8List block) async {
    final bd = ByteData.sublistView(block);
    final n = block.length ~/ 2;
    for (var i = 0; i < n; i++) {
      _fenster[_pos] = bd.getInt16(i * 2, Endian.little) / 32768.0;
      _pos = (_pos + 1) % fensterSamples;
      if (_gefuellt < fensterSamples) _gefuellt++;
      _seitHop++; _samples++;
      if (_seitHop >= _hopSamples && _gefuellt >= fensterSamples) {
        _seitHop = 0;
        await _pruefe();
      }
    }
  }

  Future<void> _pruefe() async {
    if (_laeuft) { _ausgelassen++; return; }
    _laeuft = true;
    try {
      abfragen++;
      final p = await modell.wahrscheinlichkeit(fensterKopie()); // Modell immer füttern (es hält seinen Ring), Sperre nur für die Auslösung
      if (_samples < _gesperrtBisSample) { _folge = 0; return; }
      if (p >= schwelle) {
        _folge++;
        if (_folge >= treffer) {
          _folge = 0;
          _gesperrtBisSample = _samples + sperreMs * 16;
          _treffer.add(WortTreffer(p, _uhr()));
        }
      } else {
        _folge = 0;
      }
    } finally {
      _laeuft = false;
    }
  }

  /// Das aktuelle Fenster in zeitlicher Reihenfolge (ältestes Sample zuerst), wie das Modell es erwartet.
  Float32List fensterKopie() {
    final k = Float32List(fensterSamples);
    final erste = fensterSamples - _pos;
    k.setRange(0, erste, _fenster, _pos);
    k.setRange(erste, fensterSamples, _fenster, 0);
    return k;
  }

  void schliesse() { _treffer.close(); }
}

/// Fake-Modell für Tests und Beweisläufe ohne Laufzeit: Wahrscheinlichkeit = Energie des Fensters (RMS × [faktor]),
/// gedeckelt auf 1. Ein lauter Abschnitt im Fenster zählt damit als „Wort“.
class EnergieModell implements WortModell {
  EnergieModell({this.faktor = 10});
  final double faktor;
  @override
  Future<double> wahrscheinlichkeit(Float32List pcm) async {
    var s = 0.0;
    for (final v in pcm) { s += v * v; }
    final rms = pcm.isEmpty ? 0.0 : (s / pcm.length);
    final p = rms * faktor * faktor;
    return p > 1 ? 1 : p;
  }
}
