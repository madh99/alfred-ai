import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:alfred_app/aufgaben.dart';
import 'package:alfred_app/eingang.dart';
import 'package:alfred_app/hinweise.dart';
import 'package:alfred_app/modell.dart';

// 1.36.0 — Eingang: Dringlichkeits-Reihenfolge und was hineingehört
void main() {
  test('1.39.0 Hinweis-Anzeige: ohne Nummer und Fettung, abgeschnittener Titel nicht doppelt', () {
    final a = hinweisAnzeige('Hinweis: Auto-Freigabe niedrig — Die Akzeptanzrate liegt bei 13 % (itsm 26', '5. **Hinweis: Auto-Freigabe niedrig** — Die Akzeptanzrate liegt bei 13 % (itsm 26 %, email 11 %).');
    expect(a.titel, 'Hinweis: Auto-Freigabe niedrig — Die Akzeptanzrate liegt bei 13 % (itsm 26 %, email 11 %).');
    expect(a.text, isNull);
    final b = hinweisAnzeige('Batterie wechseln', 'Temp Terrasse meldet **5 %**.');
    expect((b.titel, b.text), ('Batterie wechseln', 'Temp Terrasse meldet 5 %.'));
    expect(hinweisAnzeige('', '3. **Nur Text**').titel, 'Nur Text');
    expect(hinweisAnzeige('Gleich', 'Gleich').text, isNull);
  });

  final jetzt = DateTime(2026, 10, 16, 12);
  final vorgaenge = <Map<String, dynamic>>[
    {'id': 'v-alfred', 'titel': 'Erinnerung setzen', 'status': 'offen', 'besitzer': 'alfred'},
    {'id': 'v-wartet', 'titel': 'Wallbox prüfen', 'status': 'wartet', 'besitzer': 'user'},
    {'id': 'v-dir', 'titel': 'Fenster prüfen', 'status': 'offen', 'besitzer': 'user'},
    {'id': 'v-zurueck', 'titel': 'Später', 'status': 'offen', 'besitzer': 'user', 'zurueckBis': '2026-10-20T08:00:00Z'},
  ];
  final aufgaben = [
    Aufgabe({'id': 'a-heute', 'titel': 'Müll', 'faellig': '2026-10-16T08:00:00', 'erledigt': false}),
    Aufgabe({'id': 'a-spaeter', 'titel': 'Steuer', 'faellig': '2026-10-30T08:00:00', 'erledigt': false}),
  ];
  final hinweise = [
    Hinweis({'id': 'h-alt', 'titel': 'Alt', 'status': 'pending', 'zeit': '2026-10-15T10:00:00Z'}),
    Hinweis({'id': 'h-neu', 'titel': 'Neu', 'status': 'pending', 'zeit': '2026-10-16T09:00:00Z'}),
    Hinweis({'id': 'h-gelesen', 'titel': 'Gelesen', 'status': 'acted', 'zeit': '2026-10-16T09:00:00Z'}),
  ];
  final bestaetigungen = [Bestaetigung(id: 'b1', text: 'Update installieren?')];

  test('Reihenfolge: Bestätigung, wartender Vorgang, fällige Aufgabe, Vorgang bei dir, Hinweise neueste zuerst', () {
    final e = eingangEintraege(bestaetigungen: bestaetigungen, vorgaenge: vorgaenge, aufgaben: aufgaben, hinweise: hinweise, jetzt: jetzt);
    expect(e.map((x) => x.id).toList(), ['b1', 'v-wartet', 'a-heute', 'v-dir', 'h-neu', 'h-alt']);
  });

  test('Zähler: ohne Vorgänge bei Alfred, ohne zurückgestellte', () {
    expect(eingangZahl(bestaetigungen: 1, vorgaenge: vorgaenge, aufgabenFaellig: 1, hinweiseOffen: 2, jetzt: jetzt), 6);
  });

  testWidgets('1.81.0: Hinweis mit Feld im Eingang fragt die Angabe ab und schickt sie mit (Owner 27.10.)', (t) async {
    final gesendet = <Map<String, dynamic>?>[];
    await t.binding.setSurfaceSize(const Size(1000, 1400));
    await t.pumpWidget(MaterialApp(home: Scaffold(body: Eingang(
      json: (p, {methode = 'GET', koerper}) async {
        if (methode == 'POST') { gesendet.add(koerper); return {'ok': true}; }
        if (p == '/api/geraete/hinweise') {
          return {'hinweise': [{'id': 'a1', 'quelle': 'knowledge', 'titel': 'Adresse für Vereinssitz fehlt', 'text': 'KSV 1919', 'status': 'pending', 'zeit': '2026-10-27T08:00:00Z', 'aktion': 'Adresse speichern', 'felder': [{'key': 'address', 'label': 'Adresse', 'type': 'text'}]}]};
        }
        return {};
      },
      bestaetigungen: const [], aufEntscheiden: (_, __) async {}, aufMeldung: (_) {},
    ))));
    await t.pumpAndSettle();
    await t.tap(find.byKey(const Key('eingang-aktion-a1')));
    await t.pumpAndSettle();
    await t.enterText(find.byKey(const Key('feld-address')), 'Johann-Böhm-Straße 1, 8605 Kapfenberg');
    await t.pumpAndSettle();
    await t.tap(find.byKey(const Key('uebernehmen')));
    await t.pumpAndSettle();
    expect(gesendet.single, {'aktion': 'ausfuehren', 'werte': {'address': 'Johann-Böhm-Straße 1, 8605 Kapfenberg'}});
    await t.pumpWidget(const SizedBox()); // Abgleich-Takt beenden
  });
}
