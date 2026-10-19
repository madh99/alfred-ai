/// Phase 5 H1 (Spec Geräte §20.4) — Plattform-Weiche: Fenster, Tray, Tastenkürzel, Desktop-Benachrichtigungen, Drag & Drop,
/// IPC zum Satelliten und die App-eigene Update-Prüfung gibt es nur auf dem Desktop. Das Handy koppelt selbst und spricht
/// direkt mit dem Gehirn (handy_verbindung.dart).
library;

import 'dart:io';

final bool istHandy = Platform.isIOS || Platform.isAndroid;
final bool istDesktop = !istHandy;

/// Plattformname fürs Manifest beim Koppeln (`GeraetPlattform` am Server).
String get handyPlattform => Platform.isIOS ? 'ios' : 'android';

/// 1.54.1 — Ordner für App-Daten (Einstellungen, Anhänge). Desktop: ~/.alfred wie bisher. iOS: im App-Container sind nur
/// Library, Documents und tmp für App-Daten vorgesehen; ~/.alfred läge auf der obersten Ebene des Containers.
/// Daher Library/Application Support/alfred (nicht in der Dateien-App sichtbar, nicht vom System geleert).
String alfredDatenOrdner() {
  final heim = Platform.environment['USERPROFILE'] ?? Platform.environment['HOME'] ?? '.';
  final t = Platform.pathSeparator;
  if (Platform.isIOS) return '$heim${t}Library${t}Application Support${t}alfred';
  return '$heim$t.alfred';
}
