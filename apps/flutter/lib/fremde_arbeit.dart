/// 1.11.0 — „Alfred arbeitet" für Anfragen aus anderen Kanälen (Owner 11.10.: in Telegram gefragt, die App zeigte
/// nichts, bis die Antwort fertig war). Server v1354 schickt je Anfrage in einem Owner-Gespräch die Ereignisse start
/// (mit Frage), status und ende; der Satellit reicht sie als IPC-Ereignis „arbeit" (JSON im Text) weiter.
/// Eigene Anfragen dieses Geräts zeigt die App ohnehin selbst — sie werden hier übergangen.
///
/// 1.87.0 / v1975 — Owner 28.11. („sehr mühsam, wenn man nicht weiß, womit er beschäftigt ist und seit wann“):
/// Beginn, Modell, bisherige Kosten und Runde; der Stand lässt sich jederzeit abfragen (`GET /api/geraete/arbeit`),
/// auch für Läufe, die vor dem Öffnen der App begannen, und für Changes, die der Change-Motor gerade ausführt.
library;

import 'dart:convert';

class FremdeArbeit {
  FremdeArbeit({required this.id, required this.faden, required this.kanal, required this.frage, required this.zuletzt, this.projekt, this.seit});
  final String id;
  /// null = Hauptgespräch
  final String? faden;
  final String kanal;
  final String frage;
  String? status;
  DateTime zuletzt;
  /// 1.16.1 G2 — Live-Aktivität eines Geräte-Projekts (Projekt-ID): öffnet das Projekt statt eines Gesprächs, kein Abbrechen hier
  final String? projekt;
  /// 1.87.0 — Beginn der Anfrage (vom Server; fehlt bei alten Servern → Zeitpunkt des Start-Ereignisses)
  DateTime? seit;
  String? modell;
  double? kostenUsd;
  int? runde;
}

/// 1.87.0 — Change, den der Change-Motor gerade bearbeitet (oder an dem er angehalten hat)
class LaufenderChange {
  LaufenderChange({required this.id, required this.titel, required this.phase, required this.schritt, required this.schritte, this.schrittTitel, this.schrittSeit, this.zeitlimitS, this.grund, this.aktiv = false});
  final String id;
  final String titel;
  final String phase;
  final int schritt;
  final int schritte;
  final String? schrittTitel;
  final DateTime? schrittSeit;
  final int? zeitlimitS;
  final String? grund;
  final bool aktiv;

  static LaufenderChange? aus(dynamic j) {
    if (j is! Map) return null;
    final id = j['id'];
    if (id is! String || id.isEmpty) return null;
    int zahl(dynamic v) => v is num ? v.toInt() : 0;
    return LaufenderChange(
      id: id, titel: '${j['titel'] ?? ''}', phase: '${j['phase'] ?? ''}', schritt: zahl(j['schritt']), schritte: zahl(j['schritte']),
      schrittTitel: j['schrittTitel'] is String ? j['schrittTitel'] as String : null,
      schrittSeit: j['schrittSeit'] is String ? DateTime.tryParse(j['schrittSeit'] as String)?.toLocal() : null,
      zeitlimitS: j['zeitlimitS'] is num ? (j['zeitlimitS'] as num).toInt() : null,
      grund: j['grund'] is String ? j['grund'] as String : null,
      aktiv: j['aktiv'] == true,
    );
  }
}

bool _eigene(String von, String geraetId) => von == 'sitzung:$geraetId' || von.startsWith('sitzung:$geraetId:');

void _metaUebernehmen(FremdeArbeit a, Map j) {
  final seit = j['seit'];
  if (seit is String) a.seit = DateTime.tryParse(seit)?.toLocal() ?? a.seit;
  if (j['modell'] is String && (j['modell'] as String).isNotEmpty) a.modell = j['modell'] as String;
  if (j['kostenUsd'] is num) a.kostenUsd = (j['kostenUsd'] as num).toDouble();
  if (j['runde'] is num) a.runde = (j['runde'] as num).toInt();
}

/// Ereignis anwenden. Rückgabe: (phase, arbeit) — `start` heißt neu (Frage anzeigen), `status`, `ende` (schon entfernt);
/// null = übergangen (eigene Anfrage, unlesbar, unbekannte Arbeit).
(String, FremdeArbeit)? fremdeArbeitAnwenden(Map<String, FremdeArbeit> laufend, String json, String? faden, String geraetId, DateTime jetzt) {
  Map<String, dynamic> j;
  try { j = jsonDecode(json) as Map<String, dynamic>; } catch (_) { return null; }
  final id = j['arbeit'];
  final phase = j['phase'];
  if (id is! String || id.isEmpty) return null;
  final von = '${j['von'] ?? ''}';
  if (_eigene(von, geraetId)) return null; // eigene Anfrage
  switch (phase) {
    case 'start':
      final a = FremdeArbeit(id: id, faden: faden, kanal: '${j['kanal'] ?? 'anderer Kanal'}', frage: '${j['frage'] ?? ''}', zuletzt: jetzt, projekt: j['projekt'] is String ? j['projekt'] as String : null, seit: jetzt);
      _metaUebernehmen(a, j);
      laufend[id] = a;
      return ('start', a);
    case 'status':
      final a = laufend[id];
      if (a == null) return null;
      if (j['text'] is String && (j['text'] as String).isNotEmpty) a.status = j['text'] as String;
      _metaUebernehmen(a, j);
      a.zuletzt = jetzt;
      return ('status', a);
    case 'ende':
      final a = laufend.remove(id);
      return a == null ? null : ('ende', a);
  }
  return null;
}

