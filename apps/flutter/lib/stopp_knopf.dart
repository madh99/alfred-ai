/// 1.14.1 — Stopp-Knopf mit Lauf-Kreis (Owner 12.10.: „der Kreis, der vorher rund um Senden gelaufen ist, fehlt jetzt um das
/// Stopp"). Bis 1.6 zeigte der Senden-Knopf während der Antwort einen drehenden Kreis; 1.7.0 ersetzte ihn durch das
/// Stopp-Symbol. Jetzt beides: Stopp in der Mitte (antippen bricht ab), der Kreis läuft außen herum.
library;

import 'package:flutter/material.dart';

class StoppKnopf extends StatelessWidget {
  const StoppKnopf({super.key, required this.aufStopp, this.gefuellt = true, this.groesse = 44});
  final VoidCallback aufStopp;
  /// gefüllt wie der Senden-Knopf der Eingabezeile; ungefüllt in der Schnellfrage
  final bool gefuellt;
  final double groesse;

  @override
  Widget build(BuildContext context) {
    final icon = Icon(Icons.stop_rounded, size: gefuellt ? 20 : 22);
    return SizedBox(
      width: groesse,
      height: groesse,
      child: Stack(alignment: Alignment.center, children: [
        SizedBox(width: groesse, height: groesse, child: CircularProgressIndicator(key: const Key('stopp-kreis'), strokeWidth: 2, color: Theme.of(context).colorScheme.primary)),
        gefuellt
            ? IconButton.filled(tooltip: 'Antwort abbrechen', onPressed: aufStopp, icon: icon, visualDensity: VisualDensity.compact)
            : IconButton(tooltip: 'Antwort abbrechen', onPressed: aufStopp, icon: icon, visualDensity: VisualDensity.compact),
      ]),
    );
  }
}
