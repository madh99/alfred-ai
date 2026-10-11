import 'package:alfred_app/markdown.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// 1.6.0 — Textdarstellung (Punkt 1): Blöcke, Links, Tabellen, Code; Oberflächentests (Punkt 6).
void main() {
  group('zerlege', () {
    test('Text, Code-Zaun und Tabelle als eigene Blöcke', () {
      const t = 'Zusammenfassung:\n\n| Posten | Betrag |\n|---|---:|\n| Energie | 41,20 € |\n| Netz | 18,05 € |\n\n```bash\nalfred --version\n```\nEnde';
      final b = zerlege(t);
      expect(b.map((x) => x.runtimeType.toString()).toList(), ['MdText', 'MdTabelle', 'MdText', 'MdCode', 'MdText']);
      final tab = b[1] as MdTabelle;
      expect(tab.kopf, ['Posten', 'Betrag']);
      expect(tab.zeilen, [['Energie', '41,20 €'], ['Netz', '18,05 €']]);
      final code = b[3] as MdCode;
      expect(code.code, 'alfred --version');
      expect(code.sprache, 'bash');
    });

    test('Pipe im Fließtext ohne Trennzeile bleibt Text; offener Code-Zaun nimmt den Rest', () {
      expect(zerlege('a | b ist kein Tisch').single, isA<MdText>());
      expect(zerlege('a | b\n---\nweiter').single, isA<MdText>()); // Trennlinie, keine Tabelle
      final b = zerlege('```\nx\ny');
      expect((b.single as MdCode).code, 'x\ny');
    });

    test('kurze Tabellenzeilen werden aufgefüllt', () {
      final tab = zerlege('|a|b|c|\n|-|--|--|\n|1|2|').whereType<MdTabelle>().single;
      expect(tab.zeilen.single, ['1', '2', '']);
    });
  });

  test('linkErlaubt: nur http(s) und mailto', () {
    expect(linkErlaubt('https://awattar.at'), isTrue);
    expect(linkErlaubt('mailto:md@example.at'), isTrue);
    expect(linkErlaubt('file:///etc/passwd'), isFalse);
    expect(linkErlaubt('javascript:alert(1)'), isFalse);
  });

  test('inlineSpans: Markdown-Link, nackte URL ohne Satzzeichen, fett, code', () {
    final theme = ThemeData();
    final urls = <String>[];
    final s = inlineSpans('Siehe [Rechnung](https://x.at/r?id=1), **wichtig** und `code` — https://awattar.at.', theme, aufLink: (u) { urls.add(u); return TapGestureRecognizer(); });
    expect(urls, ['https://x.at/r?id=1', 'https://awattar.at']);
    final text = TextSpan(children: s).toPlainText();
    expect(text, 'Siehe Rechnung, wichtig und code — https://awattar.at.');
  });

  testWidgets('Link antippen ruft aufLink mit der Adresse', (t) async {
    String? geoeffnet;
    await t.pumpWidget(MaterialApp(home: Scaffold(body: AlfredText('Mehr unter [aWATTar](https://www.awattar.at/) bitte.', aufLink: (u) async => geoeffnet = u))));
    final rich = t.widget<RichText>(find.byType(RichText).first).text; // 1.12.1 Text.rich in SelectionArea
    TapGestureRecognizer? r;
    rich.visitChildren((s) { if (s is TextSpan && s.recognizer is TapGestureRecognizer) { r = s.recognizer as TapGestureRecognizer; return false; } return true; });
    expect(r, isNotNull);
    r!.onTap!();
    expect(geoeffnet, 'https://www.awattar.at/');
  });

  testWidgets('Tabelle wird als Table gezeichnet, Code-Block hat Kopier-Knopf', (t) async {
    String? kopiert;
    t.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') kopiert = (call.arguments as Map)['text'] as String?;
      return null;
    });
    var gemeldet = false;
    await t.pumpWidget(MaterialApp(home: Scaffold(body: SingleChildScrollView(child: AlfredText('| A | B |\n|---|---|\n| 1 | 2 |\n\n```\nnpm pack\n```', aufKopiert: (_) => gemeldet = true)))));
    expect(find.byType(Table), findsOneWidget);
    expect(find.text('A'), findsOneWidget);
    expect(find.text('2'), findsOneWidget);
    await t.tap(find.byTooltip('Code kopieren'));
    expect(kopiert, 'npm pack');
    expect(gemeldet, isTrue);
  });

  // 1.12.1 — Owner 12.10.: Tabellenwerte und IPs ließen sich weder markieren noch anklicken
  test('IP-Adressen: gültige IPv4 mit/ohne Port, keine Versionsnummern, auch am Satzende', () {
    expect(istIpAdresse('172.16.0.38'), isTrue);
    expect(istIpAdresse('192.168.1.92:3420'), isTrue);
    expect(istIpAdresse('300.1.1.1'), isFalse);
    expect(istIpAdresse('0.19.0'), isFalse);
    final theme = ThemeData();
    final codes = <String>[];
    TapGestureRecognizer code(String c) { codes.add(c); return TapGestureRecognizer(); }
    inlineSpans('IP 172.16.0.38. Version 0.19.0-jarvis.1359, Port 192.168.1.92:3420, falsch 999.1.1.1 und `sensor.x`', theme, aufCode: code);
    expect(codes, ['172.16.0.38', '192.168.1.92:3420', 'sensor.x']);
  });

  testWidgets('ganze Antwort in einer SelectionArea; Tabellenzelle ist Text darin', (t) async {
    await t.pumpWidget(const MaterialApp(home: Scaffold(body: AlfredText('Vorher\n\n| Wert | Zustand |\n|---|---|\n| IP | `172.16.0.38` |\n\nNachher'))));
    expect(find.byType(SelectionArea), findsOneWidget);
    expect(find.byType(SelectableText), findsNothing); // kein Insel-Markieren je Block mehr
    expect(find.descendant(of: find.byType(SelectionArea), matching: find.byType(Table)), findsOneWidget);
  });

  testWidgets('Klick auf Code kopiert; Klick auf IP öffnet Menü mit Kopieren und Browser', (t) async {
    String? kopiert;
    t.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') kopiert = (call.arguments as Map)['text'] as String?;
      return null;
    });
    String? gemeldet; String? geoeffnet;
    await t.pumpWidget(MaterialApp(home: Scaffold(body: AlfredText('Schalter `switch.licht` an 172.16.0.38', aufKopiert: (w) => gemeldet = w, aufLink: (u) async => geoeffnet = u))));
    final erkenner = <String, TapGestureRecognizer>{};
    t.widget<RichText>(find.byType(RichText).first).text.visitChildren((s) {
      if (s is TextSpan && s.recognizer is TapGestureRecognizer) erkenner[s.text!] = s.recognizer as TapGestureRecognizer;
      return true;
    });
    erkenner['switch.licht']!.onTapUp!(TapUpDetails(kind: PointerDeviceKind.mouse, globalPosition: const Offset(10, 10)));
    expect(kopiert, 'switch.licht');
    expect(gemeldet, 'switch.licht');
    erkenner['172.16.0.38']!.onTapUp!(TapUpDetails(kind: PointerDeviceKind.mouse, globalPosition: const Offset(10, 10)));
    await t.pumpAndSettle();
    expect(find.text('Kopieren'), findsOneWidget);
    await t.tap(find.text('Im Browser öffnen (http://172.16.0.38)'));
    await t.pumpAndSettle();
    expect(geoeffnet, 'http://172.16.0.38');
  });

  testWidgets('echter Mausklick durch die SelectionArea erreicht IP und Code', (t) async {
    String? kopiert;
    t.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') kopiert = (call.arguments as Map)['text'] as String?;
      return null;
    });
    await t.pumpWidget(MaterialApp(home: Scaffold(body: Center(child: AlfredText('172.16.0.38', aufKopiert: (_) {})))));
    await t.tapAt(t.getCenter(find.byType(RichText).first), kind: PointerDeviceKind.mouse);
    await t.pumpAndSettle();
    expect(find.text('Im Browser öffnen (http://172.16.0.38)'), findsOneWidget);
    await t.tap(find.text('Kopieren'));
    await t.pumpAndSettle();
    expect(kopiert, '172.16.0.38');
  });

  testWidgets('leerer Text zeigt die Denkpunkte', (t) async {
    await t.pumpWidget(const MaterialApp(home: Scaffold(body: AlfredText(''))));
    expect(find.text('…'), findsOneWidget);
  });
}
