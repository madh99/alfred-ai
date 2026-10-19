/// 1.54.0 (Owner 19.10., Paket „Handy als Gerät“) — Systemzugriffe des Handys über den eigenen Kanal `alfred/system`
/// (AppDelegate.swift): Text in die Zwischenablage (vertraulich: nur dieses Gerät, verfällt nach 2 min) und der Zustand für
/// die Sinne — Akku, Netzweg, Audio-Ausgang, Modell, System, Speicher. Am Desktop gibt es den Kanal nicht.
library;

import 'package:flutter/services.dart';

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