/// 1.87.0 — Abgleich mit dem Server-Stand (`GET /api/geraete/arbeit`): fehlende Läufe aufnehmen (App später geöffnet),
/// beendete entfernen (Ende verpasst). Projekt-Aktivitäten (G2) kennt der Server dort nicht — sie bleiben.
/// Rückgabe: ob sich etwas geändert hat.
bool fremdeArbeitAbgleich(Map<String, FremdeArbeit> laufend, dynamic anfragen, String geraetId, DateTime jetzt) {
  if (anfragen is! List) return false;
  var geaendert = false;
  final gesehen = <String>{};
  for (final j in anfragen) {
    if (j is! Map) continue;
    final id = j['arbeit'];
    if (id is! String || id.isEmpty || _eigene('${j['von'] ?? ''}', geraetId)) continue;
    gesehen.add(id);
    var a = laufend[id];
    if (a == null) {
      a = FremdeArbeit(id: id, faden: j['faden'] is String ? j['faden'] as String : null, kanal: '${j['kanal'] ?? 'anderer Kanal'}', frage: '${j['frage'] ?? ''}', zuletzt: jetzt);
      laufend[id] = a;
      geaendert = true;
    }
    if (j['status'] is String && j['status'] != a.status) { a.status = j['status'] as String; geaendert = true; }
    final vorher = '${a.seit}|${a.modell}|${a.kostenUsd}|${a.runde}';
    _metaUebernehmen(a, j);
    if (vorher != '${a.seit}|${a.modell}|${a.kostenUsd}|${a.runde}') geaendert = true;
    a.zuletzt = jetzt;
  }
  final vorherAnzahl = laufend.length;
  laufend.removeWhere((id, a) => a.projekt == null && !gesehen.contains(id));
  return geaendert || laufend.length != vorherAnzahl;
}

/// Hängengebliebene Anzeigen entfernen (Ende verpasst, z. B. Satellit kurz getrennt): 10 min ohne Lebenszeichen.
/// 1.87.0 — der Abgleich mit dem Server (jede Minute) ist maßgeblich; diese Grenze greift nur, wenn er nicht antwortet,
/// und ist deshalb großzügiger (ein Modellaufruf am Ausgabelimit dauert Minuten ohne Status).
bool fremdeArbeitAufraeumen(Map<String, FremdeArbeit> laufend, DateTime jetzt) {
  final vorher = laufend.length;
  laufend.removeWhere((_, a) => jetzt.difference(a.zuletzt) > const Duration(minutes: 30));
  return laufend.length != vorher;
}

/// „6 min“, „1 h 12 min“, „42 s“
String dauerText(Duration d) {
  if (d.isNegative) d = Duration.zero;
  if (d.inMinutes < 1) return '${d.inSeconds} s';
  if (d.inHours < 1) return '${d.inMinutes} min';
  return '${d.inHours} h ${d.inMinutes % 60} min';
}

String _uhr(DateTime t) => '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

/// 1.87.0 — Zeile unter der Live-Anzeige: „seit 11:27 (6 min) · gpt-6.2-sol · 1,27 $ · Runde 4“
String arbeitMetaZeile(FremdeArbeit a, DateTime jetzt) {
  final teile = <String>[];
  final seit = a.seit;
  if (seit != null) teile.add('seit ${_uhr(seit)} (${dauerText(jetzt.difference(seit))})');
  if (a.modell != null) teile.add(a.modell!);
  if (a.kostenUsd != null) teile.add('${a.kostenUsd!.toStringAsFixed(2).replaceAll('.', ',')} \$');
  if (a.runde != null) teile.add('Runde ${a.runde}');
  return teile.join(' · ');
}

/// 1.87.0 — „Change f996c656 · Schritt 12/15 · seit 0:22 von 2:35 · läuft“
String changeZeile(LaufenderChange c, DateTime jetzt) {
  final teile = <String>['Schritt ${c.schritt}/${c.schritte}'];
  final seit = c.schrittSeit;
  if (seit != null) {
    final d = jetzt.difference(seit);
    teile.add(c.zeitlimitS != null ? 'seit ${dauerText(d)} (Limit ${dauerText(Duration(seconds: c.zeitlimitS!))})' : 'seit ${dauerText(d)}');
  }
  teile.add(switch (c.phase) { 'laeuft' => c.aktiv ? 'läuft' : 'wartet', 'angehalten' => 'angehalten', 'wartet_owner' => 'wartet auf dich', 'rueckweg' => 'Rückweg läuft', _ => c.phase });
  return teile.join(' · ');
}
