import 'package:flutter_test/flutter_test.dart';
import 'package:alfred_app/aufgaben.dart';
import 'package:alfred_app/eingang.dart';
import 'package:alfred_app/hinweise.dart';
import 'package:alfred_app/modell.dart';

// 1.36.0 — Eingang: Dringlichkeits-Reihenfolge und was hineingehört
void main() {
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
}
