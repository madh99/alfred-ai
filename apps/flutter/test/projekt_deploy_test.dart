import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:alfred_app/projekt_deploy.dart';
import 'package:alfred_app/projekt_umgebungen.dart';

void main() {
  testWidgets('1.25.0 Deploy je Stufe: Ziel zur Bestätigung, Deployen nur bestätigt, Hochstufen nur bei grünem Stand + Ziel', (t) async {
    final gesendet = <Map<String, dynamic>>[];
    var deploy = <String, dynamic>{'repoUrl': 'https://git.lokalkraft.at/madh/x.git', 'token': 'gitlab', 'stufen': <String, dynamic>{}};
    Future<Map<String, dynamic>> json(String pfad, {String methode = 'GET', Map<String, dynamic>? koerper}) async { gesendet.add(koerper ?? {}); return {'success': true, 'display': 'gestellt'}; }
    Widget app() => MaterialApp(home: Scaffold(body: SingleChildScrollView(child: ProjektDeploy(id: 'p1', json: json, deploy: deploy, neuLaden: () async {}))));
    await t.binding.setSurfaceSize(const Size(1000, 2400));
    await t.pumpWidget(app());
    expect(find.textContaining('vorhandenes GitLab-Token'), findsOneWidget);
    expect(find.text('kein Ziel'), findsNWidgets(3));
    await t.tap(find.byKey(const Key('deploy-ziel-test')));
    await t.pumpAndSettle();
    expect(find.byKey(const Key('deploy-autodev')), findsNothing); // nur dev
    await t.enterText(find.byKey(const Key('deploy-host')), '192.168.1.96');
    await t.pumpAndSettle();
    await t.tap(find.byKey(const Key('deploy-ziel-speichern')));
    await t.pumpAndSettle();
    expect(gesendet.last['aktion'], 'deploy_ziel');
    expect(gesendet.last['deploy'], containsPair('stufe', 'test'));
    expect((gesendet.last['deploy'] as Map).containsKey('bestaetigt'), false);
    // dev grün mit Stand, test bestätigt → Hochstufen möglich; prod ohne Ziel
    deploy = {...deploy, 'stufen': {
      'dev': {'ziel': {'host': 'h1', 'prozess': 'pm2', 'stufe': 'dev'}, 'zielText': 'dev · root@h1 · pm2', 'bestaetigt': true, 'letzter': {'zeit': '2026-10-13T20:00:00Z', 'ok': true, 'text': '🚀 grün', 'nachher': 'abc1234def', 'vorher': '0001112'}},
      'test': {'ziel': {'host': 'h2', 'prozess': 'pm2', 'stufe': 'test'}, 'zielText': 'test · root@h2 · pm2', 'bestaetigt': true},
    }};
    await t.pumpWidget(app());
    await t.pumpAndSettle();
    expect(find.textContaining('abc1234 · 🚀 grün'), findsOneWidget);
    await t.tap(find.byKey(const Key('deploy-hoch-dev')));
    await t.pumpAndSettle();
    expect(gesendet.last, {'aktion': 'hochstufen', 'deploy': {'von': 'dev', 'nach': 'test'}});
    expect(t.widget<ButtonStyleButton>(find.byKey(const Key('deploy-hoch-test'))).onPressed, isNull); // test ohne grünen Stand, prod ohne Ziel
    await t.tap(find.byKey(const Key('deploy-start-test')));
    await t.pumpAndSettle();
    expect(gesendet.last, {'aktion': 'deploy', 'deploy': {'stufe': 'test'}});
    await t.tap(find.byKey(const Key('deploy-rollback-dev')));
    await t.pumpAndSettle();
    expect(gesendet.last, {'aktion': 'rollback', 'deploy': {'stufe': 'dev'}});
    // unbestätigtes Ziel: Deployen gesperrt
    deploy = {...deploy, 'stufen': {'prod': {'ziel': {'host': 'h3', 'prozess': 'pm2', 'stufe': 'prod'}, 'zielText': 'prod · root@h3 · pm2', 'bestaetigt': false}}};
    await t.pumpWidget(app());
    await t.pumpAndSettle();
    expect(find.textContaining('(nicht bestätigt)'), findsOneWidget);
    expect(t.widget<ButtonStyleButton>(find.byKey(const Key('deploy-start-prod'))).onPressed, isNull);
  });

  testWidgets('1.25.0 Umgebungen: maskiert anzeigen, setzen, löschen, kopieren, Schlüssel am Gerät erkennen', (t) async {
    final gesendet = <Map<String, dynamic>>[];
    Future<Map<String, dynamic>> json(String pfad, {String methode = 'GET', Map<String, dynamic>? koerper}) async {
      gesendet.add(koerper ?? {});
      final a = koerper?['aktion'];
      if (a == 'env_liste') return {'success': true, 'data': {'stufen': [{'stage': 'dev', 'lesbar': true, 'werte': {'DATABASE_URL': 'po****db'}}]}};
      if (a == 'env_erkennen') return {'success': true, 'display': '2 erkannt', 'data': {'keys': [{'key': 'API_KEY', 'sources': ['.env.example']}, {'key': 'PORT', 'sources': []}]}};
      return {'success': true, 'display': 'ok'};
    }
    await t.binding.setSurfaceSize(const Size(1000, 2000));
    await t.pumpWidget(MaterialApp(home: Scaffold(body: SingleChildScrollView(child: ProjektUmgebungen(id: 'p1', json: json)))));
    await t.tap(find.byKey(const Key('umgebungen-oeffnen')));
    await t.pumpAndSettle();
    expect(find.text('DATABASE_URL = po****db'), findsOneWidget);
    await t.tap(find.byKey(const Key('umgebung-erkennen')));
    await t.pumpAndSettle();
    await t.tap(find.widgetWithText(ActionChip, 'API_KEY'));
    await t.pumpAndSettle();
    await t.enterText(find.byKey(const Key('umgebung-wert')), 'geheim');
    await t.tap(find.byKey(const Key('umgebung-setzen')));
    await t.pumpAndSettle();
    expect(gesendet.firstWhere((g) => g['aktion'] == 'env_setzen'), {'aktion': 'env_setzen', 'deploy': {'stage': 'dev', 'key': 'API_KEY', 'value': 'geheim'}});
    await t.tap(find.text('→ test'));
    await t.pumpAndSettle();
    expect(gesendet.lastWhere((g) => g['aktion'] == 'env_kopieren'), {'aktion': 'env_kopieren', 'deploy': {'von': 'dev', 'nach': 'test'}});
    await t.tap(find.byTooltip('Löschen'));
    await t.pumpAndSettle();
    expect(gesendet.lastWhere((g) => g['aktion'] == 'env_loeschen'), {'aktion': 'env_loeschen', 'deploy': {'stage': 'dev', 'key': 'DATABASE_URL'}});
  });
}
