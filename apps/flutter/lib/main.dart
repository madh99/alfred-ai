import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:hotkey_manager/hotkey_manager.dart';
import 'package:local_notifier/local_notifier.dart';
import 'package:tray_manager/legacy.dart'; // trayManager, Menu, MenuItem, TrayListener (0.5-kompatible API)
import 'package:window_manager/window_manager.dart';

import 'package:package_info_plus/package_info_plus.dart';
import 'package:path_provider/path_provider.dart';

import 'package:file_selector/file_selector.dart';

import 'audio.dart';
import 'einstellungen.dart';
import 'hoeren.dart';
import 'update.dart';
import 'ipc.dart';
import 'kacheln.dart';
import 'linux_hotkey.dart';
import 'modell.dart';
import 'server.dart';
import 'transfer.dart';
import 'package:desktop_drop/desktop_drop.dart';

/// Alfred — Desktop-App, Phase 4 (Spec docs/specs/2026-10-07-flutter-app-phase4.md).
/// Meilenstein 1: hängt sich an den Satelliten (IPC), spricht per HTTP mit dem Gehirn, zeigt Verlauf, streamt Antworten,
/// stellt Bestätigungen mit Buttons dar. Meilenstein 2: Push-to-Talk mit globalem Tastenkürzel (Strg+Alt+Leertaste),
/// gesprochene Antwort, App im Tray (Schließen = ausblenden), Systembenachrichtigung bei neuer Bestätigung,
/// Fenstertitel mit Bestätigungszahl.
///
/// Startargumente: `--protokoll <datei>` schreibt jede Verlaufszeile in die Datei (Beweise, Fehlersuche),
/// `--sende "<text>"` schickt nach dem Anhängen eine Nachricht, `--sprachtest <wav>` schickt eine Aufnahme durch
/// Transkription, Chat und Sprachausgabe (Beweislauf ohne Mikrofon).
late final Map<String, String> startArgs;

Future<void> main(List<String> args) async {
  // 1.0.3 — Linux/Wayland: zweiter Prozess aus dem GNOME-Tastenkürzel signalisiert der laufenden App und endet
  if (Platform.isLinux && args.contains('--sprechen')) { exit(await LinuxHotkey.signal() ? 0 : 1); }
  final m = <String, String>{};
  for (var i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length) { m[args[i].substring(2)] = args[i + 1]; i++; }
  }
  startArgs = m;
  WidgetsFlutterBinding.ensureInitialized();
  einstellungenLaden(); // 1.1.0 — Farbschema vor dem ersten Bild
  await windowManager.ensureInitialized();
  await windowManager.waitUntilReadyToShow(const WindowOptions(title: 'Alfred', size: Size(1180, 800), minimumSize: Size(640, 480), center: true), () async {
    await windowManager.show();
    await windowManager.focus();
  });
  try { await hotKeyManager.unregisterAll(); } catch (_) {}
  // Systembenachrichtigungen über local_notifier (WinToast, ohne ATL — flutter_local_notifications brauchte atlbase.h der VS-Build-Tools)
  // Windows: local_notifier legt für die App-Identität eine Startmenü-Verknüpfung „Alfred.lnk" an und lässt sie danach in Ruhe.
  // Zeigt sie auf eine alte Exe (Realfall 09.10.: alfred_app.exe → Alfred.exe), übernimmt die Taskleiste deren altes Symbol.
  // Deshalb vor dem Setup entfernen; sie wird gleich für die laufende Exe neu angelegt.
  if (Platform.isWindows) {
    try { final lnk = File('${Platform.environment['APPDATA']}\\Microsoft\\Windows\\Start Menu\\Programs\\Alfred.lnk'); if (await lnk.exists()) await lnk.delete(); } catch (_) { /* dann bleibt die alte */ }
  }
  try { await localNotifier.setup(appName: 'Alfred', shortcutPolicy: ShortcutPolicy.requireCreate); } catch (_) { /* ohne Benachrichtigungen weiter */ }
  // M6 macOS — Autostart als LaunchAgent (Windows: Installer-Option, Linux: /etc/xdg/autostart aus dem Paket).
  // Nur wenn die App aus einem Bundle läuft; die Datei zeigt immer auf das aktuelle Bundle (nach Updates/Verschieben neu).
  if (Platform.isMacOS) {
    try {
      final bundle = AppUpdate.eigenesBundle();
      if (bundle != null) {
        final dir = Directory('${Platform.environment['HOME']}/Library/LaunchAgents');
        await dir.create(recursive: true);
        final plist = File('${dir.path}/at.alfred.app.plist');
        final inhalt = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>at.alfred.app</string>\n<key>ProgramArguments</key><array><string>$bundle/Contents/MacOS/Alfred</string></array>\n<key>RunAtLoad</key><true/>\n<key>ProcessType</key><string>Interactive</string>\n</dict></plist>\n';
        if (!await plist.exists() || await plist.readAsString() != inhalt) await plist.writeAsString(inhalt);
      }
    } catch (_) { /* Autostart ist Komfort */ }
  }
  runApp(const AlfredApp());
}

class AlfredApp extends StatelessWidget {
  const AlfredApp({super.key});

  @override
  Widget build(BuildContext context) {
    // 1.1.0 — hell als Standard, dunkel folgt dem System oder der Einstellung (Redesign Stufe 1, Owner-Vorlage 09.10.)
    return ValueListenableBuilder<ThemeMode>(
      valueListenable: themeModus,
      builder: (context, modus, _) => MaterialApp(
        title: 'Alfred',
        debugShowCheckedModeBanner: false,
        theme: alfredTheme(Brightness.light),
        darkTheme: alfredTheme(Brightness.dark),
        themeMode: modus,
        home: const Sitzung(),
      ),
    );
  }
}

class Sitzung extends StatefulWidget {
  const Sitzung({super.key});

  @override
  State<Sitzung> createState() => _SitzungState();
}

class _SitzungState extends State<Sitzung> with WindowListener, TrayListener {
  final List<Eintrag> verlauf = [];
  final List<Bestaetigung> offen = [];
  final Set<String> gemeldet = {};
  final TextEditingController eingabe = TextEditingController();
  final ScrollController scroll = ScrollController();
  final FocusNode fokus = FocusNode();
  final Audio audio = Audio();

  SatellitStatus? satellit;
  String ipcZustand = 'verbinde …';
  Konfig? konfig;
  Server? server;
  Eintrag? laufend;
  String fluechtig = '';
  bool antwortet = false;
  bool stimme = false;
  bool aufnahme = false;
  bool sichtbar = true;
  bool kachelnOffen = false; // Meilenstein 3 — Kacheln nativ statt Webview
  /// 1.1.0 — Redesign Stufe 1: Symbolleiste links (Chat, Lage, Bestätigungen, Einstellungen), einklappbare Seitenleiste,
  /// Chat mittig mit Datumstrennern, Eingabekarte mit Stufenwahl.
  Ansicht ansicht = Ansicht.chat;
  bool seitenleisteOffen = seitenleisteGespeichert();
  String? tierWahl; // null = Automatisch, sonst fast/default/strong
  List<Map<String, dynamic>> vorgaenge = [];
  Timer? vorgaengeTakt;
  bool hoeren = false; // Meilenstein 4 — Echtzeit-Hören mit Aktivierungswort
  HoerClient? hoerClient;
  SatzendeErkenner? erkenner;
  DateTime gespraechsfensterBis = DateTime.fromMillisecondsSinceEpoch(0);
  String gehoert = '';
  /// Hineingezogene Dateien warten als Anhänge in der Eingabezeile, bis gesendet wird (Owner 09.10.: nicht sofort schicken).
  final List<File> anhaenge = [];
  /// M6 — Selbstupdate über den Server: eigene Version, gefundenes Update, Prüf-Takt.
  String appVersion = '';
  UpdateInfo? update;
  bool updateLaeuft = false;
  Timer? updateTakt;
  Timer? abfrage;
  int benachrichtigungNr = 0;
  late final IpcVerbindung ipc;
  final HotKey tastenkuerzel = HotKey(key: PhysicalKeyboardKey.space, modifiers: [HotKeyModifier.control, HotKeyModifier.alt], scope: HotKeyScope.system);

