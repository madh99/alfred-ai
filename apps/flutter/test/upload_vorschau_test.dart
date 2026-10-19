import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:alfred_app/modell.dart';
import 'package:alfred_app/upload_vorschau.dart';
import 'package:alfred_app/verlaufsleiste.dart';

/// 1.46.0 (v1505) — eigene Anhänge als Vorschau statt Upload-Zeilen (Owner 19.10., Vorbild: Bilder über der Blase).
void main() {
  const k1 = 'f165df7a-0000-4000-8000-000000000001/2026-10-15T18-58-03-288Z_Screenshot 2026-10-15 205758.png';
  const k2 = 'f165df7a-0000-4000-8000-000000000001/2026-10-15T18-58-04-001Z_Rechnung.v2.pdf';
  const app = 'Datei „Screenshot 2026-10-15 205758.png" (154451 Bytes, SHA-256 ab12cd) liegt in deinem Dateispeicher, Schlüssel: $k1.';

  test('App-Zeilen ohne Text: nur Dateien, „Bestätige kurz den Empfang." verschwindet', () {
    final u = uploadZeilenTrennen('$app\nBestätige kurz den Empfang.');
    expect(u.text, '');
    expect(u.dateien.single.name, 'Screenshot 2026-10-15 205758.png');
    expect(u.dateien.single.key, k1);
    expect(u.dateien.single.groesse, 154451);
    expect(u.dateien.single.istBild, isTrue);
  });

  test('App mit Text davor, Web mit Text danach und typografischem Anführungszeichen; Punkte im Schlüssel bleiben', () {
    final a = uploadZeilenTrennen('Was steht da drauf?\n\n$app');
    expect(a.text, 'Was steht da drauf?');
    expect(a.dateien.length, 1);
    final w = uploadZeilenTrennen('Datei „Rechnung.v2.pdf“ (2048 Bytes) liegt in deinem Dateispeicher, Schlüssel: $k2.\nBitte prüfen');
    expect(w.text, 'Bitte prüfen');
    expect(w.dateien.single.key, k2);
    expect(w.dateien.single.istBild, isFalse);
  });

  test('ohne Upload-Zeile bleibt alles wie es ist (auch „Bestätige …" im normalen Text)', () {
    const t = 'Bestätige kurz den Empfang.';
    expect(uploadZeilenTrennen(t).text, t);
    expect(uploadZeilenTrennen(t).dateien, isEmpty);
  });

  test('Verlaufsleiste: Frage ohne Upload-Zeilen, reine Dateinachricht als „📎 Name"', () {
    final l = leistenEintraege([
      Eintrag(Art.du, 'Was steht da drauf?\n\n$app'),
      Eintrag(Art.alfred, 'Ein Bildschirmfoto.'),
      Eintrag(Art.du, '$app\nBestätige kurz den Empfang.'),
    ]);
    expect(l.map((e) => e.frage), ['Was steht da drauf?', '📎 Screenshot 2026-10-15 205758.png']);
  });

  testWidgets('Vorschau: Bild als Kachel, andere Datei als Kärtchen mit Größe; Tippen öffnet den geladenen Inhalt', (t) async {
    final geoeffnet = <String>[];
    final dateien = [
      const UploadVerweis(name: 'bild.png', key: 'k/bild.png'),
      const UploadVerweis(name: 'Rechnung.pdf', key: 'k/Rechnung.pdf', groesse: 2048),
    ];
    await t.pumpWidget(MaterialApp(home: Scaffold(body: UploadVorschau(
      dateien: dateien,
      laden: (d) async => Anhang(name: d.name, mime: d.istBild ? 'image/png' : 'application/pdf', bytes: const [1, 2, 3]),
      aufOeffnen: (a) => geoeffnet.add(a.name),
    ))));
    await t.pump();
    expect(find.byKey(const Key('upload-bild-bild.png')), findsOneWidget);
    expect(find.text('Rechnung.pdf'), findsOneWidget);
    expect(find.text('2 KB'), findsOneWidget);
    await t.tap(find.byKey(const Key('upload-datei-Rechnung.pdf')));
    await t.pump();
    await t.tap(find.byKey(const Key('upload-bild-bild.png')));
    await t.pump();
    expect(geoeffnet, ['Rechnung.pdf', 'bild.png']);
  });
}
