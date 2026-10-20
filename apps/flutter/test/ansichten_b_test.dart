import 'package:alfred_app/kosten_ansicht.dart';
import 'package:alfred_app/notizen.dart';
import 'package:alfred_app/web_seiten.dart';
import 'package:alfred_app/wissen_ansicht.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

// 1.71.0 — Kosten, Notizen, Wissen/Interessen/Ziele und „Im Web öffnen“
Future<Map<String, dynamic>> _fake(String pfad, {String methode = 'GET', Map<String, dynamic>? koerper}) async {
  if (pfad.startsWith('/api/geraete/nutzung')) {
    return {'tage': [
      {'date': '2026-10-19', 'totalCostUsd': 4.0, 'models': [{'model': 'gpt-6.1-sol', 'calls': 10, 'costUsd': 3.0}, {'model': 'sonnet-5-5', 'calls': 5, 'costUsd': 1.0}]},
      {'date': '2026-10-20', 'totalCostUsd': 12.0, 'models': [{'model': 'gpt-6.1-sol', 'calls': 20, 'costUsd': 12.0}]},
    ]};
  }
  if (pfad == '/api/geraete/konto') {
    return {'kosten': {'heute': 20.0, 'woche': 50.0, 'monat': 300.0, 'llm': {'heute': 12.0}, 'tagesbudgetUsd': 10.0, 'agenten': [{'agent': 'claude-code', 'heute': 8.0, 'woche': 20.0, 'monat': 120.0}], 'herkunftMonat': [{'herkunft': 'chat', 'kosten': 90.0, 'aufrufe': 300}]}};
  }
  if (pfad.startsWith('/api/geraete/notizen')) return {'notes': [{'id': '1', 'title': 'Einkauf', 'content': 'Milch\nBrot', 'updatedAt': '2026-10-20T10:00:00Z'}]};
  if (pfad.startsWith('/api/geraete/wissen')) {
    return {'entities': [{'id': 'a', 'name': 'Alexandra', 'entityType': 'person', 'mentionCount': 9, 'attributes': {'rolle': 'Partnerin'}}, {'id': 'b', 'name': 'Linz', 'entityType': 'location', 'mentionCount': 3}],
      'relations': [{'sourceEntityId': 'a', 'targetEntityId': 'b', 'relationType': 'arbeitet_in'}], 'gesamt': 2};
  }
  if (pfad == '/api/geraete/interessen') return {'topics': [{'id': 't1', 'name': 'KI-Modelle', 'keywords': ['llm'], 'status': 'active', 'itemsLast7d': 4}]};
  if (pfad == '/api/geraete/ziele') return {'goals': [{'id': 'g1', 'title': '10 000 Schritte', 'status': 'active', 'lastStatus': 'on_track'}]};
  return {};
}

Widget _rahmen(Widget w) => MaterialApp(home: Scaffold(body: w));

void main() {
  test('Summe je Modell absteigend', () {
    final s = summeJeModell([
      {'models': [{'model': 'a', 'calls': 1, 'costUsd': 1.0}, {'model': 'b', 'calls': 2, 'costUsd': 5.0}]},
      {'models': [{'model': 'a', 'calls': 3, 'costUsd': 6.0}]},
    ]);
    expect(s.map((x) => x.modell), ['a', 'b']);
    expect(s.first.usd, 7.0);
    expect(s.first.aufrufe, 4);
  });

  test('Web-Adresse mit basePath, ohne doppelten Schrägstrich', () {
    expect(webAdresse('https://alfred:3420/', 'settings'), 'https://alfred:3420/alfred/settings/');
    expect(webSeiten.any((s) => s.pfad == 'social'), isFalse); // Social pausiert
  });

  testWidgets('Kosten zeigt Summe, Modelle und Agenten getrennt', (t) async {
    await t.pumpWidget(_rahmen(KostenAnsicht(json: _fake)));
    await t.pumpAndSettle();
    expect(find.text('16.00 \$'), findsOneWidget);
    expect(find.text('gpt-6.1-sol'), findsOneWidget);
    await t.scrollUntilVisible(find.text('claude-code'), 200);
    expect(find.textContaining('zählen nicht zum API-Budget'), findsOneWidget);
  });

  testWidgets('Notizen listet und öffnet', (t) async {
    await t.pumpWidget(_rahmen(NotizenAnsicht(json: _fake)));
    await t.pumpAndSettle();
    await t.tap(find.text('Einkauf'));
    await t.pumpAndSettle();
    expect(find.text('Milch\nBrot'), findsOneWidget);
  });

  testWidgets('Wissen: Gruppen, Beziehung, Interessen, Ziele', (t) async {
    await t.pumpWidget(_rahmen(WissenAnsicht(json: _fake)));
    await t.pumpAndSettle();
    expect(find.text('Person (1)'), findsOneWidget);
    await t.tap(find.text('Alexandra'));
    await t.pumpAndSettle();
    expect(find.text('→ arbeitet_in Linz'), findsOneWidget);
    Navigator.of(t.element(find.text('→ arbeitet_in Linz'))).pop();
    await t.pumpAndSettle();
    await t.tap(find.text('Interessen'));
    await t.pumpAndSettle();
    expect(find.text('KI-Modelle'), findsOneWidget);
    await t.tap(find.text('Ziele'));
    await t.pumpAndSettle();
    expect(find.text('10 000 Schritte'), findsOneWidget);
  });
}
