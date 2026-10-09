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

/// Helle und dunkle Variante aus einem Samen — Aufbau wie die Vorlage des Owners (ruhige Flächen, blaue Akzente).
ThemeData alfredTheme(Brightness b) {
  final base = ThemeData(brightness: b, colorSchemeSeed: const Color(0xFF3B6FD8), useMaterial3: true);
  return base.copyWith(
    scaffoldBackgroundColor: b == Brightness.light ? const Color(0xFFFAFAFA) : base.colorScheme.surface,
    dividerColor: base.colorScheme.outlineVariant,
    cardTheme: base.cardTheme.copyWith(elevation: 0, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12), side: BorderSide(color: base.colorScheme.outlineVariant))),
  );
}
