import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';

/// 1.1.0 (Redesign Stufe 1) — Einstellungen der App, die der Server nicht kennt: Farbschema (System/Hell/Dunkel),
/// Seitenleiste. Liegt als kleine JSON-Datei neben der Satelliten-Konfiguration (~/.alfred/app.json).
final themeModus = ValueNotifier<ThemeMode>(ThemeMode.system);

String _pfad() {
  final heim = Platform.environment['USERPROFILE'] ?? Platform.environment['HOME'] ?? '.';
  return '$heim${Platform.pathSeparator}.alfred${Platform.pathSeparator}app.json';
}

Map<String, dynamic> _lesen() {
  try {
    final f = File(_pfad());
    if (!f.existsSync()) return {};
    final j = jsonDecode(f.readAsStringSync());
    return j is Map<String, dynamic> ? j : {};
  } catch (_) { return {}; }
}

void _schreiben(Map<String, dynamic> j) {
  try {
    final f = File(_pfad());
    f.parent.createSync(recursive: true);
    f.writeAsStringSync(const JsonEncoder.withIndent('  ').convert(j));
  } catch (_) { /* Einstellungen sind Komfort */ }
}

ThemeMode _modus(Object? v) => switch (v) { 'hell' => ThemeMode.light, 'dunkel' => ThemeMode.dark, _ => ThemeMode.system };
String _modusName(ThemeMode m) => switch (m) { ThemeMode.light => 'hell', ThemeMode.dark => 'dunkel', ThemeMode.system => 'system' };

void einstellungenLaden() { themeModus.value = _modus(_lesen()['thema']); }

void themaSpeichern(ThemeMode m) {
  themeModus.value = m;
  final j = _lesen(); j['thema'] = _modusName(m); _schreiben(j);
}

bool seitenleisteGespeichert() => _lesen()['seitenleiste'] != false;
void seitenleisteSpeichern(bool offen) { final j = _lesen(); j['seitenleiste'] = offen; _schreiben(j); }

/// 1.3.0 — Aktivierungswort lokal erkennen (ONNX in der App): Standard an. Aus = jede Äußerung geht wie bisher ans Relais,
/// der Server prüft das Wort im Transkript.
bool wortLokalGespeichert() => _lesen()['wortLokal'] != false;
void wortLokalSpeichern(bool an) { final j = _lesen(); j['wortLokal'] = an; _schreiben(j); }

/// 1.5.0 — Punkt 3: Zeitpunkt der neuesten Alfred-Antwort, die im sichtbaren Fenster stand. Was danach kam (App zu,
/// ausgeblendet, Gerät aus), zeigt die App beim nächsten Öffnen als „neu" an.
DateTime? gesehenGespeichert() => DateTime.tryParse('${_lesen()['gesehen'] ?? ''}');
void gesehenSpeichern(DateTime t) { final j = _lesen(); j['gesehen'] = t.toUtc().toIso8601String(); _schreiben(j); }

/// 1.8.0 — Updates still installieren, wenn die App nicht benutzt wird (Standard an; Linux immer mit Klick).
bool stillUpdateGespeichert() => _lesen()['stillUpdate'] != false;
void stillUpdateSpeichern(bool an) { final j = _lesen(); j['stillUpdate'] = an; _schreiben(j); }

/// 1.36.0 — Navigation breit (mit Beschriftung) oder schmal (nur Symbole); Standard breit.
bool navBreitGespeichert() => _lesen()['navBreit'] != false;
void navBreitSpeichern(bool breit) { final j = _lesen(); j['navBreit'] = breit; _schreiben(j); }

/// 1.36.0 — Erscheinungsbild aus dem App-Icon (Owner 16.10.: „die App insgesamt sehr plump in der UI"): Blau als Hauptfarbe,
/// Cyan als Akzent, Violett als dritte Farbe; leicht bläuliche Flächen, weiche Karten, klare Schrift-Hierarchie.
ThemeData alfredTheme(Brightness b) {
  final hell = b == Brightness.light;
  final cs = ColorScheme.fromSeed(seedColor: const Color(0xFF5B6CF0), brightness: b).copyWith(
    primary: hell ? const Color(0xFF4458DB) : const Color(0xFF9AAAFF),
    onPrimary: hell ? Colors.white : const Color(0xFF0B1240),
    primaryContainer: hell ? const Color(0xFFE2E6FF) : const Color(0xFF2A3486),
    onPrimaryContainer: hell ? const Color(0xFF14206E) : const Color(0xFFE2E6FF),
    secondary: hell ? const Color(0xFF00809F) : const Color(0xFF4FD8F2),
    secondaryContainer: hell ? const Color(0xFFD3F4FB) : const Color(0xFF00485A),
    onSecondaryContainer: hell ? const Color(0xFF003A48) : const Color(0xFFCFF6FD),
    tertiary: hell ? const Color(0xFF7448D9) : const Color(0xFFC0A6FF),
    surface: hell ? const Color(0xFFF7F8FD) : const Color(0xFF10131F),
    surfaceContainerLowest: hell ? Colors.white : const Color(0xFF0B0D17),
    surfaceContainerLow: hell ? const Color(0xFFF1F3FB) : const Color(0xFF151927),
    surfaceContainer: hell ? const Color(0xFFEBEEF8) : const Color(0xFF1A1F2F),
    surfaceContainerHigh: hell ? const Color(0xFFE4E8F5) : const Color(0xFF212739),
    surfaceContainerHighest: hell ? const Color(0xFFDCE1F1) : const Color(0xFF293044),
    outlineVariant: hell ? const Color(0xFFD7DCEC) : const Color(0xFF2E3549),
  );
  final base = ThemeData(colorScheme: cs, useMaterial3: true, visualDensity: VisualDensity.standard);
  final tt = base.textTheme;
  return base.copyWith(
    scaffoldBackgroundColor: cs.surface,
    dividerColor: cs.outlineVariant,
    textTheme: tt.copyWith(
      headlineSmall: tt.headlineSmall?.copyWith(fontWeight: FontWeight.w700, letterSpacing: -0.3),
      titleLarge: tt.titleLarge?.copyWith(fontWeight: FontWeight.w700, letterSpacing: -0.2),
      titleMedium: tt.titleMedium?.copyWith(fontWeight: FontWeight.w600),
      titleSmall: tt.titleSmall?.copyWith(fontWeight: FontWeight.w600),
      labelLarge: tt.labelLarge?.copyWith(fontWeight: FontWeight.w600),
    ),
    cardTheme: base.cardTheme.copyWith(
      elevation: 0, color: hell ? Colors.white : cs.surfaceContainerLow, surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14), side: BorderSide(color: cs.outlineVariant)),
    ),
    chipTheme: base.chipTheme.copyWith(shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)), side: BorderSide(color: cs.outlineVariant)),
    dialogTheme: base.dialogTheme.copyWith(shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)), backgroundColor: hell ? Colors.white : cs.surfaceContainer),
    filledButtonTheme: FilledButtonThemeData(style: FilledButton.styleFrom(shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)))),
    outlinedButtonTheme: OutlinedButtonThemeData(style: OutlinedButton.styleFrom(shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)), side: BorderSide(color: cs.outlineVariant))),
    inputDecorationTheme: base.inputDecorationTheme.copyWith(border: OutlineInputBorder(borderRadius: BorderRadius.circular(12))),
    tooltipTheme: TooltipThemeData(waitDuration: const Duration(milliseconds: 400), decoration: BoxDecoration(color: cs.inverseSurface, borderRadius: BorderRadius.circular(8)), textStyle: TextStyle(color: cs.onInverseSurface, fontSize: 12)),
  );
}
