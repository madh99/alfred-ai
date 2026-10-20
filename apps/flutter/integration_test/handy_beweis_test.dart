import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:alfred_app/main.dart' as app;

/// Phase 5 H1 (Spec Geräte §20) — Bedien-Beweis im iOS-Simulator gegen den echten Server. Voraussetzung: die App ist gekoppelt
/// (Schlüsselbund). Ablauf: verbunden → Schublade → Neuer Chat → Frage senden → Antwort abwarten → Faden archivieren.
/// Lauf am Mac: `flutter test integration_test/handy_beweis_test.dart -d <Simulator>` (siehe release/ios-sim-fern.sh --beweis).
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  Future<void> warte(WidgetTester t, bool Function() bedingung, {int sekunden = 60, required String was}) async {
    for (var i = 0; i < sekunden * 4; i++) {
      await t.pump(const Duration(milliseconds: 250));
      if (bedingung()) return;
    }
    fail('Zeitüberschreitung: $was');
  }

  testWidgets('Handy: Frage stellen, Antwort erhalten, Faden archivieren', (t) async {
    await app.main(const []);
    final senden = find.byTooltip('Senden (Enter)');
    // 1.58.0 G1 — bei leerem Feld steht dort der Unterhaltungsknopf, der Senden-Pfeil kommt erst mit Text
    await warte(t, () => find.byKey(const Key('unterhaltung-start')).evaluate().isNotEmpty, was: 'Chat mit Unterhaltungsknopf');
    // Status-Punkt grün = WSS verbunden
    await warte(t, () => find.byWidgetPredicate((w) => w is Icon && w.icon == Icons.circle && w.color == Colors.green).evaluate().isNotEmpty, was: 'verbunden');

    await t.tap(find.byKey(const Key('handy-menue')));
    await t.pumpAndSettle();
    await t.tap(find.text('Neuer Chat'));
    await t.pumpAndSettle();
    expect(find.textContaining('Neues Gespräch'), findsWidgets);

    const frage = 'Beweis H1 vom iPhone-Simulator: antworte bitte nur mit „Verstanden“.';
    await t.enterText(find.byType(TextField).last, frage);
    await t.pump();
    await t.tap(senden);
    await warte(t, () => find.byKey(const Key('stopp')).evaluate().isNotEmpty, sekunden: 15, was: 'Antwort läuft');
    await warte(t, () => find.byKey(const Key('stopp')).evaluate().isEmpty && find.byKey(const Key('unterhaltung-start')).evaluate().isNotEmpty, sekunden: 180, was: 'Antwort fertig');
    await warte(t, () => find.textContaining('Verstanden').evaluate().length >= 2, sekunden: 20, was: 'Antwort im Verlauf');

    await t.tap(find.byKey(const Key('kopf-menue')));
    await t.pumpAndSettle();
    await t.tap(find.text('Archivieren'));
    await t.pumpAndSettle();
    // Archivieren des offenen Fadens führt ins Hauptgespräch (1.41.0)
    await warte(t, () => find.textContaining('Hauptgespräch').evaluate().isNotEmpty, sekunden: 15, was: 'zurück im Hauptgespräch');
  });
}
