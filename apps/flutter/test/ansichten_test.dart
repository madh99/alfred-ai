import 'package:alfred_app/aufgaben.dart';
import 'package:alfred_app/gedaechtnis.dart';
import 'package:alfred_app/vorgaenge.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// 1.9.0 — A1 Aufgaben & Erinnerungen, A3 Gedächtnis, A4 Vorgänge mit Entscheidung (Server v1353).
class Aufruf {
  Aufruf(this.pfad, this.methode, this.koerper);
  final String pfad, methode;
  final Map<String, dynamic>? koerper;
  @override
  String toString() => '$methode $pfad ${koerper ?? ''}';
}

void main() {
  // Sonntag 11.10.2026, 14:00 lokal
  final jetzt = DateTime(2026, 10, 11, 14);
  Aufgabe a(String id, {DateTime? faellig, String prio = 'normal'}) => Aufgabe({'id': id, 'titel': id, 'prioritaet': prio, 'faellig': faellig?.toUtc().toIso8601String(), 'liste': 'default'});

  group('Aufgaben — Hilfsfunktionen', () {
    test('Gruppen: überfällig erst ab gestern, heute bleibt heute, Woche endet Sonntag', () {
      expect(aufgabenGruppe(a('x'), jetzt), 'Ohne Termin');
      expect(aufgabenGruppe(a('x', faellig: DateTime(2026, 10, 10, 23)), jetzt), 'Überfällig');
      expect(aufgabenGruppe(a('x', faellig: DateTime(2026, 10, 11, 0)), jetzt), 'Heute'); // reine Datumsaufgabe
      expect(aufgabenGruppe(a('x', faellig: DateTime(2026, 10, 12, 9)), jetzt), 'Morgen');
      expect(aufgabenGruppe(a('x', faellig: DateTime(2026, 10, 14, 9)), DateTime(2026, 10, 12, 8)), 'Diese Woche');
      expect(aufgabenGruppe(a('x', faellig: DateTime(2026, 10, 19, 9)), DateTime(2026, 10, 12, 8)), 'Später');
      expect(aufgabenFaellig([a('1', faellig: DateTime(2026, 10, 9)), a('2', faellig: DateTime(2026, 10, 11, 18)), a('3'), a('4', faellig: DateTime(2026, 10, 13))], jetzt), 2);
    });

    test('verschieben: morgen 9:00, nächste Woche = Montag 9:00', () {
      expect(verschiebeZiel('morgen', jetzt), DateTime(2026, 10, 12, 9));
      expect(verschiebeZiel('woche', jetzt), DateTime(2026, 10, 12, 9)); // Sonntag → morgen ist Montag
      expect(verschiebeZiel('woche', DateTime(2026, 10, 14, 10)), DateTime(2026, 10, 19, 9));
    });

    test('Erinnerungen: bekannt bis gemeldet, gelöschte künftige weg, nichts Altes nachmelden', () {
      Erinnerung e(String id, DateTime z) => Erinnerung({'id': id, 'text': 'T$id', 'zeit': z.toUtc().toIso8601String()});
      final bekannt = <String, Erinnerung>{};
      erinnerungenAbgleichen(bekannt, [e('1', DateTime(2026, 10, 11, 14, 1)), e('2', DateTime(2026, 10, 11, 15))], jetzt);
      expect(faelligeErinnerungen(bekannt.values.toList(), jetzt, {}), isEmpty);
      // 14:02 — Server hat 1 ausgelöst (nicht mehr in der Liste), 2 wurde gelöscht
      final spaeter = DateTime(2026, 10, 11, 14, 2);
      erinnerungenAbgleichen(bekannt, [], spaeter);
      expect(bekannt.keys, ['1']);
      expect(faelligeErinnerungen(bekannt.values.toList(), spaeter, {}).map((x) => x.id), ['1']);
      expect(faelligeErinnerungen(bekannt.values.toList(), spaeter, {'1'}), isEmpty);
      erinnerungenAbgleichen(bekannt, [], DateTime(2026, 10, 11, 14, 40));
      expect(bekannt, isEmpty);
    });
  });

  testWidgets('Aufgaben: gruppiert, abhaken mit Rückgängig, anlegen, Erinnerung löschen', (t) async {
    final aufrufe = <Aufruf>[];
    List<Aufgabe>? stand;
    await t.binding.setSurfaceSize(const Size(1000, 1400));
    await t.pumpWidget(MaterialApp(home: Scaffold(body: Aufgaben(
      jetzt: () => jetzt,
      json: (p, {methode = 'GET', koerper}) async {
        aufrufe.add(Aufruf(p, methode, koerper));
        if (p == '/api/geraete/aufgaben' && methode == 'GET') {
          return {'aufgaben': [
            {'id': 'a1', 'titel': 'Steuer abgeben', 'prioritaet': 'high', 'faellig': '2026-10-09T08:00:00.000Z', 'liste': 'default'},
            {'id': 'a2', 'titel': 'Milch kaufen', 'prioritaet': 'normal', 'liste': 'Einkauf'},
          ], 'erinnerungen': [{'id': 'r1', 'text': 'Anrufen', 'zeit': '2026-10-12T07:00:00.000Z'}]};
        }
        return {'ok': true};
      },
      aufMeldung: (_) {},
      aufStand: (a, _) => stand = a,
    ))));
    await t.pumpAndSettle();
    expect(stand, hasLength(2));
    expect(find.text('Überfällig (1)'), findsOneWidget);
    expect(find.text('Ohne Termin (1)'), findsOneWidget);
    expect(find.text('Anrufen'), findsOneWidget);

    await t.tap(find.byType(Checkbox).first);
    await t.pumpAndSettle();
    expect(aufrufe.any((x) => x.pfad == '/api/geraete/aufgaben/a1' && x.koerper?['erledigt'] == true), isTrue);
    await t.tap(find.text('Rückgängig'));
    await t.pumpAndSettle();
    expect(aufrufe.any((x) => x.pfad == '/api/geraete/aufgaben/a1' && x.koerper?['erledigt'] == false), isTrue);

    await t.enterText(find.byType(TextField).first, 'Neue Sache');
    await t.testTextInput.receiveAction(TextInputAction.done);
    await t.pumpAndSettle();
    expect(aufrufe.where((x) => x.pfad == '/api/geraete/aufgaben' && x.methode == 'POST').single.koerper, {'titel': 'Neue Sache'});

    await t.tap(find.byTooltip('Löschen'));
    await t.pumpAndSettle();
    await t.tap(find.widgetWithText(FilledButton, 'Löschen'));
    await t.pumpAndSettle();
    expect(aufrufe.any((x) => x.pfad == '/api/geraete/erinnerungen/r1' && x.methode == 'DELETE'), isTrue);
    await t.binding.setSurfaceSize(null);
  });

  testWidgets('Gedächtnis: Typ-Filter, Korrigieren und Löschen fragen den Server', (t) async {
    final aufrufe = <Aufruf>[];
    final meldungen = <String>[];
    await t.binding.setSurfaceSize(const Size(1000, 1200));
    await t.pumpWidget(MaterialApp(home: Scaffold(body: Gedaechtnis(
      json: (p, {methode = 'GET', koerper}) async {
        aufrufe.add(Aufruf(p, methode, koerper));
        if (methode == 'GET') {
          return {'eintraege': [
            {'id': 'm1', 'schluessel': 'wohnort', 'text': 'Wohnt in Linz', 'typ': 'fact', 'quelle': 'auto', 'geaendert': '2026-10-10T10:00:00Z'},
          ], 'typen': {'fact': 1, 'feedback': 5}};
        }
        return {'ok': true};
      },
      aufMeldung: meldungen.add,
    ))));
    await t.pumpAndSettle();
    expect(find.text('Wohnt in Linz'), findsOneWidget);
    expect(find.text('Alles (1)'), findsOneWidget); // interne (feedback) zählen nicht zu „Alles"
    await t.tap(find.text('Zugestellte Hinweise (5)'));
    await t.pumpAndSettle();
    expect(aufrufe.last.pfad, '/api/geraete/gedaechtnis?typ=feedback');

    await t.tap(find.byTooltip('Korrigieren'));
    await t.pumpAndSettle();
    await t.enterText(find.byType(TextField).last, 'Wohnt in Steyr');
    await t.tap(find.text('Speichern'));
    await t.pumpAndSettle();
    expect(aufrufe.where((x) => x.methode == 'POST').single.toString(), 'POST /api/geraete/gedaechtnis/m1 {text: Wohnt in Steyr}');
    expect(find.text('Wohnt in Steyr'), findsOneWidget);

    await t.tap(find.byTooltip('Löschen'));
    await t.pumpAndSettle();
    await t.tap(find.widgetWithText(FilledButton, 'Löschen'));
    await t.pumpAndSettle();
    expect(aufrufe.any((x) => x.methode == 'DELETE' && x.pfad == '/api/geraete/gedaechtnis/m1'), isTrue);
    expect(find.text('Wohnt in Steyr'), findsNothing);
    expect(meldungen.length, 2);
    await t.binding.setSurfaceSize(null);
  });

  testWidgets('Vorgang: Details mit Schritten, Abschluss „behoben" mit Maßnahme (1.13.0)', (t) async {
    final aufrufe = <Aufruf>[];
    bool? ergebnis;
    await t.pumpWidget(MaterialApp(home: Scaffold(body: Builder(builder: (ctx) => TextButton(
      onPressed: () async => ergebnis = await zeigeVorgang(ctx,
        v: {'id': 'v1', 'titel': 'Domain verlängern', 'status': 'offen', 'besitzer': 'user', 'ziel': 'noahhabel.com läuft weiter', 'begruendung': 'Mail vom 10.10.'},
        schritte: [
          {'vorgangId': 'v1', 'zeit': '2026-10-10T08:00:00Z', 'art': 'vorgeschlagen', 'beschreibung': 'Verlängerung vorgeschlagen'},
          {'vorgangId': 'anderer', 'zeit': '2026-10-10T09:00:00Z', 'art': 'notiz', 'beschreibung': 'gehört nicht hierher'},
        ],
        json: (p, {methode = 'GET', koerper}) async { aufrufe.add(Aufruf(p, methode, koerper)); return {'ok': true}; },
        aufMeldung: (_) {}),
      child: const Text('öffnen'),
    )))));
    await t.tap(find.text('öffnen'));
    await t.pumpAndSettle();
    expect(find.text('noahhabel.com läuft weiter'), findsOneWidget);
    expect(find.textContaining('Verlängerung vorgeschlagen'), findsOneWidget);
    expect(find.textContaining('gehört nicht hierher'), findsNothing);
    await t.tap(find.text('Behoben'));
    await t.pumpAndSettle();
    await t.enterText(find.widgetWithText(TextField, 'Maßnahme — was wurde getan?'), 'bei easyname bezahlt');
    await t.tap(find.text('Abschließen'));
    await t.pumpAndSettle();
    expect(aufrufe.single.toString(), 'POST /api/geraete/vorgaenge/v1 {ergebnis: {art: behoben, massnahme: bei easyname bezahlt}, kuenftig: {art: wie_heute}}');
    expect(ergebnis, isTrue);
  });
}
