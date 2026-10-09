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

import 'audio.dart';
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
  await windowManager.ensureInitialized();
  await windowManager.waitUntilReadyToShow(const WindowOptions(title: 'Alfred', size: Size(960, 720), minimumSize: Size(560, 420), center: true), () async {
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
    return MaterialApp(
      title: 'Alfred',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(brightness: Brightness.dark, colorSchemeSeed: const Color(0xFF4FC3F7), useMaterial3: true),
      home: const Sitzung(),
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
      aufEreignis: (art, text, zeit, anhang) {
        if (art == 'nachricht') { // v1318 — Ergebnis nach Freigabe; 1.0.5 — mit Anhang (Foto, Bildschirmfoto, Datei)
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
        if (erste) {
          final auto = startArgs['sende'];
          if (auto != null && auto.isNotEmpty) { eingabe.text = auto; Future.delayed(const Duration(milliseconds: 800), _senden); }
          final wav = startArgs['sprachtest'];
          if (wav != null && wav.isNotEmpty) Future.delayed(const Duration(milliseconds: 800), () => _sprachtest(wav));
          if (startArgs['kacheln'] == 'an') setState(() => kachelnOffen = true); // Beweislauf: Kacheln sofort öffnen
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

  void _protokolliere(Eintrag e) {
    final p = startArgs['protokoll'];
    if (p == null) return;
    try { File(p).writeAsStringSync('${e.zeit.toIso8601String()} ${e.art.name} ${e.text.replaceAll('\n', ' ')}\n', mode: FileMode.append, flush: true); } catch (_) {}
  }

  void _nachUnten() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (scroll.hasClients) scroll.animateTo(scroll.position.maxScrollExtent, duration: const Duration(milliseconds: 150), curve: Curves.easeOut);
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
      final j = await s.json('/api/geraete/verlauf?limit=30');
      final n = (j['nachrichten'] as List<dynamic>? ?? []).cast<Map<String, dynamic>>();
      if (n.isEmpty) return;
      final alte = n.map((m) => Eintrag(m['rolle'] == 'user' ? Art.du : Art.alfred, '${m['text']}', zeit: DateTime.tryParse('${m['zeit']}')?.toLocal())).toList();
      setState(() => verlauf.insertAll(0, alte));
      _zeile(Eintrag(Art.hinweis, 'Verlauf geladen: ${alte.length} Nachrichten aus früheren Sitzungen dieses Geräts.'));
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
    if (text == null) {
      eingabe.clear();
      final namen = anhaenge.map((f) => f.uri.pathSegments.last).toList();
      _zeile(Eintrag(Art.du, namen.isEmpty ? t : '${t.isEmpty ? '' : '$t\n'}📎 ${namen.join(', ')}'));
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
      final ende = await s.sende(t,
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
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final geraet = konfig?.name ?? satellit?.name ?? '…';
    return Scaffold(
      appBar: AppBar(
        title: Text('Alfred — $geraet'),
        actions: [
          IconButton(tooltip: kachelnOffen ? 'Zurück zum Gespräch' : 'Kacheln: Lage, Befunde, Vorgänge, Geräte', onPressed: server == null ? null : () => setState(() => kachelnOffen = !kachelnOffen), icon: Icon(kachelnOffen ? Icons.chat_bubble_outline : Icons.dashboard_outlined)),
          IconButton(tooltip: stimme ? 'Antworten vorlesen: an' : 'Antworten vorlesen: aus', onPressed: () => setState(() => stimme = !stimme), icon: Icon(stimme ? Icons.volume_up : Icons.volume_off)),
          IconButton(tooltip: aufnahme ? 'Aufnahme stoppen' : 'Sprechen (Strg+Alt+Leertaste)', onPressed: _talkUmschalten, icon: Icon(aufnahme ? Icons.stop_circle : Icons.mic, color: aufnahme ? Colors.redAccent : null)),
          IconButton(tooltip: hoeren ? 'Zuhören aus' : 'Zuhören mit Aktivierungswort „${konfig?.aktivierungswort ?? 'Alfred'}“', onPressed: server == null ? null : _hoerenUmschalten, icon: Icon(hoeren ? Icons.headset_mic : Icons.headset, color: hoeren ? Colors.greenAccent : null)),
          if (update != null)
            Padding(
              padding: const EdgeInsets.only(left: 4),
              child: ActionChip(avatar: updateLaeuft ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.system_update_alt, size: 18), label: Text('Update ${update!.version}'), tooltip: 'Herunterladen und installieren (${(update!.groesse / 1024 / 1024).toStringAsFixed(1)} MB)', onPressed: updateLaeuft ? null : _updateInstallieren),
            ),
          if (offen.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(right: 12, left: 4),
              child: Chip(avatar: const Icon(Icons.notifications_active, size: 18), label: Text('${offen.length} ${offen.length == 1 ? 'Bestätigung' : 'Bestätigungen'}'), backgroundColor: Colors.amber.shade900),
            ),
        ],
      ),
      body: kachelnOffen && server != null ? Kacheln(server: server!, aufHinweis: (t) => _zeile(Eintrag(Art.hinweis, t))) : DropTarget(
        onDragDone: (d) => _dateienAbgelegt(d.files.map((f) => f.path).toList()),
        child: Column(
        children: [
          Expanded(
            child: ListView.builder(
              controller: scroll,
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
              itemCount: verlauf.length,
              itemBuilder: (context, i) => _eintrag(verlauf[i], theme),
            ),
          ),
          if (offen.isNotEmpty) _bestaetigungen(theme),
          if (anhaenge.isNotEmpty) Padding(padding: const EdgeInsets.fromLTRB(12, 6, 12, 0), child: Align(alignment: Alignment.centerLeft, child: Wrap(spacing: 6, runSpacing: 4, children: [
            for (final f in anhaenge) InputChip(avatar: const Icon(Icons.insert_drive_file_outlined, size: 18), label: Text(f.uri.pathSegments.last, overflow: TextOverflow.ellipsis), tooltip: f.path, onDeleted: () => setState(() => anhaenge.remove(f))),
          ]))),
          if (fluechtig.isNotEmpty) Padding(padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4), child: Align(alignment: Alignment.centerLeft, child: Text(fluechtig, style: theme.textTheme.bodySmall?.copyWith(color: aufnahme ? Colors.redAccent : Colors.white54)))),
          const Divider(height: 1),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
            child: Row(
              children: [
                Expanded(
                  // 1.0.3 — mehrzeiliges Feld: Enter fügte nur eine Zeile ein (onSubmitted feuert bei maxLines > 1 nicht).
                  // Enter sendet, Umschalt+Enter macht eine neue Zeile.
                  child: Focus(
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
                      maxLines: 5,
                      decoration: InputDecoration(hintText: anhaenge.isEmpty ? 'Nachricht an Alfred … (Enter sendet, Umschalt+Enter neue Zeile, Dateien hineinziehen)' : 'Was soll Alfred mit ${anhaenge.length == 1 ? 'der Datei' : 'den Dateien'} tun? (Enter sendet, leer = nur ablegen)', border: const OutlineInputBorder(), isDense: true),
                      onSubmitted: (_) => _senden(),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton.icon(onPressed: antwortet ? null : () => _senden(), icon: antwortet ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.send), label: const Text('Senden')),
              ],
            ),
          ),
          Container(
            color: theme.colorScheme.surfaceContainerHighest,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
            child: Row(
              children: [
                Icon(Icons.circle, size: 10, color: satellit?.verbunden == true ? Colors.greenAccent : Colors.redAccent),
                const SizedBox(width: 6),
                Expanded(child: Text(satellit == null ? ipcZustand : 'Satellit ${satellit!.version} · ${satellit!.verbunden ? 'verbunden mit Alfred ${satellit!.serverVersion ?? ''}' : 'nicht verbunden'}${satellit!.aktionenLaufend > 0 ? ' · ${satellit!.aktionenLaufend} Aktion(en)' : ''}', style: theme.textTheme.bodySmall, overflow: TextOverflow.ellipsis)),
                Text(konfig?.server ?? '', style: theme.textTheme.bodySmall?.copyWith(color: Colors.white38)),
              ],
            ),
          ),
        ],
      )),
    );
  }

  Widget _bestaetigungen(ThemeData theme) {
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 0, 12, 8),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(border: Border.all(color: Colors.amber.shade700), borderRadius: BorderRadius.circular(8)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Offene Bestätigungen (${offen.length})', style: theme.textTheme.titleSmall?.copyWith(color: Colors.amber.shade300)),
          for (final b in offen)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Row(
                children: [
                  Expanded(child: Text('${b.quelle == 'geraet' ? '(Gerät) ' : ''}${b.text}', maxLines: 3, overflow: TextOverflow.ellipsis)),
                  const SizedBox(width: 8),
                  FilledButton(onPressed: () => _entscheide(b, true), child: const Text('Ja')),
                  const SizedBox(width: 6),
                  OutlinedButton(onPressed: () => _entscheide(b, false), child: const Text('Nein')),
                ],
              ),
            ),
        ],
      ),
    );
  }

  /// 1.0.5 — Anhang in der Antwort: Bilder als Vorschau (Klick öffnet), Dateien als Chip; „Speichern" legt sie in Downloads ab.
  Widget _anhang(Anhang a, ThemeData theme) {
    final kb = (a.bytes.length / 1024).round();
    final knoepfe = Row(mainAxisSize: MainAxisSize.min, children: [
      Text('${a.name} · $kb KB', style: theme.textTheme.bodySmall?.copyWith(color: Colors.white70)),
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
    switch (e.art) {
      case Art.du:
        return Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: Align(alignment: Alignment.centerRight, child: Container(constraints: const BoxConstraints(maxWidth: 720), padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8), decoration: BoxDecoration(color: theme.colorScheme.primaryContainer, borderRadius: BorderRadius.circular(12)), child: SelectableText(e.text))));
      case Art.alfred:
        return Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: Align(alignment: Alignment.centerLeft, child: Container(constraints: const BoxConstraints(maxWidth: 820), padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8), decoration: BoxDecoration(color: theme.colorScheme.surfaceContainerHigh, borderRadius: BorderRadius.circular(12)), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text('Alfred · $zeit', style: theme.textTheme.labelSmall?.copyWith(color: Colors.cyanAccent)), const SizedBox(height: 4), SelectableText.rich(markdown(e.text.isEmpty ? '…' : e.text, theme)), for (final a in e.anhaenge) _anhang(a, theme)]))));
      case Art.satellit:
        return Text('$zeit  ⚙ ${e.text}', style: theme.textTheme.bodySmall?.copyWith(color: Colors.white54));
      case Art.bestaetigung:
        return Text('$zeit  🔔 ${e.text}', style: theme.textTheme.bodySmall?.copyWith(color: Colors.amber.shade200));
      case Art.hinweis:
        return Text('$zeit  ${e.text}', style: theme.textTheme.bodySmall?.copyWith(color: Colors.white70));
      case Art.fehler:
        return Text('$zeit  ${e.text}', style: theme.textTheme.bodySmall?.copyWith(color: Colors.redAccent));
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
      else spans.add(TextSpan(text: m.group(3), style: TextStyle(fontFamily: 'Consolas', color: Colors.amber.shade200)));
      i = m.end;
    }
    if (i < zeile.length) spans.add(TextSpan(text: zeile.substring(i), style: fettZeile ? const TextStyle(fontWeight: FontWeight.bold) : null));
    if (z < zeilen.length - 1) spans.add(const TextSpan(text: '\n'));
  }
  return TextSpan(children: spans, style: theme.textTheme.bodyMedium);
}