  @override
  void initState() {
    super.initState();
    windowManager.addListener(this);
    trayManager.addListener(this);
    windowManager.setPreventClose(true);
    _trayEinrichten();
    _tastenkuerzelEinrichten();
    ipc = IpcVerbindung(
      aufStatus: (s) => setState(() => satellit = s),
      aufEreignis: (art, text, zeit, anhang, faden) {
        if (art == 'gespraech') { // 1.2.1 / v1330 — das Gespräch lief anderswo weiter (Telegram, andere App): nachladen
          if (text == server?.chatId) return; // eigene Nachricht
          if (faden == server?.faden) { _gespraechNachladen(); } else { _faedenLaden(); }
          return;
        }
        if (art == 'nachricht') { // v1318 — Ergebnis nach Freigabe; 1.0.5 — mit Anhang (Foto, Bildschirmfoto, Datei)
          if (faden != server?.faden) { // 1.2.0 — Antwort gehört zu einem anderen Gespräch: Hinweis mit Sprungmarke
            _zeile(Eintrag(Art.hinweis, '💬 Antwort im Gespräch „${_fadenTitel(faden)}“: ${text.isEmpty && anhang != null ? '📎 ${anhang.name}' : (text.length > 80 ? '${text.substring(0, 80)}…' : text)} — in der Seitenleiste öffnen'));
            _faedenLaden();
            return;
          }
          // 1.2.5 — Anhang ohne Text direkt nach einer Alfred-Antwort: an diese hängen statt eigene Zeile (zwei Pushes vom Server)
          if (text.isEmpty && anhang != null && verlauf.isNotEmpty && verlauf.last.art == Art.alfred && zeit.difference(verlauf.last.zeit).inSeconds.abs() <= 10) {
            setState(() => verlauf.last.anhaenge.add(anhang)); _nachUnten(); return;
          }
          _zeile(Eintrag(Art.alfred, text.isEmpty && anhang != null ? '📎 ${anhang.name}' : text, zeit: zeit, anhaenge: anhang == null ? null : [anhang]));
          if (stimme && text.isNotEmpty) _sprichKurz(text);
          return;
        }
        _zeile(Eintrag(Art.satellit, text, zeit: zeit));
      },
      aufBestaetigung: _meldeNeu,
      aufKonfig: (k) {
        final erste = server == null;
        setState(() { konfig = k; server = Server(k); });
        _titel();
        if (erste) _holeVerlauf(); // v1314 — was zuletzt besprochen wurde
        _holeBestaetigungen();
        abfrage ??= Timer.periodic(const Duration(seconds: 4), (_) => _holeBestaetigungen());
        if (erste) { _updatePruefen(); updateTakt ??= Timer.periodic(const Duration(hours: 6), (_) => _updatePruefen()); } // M6
        if (erste) { _vorgaengeLaden(); vorgaengeTakt ??= Timer.periodic(const Duration(seconds: 60), (_) => _vorgaengeLaden()); } // 1.1.0 Seitenleiste
        if (erste) _faedenLaden(); // 1.2.0 Gespräche
        if (erste) _spiegelungLaden(); // 1.2.3
        if (erste) {
          final auto = startArgs['sende'];
          if (auto != null && auto.isNotEmpty) { eingabe.text = auto; Future.delayed(const Duration(milliseconds: 800), _senden); }
          final wav = startArgs['sprachtest'];
          if (wav != null && wav.isNotEmpty) Future.delayed(const Duration(milliseconds: 800), () => _sprachtest(wav));
          if (startArgs['kacheln'] == 'an') setState(() { kachelnOffen = true; ansicht = Ansicht.kacheln; }); // Beweislauf: Kacheln sofort öffnen
          if (startArgs['hoeren'] == 'an') Future.delayed(const Duration(milliseconds: 800), _hoerenStart); // Meilenstein 4
          final hoertest = startArgs['hoertest'];
          if (hoertest != null && hoertest.isNotEmpty) Future.delayed(const Duration(milliseconds: 800), () => _hoertest(hoertest));
          final datei = startArgs['datei']; // Meilenstein 3: Beweislauf Datei zum Gehirn
          if (datei != null && datei.isNotEmpty) Future.delayed(const Duration(milliseconds: 800), () { _dateienAbgelegt([datei]); _senden(); }); // Beweislauf: Anhang + sofort senden
        }
      },
      aufZustand: (z) => setState(() => ipcZustand = z),
    );
    ipc.start();
    _zeile(Eintrag(Art.hinweis, 'Alfred-App — Verlauf, Chat und Bestätigungen laufen über den Satelliten dieses Geräts. Strg+Alt+Leertaste: sprechen (auch aus anderen Programmen).'));
  }

  @override
  void dispose() {
    abfrage?.cancel();
    vorgaengeTakt?.cancel();
    _signal?.cancel();
    hoerClient?.schluss();
    ipc.stop();
    windowManager.removeListener(this);
    trayManager.removeListener(this);
    hotKeyManager.unregisterAll();
    audio.dispose();
    super.dispose();
  }

  // ── Tray, Fenster, Tastenkürzel (Meilenstein 2) ──────────────────────────────────────────────────────────────────
  Future<void> _trayEinrichten() async {
    try {
      await trayManager.setIcon(Platform.isWindows ? 'assets/alfred.ico' : 'assets/alfred.png'); // M5: macOS/Linux brauchen PNG
      await trayManager.setToolTip('Alfred');
      await trayManager.setContextMenu(Menu(items: [
        MenuItem(key: 'zeigen', label: 'Alfred öffnen'),
        MenuItem(key: 'sprechen', label: 'Sprechen (Strg+Alt+Leertaste)'),
        MenuItem.separator(),
        MenuItem(key: 'beenden', label: 'Beenden'),
      ]));
    } catch (e) { _zeile(Eintrag(Art.fehler, 'Tray nicht verfügbar: $e')); }
  }

  StreamSubscription<ProcessSignal>? _signal;

  Future<void> _tastenkuerzelEinrichten() async {
    if (Platform.isLinux) {
      // 1.0.3 — Wayland: keybinder kann nicht binden; GNOME-Kürzel + SIGUSR1 (linux_hotkey.dart). Unter X11 zusätzlich wie bisher.
      _signal = LinuxHotkey.hoere(_talkUmschalten);
      final m = await LinuxHotkey.einrichten();
      if (m != null) _zeile(Eintrag(Art.hinweis, m));
      if (LinuxHotkey.wayland) return;
    }
    try {
      await hotKeyManager.register(tastenkuerzel, keyDownHandler: (_) => _talkUmschalten());
    } catch (e) { _zeile(Eintrag(Art.fehler, 'Tastenkürzel nicht registriert: $e')); }
  }

  @override
  void onWindowClose() async {
    // Schließen = in den Tray; Beenden über das Tray-Menü
    await windowManager.hide();
    setState(() => sichtbar = false);
  }

  @override
  void onWindowFocus() { sichtbar = true; }

  @override
  void onTrayIconMouseDown() { _zeigen(); }

  @override
  void onTrayIconRightMouseDown() { trayManager.popUpContextMenu(); }

  @override
  void onTrayMenuItemClick(MenuItem menuItem) {
    switch (menuItem.key) {
      case 'zeigen': _zeigen();
      case 'sprechen': _talkUmschalten();
      case 'beenden': _beenden();
    }
  }

  Future<void> _zeigen() async {
    await windowManager.show();
    await windowManager.focus();
    setState(() => sichtbar = true);
  }

  Future<void> _beenden() async {
    abfrage?.cancel();
    hoerClient?.schluss();
    ipc.stop();
    try { await trayManager.destroy(); } catch (_) {}
    await windowManager.setPreventClose(false);
    await windowManager.destroy();
    exit(0);
  }

  Future<void> _titel() async {
    final geraet = konfig?.name ?? satellit?.name ?? 'Alfred';
    try { await windowManager.setTitle(offen.isEmpty ? 'Alfred — $geraet' : 'Alfred — $geraet · ${offen.length} ${offen.length == 1 ? 'Bestätigung' : 'Bestätigungen'}'); } catch (_) {}
  }

  Future<void> _benachrichtige(Bestaetigung b) async {
    if (sichtbar) return;
    try {
      benachrichtigungNr++;
      final n = LocalNotification(title: 'Alfred — Bestätigung', body: b.text.length > 180 ? '${b.text.substring(0, 180)}…' : b.text);
      n.onClick = () => _zeigen();
      await n.show();
    } catch (_) {}
  }

  // ── Sprache ─────────────────────────────────────────────────────────────────────────────────────────────────────
  Future<void> _talkUmschalten() async {
    if (aufnahme) { await _talkStop(); return; }
    if (antwortet) return;
    if (hoeren) { _zeile(Eintrag(Art.hinweis, '🎧 Zuhören läuft — einfach „${konfig?.aktivierungswort ?? 'Alfred'}, …“ sagen.')); return; }
    bool ok;
    try { ok = await audio.aufnehmen(); } catch (e) { _zeile(Eintrag(Art.fehler, 'Mikrofon: $e')); return; } // 1.0.4 — Fehler sichtbar statt verschluckt (VM ohne Mikrofon)
    if (!ok) { _zeile(Eintrag(Art.fehler, 'Mikrofon nicht verfügbar oder nicht erlaubt')); return; }
    setState(() { aufnahme = true; fluechtig = '● Aufnahme läuft — Strg+Alt+Leertaste stoppt'; });
  }

  Future<void> _talkStop() async {
    setState(() { aufnahme = false; fluechtig = '… höre zu'; });
    final daten = await audio.stop();
    await _sprachEingabe(daten, 'audio/wav');
  }

  Future<void> _sprachEingabe(List<int> daten, String mime) async {
    final s = server;
    if (s == null) { setState(() => fluechtig = ''); return; }
    if (daten.length < 2000) { setState(() => fluechtig = ''); _zeile(Eintrag(Art.hinweis, '🎙 Aufnahme zu kurz — nichts gesendet.')); return; }
    final t0 = DateTime.now();
    try {
      final text = await s.transkribiere(daten, mime);
      if (text.isEmpty) { setState(() => fluechtig = ''); _zeile(Eintrag(Art.hinweis, '🎙 Nichts verstanden.')); return; }
      _zeile(Eintrag(Art.du, '🎙 $text'));
      await _senden(text: text, sprechen: true, seit: t0); // blockweise vorgelesen, während die Antwort noch kommt
    } catch (e) { _zeile(Eintrag(Art.fehler, '🎙 $e')); }
    finally { setState(() => fluechtig = ''); }
  }

  Future<void> _sprachtest(String wav) async {
    try {
      final daten = await File(wav).readAsBytes();
      _zeile(Eintrag(Art.hinweis, 'Sprachtest mit $wav (${(daten.length / 1024).round()} KB)'));
      await _sprachEingabe(daten, 'audio/wav');
    } catch (e) { _zeile(Eintrag(Art.fehler, 'Sprachtest: $e')); }
  }


  // ── Echtzeit-Hören (Meilenstein 4): Mikrofonstrom → Satzende lokal → Relais → Aktivierungswort → Nachricht ───────
  Future<void> _hoerenUmschalten() async { if (hoeren) { await _hoerenStop('aus'); } else { await _hoerenStart(); } }

