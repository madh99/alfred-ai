/// 1.54.0 (Owner 19.10., Paket „Handy als Gerät“) — Systemzugriffe des Handys über den eigenen Kanal `alfred/system`
/// (AppDelegate.swift): Text in die Zwischenablage (vertraulich: nur dieses Gerät, verfällt nach 2 min) und der Zustand für
/// die Sinne — Akku, Netzweg, Audio-Ausgang, Modell, System, Speicher. Am Desktop gibt es den Kanal nicht.
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';

import 'einstellungen.dart';

const _kanal = MethodChannel('alfred/system');

/// Text in die Zwischenablage; `vertraulich` = nicht über die universelle Zwischenablage teilen, nach 2 min weg.
Future<bool> handyKopieren(String text, {bool vertraulich = false}) async {
  try { return await _kanal.invokeMethod<bool>('kopieren', {'text': text, 'vertraulich': vertraulich}) ?? false; }
  on MissingPluginException { await Clipboard.setData(ClipboardData(text: text)); return true; }
}

/// Zustand fürs Weltmodell; leere Karte, wenn der Kanal fehlt.
Future<Map<String, dynamic>> handyZustand() async {
  try { return Map<String, dynamic>.from(await _kanal.invokeMethod<Map<Object?, Object?>>('zustand') ?? const {}); }
  on MissingPluginException { return const {}; }
  on PlatformException { return const {}; }
}

/// Audio-Ausgänge, bei denen Antworten automatisch vorgelesen werden (Kopfhörer, Bluetooth, Auto).
const vorleseAusgaenge = {'kopfhoerer', 'bluetooth', 'auto'};

// ── 1.54.1 — Dateien von Alfred ablegen (Owner 19.10.: „Alfred“ als Standard, mehrere freigegebene Ordner, ohne Rückfrage) ──

/// Standardordner: der Dokumente-Ordner der App, in der Dateien-App unter „Auf meinem iPhone → Alfred“.
const alfredOrdner = 'Alfred';

/// Namen aller Ziele für das Manifest: „Alfred“ zuerst, dann die freigegebenen.
List<String> ablageOrdnerNamen() => [alfredOrdner, for (final o in ablageOrdnerGespeichert()) o.name];

/// Ordner freigeben (iOS-Dateien-Fenster). Ergebnis: Name, oder null = abgebrochen. Fehler mit Grund als Exception.
/// 1.54.2 — prüft nach dem Speichern, dass die Freigabe wirklich in der Liste steht (Owner-Test 20.10.: blieb ohne Wirkung).
Future<({String? name, String detail})> ordnerFreigeben() async {
  final Map<Object?, Object?>? r;
  try { r = await _kanal.invokeMethod<Map<Object?, Object?>>('ordnerWaehlen'); }
  on PlatformException catch (e) { throw Exception('iOS: ${e.message ?? e.code}'); }
  if (r == null || r['abgebrochen'] == true) return (name: null, detail: 'Auswahl abgebrochen (kein Ordner zurückgegeben)');
  final name = r['name'], bookmark = r['bookmark'];
  if (name is! String || bookmark is! Uint8List) throw Exception('unerwartete Antwort von iOS: ${r.keys.join(', ')}');
  final neu = [for (final o in ablageOrdnerGespeichert()) if (o.name.toLowerCase() != name.toLowerCase()) o, (name: name, bookmark: base64Encode(bookmark))];
  ablageOrdnerSpeichern(neu);
  if (!ablageOrdnerGespeichert().any((o) => o.name == name)) throw Exception('Freigabe nicht gespeichert — Einstellungsdatei nicht schreibbar (${einstellungsDatei()})');
  return (name: name, detail: 'Pfad ${r['pfad']}, Zugriff ${r['zugriff']}, Bookmark ${bookmark.length} B');
}

void ordnerEntfernen(String name) => ablageOrdnerSpeichern([for (final o in ablageOrdnerGespeichert()) if (o.name != name) o]);

/// `name` ohne Pfadanteile, ohne Steuerzeichen; nie leer.
String sichererName(String name) {
  final n = name.split(RegExp(r'[\\/]')).last.replaceAll(RegExp(r'[\x00-\x1f:*?"<>|]'), '_').trim();
  return n.isEmpty || n == '.' || n == '..' ? 'datei' : n;
}

/// Freier Name im Ordner: „x.pdf“, sonst „x (1).pdf“, „x (2).pdf“ …
String freierName(String name, bool Function(String) belegt) {
  if (!belegt(name)) return name;
  final punkt = name.lastIndexOf('.');
  final basis = punkt > 0 ? name.substring(0, punkt) : name, endung = punkt > 0 ? name.substring(punkt) : '';
  for (var n = 1; n < 1000; n++) { final k = '$basis ($n)$endung'; if (!belegt(k)) return k; }
  return '$basis (${DateTime.now().millisecondsSinceEpoch})$endung';
}

