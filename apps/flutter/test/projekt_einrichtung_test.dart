import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:alfred_app/projekt_einrichtung.dart';

void main() {
  Map<String, dynamic> stand(Set<String> erledigt) {
    const titel = {'repo': 'Repository', 'pruefung': 'Prüfbefehle', 'mr': 'Merge Requests', 'regeln': 'Projektregeln', 'protokoll': 'Protokoll im Repository'};
    final s = [for (final k in titel.keys) {'schritt': k, 'titel': titel[k], 'erledigt': erledigt.contains(k), 'stand': erledigt.contains(k) ? 'gesetzt' : 'offen'}];
    return {'schritte': s, 'erledigt': erledigt.length, 'gesamt': s.length};
  }

  testWidgets('1.37.0 Einrichtung: n/m, passt so, Merge Requests/Protokoll über ihre Aktionen, Prüfbefehle vorschlagen und übernehmen; fertig → verschwindet', (t) async {
    final gesendet = <Map<String, dynamic>>[];
    Future<Map<String, dynamic>> json(String pfad, {String methode = 'GET', Map<String, dynamic>? koerper}) async {
      gesendet.add(koerper ?? {});
      if (koerper?['text'] == 'pruefung_vorschlag') return {'success': true, 'display': 'npm run typecheck, npm test', 'data': {'befehle': ['npm run typecheck', 'npm test'], 'quelle': 'package.json', 'hinweise': []}};
      return {'success': true, 'display': 'Gespeichert.'};
    }
    var e = stand({'repo'});
    var geladen = 0;
    Widget app() => MaterialApp(home: Scaffold(body: SingleChildScrollView(child: ProjektEinrichtung(id: 'p1', json: json, einrichtung: e, neuLaden: () async { geladen++; }))));
    await t.binding.setSurfaceSize(const Size(900, 1600));
    await t.pumpWidget(app());
    expect(find.text('Einrichtung 1/5'), findsOneWidget);
    expect(find.byKey(const Key('einrichtung-repo-keins')), findsNothing); // erledigt: keine Knöpfe
    await t.tap(find.byKey(const Key('einrichtung-regeln-keine')));
    await t.pumpAndSettle();
    expect(gesendet.last, {'aktion': 'einrichtung', 'text': 'ok:regeln'});
    expect(geladen, 1);
    await t.tap(find.byKey(const Key('einrichtung-mr-aus')));
    await t.pumpAndSettle();
    expect(gesendet.last, {'aktion': 'merge_requests', 'text': 'aus'});
    await t.tap(find.byKey(const Key('einrichtung-protokoll-an')));
    await t.pumpAndSettle();
    expect(gesendet.last, {'aktion': 'protokoll', 'text': 'an'});
    await t.tap(find.byKey(const Key('einrichtung-pruefung-vorschlag')));
    await t.pumpAndSettle();
    expect(find.text('npm run typecheck'), findsOneWidget);
    expect(find.textContaining('aus package.json'), findsOneWidget);
    await t.tap(find.byKey(const Key('einrichtung-pruefung-uebernehmen')));
    await t.pumpAndSettle();
    expect(gesendet.last, {'aktion': 'einrichtung', 'text': 'pruefung_setzen', 'deploy': {'befehle': ['npm run typecheck', 'npm test']}});
    expect(find.text('npm run typecheck'), findsNothing);
    expect(find.textContaining('kosten', findRichText: true), findsNothing);
    e = stand({'repo', 'pruefung', 'mr', 'regeln', 'protokoll'});
    await t.pumpWidget(app());
    await t.pumpAndSettle();
    expect(find.byKey(const Key('projekt-einrichtung')), findsNothing);
  });
}
