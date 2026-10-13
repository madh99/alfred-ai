import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:alfred_app/projekt_deploy.dart';

void main() {
  testWidgets('1.24.0 Deploy: Ziel zur Bestätigung, Deployen nur bei bestätigtem Ziel, Rollback mit Stand davor', (t) async {
    final gesendet = <Map<String, dynamic>>[];
    var deploy = <String, dynamic>{'repoUrl': 'http://git.lokalkraft.at/madh/x.git', 'token': 'gitlab'};
    Future<Map<String, dynamic>> json(String pfad, {String methode = 'GET', Map<String, dynamic>? koerper}) async { gesendet.add(koerper ?? {}); return {'success': true, 'display': 'gestellt'}; }
    Widget app() => MaterialApp(home: Scaffold(body: SingleChildScrollView(child: ProjektDeploy(id: 'p1', json: json, deploy: deploy, neuLaden: () async {}))));
    await t.binding.setSurfaceSize(const Size(1000, 2000));
    await t.pumpWidget(app());
    expect(find.textContaining('vorhandenes GitLab-Token'), findsOneWidget);
    expect(find.textContaining('Kein Deploy-Ziel'), findsOneWidget);
    expect(find.byKey(const Key('deploy-start')), findsNothing);
    await t.tap(find.byKey(const Key('deploy-ziel-bearbeiten')));
    await t.pumpAndSettle();
    await t.enterText(find.byKey(const Key('deploy-host')), '192.168.1.96');
    await t.enterText(find.byKey(const Key('deploy-port')), '3003');
    await t.tap(find.byKey(const Key('deploy-autodev')));
    await t.pumpAndSettle();
    await t.tap(find.byKey(const Key('deploy-ziel-speichern')));
    await t.pumpAndSettle();
    expect(gesendet.last['aktion'], 'deploy_ziel');
    expect(gesendet.last['deploy'], containsPair('host', '192.168.1.96'));
    expect((gesendet.last['deploy'] as Map)['app_port'], 3003);
    expect((gesendet.last['deploy'] as Map)['auto_dev'], true);
    expect((gesendet.last['deploy'] as Map).containsKey('bestaetigt'), false);
    // Ziel gespeichert, aber unbestätigt: Deployen gesperrt
    deploy = {...deploy, 'ziel': {'host': '192.168.1.96', 'prozess': 'pm2', 'stufe': 'dev'}, 'zielText': 'dev · root@192.168.1.96 · pm2', 'bestaetigt': false};
    await t.pumpWidget(app());
    await t.pumpAndSettle();
    expect(find.textContaining('(nicht bestätigt)'), findsOneWidget);
    expect(t.widget<ButtonStyleButton>(find.byKey(const Key('deploy-start'))).onPressed, isNull);
    // bestätigt + letzter Deploy rot mit Stand davor: Deployen und Rollback möglich
    deploy = {...deploy, 'bestaetigt': true, 'letzter': {'zeit': '2026-10-13T20:00:00Z', 'ok': false, 'text': '❌ Nachkontrolle rot — Dienst läuft nicht (pm2).', 'vorher': 'abc1234def'}};
    await t.pumpWidget(app());
    await t.pumpAndSettle();
    expect(find.textContaining('Nachkontrolle rot'), findsOneWidget);
    await t.tap(find.byKey(const Key('deploy-start')));
    await t.pumpAndSettle();
    expect(gesendet.last, {'aktion': 'deploy'});
    await t.tap(find.byKey(const Key('deploy-rollback')));
    await t.pumpAndSettle();
    expect(gesendet.last, {'aktion': 'rollback'});
  });
}