/// Datei ablegen; Ergebnis „Ordner/Name“. Unbekannter Ordner → Fehler mit der Liste der freigegebenen.
Future<String> dateiAblegen(String? ordner, String name, Uint8List daten) async {
  final dateiname = sichererName(name);
  final ziel = (ordner ?? '').trim();
  if (ziel.isEmpty || ziel.toLowerCase() == alfredOrdner.toLowerCase()) {
    final dir = await getApplicationDocumentsDirectory();
    final frei = freierName(dateiname, (n) => File('${dir.path}/$n').existsSync());
    await File('${dir.path}/$frei').writeAsBytes(daten, flush: true);
    return '$alfredOrdner/$frei';
  }
  final o = ablageOrdnerGespeichert().where((x) => x.name.toLowerCase() == ziel.toLowerCase()).firstOrNull;
  if (o == null) throw Exception('Ordner „$ziel“ ist nicht freigegeben. Freigegeben: ${ablageOrdnerNamen().join(', ')}');
  final r = await _kanal.invokeMethod<Map<Object?, Object?>>('ordnerSchreiben', {'bookmark': base64Decode(o.bookmark), 'name': dateiname, 'daten': daten});
  final neu = r?['bookmark'];
  if (neu is Uint8List) ablageOrdnerSpeichern([for (final x in ablageOrdnerGespeichert()) x.name == o.name ? (name: x.name, bookmark: base64Encode(neu)) : x]); // veraltete Freigabe erneuert
  return '${o.name}/${r?['name'] ?? dateiname}';
}

// ── 1.54.2 — Fotos und Bilder ins Chat (Owner 20.10.: Plus-Menü nur Dateien, Einfügen ging nicht) ──

/// Fotos aus der Mediathek (mehrere); Pfade der JPEG-Dateien, leer = abgebrochen.
Future<List<String>> fotosWaehlen() async => ((await _kanal.invokeMethod<List<Object?>>('fotosWaehlen')) ?? const []).whereType<String>().toList();

/// Foto mit der Kamera aufnehmen.
Future<List<String>> kameraFoto() async => ((await _kanal.invokeMethod<List<Object?>>('kamera')) ?? const []).whereType<String>().toList();

/// Bild aus der Zwischenablage als JPEG-Datei, null = kein Bild.
Future<String?> zwischenablageBildPfad() async {
  try { return await _kanal.invokeMethod<String>('zwischenablageBild'); } on MissingPluginException { return null; }
}

/// 1.54.4 — Datei in der iOS-Vorschau (Quick Look) zeigen: Bilder vergrößern, PDF/Office ansehen, Teilen/Sichern.
Future<bool> handyVorschau(String pfad) async {
  try { return await _kanal.invokeMethod<bool>('vorschau', {'pfad': pfad}) ?? false; } on MissingPluginException { return false; }
}

// ── v1522 — Standortzonen (iOS überwacht sie selbst, Meldung nativ an den Server) ──

/// Zonen an iOS übergeben (ersetzt die überwachten Zonen); höchstens 10.
Future<void> zonenAnIos() async {
  try { await _kanal.invokeMethod('zonenSetzen', {'zonen': [for (final z in standortZonenGespeichert()) {'name': z.name, 'breite': z.breite, 'laenge': z.laenge, 'radius': z.radius}]}); } on MissingPluginException { /* Desktop */ }
}

/// Erlaubnis „Immer“ anfragen (iOS fragt in zwei Schritten). Ergebnis: immer | beimBenutzen | abgelehnt | offen.
Future<String> zonenErlaubnis() async => await _kanal.invokeMethod<String>('zonenErlaubnis') ?? 'offen';
Future<String> zonenStatus() async { try { return await _kanal.invokeMethod<String>('zonenStatus') ?? 'offen'; } on MissingPluginException { return 'offen'; } }

/// Aktueller Ort (einmalig, für „Zone hier anlegen“); null = nicht ermittelbar.
Future<({double breite, double laenge, double genau})?> ortJetzt() async {
  final r = await _kanal.invokeMethod<Map<Object?, Object?>>('ortJetzt');
  if (r == null || r['breite'] is! num || r['laenge'] is! num) return null;
  return (breite: (r['breite'] as num).toDouble(), laenge: (r['laenge'] as num).toDouble(), genau: ((r['genau'] as num?) ?? 0).toDouble());
}

/// Zone hinzufügen oder gleichnamige ersetzen, dann an iOS.
Future<void> zoneSetzen(String name, double breite, double laenge, {double radius = 150}) async {
  standortZonenSpeichern([for (final z in standortZonenGespeichert()) if (z.name.toLowerCase() != name.toLowerCase()) z, (name: name, breite: breite, laenge: laenge, radius: radius)]);
  await zonenAnIos();
}

Future<void> zoneEntfernen(String name) async {
  standortZonenSpeichern([for (final z in standortZonenGespeichert()) if (z.name != name) z]);
  await zonenAnIos();
}

// ── v1526 — Zonenkarte und Bewegung ──

/// Karte mit allen Zonen öffnen (Adresssuche, langes Tippen, verschieben, Umkreis); übernommen → speichern und an iOS.
/// Ergebnis: true = geändert.
Future<bool> zonenKarteOeffnen() async {
  final r = await _kanal.invokeMethod<List<Object?>>('zonenKarte', {'zonen': [for (final z in standortZonenGespeichert()) {'name': z.name, 'breite': z.breite, 'laenge': z.laenge, 'radius': z.radius}]});
  if (r == null) return false;
  standortZonenSpeichern([for (final e in r) if (e is Map && e['name'] is String && e['breite'] is num && e['laenge'] is num) (name: e['name'] as String, breite: (e['breite'] as num).toDouble(), laenge: (e['laenge'] as num).toDouble(), radius: ((e['radius'] as num?) ?? 150).toDouble())]);
  await zonenAnIos();
  return true;
}

/// Bewegung: erlaubt | abgelehnt | offen | nichtVerfuegbar
Future<String> bewegungStatus() async { try { return await _kanal.invokeMethod<String>('bewegungStatus') ?? 'offen'; } on MissingPluginException { return 'nichtVerfuegbar'; } }
Future<String> bewegungErlaubnis() async => await _kanal.invokeMethod<String>('bewegungErlaubnis') ?? 'offen';
