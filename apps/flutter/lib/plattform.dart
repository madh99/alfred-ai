/// Phase 5 H1 (Spec Geräte §20.4) — Plattform-Weiche: Fenster, Tray, Tastenkürzel, Desktop-Benachrichtigungen, Drag & Drop,
/// IPC zum Satelliten und die App-eigene Update-Prüfung gibt es nur auf dem Desktop. Das Handy koppelt selbst und spricht
/// direkt mit dem Gehirn (handy_verbindung.dart).
library;

import 'dart:io';

final bool istHandy = Platform.isIOS || Platform.isAndroid;
final bool istDesktop = !istHandy;

/// Plattformname fürs Manifest beim Koppeln (`GeraetPlattform` am Server).
String get handyPlattform => Platform.isIOS ? 'ios' : 'android';