  Future<void> _hoerenStart() async {
    final k = konfig;
    if (k == null) { _zeile(Eintrag(Art.fehler, 'Noch nicht mit dem Satelliten verbunden — $ipcZustand')); return; }
    if (hoeren) return;
    if (aufnahme) await _talkStop();
    final client = HoerClient(k, _hoerEreignis, (grund) { _zeile(Eintrag(Art.fehler, '🎧 Relais: $grund — Zuhören beendet')); _hoerenStop(null); });
    try { await client.verbinde(); } catch (e) { _zeile(Eintrag(Art.fehler, '🎧 Relais nicht erreichbar: $e')); return; }
    final erk = SatzendeErkenner();
    final ok = await audio.stromStart((pcm) {
      if (antwortet || audio.spielt) return; // Halbduplex: während Alfred antwortet oder spricht, nicht hören
      for (final ev in erk.schiebe(pcm)) {
        if (ev is SatzStart) { client.start(); client.audio(ev.audio); }
        else if (ev is SatzEnde) { client.ende(); }
      }
      if (erk.spricht) client.audio(pcm);
    }, (grund) { _zeile(Eintrag(Art.fehler, '🎧 Mikrofon: $grund')); _hoerenStop(null); });
    if (!ok) { client.schluss(); _zeile(Eintrag(Art.fehler, 'Mikrofon nicht verfügbar oder nicht erlaubt')); return; }
    hoerClient = client; erkenner = erk;
    setState(() => hoeren = true);
    _zeile(Eintrag(Art.hinweis, '🎧 Höre zu — sag „${k.aktivierungswort}, …". Nach einer Antwort 20 s ohne Wort. „${k.aktivierungswort}, stopp" bricht die Wiedergabe ab.'));
  }

  Future<void> _hoerenStop(String? meldung) async {
    final c = hoerClient; hoerClient = null; erkenner = null;
    await audio.stromStop();
    try { c?.schluss(); } catch (_) {}
    if (!mounted) return;
    setState(() { hoeren = false; if (fluechtig.startsWith('🎧')) fluechtig = ''; });
    if (meldung != null) _zeile(Eintrag(Art.hinweis, '🎧 Zuhören $meldung.'));
  }

  void _hoerEreignis(HoerEreignis e) {
    final k = konfig; if (k == null) return;
    if (e.typ == 'delta') { gehoert += e.text ?? ''; setState(() => fluechtig = '🎧 ${gehoert.length > 100 ? gehoert.substring(gehoert.length - 100) : gehoert}'); }
    else if (e.typ == 'fertig') {
      final text = (e.text ?? '').trim(); gehoert = '';
      setState(() => fluechtig = '');
      if (text.isEmpty) return;
      final a = pruefeAktivierung(text, k.aktivierungswort, DateTime.now().isBefore(gespraechsfensterBis));
      switch (a.art) {
        case AktivierungsArt.ignoriert: _zeile(Eintrag(Art.hinweis, '(nicht an mich: $text)'));
        case AktivierungsArt.stopp: audio.abbrechen(); _zeile(Eintrag(Art.hinweis, '⏹ gestoppt')); gespraechsfensterBis = DateTime.now().add(const Duration(seconds: 20));
        case AktivierungsArt.nurWort: gespraechsfensterBis = DateTime.now().add(const Duration(seconds: 20)); _zeile(Eintrag(Art.du, '🎧 $text')); _sprichKurz('Ja?');
        case AktivierungsArt.nachricht:
          _zeile(Eintrag(Art.du, '🎧 ${a.text}'));
          _senden(text: a.text, sprechen: true).then((_) { gespraechsfensterBis = DateTime.now().add(const Duration(seconds: 20)); });
      }
    }
    else if (e.typ == 'fehler' || e.typ == 'limit') _zeile(Eintrag(Art.fehler, '🎧 ${e.typ}: ${e.grund ?? ''}'));
  }

  Future<void> _sprichKurz(String text) async {
    final s = server; if (s == null) return;
    try { final (b, mime) = await s.sprich(text); await audio.abspielen(Uint8List.fromList(b), mime); } catch (e) { _zeile(Eintrag(Art.fehler, '🔊 $e')); }
  }

  /// Beweislauf: WAV durch dieselbe Kette (Satzende → Relais → Aktivierung) schicken, in Echtzeit-Blöcken von 80 ms.
  Future<void> _hoertest(String wav) async {
    try {
      final pcm = wavZuPcm16k(await File(wav).readAsBytes());
      _zeile(Eintrag(Art.hinweis, 'Hörtest mit $wav (${(pcm.length / 32000).toStringAsFixed(1)} s Audio); Gesprächsfenster offen, als hätte Alfred gerade geantwortet'));
      final k = konfig!;
      final erk = SatzendeErkenner();
      final client = HoerClient(k, _hoerEreignis, (grund) => _zeile(Eintrag(Art.fehler, '🎧 Relais: $grund')));
      await client.verbinde();
      gespraechsfensterBis = DateTime.now().add(const Duration(seconds: 60));
      final t0 = DateTime.now();
      var saetze = 0;
      for (var off = 0; off < pcm.length; off += 2560) {
        final block = Uint8List.sublistView(pcm, off, off + 2560 > pcm.length ? pcm.length : off + 2560);
        for (final ev in erk.schiebe(block)) {
          if (ev is SatzStart) { client.start(); client.audio(ev.audio); saetze++; }
          else if (ev is SatzEnde) { client.ende(); _zeile(Eintrag(Art.hinweis, '🎧 Satzende nach ${ev.dauerMs} ms Sprache (${DateTime.now().difference(t0).inMilliseconds} ms)')); }
        }
        if (erk.spricht) client.audio(block);
        await Future.delayed(const Duration(milliseconds: 80));
      }
      for (final ev in erk.schliesse()) { if (ev is SatzEnde) { client.ende(); _zeile(Eintrag(Art.hinweis, '🎧 Satzende am Stromende nach ${ev.dauerMs} ms Sprache')); } }
      _zeile(Eintrag(Art.hinweis, '🎧 Hörtest: Audio gesendet, $saetze Äußerung(en) erkannt'));
      await Future.delayed(const Duration(seconds: 8));
      client.schluss();
    } catch (e) { _zeile(Eintrag(Art.fehler, 'Hörtest: $e')); }
  }

  // ── Selbstupdate (M6): Server kennt den neuesten Installer je Plattform ──────────────────────────────────────────
  Future<void> _updatePruefen() async {
    final s = server; if (s == null) return;
    if (appVersion.isEmpty) { try { final p = await PackageInfo.fromPlatform(); appVersion = p.version; } catch (_) { appVersion = '0.0.0'; } }
    final u = await AppUpdate(s, appVersion).pruefe();
    if (!mounted || u == null) return;
    if (update?.version != u.version) {
      setState(() => update = u);
      _zeile(Eintrag(Art.hinweis, '⬆ Update ${u.version} verfügbar (du hast $appVersion) — Knopf in der Titelleiste installiert es.'));
      if (startArgs['update'] == 'sofort') _updateInstallieren(); // Beweislauf: ohne Klick installieren
    }
  }

  Future<void> _updateInstallieren() async {
    final s = server; final u = update;
    if (s == null || u == null || updateLaeuft) return;
    setState(() => updateLaeuft = true);
    try {
      final f = await AppUpdate(s, appVersion).lade(u, fortschritt: (g, ges) => setState(() => fluechtig = '⬆ ${u.datei}: ${ges > 0 ? (100 * g / ges).round() : 0} %'));
      _zeile(Eintrag(Art.hinweis, '⬆ ${u.datei} geladen, Prüfsumme stimmt — Installer startet.'));
      final beenden = await AppUpdate(s, appVersion).installiere(f, melde: (t) => _zeile(Eintrag(Art.hinweis, '⬆ $t')));
      if (beenden) { await Future.delayed(const Duration(milliseconds: 800)); exit(0); }
    } catch (e) { _zeile(Eintrag(Art.fehler, '⬆ Update: $e')); }
    finally { if (mounted) setState(() { updateLaeuft = false; fluechtig = ''; }); }
  }

  // ── Verlauf, Bestätigungen, Chat (Meilenstein 1) ────────────────────────────────────────────────────────────────
  // ── Dateien (Meilenstein 3): per Drag-and-drop ins Fenster → Dateispeicher des Owners, dann Alfred Bescheid geben ──
  /// Hineingezogene Dateien werden Anhänge der Eingabezeile; hochgeladen wird erst beim Senden (mit oder ohne Text).
  void _dateienAbgelegt(List<String> pfade) {
    for (final p in pfade) {
      final f = File(p);
      if (!f.existsSync()) { _zeile(Eintrag(Art.fehler, 'Keine Datei: $p')); continue; }
      if (anhaenge.any((a) => a.path == f.path)) continue;
      setState(() => anhaenge.add(f));
    }
    fokus.requestFocus();
  }

  /// Anhänge blockweise in den Dateispeicher des Owners laden; liefert die Zeilen für die Nachricht an Alfred.
  Future<List<String>> _anhaengeHochladen() async {
    final k = konfig!;
    final t = Transfer(k);
    final zeilen = <String>[];
    for (final f in List<File>.of(anhaenge)) {
      final name = f.uri.pathSegments.last;
      final t0 = DateTime.now();
      setState(() => fluechtig = '📎 $name wird hochgeladen …');
      final r = await t.hochladen(f, fortschritt: (g, s) => setState(() => fluechtig = '📎 $name: ${(100 * g / s).round()} %'));
      final sek = DateTime.now().difference(t0).inMilliseconds / 1000;
      _zeile(Eintrag(Art.hinweis, '📎 $name (${(r.groesse / 1024 / 1024).toStringAsFixed(1)} MB) in ${sek.toStringAsFixed(1)} s hochgeladen · Schlüssel ${r.key} · SHA-256 ${r.sha256}'));
      zeilen.add('Datei „$name" (${r.groesse} Bytes, SHA-256 ${r.sha256}) liegt in deinem Dateispeicher, Schlüssel: ${r.key}.');
    }
    setState(() { anhaenge.clear(); fluechtig = ''; });
    return zeilen;
  }

  void _zeile(Eintrag e) {
    setState(() => verlauf.add(e));
    _protokolliere(e);
    _nachUnten();
  }

  void _protokolliere(Eintrag e, [String? quelle]) {
    final p = startArgs['protokoll'];
    if (p == null) return;
    try { File(p).writeAsStringSync('${e.zeit.toIso8601String()} ${quelle == null ? '' : '$quelle '}${e.art.name} ${e.text.replaceAll('\n', ' ')}\n', mode: FileMode.append, flush: true); } catch (_) {}
  }

