import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:alfred_app/beobachter.dart';

void main() {
  testWidgets('1.20.0 Beobachter: Liste mit Stand, Schalter, neue Regel', (t) async {
    final gesendet = <List<dynamic>>[];
    var aktiv = true;
    Future<Map<String, dynamic>> json(String pfad, {String methode = 'GET', Map<String, dynamic>? koerper}) async {
      if (methode == 'POST') { gesendet.add([pfad, koerper]); if (koerper?['aktion'] == 'aus') aktiv = false; return {'success': true, 'display': 'ok'}; }
      return {'regeln': [{'id': 'r1', 'name': 'Rechnungen', 'geraet': 'PC-madh', 'wirkung': 'vorgang', 'auftrag': 'prüfen', 'aktiv': aktiv, 'stand': aktiv ? 'läuft' : 'aus', 'treffer': 3, 'filter': {'pfad': 'C:/Downloads', 'muster': '*.pdf', 'ereignisse': ['neu']}}], 'geraete': [{'id': 'g1', 'name': 'PC-madh', 'online': true}], 'projekte': []};
    }
    await t.binding.setSurfaceSize(const Size(1200, 2400));
    await t.pumpWidget(MaterialApp(home: Scaffold(body: Beobachter(json: json))));
    await t.pumpAndSettle();
    expect(find.text('Rechnungen'), findsOneWidget);
    expect(find.textContaining('läuft · 3 Treffer'), findsOneWidget);
    await t.tap(find.byKey(const Key('beobachter-schalter-r1')));
    await t.pumpAndSettle();
    expect(gesendet.last, ['/api/geraete/beobachter/r1', {'aktion': 'aus'}]);
    await t.tap(find.byKey(const Key('beobachter-neu')));
    await t.pumpAndSettle();
    await t.enterText(find.byKey(const Key('beobachter-pfad')), '/home/madh/Downloads');
    await t.enterText(find.byKey(const Key('beobachter-muster')), '*.pdf');
    await t.tap(find.byKey(const Key('beobachter-anlegen')));
    await t.pumpAndSettle();
    final k = gesendet.last[1] as Map<String, dynamic>;
    expect(gesendet.last[0], '/api/geraete/beobachter');
    expect(k['geraet'], 'g1'); expect(k['pfad'], '/home/madh/Downloads'); expect(k['muster'], '*.pdf'); expect(k['wirkung'], 'hinweis'); expect(k['ereignisse'], ['neu']); expect(k['quelle'], 'ordner');
    // 1.21.0 — Quelle Benachrichtigung
    await t.tap(find.byKey(const Key('beobachter-neu')));
    await t.pumpAndSettle();
    await t.tap(find.byKey(const Key('beobachter-quelle')));
    await t.pumpAndSettle();
    await t.tap(find.text('Benachrichtigungen (Windows/macOS)').last);
    await t.pumpAndSettle();
    expect(find.byKey(const Key('beobachter-pfad')), findsNothing);
    await t.enterText(find.byKey(const Key('beobachter-apps')), 'WhatsApp');
    await t.tap(find.byKey(const Key('beobachter-anlegen')));
    await t.pumpAndSettle();
    final k2 = gesendet.last[1] as Map<String, dynamic>;
    expect(k2['quelle'], 'benachrichtigung'); expect(k2['apps'], 'WhatsApp');
  });

  testWidgets('1.23.0 B10/B11/B12: Art je Gerät schalten, einmalig + Dauer, eigene Konten', (t) async {
    final gesendet = <Map<String, dynamic>>[];
    var aus = <String>[];
    Future<Map<String, dynamic>> json(String pfad, {String methode = 'GET', Map<String, dynamic>? koerper}) async {
      if (methode == 'POST') { gesendet.add(koerper!); if (koerper['aktion'] == 'geraet_art') { aus = koerper['an'] == true ? [] : ['${koerper['quelle']}']; } return {'success': true, 'display': 'ok'}; }
      return {'regeln': [{'id': 'r1', 'name': 'Sobald', 'geraet': 'PC-madh', 'wirkung': 'hinweis', 'aktiv': true, 'einmalig': true, 'bis': '2026-10-16T16:00:00Z', 'stand': aus.isEmpty ? 'läuft' : 'Art am Gerät aus', 'treffer': 0, 'filter': {'pfad': '/d'}}],
        'geraete': [{'id': 'g1', 'name': 'PC-madh', 'online': true, 'artenAus': aus}], 'projekte': [], 'serverKonten': ['md@3033.at']};
    }
    await t.binding.setSurfaceSize(const Size(1200, 2400));
    await t.pumpWidget(MaterialApp(home: Scaffold(body: Beobachter(json: json))));
    await t.pumpAndSettle();
    expect(find.textContaining('einmalig · bis 16.10.'), findsOneWidget);
    expect(find.textContaining('Alfred liest selbst: md@3033.at'), findsOneWidget);
    await t.tap(find.byKey(const Key('beobachter-art-g1-ordner')));
    await t.pumpAndSettle();
    expect(gesendet.last, {'aktion': 'geraet_art', 'geraet': 'g1', 'quelle': 'ordner', 'an': false});
    expect(find.textContaining('Art am Gerät aus'), findsOneWidget);
    await t.tap(find.byKey(const Key('beobachter-neu')));
    await t.pumpAndSettle();
    await t.enterText(find.byKey(const Key('beobachter-pfad')), '/home/madh/Downloads');
    await t.tap(find.byKey(const Key('beobachter-einmalig')));
    await t.tap(find.byKey(const Key('beobachter-tage')));
    await t.pumpAndSettle();
    await t.tap(find.text('3 Tage').last);
    await t.pumpAndSettle();
    await t.tap(find.byKey(const Key('beobachter-anlegen')));
    await t.pumpAndSettle();
    expect(gesendet.last['einmalig'], true); expect(gesendet.last['tage'], 3);
  });
}
