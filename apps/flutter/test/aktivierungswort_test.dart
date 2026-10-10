import 'dart:typed_data';

import 'package:alfred_app/aktivierungswort.dart';
import 'package:flutter_test/flutter_test.dart';

/// PCM-Block 16 Bit LE mit konstanter Amplitude (0…32767) und [n] Samples.
Uint8List block(int n, int amplitude) {
  final b = ByteData(n * 2);
  for (var i = 0; i < n; i++) { b.setInt16(i * 2, (i.isEven ? amplitude : -amplitude), Endian.little); }
  return b.buffer.asUint8List();
}

class FestesModell implements WortModell {
  FestesModell(this.werte);
  final List<double> werte;
  int i = 0;
  @override
  Future<double> wahrscheinlichkeit(Float32List pcm) async => werte[i++ % werte.length];
}

void main() {
  group('WortErkenner', () {
    test('fragt das Modell erst ab, wenn das Fenster voll ist, dann je Hop', () async {
      final m = FestesModell([0.0]);
      final e = WortErkenner(m, hopMs: 100); // Hop 1 600 Samples, Fenster 24 000
      await e.verarbeite(block(23999, 0));
      expect(e.abfragen, 0);
      await e.verarbeite(block(1, 0));
      expect(e.abfragen, 1, reason: 'erste Abfrage, sobald das Fenster voll ist');
      await e.verarbeite(block(1600 * 3, 0));
      expect(e.abfragen, 4, reason: 'danach eine Abfrage je Hop (100 ms = 1 600 Samples)');
    });

    test('Treffer erst nach zwei Fenstern über der Schwelle, danach Sperre in Audiozeit (nicht Wanduhr)', () async {
      final m = FestesModell([0.9]);
      final e = WortErkenner(m, hopMs: 100, treffer: 2, sperreMs: 2000);
      final treffer = <WortTreffer>[];
      e.treffer$.listen(treffer.add);
      await e.verarbeite(block(24000, 100)); // Fenster voll → Abfrage 1
      await e.verarbeite(block(1600, 100)); // Abfrage 2 → Treffer
      await Future<void>.delayed(Duration.zero);
      expect(treffer.length, 1);
      // innerhalb der Sperre (2 s = 32 000 Samples): keine weiteren Treffer, das Modell wird aber weiter gefüttert
      final vorher = e.abfragen;
      await e.verarbeite(block(1600 * 5, 100));
      await Future<void>.delayed(Duration.zero);
      expect(treffer.length, 1);
      expect(e.abfragen, vorher + 5);
      // Sperre abgelaufen (nach 32 000 Samples ab dem Treffer) → wieder zwei Fenster nötig
      await e.verarbeite(block(32000 - 1600 * 5, 100));
      await e.verarbeite(block(1600 * 2, 100));
      await Future<void>.delayed(Duration.zero);
      expect(treffer.length, 2);
    });

    test('ein einzelnes Fenster über der Schwelle löst nicht aus', () async {
      final m = FestesModell([0.95, 0.1, 0.95, 0.1]);
      final e = WortErkenner(m, hopMs: 100, treffer: 2);
      final treffer = <WortTreffer>[];
      e.treffer$.listen(treffer.add);
      await e.verarbeite(block(24000 + 1600 * 4, 100));
      await Future<void>.delayed(Duration.zero);
      expect(treffer, isEmpty);
    });

    test('fensterKopie liefert die Samples in zeitlicher Reihenfolge', () async {
      final e = WortErkenner(FestesModell([0.0]), fensterSamples: 4, hopMs: 100);
      final b = ByteData(6 * 2);
      for (var i = 0; i < 6; i++) { b.setInt16(i * 2, (i + 1) * 1000, Endian.little); }
      await e.verarbeite(b.buffer.asUint8List());
      final k = e.fensterKopie();
      expect(k.map((v) => (v * 32768).round()).toList(), [3000, 4000, 5000, 6000]);
    });

    test('EnergieModell: Stille ≈ 0, Vollaussteuerung = 1', () async {
      final m = EnergieModell();
      expect(await m.wahrscheinlichkeit(Float32List(24000)), 0);
      expect(await m.wahrscheinlichkeit(Float32List.fromList(List.filled(24000, 0.9))), 1);
    });
  });
}
