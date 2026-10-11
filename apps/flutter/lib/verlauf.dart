import 'hinweise.dart';
import 'modell.dart';

/// 1.5.0 — Verlaufslogik ohne Oberfläche (testbar, Punkt 6): Zeilen des Servers in Einträge, Zählung neuer Nachrichten.

/// Eine Zeile aus `/api/geraete/verlauf` als Eintrag (ohne Anhänge — die lädt die App nach).
/// 1.1.0 — synthetische Fortsetzung („Freigabe erteilt für das Vorhaben …", v1324) als Hinweis; 1.2.5 — rolle „system"
/// (v1336, interne Fortsetzungen) als Hinweis mit der ersten Zeile; 1.4.0 — Insights als Kurzzeile (v1343).
Eintrag eintragAusVerlauf(Map<String, dynamic> m) {
  final t = '${m['text'] ?? ''}';
  final du = m['rolle'] == 'user';
  final sys = m['rolle'] == 'system';
  final ins = m['insight'] == true;
  final art = sys || ins || (du && t.startsWith('Freigabe erteilt für das Vorhaben')) ? Art.hinweis : du ? Art.du : Art.alfred;
  return Eintrag(art, ins ? hinweisKurzzeile(t) : sys ? 'ℹ ${t.split('\n').first}' : t, zeit: DateTime.tryParse('${m['zeit']}')?.toLocal());
}

/// Zeilen mit Text als Einträge (leere fallen weg, wie bisher).
List<Eintrag> eintraegeAusVerlauf(List<Map<String, dynamic>> zeilen) =>
    zeilen.where((m) => '${m['text'] ?? ''}'.trim().isNotEmpty).map(eintragAusVerlauf).toList();

/// 1.5.0 — Punkt 3: Antworten von Alfred, die nach `gesehen` kamen (während die App zu oder ausgeblendet war).
/// Liefert den Index der ersten neuen Antwort und die Anzahl; null, wenn nichts Neues da ist oder noch nie etwas gesehen wurde.
({int ab, int anzahl})? neueAntworten(List<Eintrag> verlauf, DateTime? gesehen) {
  if (gesehen == null) return null;
  var ab = -1; var n = 0;
  for (var i = 0; i < verlauf.length; i++) {
    final e = verlauf[i];
    if (e.art == Art.alfred && e.zeit.isAfter(gesehen)) { if (ab < 0) ab = i; n++; }
  }
  return n == 0 ? null : (ab: ab, anzahl: n);
}

/// Zeitpunkt der neuesten Alfred-Antwort im Verlauf (für „gesehen bis").
DateTime? neuesteAntwort(List<Eintrag> verlauf) {
  DateTime? t;
  for (final e in verlauf) { if (e.art == Art.alfred && (t == null || e.zeit.isAfter(t))) t = e.zeit; }
  return t;
}
