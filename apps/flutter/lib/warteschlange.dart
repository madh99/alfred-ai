import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// 1.8.0 — Nachrichten bei Verbindungsabbruch zurückhalten (Owner-Freigabe 11.10., Punkt 9): ist der Server nicht
/// erreichbar (Neustart beim Selbstupdate, WLAN weg), ging eine Nachricht bisher als Fehler verloren. Jetzt wartet sie
/// in `~/.alfred/warteschlange.json` (übersteht auch einen App-Neustart) und wird nachgesendet, sobald der Server wieder
/// antwortet — in ihrem Gespräch, in der Reihenfolge des Schreibens. Nach 24 Stunden verfällt sie mit Hinweis.

class Wartend {
  Wartend({required this.text, this.faden, this.tier, DateTime? zeit}) : zeit = zeit ?? DateTime.now();
  final String text;
  /// Gespräch (null = Hauptgespräch) — nachgesendet wird nur dorthin.
  final String? faden;
  final String? tier;
  final DateTime zeit;

  Map<String, dynamic> zuJson() => {'text': text, 'faden': faden, 'tier': tier, 'zeit': zeit.toUtc().toIso8601String()};
  static Wartend? ausJson(Object? j) {
    if (j is! Map || j['text'] is! String) return null;
    return Wartend(text: j['text'] as String, faden: j['faden'] as String?, tier: j['tier'] as String?, zeit: DateTime.tryParse('${j['zeit']}')?.toLocal());
  }
}

/// Fehler, bei denen die Nachricht den Server sicher nicht erreicht hat (kein Antwortstrom begonnen).
bool istVerbindungsfehler(Object e) =>
    e is SocketException || e is HandshakeException || e is TimeoutException ||
    (e is HttpException && !e.message.contains('abgebrochen')) ||
    RegExp(r'HTTP (502|503|504)\b').hasMatch('$e');

class Warteschlange {
  Warteschlange(this.datei);

  factory Warteschlange.standard() {
    final heim = Platform.environment['USERPROFILE'] ?? Platform.environment['HOME'] ?? '.';
    return Warteschlange(File('$heim${Platform.pathSeparator}.alfred${Platform.pathSeparator}warteschlange.json'));
  }

  final File datei;
  static const verfall = Duration(hours: 24);
  final List<Wartend> eintraege = [];

  bool get leer => eintraege.isEmpty;

  void lade() {
    eintraege.clear();
    try {
      if (!datei.existsSync()) return;
      final j = jsonDecode(datei.readAsStringSync());
      if (j is List) eintraege.addAll(j.map(Wartend.ausJson).whereType<Wartend>());
    } catch (_) { /* defekte Datei = leer */ }
  }

  void _speichere() {
    try {
      if (eintraege.isEmpty) { if (datei.existsSync()) datei.deleteSync(); return; }
      datei.parent.createSync(recursive: true);
      datei.writeAsStringSync(jsonEncode(eintraege.map((e) => e.zuJson()).toList()));
    } catch (_) { /* Warteschlange ist Komfort */ }
  }

  void hinzu(Wartend w) { eintraege.add(w); _speichere(); }
  void entferne(Wartend w) { eintraege.remove(w); _speichere(); }

  /// Verfallene Einträge herausnehmen und zurückgeben (für den Hinweis an den Owner).
  List<Wartend> verfallene({DateTime? jetzt}) {
    final grenze = (jetzt ?? DateTime.now()).subtract(verfall);
    final alt = eintraege.where((e) => e.zeit.isBefore(grenze)).toList();
    if (alt.isNotEmpty) { eintraege.removeWhere(alt.contains); _speichere(); }
    return alt;
  }

  /// Nächster Eintrag für das gerade offene Gespräch (älteste zuerst).
  Wartend? naechster(String? faden) {
    for (final e in eintraege) { if (e.faden == faden) return e; }
    return null;
  }

  int anzahlAusserhalb(String? faden) => eintraege.where((e) => e.faden != faden).length;
}
