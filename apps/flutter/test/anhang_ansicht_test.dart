import 'dart:typed_data';

import 'package:alfred_app/anhang_ansicht.dart';
import 'package:alfred_app/modell.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// 1.5.0 — Oberflächentests (Punkt 6) für die Anhang-Darstellung; Realfall 10.10. 23:40: Foto flackerte beim Mitschreiben.

// Kleinstes gültiges PNG (1×1, transparent)
final png = Uint8List.fromList([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01,
  0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

Widget huelle(Widget kind) => MaterialApp(home: Scaffold(body: SingleChildScrollView(child: kind)));

void main() {
  testWidgets('Bild: dieselbe Bildquelle über Neuzeichnen hinweg, gaplessPlayback an (kein Flackern)', (t) async {
    final a = Anhang(name: 'foto.png', mime: 'image/png', bytes: png.toList());
    var zaehler = 0;
    late StateSetter neu;
    await t.pumpWidget(huelle(StatefulBuilder(builder: (context, setState) {
      neu = setState;
      return Column(children: [Text('Mitschrift $zaehler'), AnhangAnsicht(a, aufOeffnen: (_) {}, aufSpeichern: (_) {})]);
    })));
    final vorher = t.widget<Image>(find.byType(Image));
    expect(vorher.gaplessPlayback, isTrue);
    // Mitschreiben zeichnet mehrmals pro Sekunde neu
    for (var i = 0; i < 5; i++) { neu(() => zaehler++); await t.pump(); }
    final nachher = t.widget<Image>(find.byType(Image));
    expect(identical((vorher.image as MemoryImage).bytes, (nachher.image as MemoryImage).bytes), isTrue);
    expect(vorher.image, nachher.image); // gleicher Bild-Schlüssel → kein erneutes Dekodieren
    expect(find.text('Mitschrift 5'), findsOneWidget);
  });

  testWidgets('Datei: Zeile mit Öffnen und Speichern, kein Bild, kein Abspielen', (t) async {
    Anhang? geoeffnet; Anhang? gespeichert;
    final a = Anhang(name: 'rechnung.pdf', mime: 'application/pdf', bytes: List.filled(2048, 1));
    await t.pumpWidget(huelle(AnhangAnsicht(a, aufOeffnen: (x) => geoeffnet = x, aufSpeichern: (x) => gespeichert = x, aufAbspielen: (_) {})));
    expect(find.byType(Image), findsNothing);
    expect(find.text('rechnung.pdf · 2 KB'), findsOneWidget);
    expect(find.text('Abspielen'), findsNothing);
    await t.tap(find.text('Öffnen')); await t.tap(find.text('Speichern'));
    expect(geoeffnet, same(a)); expect(gespeichert, same(a));
  });

  testWidgets('Sprachnachricht: „Abspielen" ruft die Wiedergabe (v1350)', (t) async {
    Anhang? gespielt;
    final a = Anhang(name: 'sprachnachricht.ogg', mime: 'audio/ogg', bytes: [0x4f, 0x67, 0x67, 0x53]);
    await t.pumpWidget(huelle(AnhangAnsicht(a, aufOeffnen: (_) {}, aufSpeichern: (_) {}, aufAbspielen: (x) => gespielt = x)));
    expect(find.byIcon(Icons.graphic_eq), findsOneWidget);
    await t.tap(find.text('Abspielen'));
    expect(gespielt, same(a));
  });

  testWidgets('Bild antippen öffnet es', (t) async {
    Anhang? geoeffnet;
    final a = Anhang(name: 'foto.png', mime: 'image/png', bytes: png);
    await t.pumpWidget(huelle(AnhangAnsicht(a, aufOeffnen: (x) => geoeffnet = x, aufSpeichern: (_) {})));
    // Bilder werden im Test nicht dekodiert (Größe 0) — den Tipp-Bereich direkt auslösen
    t.widget<InkWell>(find.ancestor(of: find.byType(Image), matching: find.byType(InkWell))).onTap!();
    expect(geoeffnet, same(a));
  });
}