  /// 1.2.7 — die Liste ist von unten verankert (`reverse: true`); Offset 0 = neueste Zeile. Damit landet man beim Öffnen
  /// eines Gesprächs immer bei der letzten Nachricht, auch bei sehr langen Einträgen (maxScrollExtent ist bei lazy
  /// gebauten Listen nur geschätzt und griff vorher zu kurz).
  void _nachUnten() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (scroll.hasClients) scroll.animateTo(0, duration: const Duration(milliseconds: 150), curve: Curves.easeOut);
    });
  }

  void _meldeNeu(Bestaetigung b) {
    if (gemeldet.contains(b.id)) return;
    gemeldet.add(b.id);
    setState(() => offen.add(b));
    _zeile(Eintrag(Art.bestaetigung, '${b.quelle == 'geraet' ? '(Gerät) ' : ''}${b.text}'));
    _titel();
    _benachrichtige(b);
  }

  /// Verlauf der Gerätesitzung vom Gehirn (`/api/geraete/verlauf`, v1314) — vor den Zeilen dieses Starts einsortiert.
  Future<void> _holeVerlauf() async {
    final s = server; if (s == null) return;
    try {
      final j = await s.json('/api/geraete/verlauf?limit=60${s.faden == null ? '' : '&faden=${s.faden}'}'); // 1.2.0 je Faden; 1.2.6: 60 sichtbare Zeilen
      final n = (j['nachrichten'] as List<dynamic>? ?? []).cast<Map<String, dynamic>>();
      if (n.isEmpty) return;
      // 1.1.0 — die synthetische Fortsetzungs-Nachricht („Freigabe erteilt für das Vorhaben …", v1324) steht im Verlauf als
      // Benutzerzeile; in der App als Hinweis zeigen, nicht als eigene Blase
      // 1.2.5 — rolle „system" (v1336: interne Fortsetzungen nach Freigabe) als Hinweis, nicht als eigene Blase
      final alte = n.where((m) => '${m['text'] ?? ''}'.trim().isNotEmpty).map((m) { final t = '${m['text']}'; final du = m['rolle'] == 'user'; final sys = m['rolle'] == 'system'; return Eintrag(sys || (du && t.startsWith('Freigabe erteilt für das Vorhaben')) ? Art.hinweis : du ? Art.du : Art.alfred, sys ? 'ℹ ${t.split('\n').first}' : t, zeit: DateTime.tryParse('${m['zeit']}')?.toLocal()); }).toList();
      setState(() => verlauf.insertAll(0, alte));
      for (final e in alte) _protokolliere(e, 'verlauf'); // 1.2.7 — geladene Zeilen im Protokoll (Beweis, Fehlersuche)
      _zeile(Eintrag(Art.hinweis, 'Verlauf geladen: ${alte.length} Nachrichten aus früheren Sitzungen dieses Geräts.'));
      _nachUnten();
    } catch (e) { _zeile(Eintrag(Art.hinweis, 'Verlauf nicht geladen: $e')); }
  }

  Future<void> _holeBestaetigungen() async {
    final s = server;
    if (s == null) return;
    try {
      final liste = await s.offeneBestaetigungen();
      final ids = liste.map((b) => b.id).toSet();
      var geaendert = false;
      for (final b in offen.where((b) => !ids.contains(b.id)).toList()) {
        setState(() => offen.remove(b));
        geaendert = true;
        _zeile(Eintrag(Art.hinweis, '✓ Bestätigung erledigt: ${b.text.length > 80 ? b.text.substring(0, 80) : b.text}'));
      }
      for (final b in liste) { _meldeNeu(b); }
      if (geaendert) _titel();
    } catch (_) { /* nächste Runde */ }
  }

  Future<void> _entscheide(Bestaetigung b, bool ja) async {
    final s = server;
    if (s == null) return;
    final r = await s.entscheide(b.id, ja);
    if (r == 'freigegeben' || r == 'abgelehnt') {
      setState(() => offen.remove(b));
      _titel();
      _zeile(Eintrag(Art.hinweis, '${ja ? '✅ Freigegeben' : '❌ Abgelehnt'}: ${b.text.length > 100 ? b.text.substring(0, 100) : b.text}'));
    } else {
      _zeile(Eintrag(Art.fehler, 'Entscheidung nicht angenommen ($r)'));
    }
  }

  /// Sendet `text` (oder die Eingabezeile) und liefert den Endtext der Antwort.
  /// `sprechen`: Antwort satzweise vorlesen, sobald Sätze vollständig sind (erster Ton nach dem ersten Satz, nicht nach dem Ende).
  Future<String?> _senden({String? text, bool sprechen = false, DateTime? seit}) async {
    var t = (text ?? eingabe.text).trim();
    final s = server;
    final mitAnhang = text == null && anhaenge.isNotEmpty;
    if ((t.isEmpty && !mitAnhang) || antwortet) return null;
    if (s == null) { _zeile(Eintrag(Art.fehler, 'Noch nicht mit dem Satelliten verbunden — $ipcZustand')); return null; }
    // 1.2.5 — `/faden …` in der App lokal: die App hat ihre eigene Seitenleiste, der Server-Stand gilt für Telegram/Terminal
    if (text == null && RegExp(r'^/faden\b', caseSensitive: false).hasMatch(t)) {
      eingabe.clear();
      final arg = t.replaceFirst(RegExp(r'^/faden\s*', caseSensitive: false), '').trim();
      final teile = arg.split(RegExp(r'\s+'));
      if (arg.isEmpty) { setState(() { seitenleisteOffen = true; }); _zeile(Eintrag(Art.hinweis, 'Gespräche stehen in der Seitenleiste. /faden neu [Titel] · /faden haupt · /faden <Kennung>')); return null; }
      if (teile.first == 'haupt') { await _fadenWechseln(null); return null; }
      if (teile.first == 'neu') { final id = DateTime.now().millisecondsSinceEpoch.toRadixString(36); await _fadenWechseln(id); final titel = teile.skip(1).join(' ').trim(); if (titel.isNotEmpty) { try { await s.json('/api/geraete/faeden/$id', methode: 'PATCH', koerper: {'titel': titel}); await _faedenLaden(); } catch (_) {} } return null; }
      if (RegExp(r'^[a-z0-9-]{1,40}$').hasMatch(teile.first)) { await _fadenWechseln(teile.first); return null; }
      _zeile(Eintrag(Art.hinweis, 'Unbekannt: /faden $arg')); return null;
    }
    if (text == null) {
      eingabe.clear();
      final namen = anhaenge.map((f) => f.uri.pathSegments.last).toList();
      final zitat = bezug == null ? '' : '↩ „${bezug!.text.replaceAll('\n', ' ').substring(0, bezug!.text.length > 80 ? 80 : bezug!.text.length)}${bezug!.text.length > 80 ? '…' : ''}“\n'; // 1.2.2
      _zeile(Eintrag(Art.du, '$zitat${namen.isEmpty ? t : '${t.isEmpty ? '' : '$t\n'}📎 ${namen.join(', ')}'}'));
      if (mitAnhang) {
        // Anhänge zuerst hochladen, dann Alfred mit Text und Schlüsseln ansprechen (Datei + Frage in einer Nachricht)
        List<String> zeilen;
        try { zeilen = await _anhaengeHochladen(); } catch (e) { _zeile(Eintrag(Art.fehler, '📎 $e')); setState(() => fluechtig = ''); return null; }
        t = t.isEmpty ? '${zeilen.join('\n')}\nBestätige kurz den Empfang.' : '$t\n\n${zeilen.join('\n')}';
      }
    }
    setState(() { antwortet = true; fluechtig = '… denkt'; });
    final e = Eintrag(Art.alfred, '');
    var gezeigt = '';
    String? ergebnis;
    final start = seit ?? DateTime.now();
    final vorleser = (sprechen || stimme)
      ? Vorleser(s.sprich, audio, beiErstemTon: () { final sek = DateTime.now().difference(start).inMilliseconds / 1000; _zeile(Eintrag(Art.hinweis, '🔊 erster Ton nach ${sek.toStringAsFixed(1)} s')); })
      : null;
    try {
      final bezugText = bezug?.text; // 1.2.2 — Antwort-Bezug geht mit, dann ist er erledigt
      if (bezug != null) setState(() => bezug = null);
      final ende = await s.sende(t, tier: tierWahl, bezug: bezugText, // 1.1.0 — Stufenwahl aus der Eingabekarte
        aufDelta: (d) {
          if (laufend == null) { laufend = e; setState(() { verlauf.add(e); fluechtig = ''; }); }
          gezeigt += d;
          vorleser?.fuege(d);
          setState(() => e.text = gezeigt);
          _nachUnten();
        },
        aufStatus: (st) => setState(() => fluechtig = st.isEmpty ? '' : '… ${st.length > 100 ? st.substring(0, 100) : st}'),
        aufAnhang: (a) { if (laufend == null) { laufend = e; setState(() { verlauf.add(e); fluechtig = ''; }); } setState(() => e.anhaenge.add(a)); _nachUnten(); }, // 1.0.5
      );
      if (laufend == null) { _zeile(Eintrag(Art.alfred, ende.isEmpty ? '(keine Antwort)' : ende)); }
      else { if (ende.trim().isNotEmpty && ende.trim() != gezeigt.trim()) setState(() => e.text = ende); _protokolliere(e); }
      ergebnis = ende.isNotEmpty ? ende : gezeigt;
      _faedenLaden(); // 1.2.0 — Titel/Zeit des Gesprächs in der Seitenleiste nachziehen
      if (vorleser != null && ergebnis.trim().isNotEmpty) {
        setState(() => fluechtig = '🔊 …');
        await vorleser.schluss(ganzerText: gezeigt.trim().isEmpty ? ergebnis : null);
        if (vorleser.fehler != null) _zeile(Eintrag(Art.fehler, '🔊 ${vorleser.fehler}'));
      }
    } catch (err) {
      _zeile(Eintrag(Art.fehler, 'Fehler: $err'));
    } finally {
      setState(() { antwortet = false; fluechtig = ''; laufend = null; });
      fokus.requestFocus();
    }
    return ergebnis;
  }

  // ── Oberfläche ──────────────────────────────────────────────────────────────────────────────────────────────────
  @override
  // ── 1.1.0 Redesign Stufe 1 (Owner-Vorlage 09.10.): Symbolleiste | Seitenleiste | Hauptbereich ──────────────────────
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      body: Row(children: [
        _leiste(theme),
        if (seitenleisteOffen) _seitenleiste(theme),
        const VerticalDivider(width: 1),
        Expanded(child: switch (ansicht) {
          Ansicht.kacheln => server == null ? const Center(child: Text('Noch nicht mit dem Satelliten verbunden.')) : Kacheln(server: server!, aufHinweis: (t) => _zeile(Eintrag(Art.hinweis, t))),
          Ansicht.einstellungen => _einstellungen(theme),
          Ansicht.chat => _chat(theme),
        }),
      ]),
    );
  }

  /// Schmale Symbolleiste links: Chat, Lage (Kacheln), Bestätigungen (mit Zähler), unten Einstellungen.
  Widget _leiste(ThemeData theme) {
    Widget knopf(IconData icon, IconData aktivIcon, String tip, bool aktiv, VoidCallback? auf, {int zaehler = 0}) {
      final i = Icon(aktiv ? aktivIcon : icon);
      final b = aktiv ? IconButton.filledTonal(tooltip: tip, onPressed: auf, icon: i) : IconButton(tooltip: tip, onPressed: auf, icon: i);
      return Padding(padding: const EdgeInsets.symmetric(vertical: 4), child: zaehler > 0 ? Badge.count(count: zaehler, child: b) : b);
    }
    return Container(
      width: 60,
      color: theme.colorScheme.surfaceContainerLow,
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Column(children: [
        Tooltip(message: 'Alfred', child: CircleAvatar(radius: 16, backgroundColor: theme.colorScheme.primary, child: Text('A', style: TextStyle(color: theme.colorScheme.onPrimary, fontWeight: FontWeight.bold)))),
        const SizedBox(height: 10),
        knopf(Icons.chat_bubble_outline, Icons.chat_bubble, 'Chat', ansicht == Ansicht.chat, () => setState(() => ansicht = Ansicht.chat)),
        knopf(Icons.dashboard_outlined, Icons.dashboard, 'Lage: Befunde, Vorgänge, Geräte', ansicht == Ansicht.kacheln, server == null ? null : () => setState(() { ansicht = Ansicht.kacheln; kachelnOffen = true; })),
        knopf(Icons.notifications_none, Icons.notifications, offen.isEmpty ? 'Keine offenen Bestätigungen' : '${offen.length} offene Bestätigung(en)', false, () => setState(() { ansicht = Ansicht.chat; seitenleisteOffen = true; }), zaehler: offen.length),
        const Spacer(),
        knopf(Icons.settings_outlined, Icons.settings, 'Einstellungen', ansicht == Ansicht.einstellungen, () => setState(() => ansicht = Ansicht.einstellungen)),
      ]),
    );
  }

  /// Einklappbare Seitenleiste: Gerät, „Neuer Chat", offene Bestätigungen, Vorgänge, letzte Fragen, Satellitenstatus.
  Widget _seitenleiste(ThemeData theme) {
    final dim = theme.colorScheme.onSurfaceVariant;
    final geraet = konfig?.name ?? satellit?.name ?? '…';
    final letzte = verlauf.where((e) => e.art == Art.du && e.text.trim().isNotEmpty).toList().reversed.take(8).toList();
    Widget abschnitt(String t) => Padding(padding: const EdgeInsets.fromLTRB(16, 14, 16, 4), child: Text(t, style: theme.textTheme.labelMedium?.copyWith(color: dim)));
    return Container(
      width: 270,
      color: theme.colorScheme.surfaceContainerLow,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Padding(padding: const EdgeInsets.fromLTRB(16, 12, 6, 0), child: Row(children: [
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Alfred', style: theme.textTheme.titleMedium),
            Text(geraet, style: theme.textTheme.bodySmall?.copyWith(color: dim), overflow: TextOverflow.ellipsis),
          ])),
          IconButton(tooltip: 'Seitenleiste einklappen', onPressed: () { setState(() => seitenleisteOffen = false); seitenleisteSpeichern(false); }, icon: const Icon(Icons.view_sidebar_outlined, size: 20)),
        ])),
        Padding(padding: const EdgeInsets.fromLTRB(10, 10, 10, 0), child: ListTile(dense: true, leading: const Icon(Icons.edit_square, size: 20), title: const Text('Neuer Chat'), subtitle: Text('Eigenes Gespräch mit Alfred', style: theme.textTheme.labelSmall?.copyWith(color: dim)), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)), tileColor: theme.colorScheme.surfaceContainerHigh, onTap: _neuerChat)),
        Expanded(child: ListView(padding: const EdgeInsets.only(bottom: 8), children: [
          abschnitt('Gespräche'),
          ListTile(dense: true, selected: server?.faden == null, leading: const Icon(Icons.forum_outlined, size: 18), title: Text('Hauptgespräch', style: theme.textTheme.bodySmall), onTap: () => _fadenWechseln(null)),
          for (final f in faeden.where((x) => x['faden'] != null && x['archiv'] == null).take(12)) ListTile(dense: true, selected: server?.faden == f['faden'], leading: const Icon(Icons.chat_bubble_outline, size: 18), title: Text('${(f['titel'] ?? '').toString().isEmpty ? 'Gespräch' : f['titel']}', maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall), subtitle: Text(_fadenZeit('${f['zeit'] ?? ''}'), style: theme.textTheme.labelSmall?.copyWith(color: dim)), trailing: Row(mainAxisSize: MainAxisSize.min, children: [IconButton(tooltip: 'Umbenennen', iconSize: 16, visualDensity: VisualDensity.compact, onPressed: () => _fadenUmbenennen('${f['faden']}', '${f['titel'] ?? ''}'), icon: const Icon(Icons.edit_outlined)), IconButton(tooltip: 'Gespräch löschen', iconSize: 16, visualDensity: VisualDensity.compact, onPressed: () => _fadenLoeschen('${f['faden']}'), icon: const Icon(Icons.delete_outline))]), onTap: () => _fadenWechseln('${f['faden']}')),
          if (offen.isNotEmpty) ...[
            abschnitt('Bestätigungen (${offen.length})'),
            for (final b in offen) ListTile(dense: true, leading: Icon(Icons.notifications_active, size: 18, color: Colors.amber.shade700), title: Text(b.text, maxLines: 2, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall), onTap: () => setState(() => ansicht = Ansicht.chat)),
          ],
          if (faeden.any((x) => x['archiv'] != null)) ...[
            abschnitt('Archiv (frühere Sitzungen)'),
            for (final f in faeden.where((x) => x['archiv'] != null).take(6)) ListTile(dense: true, selected: archiv == f['archiv'], leading: const Icon(Icons.inventory_2_outlined, size: 18), title: Text('${f['titel']}', maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall), subtitle: Text('${_fadenZeit('${f['zeit'] ?? ''}')} · ${f['anzahl']} Nachrichten', style: theme.textTheme.labelSmall?.copyWith(color: dim)), onTap: () => _archivOeffnen('${f['archiv']}')),
          ],
          abschnitt('Vorgänge${vorgaenge.isEmpty ? '' : ' (${vorgaenge.length})'}'),
          if (vorgaenge.isEmpty) Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: Text('Keine offenen Vorgänge.', style: theme.textTheme.bodySmall?.copyWith(color: dim))),
          for (final v in vorgaenge.take(8)) ListTile(dense: true, leading: const Icon(Icons.assignment_outlined, size: 18), title: Text('${v['titel'] ?? ''}', maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall), subtitle: Text('${v['status'] ?? ''}${v['naechsterSchritt'] != null ? ' · ${v['naechsterSchritt']}' : ''}', maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.labelSmall?.copyWith(color: dim)), onTap: () { eingabe.text = 'Wie steht es um „${v['titel'] ?? ''}“?'; fokus.requestFocus(); setState(() => ansicht = Ansicht.chat); }),
          if (letzte.isNotEmpty) abschnitt('Letzte'),
          for (final e in letzte) ListTile(dense: true, leading: const Icon(Icons.history, size: 18), title: Text(e.text.split('\n').first, maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall), onTap: () { eingabe.text = e.text; fokus.requestFocus(); setState(() => ansicht = Ansicht.chat); }),
        ])),
        const Divider(height: 1),
        Padding(padding: const EdgeInsets.fromLTRB(16, 8, 12, 10), child: Row(children: [
          Icon(Icons.circle, size: 9, color: satellit?.verbunden == true ? Colors.green : theme.colorScheme.error),
          const SizedBox(width: 6),
          Expanded(child: Text(satellit == null ? ipcZustand : 'Satellit ${satellit!.version}${satellit!.verbunden ? ' · Alfred ${satellit!.serverVersion ?? ''}' : ' · nicht verbunden'}', style: theme.textTheme.labelSmall?.copyWith(color: dim), overflow: TextOverflow.ellipsis)),
        ])),
      ]),
    );
  }

  // ── 1.2.0 Gesprächsfäden (Redesign Stufe 2, v1328): Hauptgespräch + beliebig viele Fäden je Gerät ────────────────
  List<Map<String, dynamic>> faeden = [];

  String _fadenTitel(String? faden) {
    if (faden == null) return 'Hauptgespräch';
    final f = faeden.where((x) => x['faden'] == faden).toList();
    final t = f.isEmpty ? '' : '${f.first['titel'] ?? ''}';
    return t.isEmpty ? 'Gespräch $faden' : t;
  }

  Future<void> _faedenLaden() async {
    final s = server; if (s == null) return;
    try {
      final j = await s.json('/api/geraete/faeden');
      final l = ((j['faeden'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>();
      if (mounted) setState(() => faeden = l);
    } catch (_) { /* Seitenleiste ist Komfort */ }
  }

  /// Zu einem Gespräch wechseln (null = Hauptgespräch): Verlauf vom Server, Eingabe bleibt.
  Future<void> _fadenWechseln(String? faden) async {
    final s = server; if (s == null) return;
    if (antwortet) { _zeile(Eintrag(Art.hinweis, 'Bitte warten, bis die Antwort fertig ist.')); return; }
    s.faden = faden;
    setState(() { verlauf.clear(); laufend = null; ansicht = Ansicht.chat; archiv = null; });
    await _holeVerlauf();
    if (verlauf.isEmpty && faden != null) _zeile(Eintrag(Art.hinweis, 'Neues Gespräch — was möchtest du besprechen?'));
    fokus.requestFocus();
  }

  void _neuerChat() {
    final id = DateTime.now().millisecondsSinceEpoch.toRadixString(36);
    _fadenWechseln(id);
  }

  /// 1.2.1 — Gespräch wurde auf einem anderen Kanal fortgeführt: Verlauf vom Server neu laden, lokale Hinweise behalten.
  Future<void> _gespraechNachladen() async {
    if (antwortet) return;
    final hinweise = verlauf.where((e) => e.art != Art.du && e.art != Art.alfred).toList();
    setState(() { verlauf.clear(); laufend = null; });
    await _holeVerlauf();
    if (hinweise.isNotEmpty) setState(() { verlauf.addAll(hinweise); verlauf.sort((a, b) => a.zeit.compareTo(b.zeit)); });
    _nachUnten();
    _faedenLaden();
  }

  String? archiv; // 1.2.1 — geöffnete alte Kanal-Sitzung (nur lesen)
  Eintrag? bezug; // 1.2.2 — Alfred-Nachricht, auf die die nächste Eingabe antwortet (Owner-Freigabe 09.10.)
  bool? spiegelung; // 1.2.3 — Spiegel-Schalter (null = noch nicht geladen)

  Future<void> _spiegelungLaden() async {
    final s = server; if (s == null) return;
    try { final j = await s.json('/api/geraete/spiegelung'); if (mounted) setState(() => spiegelung = j['an'] == true); } catch (_) { /* kein Owner-Gerät oder alter Server */ }
  }

  Future<void> _spiegelungSetzen(bool an) async {
    final s = server; if (s == null) return;
    try { final j = await s.json('/api/geraete/spiegelung', methode: 'POST', koerper: {'an': an}); setState(() => spiegelung = j['an'] == true); _zeile(Eintrag(Art.hinweis, 'Spiegelung nach Telegram: ${j['an'] == true ? 'an' : 'aus'}')); }
    catch (e) { _zeile(Eintrag(Art.fehler, 'Spiegelung nicht umgeschaltet: $e')); }
  }

  Future<void> _archivOeffnen(String chatId) async {
    final s = server; if (s == null) return;
    setState(() { verlauf.clear(); laufend = null; ansicht = Ansicht.chat; archiv = chatId; });
    try {
      final j = await s.json('/api/geraete/verlauf?limit=100&archiv=${Uri.encodeQueryComponent(chatId)}');
      final n = (j['nachrichten'] as List<dynamic>? ?? []).cast<Map<String, dynamic>>();
      setState(() { verlauf.addAll(n.map((m) => Eintrag(m['rolle'] == 'user' ? Art.du : Art.alfred, '${m['text']}', zeit: DateTime.tryParse('${m['zeit']}')?.toLocal()))); });
      _zeile(Eintrag(Art.hinweis, 'Archiv — nur lesen. Zum Weiterschreiben ein Gespräch in der Seitenleiste wählen.'));
    } catch (e) { _zeile(Eintrag(Art.fehler, 'Archiv nicht geladen: $e')); }
  }

  /// 1.2.4 — Faden umbenennen (Owner-Freigabe 09.10.): kleiner Dialog, PATCH an den Server.
  Future<void> _fadenUmbenennen(String faden, String alt) async {
    final s = server; if (s == null) return;
    final c = TextEditingController(text: alt);
    final titel = await showDialog<String>(context: context, builder: (ctx) => AlertDialog(
      title: const Text('Gespräch umbenennen'),
      content: TextField(controller: c, autofocus: true, maxLength: 80, decoration: const InputDecoration(labelText: 'Titel'), onSubmitted: (v) => Navigator.of(ctx).pop(v)),
      actions: [TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('Abbrechen')), FilledButton(onPressed: () => Navigator.of(ctx).pop(c.text), child: const Text('Speichern'))],
    ));
    if (titel == null || titel.trim().isEmpty) return;
    try { await s.json('/api/geraete/faeden/$faden', methode: 'PATCH', koerper: {'titel': titel.trim()}); await _faedenLaden(); }
    catch (e) { _zeile(Eintrag(Art.fehler, 'Nicht umbenannt: $e')); }
  }

  Future<void> _fadenLoeschen(String faden) async {
    final s = server; if (s == null) return;
    try {
      await s.json('/api/geraete/faeden/$faden', methode: 'DELETE');
      if (s.faden == faden) await _fadenWechseln(null);
      await _faedenLaden();
    } catch (e) { _zeile(Eintrag(Art.fehler, 'Gespräch nicht gelöscht: $e')); }
  }

  Future<void> _vorgaengeLaden() async {
    final s = server; if (s == null) return;
    try {
      final v = await s.json('/api/vorgaenge?limit=12');
      final offene = ((v['offene'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>();
      if (mounted) setState(() => vorgaenge = offene);
    } catch (_) { /* Seitenleiste ist Komfort */ }
  }

  /// Hauptbereich Chat: Kopfzeile, Verlauf (mittig, Datumstrenner), Bestätigungskarten, Eingabekarte.
  Widget _chat(ThemeData theme) {
    final dim = theme.colorScheme.onSurfaceVariant;
    final geraet = konfig?.name ?? satellit?.name ?? '…';
    // 1.1.1 — Owner 16:12: Dateien ließen sich nicht mehr hineinziehen. Die Ablagezone deckte nur den Verlauf ab,
    // nicht die Eingabekarte; jetzt liegt sie über dem ganzen Chat-Bereich (zusätzlich zum Plus-Knopf).
    return DropTarget(onDragDone: (d) => _dateienAbgelegt(d.files.map((f) => f.path).toList()), child: Column(children: [
      SizedBox(height: 48, child: Row(children: [
        if (!seitenleisteOffen) IconButton(tooltip: 'Seitenleiste', onPressed: () { setState(() => seitenleisteOffen = true); seitenleisteSpeichern(true); }, icon: const Icon(Icons.view_sidebar_outlined, size: 20)),
        const SizedBox(width: 12),
        Text('Chat · $geraet', style: theme.textTheme.titleSmall),
        const Spacer(),
        if (update != null) Padding(padding: const EdgeInsets.only(right: 8), child: ActionChip(avatar: updateLaeuft ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.system_update_alt, size: 18), label: Text('Update ${update!.version}'), tooltip: 'Herunterladen und installieren (${(update!.groesse / 1024 / 1024).toStringAsFixed(1)} MB)', onPressed: updateLaeuft ? null : _updateInstallieren)),
        IconButton(tooltip: stimme ? 'Antworten vorlesen: an' : 'Antworten vorlesen: aus', onPressed: () => setState(() => stimme = !stimme), icon: Icon(stimme ? Icons.volume_up : Icons.volume_off, size: 20)),
        const SizedBox(width: 8),
      ])),
      const Divider(height: 1),
      Expanded(child: verlauf.isEmpty
          ? Center(child: Column(mainAxisSize: MainAxisSize.min, children: [Icon(Icons.auto_awesome, size: 40, color: dim), const SizedBox(height: 12), Text('Was kann ich für dich tun?', style: theme.textTheme.headlineSmall)]))
          : Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 920), child: ListView.builder(
              controller: scroll,
              reverse: true, // 1.2.7 — von unten verankert: Öffnen eines Gesprächs zeigt die letzte Nachricht
              padding: const EdgeInsets.fromLTRB(20, 12, 20, 12),
              itemCount: verlauf.length,
              itemBuilder: (context, ri) {
                final i = verlauf.length - 1 - ri;
                final e = verlauf[i];
                final neuerTag = i == 0 || !_gleicherTag(verlauf[i - 1].zeit, e.zeit);
                final w = _eintrag(e, theme);
                return neuerTag ? Column(children: [_datumstrenner(e.zeit, theme), w]) : w;
              },
            ))),
      ),
      if (offen.isNotEmpty) Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 920), child: _bestaetigungen(theme))),
      Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 920), child: _eingabekarte(theme))),
    ]));
  }

  static bool _gleicherTag(DateTime a, DateTime b) => a.year == b.year && a.month == b.month && a.day == b.day;

  /// 1.2.5 — Zitatzeile (↩ „…“) und Anhang-Zeile (📎 …) aus einer eigenen Nachricht entfernen, bevor sie wiederholt wird.
  /// 1.2.8 — lange eigene Nachrichten (Upload-Listen) eingeklappt zeigen; nie Alfreds Antworten, nie die neueste Nachricht
  /// (Owner-Freigabe 09.10. 21:55). Aufgeklappt bleibt aufgeklappt, bis das Gespräch neu geladen wird.
  static const klappAb = 1500;
  bool _eingeklappt(Eintrag e) {
    if (e.art != Art.du || e.aufgeklappt || e.text.length <= klappAb) return false;
    final i = verlauf.lastIndexWhere((x) => x.art == Art.du || x.art == Art.alfred);
    return i >= 0 && !identical(verlauf[i], e);
  }

  static String _ohneZitat(String t) => t.split('\n').where((z) => !z.startsWith('↩ „') && !z.startsWith('📎 ')).join('\n').trim();

  static String _fadenZeit(String iso) {
    final d = DateTime.tryParse(iso)?.toLocal();
    if (d == null) return '';
    final h = DateTime.now();
    final z = '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
    return _gleicherTag(d, h) ? 'heute, $z' : '${d.day.toString().padLeft(2, '0')}.${d.month.toString().padLeft(2, '0')}., $z';
  }

  Widget _datumstrenner(DateTime d, ThemeData theme) {
    final heute = DateTime.now();
    final tag = _gleicherTag(d, heute) ? 'heute' : _gleicherTag(d, heute.subtract(const Duration(days: 1))) ? 'gestern' : '${d.day.toString().padLeft(2, '0')}.${d.month.toString().padLeft(2, '0')}.${d.year}';
    final zeit = '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
    return Padding(padding: const EdgeInsets.symmetric(vertical: 10), child: Center(child: Text('$tag, $zeit', style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.onSurfaceVariant))));
  }

  /// Eingabekarte wie in der Vorlage: Textfeld oben, darunter Anhang, Stufenwahl, Status, Mikrofon, Zuhören, Senden.
  Widget _eingabekarte(ThemeData theme) {
    final dim = theme.colorScheme.onSurfaceVariant;
    const stufen = {null: 'Automatisch', 'fast': 'Schnell', 'default': 'Normal', 'strong': 'Stark'};
    return Container(
      margin: const EdgeInsets.fromLTRB(20, 6, 20, 14),
      padding: const EdgeInsets.fromLTRB(14, 10, 8, 6),
      decoration: BoxDecoration(
        color: theme.brightness == Brightness.light ? Colors.white : theme.colorScheme.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: theme.colorScheme.outlineVariant),
        boxShadow: theme.brightness == Brightness.light ? [BoxShadow(color: Colors.black.withValues(alpha: 0.06), blurRadius: 12, offset: const Offset(0, 4))] : null,
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (bezug != null) Padding(padding: const EdgeInsets.only(bottom: 6), child: Container( // 1.2.2 — Zitat der Nachricht, auf die geantwortet wird
          padding: const EdgeInsets.fromLTRB(10, 6, 4, 6),
          decoration: BoxDecoration(color: theme.colorScheme.surfaceContainerHighest, borderRadius: BorderRadius.circular(10), border: Border(left: BorderSide(color: theme.colorScheme.primary, width: 3))),
          child: Row(children: [
            Icon(Icons.reply, size: 16, color: theme.colorScheme.primary),
            const SizedBox(width: 8),
            Expanded(child: Text('Antwort auf Alfred: ${bezug!.text.replaceAll('\n', ' ')}', maxLines: 2, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall?.copyWith(color: dim))),
            IconButton(tooltip: 'Bezug entfernen', onPressed: () => setState(() => bezug = null), icon: const Icon(Icons.close, size: 16), visualDensity: VisualDensity.compact),
          ]),
        )),
        if (anhaenge.isNotEmpty) Padding(padding: const EdgeInsets.only(bottom: 6), child: Wrap(spacing: 6, runSpacing: 4, children: [
          for (final f in anhaenge) InputChip(avatar: const Icon(Icons.insert_drive_file_outlined, size: 18), label: Text(f.uri.pathSegments.last, overflow: TextOverflow.ellipsis), tooltip: f.path, onDeleted: () => setState(() => anhaenge.remove(f))),
        ])),
        // 1.0.3 — mehrzeiliges Feld: Enter sendet, Umschalt+Enter macht eine neue Zeile (onSubmitted feuert bei maxLines > 1 nicht).
        Focus(
          onKeyEvent: (node, ev) {
            if (ev is KeyDownEvent && (ev.logicalKey == LogicalKeyboardKey.enter || ev.logicalKey == LogicalKeyboardKey.numpadEnter) && !HardwareKeyboard.instance.isShiftPressed) {
              if (!antwortet) _senden();
              return KeyEventResult.handled;
            }
            return KeyEventResult.ignored;
          },
          child: TextField(
            controller: eingabe,
            focusNode: fokus,
            autofocus: true,
            enabled: !antwortet,
            minLines: 1,
            maxLines: 6,
            decoration: InputDecoration.collapsed(hintText: anhaenge.isEmpty ? 'Nachricht an Alfred … (Umschalt+Enter: neue Zeile, Dateien hineinziehen)' : 'Was soll Alfred mit ${anhaenge.length == 1 ? 'der Datei' : 'den Dateien'} tun? (leer = nur ablegen)', hintStyle: TextStyle(color: dim)),
            onSubmitted: (_) => _senden(),
          ),
        ),
        const SizedBox(height: 6),
        Row(children: [
          IconButton(tooltip: 'Datei anhängen', onPressed: antwortet ? null : _anhangWaehlen, icon: const Icon(Icons.add_circle_outline, size: 22), visualDensity: VisualDensity.compact),
          PopupMenuButton<String?>(
            tooltip: 'Stufe: wie gründlich Alfred denkt (Kosten, Tempo)',
            initialValue: tierWahl,
            onSelected: (v) => setState(() => tierWahl = v == '' ? null : v),
            itemBuilder: (_) => [for (final s in stufen.entries) PopupMenuItem<String?>(value: s.key ?? '', child: Text(s.value))],
            child: Padding(padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6), child: Row(mainAxisSize: MainAxisSize.min, children: [Text(stufen[tierWahl] ?? 'Automatisch', style: theme.textTheme.bodySmall?.copyWith(color: dim)), Icon(Icons.expand_more, size: 16, color: dim)])),
          ),
          const SizedBox(width: 8),
          if (fluechtig.isNotEmpty) Expanded(child: Text(fluechtig, style: theme.textTheme.bodySmall?.copyWith(color: aufnahme ? theme.colorScheme.error : dim), overflow: TextOverflow.ellipsis)) else const Spacer(),
          IconButton(tooltip: aufnahme ? 'Aufnahme stoppen' : 'Sprechen (Strg+Alt+Leertaste)', onPressed: _talkUmschalten, icon: Icon(aufnahme ? Icons.stop_circle : Icons.mic_none, size: 22, color: aufnahme ? theme.colorScheme.error : null), visualDensity: VisualDensity.compact),
          hoeren
            ? IconButton.filledTonal(tooltip: 'Zuhören aus', onPressed: _hoerenUmschalten, icon: const Icon(Icons.headset_mic, size: 20), visualDensity: VisualDensity.compact)
            : IconButton(tooltip: 'Zuhören mit Aktivierungswort „${konfig?.aktivierungswort ?? 'Alfred'}“', onPressed: server == null ? null : _hoerenUmschalten, icon: const Icon(Icons.headset, size: 22), visualDensity: VisualDensity.compact),
          const SizedBox(width: 4),
          IconButton.filled(tooltip: 'Senden (Enter)', onPressed: antwortet ? null : () => _senden(), icon: antwortet ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.arrow_upward, size: 20)),
        ]),
      ]),
    );
  }

  Future<void> _anhangWaehlen() async {
    try {
      final dateien = await openFiles();
      if (dateien.isNotEmpty) _dateienAbgelegt(dateien.map((x) => x.path).toList());
    } catch (e) { _zeile(Eintrag(Art.fehler, 'Dateiauswahl: $e')); }
  }

  /// Einstellungen: Farbschema, Vorlesen, Seitenleiste, Tastenkürzel, Version und Update.
  Widget _einstellungen(ThemeData theme) {
    final dim = theme.colorScheme.onSurfaceVariant;
    Widget karte(String titel, Widget inhalt) => Card(margin: const EdgeInsets.only(bottom: 12), child: Padding(padding: const EdgeInsets.all(14), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(titel, style: theme.textTheme.titleSmall), const SizedBox(height: 8), inhalt])));
    return ListView(padding: const EdgeInsets.all(20), children: [
      Text('Einstellungen', style: theme.textTheme.headlineSmall),
      const SizedBox(height: 14),
      karte('Darstellung', Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        ValueListenableBuilder<ThemeMode>(valueListenable: themeModus, builder: (_, m, __) => SegmentedButton<ThemeMode>(segments: const [ButtonSegment(value: ThemeMode.system, label: Text('System'), icon: Icon(Icons.brightness_auto)), ButtonSegment(value: ThemeMode.light, label: Text('Hell'), icon: Icon(Icons.light_mode)), ButtonSegment(value: ThemeMode.dark, label: Text('Dunkel'), icon: Icon(Icons.dark_mode))], selected: {m}, onSelectionChanged: (s) => themaSpeichern(s.first))),
        const SizedBox(height: 8),
        SwitchListTile(dense: true, contentPadding: EdgeInsets.zero, title: const Text('Seitenleiste beim Start'), value: seitenleisteOffen, onChanged: (v) { setState(() => seitenleisteOffen = v); seitenleisteSpeichern(v); }),
      ])),
      karte('Sprache', Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        SwitchListTile(dense: true, contentPadding: EdgeInsets.zero, title: const Text('Antworten vorlesen'), value: stimme, onChanged: (v) => setState(() => stimme = v)),
        Text('Sprechen: Strg+Alt+Leertaste (global). Zuhören mit Aktivierungswort „${konfig?.aktivierungswort ?? 'Alfred'}“ über den Kopfhörer-Knopf in der Eingabekarte.', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
      ])),
      karte('Gespräche', Column(crossAxisAlignment: CrossAxisAlignment.start, children: [ // 1.2.3 — Spiegel-Schalter (Owner-Freigabe 09.10., Standard aus)
        SwitchListTile(dense: true, contentPadding: EdgeInsets.zero, title: const Text('Spiegelung nach Telegram'), subtitle: Text(spiegelung == null ? 'Stand wird geladen …' : 'Fragen und Antworten aus App, Web und Terminal erscheinen auch im Telegram-Chat', style: theme.textTheme.labelSmall?.copyWith(color: dim)), value: spiegelung ?? false, onChanged: spiegelung == null ? null : (v) => _spiegelungSetzen(v)),
        Text('Alfred kennt den Verlauf aus allen Kanälen immer. In Telegram zeigt „/verlauf" die letzten Nachrichten, „/spiegel an" schaltet dasselbe wie dieser Schalter.', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
      ])),
      karte('Verbindung', Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('Gerät: ${konfig?.name ?? '…'}', style: theme.textTheme.bodyMedium),
        Text('Server: ${konfig?.server ?? '…'}', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
        Text(satellit == null ? ipcZustand : 'Satellit ${satellit!.version} · ${satellit!.verbunden ? 'verbunden mit Alfred ${satellit!.serverVersion ?? ''}' : 'nicht verbunden'}', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
      ])),
      karte('App', Row(children: [
        Expanded(child: Text('Version ${appVersion.isEmpty ? '…' : appVersion}${update != null ? ' — Update ${update!.version} verfügbar' : ' — aktuell'}', style: theme.textTheme.bodyMedium)),
        if (update != null) FilledButton.tonalIcon(onPressed: updateLaeuft ? null : _updateInstallieren, icon: const Icon(Icons.system_update_alt, size: 18), label: Text(updateLaeuft ? 'läuft …' : 'Installieren')),
        if (update == null) OutlinedButton(onPressed: _updatePruefen, child: const Text('Nach Update suchen')),
      ])),
    ]);
  }

  Widget _bestaetigungen(ThemeData theme) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 0, 20, 4),
      child: Column(children: [
        for (final b in offen.take(3))
          Card(
            margin: const EdgeInsets.only(bottom: 6),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
              child: Row(children: [
                Icon(Icons.notifications_active, size: 18, color: Colors.amber.shade700),
                const SizedBox(width: 10),
                Expanded(child: Text('${b.quelle == 'geraet' ? 'Gerät · ' : ''}${b.text}', maxLines: 3, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall)),
                const SizedBox(width: 8),
                FilledButton(onPressed: () => _entscheide(b, true), child: const Text('Ja')),
                const SizedBox(width: 6),
                OutlinedButton(onPressed: () => _entscheide(b, false), child: const Text('Nein')),
              ]),
            ),
          ),
        if (offen.length > 3) Padding(padding: const EdgeInsets.only(bottom: 4), child: Text('… und ${offen.length - 3} weitere in der Seitenleiste', style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.onSurfaceVariant))),
      ]),
    );
  }

  /// 1.0.5 — Anhang in der Antwort: Bilder als Vorschau (Klick öffnet), Dateien als Chip; „Speichern" legt sie in Downloads ab.
  Widget _anhang(Anhang a, ThemeData theme) {
    final kb = (a.bytes.length / 1024).round();
    final knoepfe = Row(mainAxisSize: MainAxisSize.min, children: [
      Text('${a.name} · $kb KB', style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
      const SizedBox(width: 8),
      TextButton.icon(onPressed: () => _anhangOeffnen(a), icon: const Icon(Icons.open_in_new, size: 16), label: const Text('Öffnen')),
      TextButton.icon(onPressed: () => _anhangSpeichern(a), icon: const Icon(Icons.download, size: 16), label: const Text('Speichern')),
    ]);
    if (!a.istBild) return Padding(padding: const EdgeInsets.only(top: 6), child: Row(mainAxisSize: MainAxisSize.min, children: [const Icon(Icons.attach_file, size: 18), const SizedBox(width: 4), knoepfe]));
    return Padding(padding: const EdgeInsets.only(top: 8), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      InkWell(onTap: () => _anhangOeffnen(a), child: ClipRRect(borderRadius: BorderRadius.circular(8), child: ConstrainedBox(constraints: const BoxConstraints(maxHeight: 360, maxWidth: 640), child: Image.memory(Uint8List.fromList(a.bytes), fit: BoxFit.contain, errorBuilder: (_, __, ___) => const Text('(Bild nicht darstellbar)'))))),
      knoepfe,
    ]));
  }

  Future<File> _anhangAblegen(Anhang a, Directory dir) async {
    await dir.create(recursive: true);
    var f = File('${dir.path}${Platform.pathSeparator}${a.name}');
    if (await f.exists()) f = File('${dir.path}${Platform.pathSeparator}${DateTime.now().millisecondsSinceEpoch}-${a.name}');
    await f.writeAsBytes(a.bytes, flush: true);
    return f;
  }

  Future<void> _anhangOeffnen(Anhang a) async {
    try {
      final f = await _anhangAblegen(a, await getTemporaryDirectory());
      if (Platform.isWindows) { await Process.start('cmd', ['/c', 'start', '', f.path], mode: ProcessStartMode.detached); }
      else if (Platform.isMacOS) { await Process.start('open', [f.path], mode: ProcessStartMode.detached); }
      else { await Process.start('xdg-open', [f.path], mode: ProcessStartMode.detached); }
    } catch (e) { _zeile(Eintrag(Art.fehler, 'Anhang nicht geöffnet: $e')); }
  }

  Future<void> _anhangSpeichern(Anhang a) async {
    try {
      final dir = await getDownloadsDirectory() ?? await getApplicationDocumentsDirectory();
      final f = await _anhangAblegen(a, dir);
      _zeile(Eintrag(Art.hinweis, '💾 gespeichert: ${f.path}'));
    } catch (e) { _zeile(Eintrag(Art.fehler, 'Anhang nicht gespeichert: $e')); }
  }

  Widget _eintrag(Eintrag e, ThemeData theme) {
    final zeit = '${e.zeit.hour.toString().padLeft(2, '0')}:${e.zeit.minute.toString().padLeft(2, '0')}';
    final dim = theme.colorScheme.onSurfaceVariant;
    switch (e.art) {
      case Art.du:
        // 1.2.5 — eigene Nachricht wiederholen oder bearbeiten (Owner-Freigabe 09.10.)
        return Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: Align(alignment: Alignment.centerRight, child: Column(crossAxisAlignment: CrossAxisAlignment.end, mainAxisSize: MainAxisSize.min, children: [
          Container(constraints: const BoxConstraints(maxWidth: 720), padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8), decoration: BoxDecoration(color: theme.colorScheme.primaryContainer, borderRadius: BorderRadius.circular(12)), child: _eingeklappt(e)
            ? Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                SelectableText(gekuerzt(e.text)),
                TextButton.icon(onPressed: () => setState(() => e.aufgeklappt = true), icon: const Icon(Icons.unfold_more, size: 16), label: Text('mehr anzeigen (${(e.text.length / 1024).toStringAsFixed(0)} KB)'), style: TextButton.styleFrom(visualDensity: VisualDensity.compact)),
              ])
            : SelectableText(e.text)),
          Row(mainAxisSize: MainAxisSize.min, children: [
            IconButton(tooltip: 'Bearbeiten (Text in die Eingabe legen)', onPressed: antwortet ? null : () { eingabe.text = _ohneZitat(e.text); eingabe.selection = TextSelection.collapsed(offset: eingabe.text.length); fokus.requestFocus(); }, icon: Icon(Icons.edit_outlined, size: 16, color: dim), visualDensity: VisualDensity.compact),
            IconButton(tooltip: 'Erneut senden', onPressed: antwortet ? null : () => _senden(text: _ohneZitat(e.text)), icon: Icon(Icons.replay_outlined, size: 16, color: dim), visualDensity: VisualDensity.compact),
          ]),
        ])));
      case Art.alfred:
        // 1.1.0 — Antwort ohne Blase (wie in der Vorlage), darunter Aktionen: kopieren, vorlesen
        return Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Align(alignment: Alignment.centerLeft, child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 820), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [Text('Alfred', style: theme.textTheme.labelMedium?.copyWith(color: theme.colorScheme.primary, fontWeight: FontWeight.w600)), Text(' · $zeit', style: theme.textTheme.labelSmall?.copyWith(color: dim))]),
          const SizedBox(height: 4),
          SelectableText.rich(markdown(e.text.isEmpty ? '…' : e.text, theme)),
          for (final a in e.anhaenge) _anhang(a, theme),
          if (e.text.isNotEmpty) Row(children: [
            IconButton(tooltip: 'Kopieren', onPressed: () { Clipboard.setData(ClipboardData(text: e.text)); setState(() => fluechtig = 'kopiert'); }, icon: Icon(Icons.copy_outlined, size: 16, color: dim), visualDensity: VisualDensity.compact),
            IconButton(tooltip: 'Vorlesen', onPressed: () => _sprichKurz(e.text), icon: Icon(Icons.volume_up_outlined, size: 16, color: dim), visualDensity: VisualDensity.compact),
            IconButton(tooltip: 'Darauf antworten (Alfred weiß dann, worauf du dich beziehst)', onPressed: () { setState(() => bezug = e); fokus.requestFocus(); }, icon: Icon(Icons.reply_outlined, size: 16, color: bezug == e ? theme.colorScheme.primary : dim), visualDensity: VisualDensity.compact), // 1.2.2
          ]),
        ]))));
      case Art.satellit:
        return Text('$zeit  ⚙ ${e.text}', style: theme.textTheme.bodySmall?.copyWith(color: dim));
      case Art.bestaetigung:
        return Text('$zeit  🔔 ${e.text}', style: theme.textTheme.bodySmall?.copyWith(color: Colors.amber.shade700));
      case Art.hinweis:
        return Text('$zeit  ${e.text}', style: theme.textTheme.bodySmall?.copyWith(color: dim));
      case Art.fehler:
        return Text('$zeit  ${e.text}', style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.error));
    }
  }
}

