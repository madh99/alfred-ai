import 'dart:async';
import 'package:alfred_app/hinweise.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('offeneHinweise zählt pending und snoozed, nicht erledigt/verworfen (1.5.1)', () {
    expect(offeneHinweise({'hinweise': [
      {'id': '1', 'status': 'pending'}, {'id': '2', 'status': 'snoozed'}, {'id': '3', 'status': 'acted'}, {'id': '4', 'status': 'dismissed'}, {'id': '5'},
    ]}), 3);
    expect(offeneHinweise({}), 0);
  });

  group('hinweisKurzzeile (1.4.0)', () {
    test('erster Punkt, Anzahl weiterer, Verweis auf die Sammlung', () {
      const t = '💡 **Alfred Insights**\n\n1. **Wallbox** nicht erreichbar seit 18:00.\n2. Zwei Sensoren offline.\n3. Akku Auto 12 %.';
      expect(hinweisKurzzeile(t), '💡 Hinweis: Wallbox nicht erreichbar seit 18:00. (+2) — unter „Hinweise"');
    });
    test('ein einzelner Satz ohne Aufzählung', () {
      expect(hinweisKurzzeile('💡 **Alfred Insights** _(erstellt vor 2h)_\n\nHome Assistant meldet 72 neu nicht verfügbare Entitäten.'),
          '💡 Hinweis: Home Assistant meldet 72 neu nicht verfügbare Entitäten. — unter „Hinweise"');
    });
    test('lange Zeilen werden gekürzt, leerer Text ergibt einen Platzhalter', () {
      expect(hinweisKurzzeile('💡 x\n\n${'a' * 200}').contains('…'), isTrue);
      expect(hinweisKurzzeile('💡 **Alfred Insights**'), '💡 Hinweis von Alfred');
    });
    test('Quellen haben lesbare Namen', () {
      expect(quellenName('reasoning'), 'Alfred');
      expect(quellenName('interests'), 'Interessen');
      expect(quellenName('unbekannt'), 'unbekannt');
    });
  });

  group('Reagieren (1.14.0, Server v1364)', () {
    test('Status nach Reaktion: nützlich/gelesen schließen, Gründe verwerfen, besprochen lässt offen', () {
      expect(statusNach('nuetzlich'), 'acted');
      expect(statusNach('gelesen'), 'acted');
      expect(statusNach('zu_oft'), 'dismissed');
      expect(statusNach('nicht_nuetzlich'), 'dismissed');
      expect(statusNach('spaeter'), 'snoozed');
      expect(statusNach('besprochen'), isNull);
    });
    test('Ausgang zeigt die Reaktion, alte Einträge den Status', () {
      expect(ausgangText('dismissed', 'kein_interesse'), 'nicht nützlich: interessiert mich nicht');
      expect(ausgangText('acted', 'gelesen'), 'gelesen');
      expect(ausgangText('acted', null), 'erledigt');
      expect(ausgangText('pending', 'besprochen'), isNull);
    });

    testWidgets('Knöpfe: Nützlich, Gelesen, Nicht nützlich mit Grund, Alle gelesen, Nachfragen = besprochen', (t) async {
      final aufrufe = <String>[];
      String? nachgefragt;
      await t.binding.setSurfaceSize(const Size(1000, 1400));
      await t.pumpWidget(MaterialApp(home: Scaffold(body: Hinweise(
        json: (p, {methode = 'GET', koerper}) async {
          if (methode == 'GET') {
            return {'hinweise': [
              {'id': 'h1', 'quelle': 'reasoning', 'titel': 'Wallbox offline', 'text': 'seit 2 h', 'status': 'pending', 'zeit': '2026-10-12T08:00:00Z'},
              {'id': 'h2', 'quelle': 'reasoning', 'titel': 'Paket kommt', 'text': 'morgen', 'status': 'pending', 'zeit': '2026-10-12T07:00:00Z'},
              {'id': 'h3', 'quelle': 'reasoning', 'titel': 'Domain läuft ab', 'text': '15.10.', 'status': 'pending', 'zeit': '2026-10-12T06:00:00Z'},
            ]};
          }
          aufrufe.add('$p ${koerper?['aktion']}');
          return {'ok': true};
        },
        aufNachfragen: (x) => nachgefragt = x,
        aufMeldung: (_) {},
      ))));
      await t.pumpAndSettle();
      expect(find.text('Erledigt'), findsNothing);
      expect(find.text('Verwerfen'), findsNothing);

      await t.tap(find.text('Nützlich').first);
      await t.pumpAndSettle();
      expect(aufrufe.last, '/api/geraete/hinweise/h1 nuetzlich');

      await t.tap(find.text('Nicht nützlich').first);
      await t.pumpAndSettle();
      await t.tap(find.text('zu oft').last);
      await t.pumpAndSettle();
      expect(aufrufe.last, '/api/geraete/hinweise/h2 zu_oft');

      await t.tap(find.text('Nachfragen').first);
      await t.pumpAndSettle();
      expect(aufrufe.last, '/api/geraete/hinweise/h3 besprochen');
      expect(nachgefragt, 'Domain läuft ab\n\n15.10.');

      await t.tap(find.text('Alle gelesen'));
      await t.pumpAndSettle();
      expect(aufrufe.last, '/api/geraete/hinweise/h3 gelesen');
      expect(find.text('Keine offenen Hinweise.'), findsOneWidget);
    });
  });

  testWidgets('1.80.0: Hinweis mit Feldern öffnet ein Formular und schickt die Werte mit (Owner 27.10.: Adresse nicht eintragbar)', (t) async {
    final gesendet = <Map<String, dynamic>?>[];
    await t.binding.setSurfaceSize(const Size(1000, 1400));
    await t.pumpWidget(MaterialApp(home: Scaffold(body: Hinweise(
      json: (p, {methode = 'GET', koerper}) async {
        if (methode == 'GET') {
          return {'hinweise': [
            {'id': 'a1', 'quelle': 'knowledge', 'titel': 'Adresse für Vereinssitz fehlt', 'text': 'KSV 1919', 'status': 'pending', 'zeit': '2026-10-27T08:00:00Z', 'aktion': 'Adresse eintragen',
             'felder': [{'key': 'info', 'label': 'Fehlende Infos (Adresse)', 'type': 'text'}]},
          ]};
        }
        gesendet.add(koerper);
        return {'ok': true};
      },
      aufNachfragen: (_) {},
      aufMeldung: (_) {},
    ))));
    await t.pumpAndSettle();
    await t.tap(find.byKey(const Key('aktion-a1')));
    await t.pumpAndSettle();
    expect(find.text('Fehlende Infos (Adresse)'), findsOneWidget);
    expect(t.widget<FilledButton>(find.byKey(const Key('uebernehmen'))).onPressed, isNull); // leer → nicht senden
    await t.enterText(find.byKey(const Key('feld-info')), 'Johann-Böhm-Straße 1, 8605 Kapfenberg');
    await t.pumpAndSettle();
    await t.tap(find.byKey(const Key('uebernehmen')));
    await t.pumpAndSettle();
    expect(gesendet.single, {'aktion': 'ausfuehren', 'werte': {'info': 'Johann-Böhm-Straße 1, 8605 Kapfenberg'}});
  });

  testWidgets('1.82.0: Nachfragen schließt die Ansicht, bevor die Antwort kommt — kein Fehler (Owner 27.10.)', (t) async {
    final meldungen = <String>[];
    var zeigen = true;
    late StateSetter neu;
    final antwort = Completer<Map<String, dynamic>>();
    await t.binding.setSurfaceSize(const Size(1000, 1400));
    await t.pumpWidget(MaterialApp(home: Scaffold(body: StatefulBuilder(builder: (c, s) { neu = s; return zeigen ? Hinweise(
      json: (p, {methode = 'GET', koerper}) async {
        if (methode == 'GET') return {'hinweise': [{'id': 'r1', 'quelle': 'reasoning', 'titel': 'Termin morgen', 'text': 'x', 'status': 'pending', 'zeit': '2026-10-27T08:00:00Z'}]};
        return antwort.future;
      },
      aufNachfragen: (_) => neu(() => zeigen = false), // wie der Wechsel in den Chat
      aufMeldung: meldungen.add,
    ) : const SizedBox(); }))));
    await t.pumpAndSettle();
    await t.tap(find.text('Nachfragen'));
    await t.pumpAndSettle();
    antwort.complete({'ok': true});
    await t.pumpAndSettle();
    expect(t.takeException(), isNull);
    expect(meldungen.where((m) => m.contains('Fehler')), isEmpty);
  });
}
