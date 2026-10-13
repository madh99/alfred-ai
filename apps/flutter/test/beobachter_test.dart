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
    expect(k['geraet'], 'g1'); expect(k['pfad'], '/home/madh/Downloads'); expect(k['muster'], '*.pdf'); expect(k['wirkung'], 'hinweis'); expect(k['ereignisse'], ['neu']);
  });
}
