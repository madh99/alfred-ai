import 'dart:math';
import 'dart:typed_data';

import 'package:alfred_app/audio.dart';
import 'package:alfred_app/hoeren.dart';
import 'package:flutter_test/flutter_test.dart';

/// PCM-Rahmen: `ms` Millisekunden Stille (leises Rauschen) oder Ton mit Amplitude `amp`.
Uint8List pcm(int ms, {int amp = 0}) {
  final n = 16 * ms;
  final b = ByteData(n * 2);
  final r = Random(7);
  for (var i = 0; i < n; i++) {
    final v = amp == 0 ? r.nextInt(60) - 30 : (amp * sin(i / 16000 * 2 * pi * 440)).round();
    b.setInt16(i * 2, v, Endian.little);
  }
  return b.buffer.asUint8List();
}

void main() {
  group('SatzendeErkenner (Portierung satzende.ts)', () {
    test('Stille liefert nichts; Ton beginnt eine Äußerung, 700 ms Ruhe beenden sie', () {
      final e = SatzendeErkenner();
      expect(e.schiebe(pcm(500)), isEmpty);
      final start = e.schiebe(pcm(1000, amp: 8000));
      expect(start.whereType<SatzStart>().length, 1);
      expect(e.spricht, isTrue);
      final ende = e.schiebe(pcm(800));
      final s = ende.whereType<SatzEnde>().single;
      expect(e.spricht, isFalse);
      expect(s.dauerMs, inInclusiveRange(900, 1200));
      expect(s.audio.length, greaterThan(16 * 2 * 1000));
    });

    test('zu kurze Äußerung (unter 400 ms) wird verworfen', () {
      final e = SatzendeErkenner();
      e.schiebe(pcm(300));
      final ev = [...e.schiebe(pcm(200, amp: 8000)), ...e.schiebe(pcm(800))];
      expect(ev.whereType<SatzVerworfen>().length, 1);
      expect(ev.whereType<SatzEnde>(), isEmpty);
    });

    test('schliesse() beendet eine laufende Äußerung', () {
      final e = SatzendeErkenner();
      e.schiebe(pcm(1000, amp: 8000));
      expect(e.schliesse().whereType<SatzEnde>().length, 1);
    });

    test('1.4.1 zuruecksetzen() verwirft die laufende Äußerung ohne Ereignis, die nächste beginnt neu', () {
      final e = SatzendeErkenner();
      e.schiebe(pcm(500));
      expect(e.schiebe(pcm(1000, amp: 8000)).whereType<SatzStart>().length, 1);
      e.zuruecksetzen();
      expect(e.spricht, isFalse);
      expect(e.schiebe(pcm(800)), isEmpty); // kein SatzEnde der verworfenen Äußerung
      expect(e.schiebe(pcm(1000, amp: 8000)).whereType<SatzStart>().length, 1);
    });
  });

  group('pruefeAktivierung (Portierung aktivierung.ts)', () {
    test('Wort am Anfang → Nachricht ohne das Wort, groß begonnen', () {
      final a = pruefeAktivierung('Alfred, wie spät ist es?', 'Alfred', false);
      expect(a.art, AktivierungsArt.nachricht);
      expect(a.text, 'Wie spät ist es?');
    });
    test('Transkriptionsvariante und Füllwort werden toleriert', () {
      expect(pruefeAktivierung('Alfried mach das Licht an', 'Alfred', false).art, AktivierungsArt.nachricht);
      expect(pruefeAktivierung('Hey Alfred, danke', 'Alfred', false).text, 'Danke');
    });
    test('ohne Wort außerhalb des Gesprächsfensters ignoriert, innerhalb angenommen', () {
      expect(pruefeAktivierung('Wie spät ist es?', 'Alfred', false).art, AktivierungsArt.ignoriert);
      expect(pruefeAktivierung('Wie spät ist es?', 'Alfred', true).art, AktivierungsArt.nachricht);
    });
    test('Stoppwort und nur das Wort', () {
      expect(pruefeAktivierung('Alfred stopp', 'Alfred', false).art, AktivierungsArt.stopp);
      expect(pruefeAktivierung('Alfred!', 'Alfred', false).art, AktivierungsArt.nurWort);
    });
  });

  group('Sprachausgabe-Blöcke', () {
    test('schneideSaetze trennt ab 60 Zeichen am Satzende und lässt den Rest stehen', () {
      final (b, rest) = schneideSaetze('Das ist der erste Satz, der etwas länger ist als sechzig Zeichen. Und hier beginnt der zweite');
      expect(b.length, 1);
      expect(rest, startsWith('Und hier'));
    });
  });

  test('wavZuPcm16k: 8-kHz-Mono-WAV wird verdoppelt', () {
    final daten = pcm(100, amp: 1000); // 1600 Abtastwerte
    final kopf = ByteData(44);
    void str(int o, String s) { for (var i = 0; i < s.length; i++) { kopf.setUint8(o + i, s.codeUnitAt(i)); } }
    str(0, 'RIFF'); kopf.setUint32(4, 36 + daten.length, Endian.little); str(8, 'WAVE'); str(12, 'fmt ');
    kopf.setUint32(16, 16, Endian.little); kopf.setUint16(20, 1, Endian.little); kopf.setUint16(22, 1, Endian.little);
    kopf.setUint32(24, 8000, Endian.little); kopf.setUint32(28, 16000, Endian.little); kopf.setUint16(32, 2, Endian.little); kopf.setUint16(34, 16, Endian.little);
    str(36, 'data'); kopf.setUint32(40, daten.length, Endian.little);
    final wav = Uint8List.fromList([...kopf.buffer.asUint8List(), ...daten]);
    expect(wavZuPcm16k(wav).length, daten.length * 2);
  });

  test('pcmZuWav (1.4.0): 16-kHz-WAV hin und zurück ergibt dieselben Abtastwerte', () {
    final daten = pcm(200, amp: 1234);
    final wav = pcmZuWav(daten);
    expect(wav.length, 44 + daten.length);
    expect(String.fromCharCodes(wav.sublist(0, 4)), 'RIFF');
    expect(wavZuPcm16k(wav), daten);
  });
}
