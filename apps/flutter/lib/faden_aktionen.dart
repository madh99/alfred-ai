/// 1.43.0 (v1500, D2) — Hilfen für Kopfzeile und Menü eines Fadens (App-Spec §11): Export als Markdown, Dateiname,
/// Zeitplan einer geplanten Aufgabe, Tastenkürzel. Reine Logik, ohne Oberfläche testbar.
library;

/// Faden als Markdown (Kopieren, Exportieren): Titel, dann je Nachricht Absender, Zeit und Text.
String fadenAlsMarkdown(String titel, List<Map<String, dynamic>> nachrichten) {
  final b = StringBuffer('# $titel\n');
  for (final m in nachrichten) {
    final rolle = m['rolle'];
    if (rolle != 'user' && rolle != 'assistant') continue;
    final text = '${m['text'] ?? ''}'.trim();
    if (text.isEmpty) continue;
    final z = DateTime.tryParse('${m['zeit'] ?? ''}')?.toLocal();
    final wann = z == null ? '' : ' · ${z.day.toString().padLeft(2, '0')}.${z.month.toString().padLeft(2, '0')}.${z.year} ${z.hour.toString().padLeft(2, '0')}:${z.minute.toString().padLeft(2, '0')}';
    b.write('\n**${rolle == 'user' ? 'Du' : 'Alfred'}**$wann\n\n$text\n');
  }
  return b.toString();
}

/// Dateiname für den Export: Titel ohne Sonderzeichen (Umlaute bleiben), höchstens 60 Zeichen, mit Datum.
String exportDateiname(String titel, DateTime d) {
  var t = titel.replaceAll(RegExp(r'[🔨↳]'), '').replaceAll(RegExp(r'[^\p{L}\p{N} _-]+', unicode: true), '').trim().replaceAll(RegExp(r'\s+'), ' ');
  if (t.isEmpty) t = 'Gespräch';
  if (t.length > 60) t = t.substring(0, 60).trim();
  return '$t ${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}.md';
}

/// Zeitplan einer geplanten Aufgabe → (art, wert) für den Server: täglich/wöchentlich als cron, einmalig als ISO-Zeitpunkt.
/// [wochentag] 1 = Montag … 7 = Sonntag (wie DateTime.weekday). Liefert null bei ungültiger Uhrzeit oder fehlendem Datum.
({String art, String wert})? zeitplanAus({required String rhythmus, required String uhrzeit, int? wochentag, DateTime? datum}) {
  final m = RegExp(r'^(\d{1,2}):(\d{2})$').firstMatch(uhrzeit.trim());
  if (m == null) return null;
  final h = int.parse(m.group(1)!), min = int.parse(m.group(2)!);
  if (h > 23 || min > 59) return null;
  switch (rhythmus) {
    case 'taeglich': return (art: 'cron', wert: '$min $h * * *');
    case 'woechentlich':
      if (wochentag == null || wochentag < 1 || wochentag > 7) return null;
      return (art: 'cron', wert: '$min $h * * ${wochentag % 7}'); // cron: 0 = Sonntag
    case 'einmalig':
      if (datum == null) return null;
      return (art: 'once', wert: DateTime(datum.year, datum.month, datum.day, h, min).toUtc().toIso8601String());
  }
  return null;
}

/// Tastenkürzel der App (Liste unter „Tastenkürzel“ in der Befehlspalette). macOS: ⌘ statt Strg.
const appKuerzel = <(String, String)>[
  ('Strg+K', 'Befehlspalette: Gespräche, Projekte, Ansichten, Aktionen'),
  ('Strg+N', 'Neuer Chat'),
  ('Strg+B', 'Seitenleiste ein/aus'),
  ('Strg+,', 'Einstellungen'),
  ('Strg+Alt+R', 'Gespräch umbenennen'),
  ('Strg+Alt+P', 'Gespräch anheften / lösen'),
  ('Strg+Alt+S', 'Seiten-Chat ein/aus'),
  ('Strg+Umschalt+A', 'Gespräch archivieren'),
  ('Strg+Alt+A', 'Schnellfrage (systemweit)'),
  ('Strg+Alt+Leertaste', 'Sprechen (systemweit)'),
  ('Enter / Umschalt+Enter', 'Senden / neue Zeile'),
  ('Esc', 'laufende Antwort abbrechen, Schnellfrage schließen'),
];

/// 1.45.3 — Breite des Chatbereichs (Owner 19.10.: im großen Fenster mehr Platz, aber nicht ganz): drei Viertel der verfügbaren
/// Breite, mindestens 920 px (wie bisher), höchstens 1440 px, nie breiter als verfügbar.
double chatBreite(double verfuegbar) => (verfuegbar * 0.75).clamp(920.0, 1440.0).clamp(0.0, verfuegbar);
