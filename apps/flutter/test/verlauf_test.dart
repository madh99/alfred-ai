import 'dart:io';

import 'package:alfred_app/anhang_speicher.dart';
import 'package:alfred_app/modell.dart';
import 'package:alfred_app/verlauf.dart';
import 'package:flutter_test/flutter_test.dart';

/// 1.5.0 — Verlaufslogik (Punkt 6), neue Antworten seit dem letzten Blick (Punkt 3), Gerätespeicher der Anhänge (Punkt 2).
void main() {
  group('eintragAusVerlauf', () {
    test('Rollen: user → du, assistant → alfred, system → Hinweis mit erster Zeile', () {
      expect(eintragAusVerlauf({'rolle': 'user', 'text': 'Hallo', 'zeit': '2026-10-11T08:00:00Z'}).art, Art.du);
      expect(eintragAusVerlauf({'rolle': 'assistant', 'text': 'Servus'}).art, Art.alfred);
      final s = eintragAusVerlauf({'rolle': 'system', 'text': 'Fortsetzung\nDetails'});
      expect(s.art, Art.hinweis);
      expect(s.text, 'ℹ Fortsetzung');
    });

    test('synthetische Freigabe-Zeile und Insights werden Hinweise', () {
      expect(eintragAusVerlauf({'rolle': 'user', 'text': 'Freigabe erteilt für das Vorhaben X'}).art, Art.hinweis);
      final i = eintragAusVerlauf({'rolle': 'assistant', 'text': '1. Strompreis morgen niedrig\n2. Backup ok', 'insight': true});
      expect(i.art, Art.hinweis);
      expect(i.text.startsWith('💡 Hinweis: Strompreis morgen niedrig'), isTrue);
    });

    test('leere Zeilen fallen weg, Zeit wird lokal', () {
      final l = eintraegeAusVerlauf([{'rolle': 'user', 'text': '  '}, {'rolle': 'assistant', 'text': 'x', 'zeit': '2026-10-11T08:00:00Z'}]);
      expect(l, hasLength(1));
      expect(l.single.zeit.isUtc, isFalse);
      expect(l.single.zeit.toUtc(), DateTime.utc(2026, 10, 11, 8));
    });
  });

  group('neueAntworten (Punkt 3)', () {
    final t0 = DateTime(2026, 10, 11, 8);
    List<Eintrag> verlauf() => [
      Eintrag(Art.du, 'Frage', zeit: t0),
      Eintrag(Art.alfred, 'alt', zeit: t0.add(const Duration(minutes: 1))),
      Eintrag(Art.hinweis, 'Hinweis', zeit: t0.add(const Duration(minutes: 5))),
      Eintrag(Art.alfred, 'neu 1', zeit: t0.add(const Duration(minutes: 10))),
      Eintrag(Art.alfred, 'neu 2', zeit: t0.add(const Duration(minutes: 11))),
    ];

    test('zählt nur Alfred-Antworten nach dem letzten Blick, ab der ersten neuen', () {
      final n = neueAntworten(verlauf(), t0.add(const Duration(minutes: 2)));
      expect(n, isNotNull);
      expect(n!.ab, 3);
      expect(n.anzahl, 2);
    });

    test('nichts Neues oder noch nie gesehen → null', () {
      expect(neueAntworten(verlauf(), t0.add(const Duration(hours: 1))), isNull);
      expect(neueAntworten(verlauf(), null), isNull);
    });

    test('neuesteAntwort', () {
      expect(neuesteAntwort(verlauf()), t0.add(const Duration(minutes: 11)));
      expect(neuesteAntwort([Eintrag(Art.du, 'x')]), isNull);
    });
  });

  group('AnhangSpeicher (Punkt 2)', () {
    late Directory dir;
    setUp(() { dir = Directory.systemTemp.createTempSync('anhaenge-'); });
    tearDown(() { try { dir.deleteSync(recursive: true); } catch (_) {} });

    test('schreiben und lesen; unbekannt → null', () async {
      final s = AnhangSpeicher(dir);
      final id = 'c' * 32;
      expect(await s.lies(id), isNull);
      await s.schreibe(id, [1, 2, 3]);
      expect(await s.lies(id), [1, 2, 3]);
      expect(dir.listSync().map((e) => e.uri.pathSegments.last), [id]); // keine .tmp-Reste
    });

    test('ungültige Kennungen (Pfad-Tricks) werden weder geschrieben noch gelesen', () async {
      final s = AnhangSpeicher(dir);
      await s.schreibe('../../boese', [1]);
      expect(await s.lies('../../boese'), isNull);
      expect(dir.listSync(), isEmpty);
    });

    test('aufraeumen entfernt nur Einträge älter als die Frist', () async {
      final s = AnhangSpeicher(dir);
      final alt = 'd' * 32, neu = 'e' * 32;
      await s.schreibe(alt, [1]); await s.schreibe(neu, [2]);
      final jetzt = DateTime.now();
      File('${dir.path}${Platform.pathSeparator}$alt').setLastModifiedSync(jetzt.subtract(const Duration(days: 31)));
      expect(await s.aufraeumen(tage: 30, jetzt: jetzt), 1);
      expect(await s.lies(alt), isNull);
      expect(await s.lies(neu), [2]);
    });
  });
}
