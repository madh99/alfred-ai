/// 1.11.0 — „Alfred arbeitet" für Anfragen aus anderen Kanälen (Owner 11.10.: in Telegram gefragt, die App zeigte
/// nichts, bis die Antwort fertig war). Server v1354 schickt je Anfrage in einem Owner-Gespräch die Ereignisse start
/// (mit Frage), status und ende; der Satellit reicht sie als IPC-Ereignis „arbeit" (JSON im Text) weiter.
/// Eigene Anfragen dieses Geräts zeigt die App ohnehin selbst — sie werden hier übergangen.
library;

import 'dart:convert';

class FremdeArbeit {
  FremdeArbeit({required this.id, required this.faden, required this.kanal, required this.frage, required this.zuletzt});
  final String id;
  /// null = Hauptgespräch
  final String? faden;
  final String kanal;
  final String frage;
  String? status;
  DateTime zuletzt;
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
  if (von == 'sitzung:$geraetId' || von.startsWith('sitzung:$geraetId:')) return null; // eigene Anfrage
  switch (phase) {
    case 'start':
      final a = FremdeArbeit(id: id, faden: faden, kanal: '${j['kanal'] ?? 'anderer Kanal'}', frage: '${j['frage'] ?? ''}', zuletzt: jetzt);
      laufend[id] = a;
      return ('start', a);
    case 'status':
      final a = laufend[id];
      if (a == null) return null;
      a.status = '${j['text'] ?? ''}';
      a.zuletzt = jetzt;
      return ('status', a);
    case 'ende':
      final a = laufend.remove(id);
      return a == null ? null : ('ende', a);
  }
  return null;
}

/// Hängengebliebene Anzeigen entfernen (Ende verpasst, z. B. Satellit kurz getrennt): 10 min ohne Lebenszeichen.
/// Rückgabe: ob etwas entfernt wurde.
bool fremdeArbeitAufraeumen(Map<String, FremdeArbeit> laufend, DateTime jetzt) {
  final vorher = laufend.length;
  laufend.removeWhere((_, a) => jetzt.difference(a.zuletzt) > const Duration(minutes: 10));
  return laufend.length != vorher;
}
