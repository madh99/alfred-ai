import 'dart:async';
import 'dart:io';

import 'package:alfred_app/update.dart';
import 'package:alfred_app/warteschlange.dart';
import 'package:flutter_test/flutter_test.dart';

/// 1.8.0 — Warteschlange (Punkt 9) und stille Updates (Punkt 10).
void main() {
  group('Warteschlange', () {
    late Directory dir;
    setUp(() { dir = Directory.systemTemp.createTempSync('warteschlange-'); });
    tearDown(() { try { dir.deleteSync(recursive: true); } catch (_) {} });

    test('übersteht einen Neustart, Reihenfolge je Gespräch, leere Schlange löscht die Datei', () {
      final f = File('${dir.path}${Platform.pathSeparator}w.json');
      final a = Warteschlange(f)..lade();
      final eins = Wartend(text: 'eins'); final zwei = Wartend(text: 'zwei', faden: 'strom'); final drei = Wartend(text: 'drei');
      a..hinzu(eins)..hinzu(zwei)..hinzu(drei);
      final b = Warteschlange(f)..lade();
      expect(b.eintraege.map((e) => e.text), ['eins', 'zwei', 'drei']);
      expect(b.naechster(null)?.text, 'eins');
      expect(b.naechster('strom')?.text, 'zwei');
      expect(b.anzahlAusserhalb(null), 1);
      for (final e in List.of(b.eintraege)) { b.entferne(e); }
      expect(f.existsSync(), isFalse);
    });

    test('nach 24 Stunden verfallen', () {
      final w = Warteschlange(File('${dir.path}${Platform.pathSeparator}w.json'));
      final jetzt = DateTime(2026, 10, 11, 12);
      w.hinzu(Wartend(text: 'alt', zeit: jetzt.subtract(const Duration(hours: 25))));
      w.hinzu(Wartend(text: 'frisch', zeit: jetzt.subtract(const Duration(hours: 1))));
      expect(w.verfallene(jetzt: jetzt).map((e) => e.text), ['alt']);
      expect(w.eintraege.map((e) => e.text), ['frisch']);
    });

    test('defekte Datei ergibt eine leere Schlange', () {
      final f = File('${dir.path}${Platform.pathSeparator}w.json')..writeAsStringSync('{kaputt');
      expect((Warteschlange(f)..lade()).leer, isTrue);
    });
  });

  test('istVerbindungsfehler: nur wenn die Nachricht den Server sicher nicht erreicht hat', () {
    expect(istVerbindungsfehler(const SocketException('Connection refused')), isTrue);
    expect(istVerbindungsfehler(TimeoutException('x')), isTrue);
    expect(istVerbindungsfehler(const HttpException('Connection closed before full header was received')), isTrue);
    expect(istVerbindungsfehler(Exception('HTTP 503: Service Unavailable')), isTrue);
    expect(istVerbindungsfehler(const HttpException('vom Benutzer abgebrochen')), isFalse); // Stopp-Knopf
    expect(istVerbindungsfehler(Exception('HTTP 400: Missing text')), isFalse);
    expect(istVerbindungsfehler(Exception('Modell überlastet')), isFalse);
  });

  group('stillesUpdateErlaubt', () {
    final jetzt = DateTime(2026, 10, 11, 12);
    bool frage({bool an = true, bool still = true, bool antwortet = false, bool hoeren = false, bool vorne = false, Duration seit = const Duration(minutes: 30)}) =>
        stillesUpdateErlaubt(eingeschaltet: an, plattformStill: still, antwortet: antwortet, hoeren: hoeren, aufnahme: false, schnellfrage: false, imVordergrund: vorne, letzteAktivitaet: jetzt.subtract(seit), jetzt: jetzt);

    test('ruhig und im Hintergrund → ja', () => expect(frage(), isTrue));
    test('ausgeschaltet oder Linux → nein', () { expect(frage(an: false), isFalse); expect(frage(still: false), isFalse); });
    test('in Benutzung → nein', () {
      expect(frage(antwortet: true), isFalse);
      expect(frage(hoeren: true), isFalse);
      expect(frage(vorne: true), isFalse);
      expect(frage(seit: const Duration(minutes: 3)), isFalse);
    });
  });
}