/// Kleines Markdown wie in der Terminal-Sitzung: **fett**, `code`, Aufzählungen, Überschriften. Rein, ohne Paket.
TextSpan markdown(String text, ThemeData theme) {
  final zeilen = text.split('\n');
  final spans = <InlineSpan>[];
  final re = RegExp(r'(\*\*([^*]+)\*\*|`([^`]+)`)');
  for (var z = 0; z < zeilen.length; z++) {
    var zeile = zeilen[z];
    var fettZeile = false;
    final u = RegExp(r'^#{1,6}\s+(.*)$').firstMatch(zeile);
    if (u != null) { zeile = u.group(1)!; fettZeile = true; }
    final p = RegExp(r'^(\s*)([-*•]|\d+[.)])\s+(.*)$').firstMatch(zeile);
    if (u == null && p != null) zeile = '${p.group(1)}• ${p.group(3)}';
    var i = 0;
    for (final m in re.allMatches(zeile)) {
      if (m.start > i) spans.add(TextSpan(text: zeile.substring(i, m.start), style: fettZeile ? const TextStyle(fontWeight: FontWeight.bold) : null));
      if (m.group(2) != null) spans.add(TextSpan(text: m.group(2), style: const TextStyle(fontWeight: FontWeight.bold)));
      else spans.add(TextSpan(text: m.group(3), style: TextStyle(fontFamily: 'Consolas', color: theme.colorScheme.tertiary)));
      i = m.end;
    }
    if (i < zeile.length) spans.add(TextSpan(text: zeile.substring(i), style: fettZeile ? const TextStyle(fontWeight: FontWeight.bold) : null));
    if (z < zeilen.length - 1) spans.add(const TextSpan(text: '\n'));
  }
  return TextSpan(children: spans, style: theme.textTheme.bodyMedium);
}
