import 'dart:async';
import 'dart:convert'; // Phase 5 H1 Startdatei
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/foundation.dart' show kDebugMode; // Phase 5 H1
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:hotkey_manager/hotkey_manager.dart';
import 'package:local_notifier/local_notifier.dart';
import 'package:tray_manager/legacy.dart'; // trayManager, Menu, MenuItem, TrayListener (0.5-kompatible API)
import 'package:window_manager/window_manager.dart';

import 'package:package_info_plus/package_info_plus.dart';
import 'package:path_provider/path_provider.dart';

import 'package:file_selector/file_selector.dart';

import 'aktivierungswort.dart'; // 1.3.0
import 'plattform.dart'; // Phase 5 H1
import 'handy_verbindung.dart'; // Phase 5 H1
import 'kopplung.dart'; // Phase 5 H1
import 'handy_push.dart'; // Phase 5 H2
import 'halte_knopf.dart'; // 1.53.0+91
import 'handy_system.dart'; // 1.54.0
import 'unterhaltung.dart'; // 1.58.0 G1
import 'anhang_ansicht.dart'; // 1.5.0
import 'anhang_speicher.dart'; // 1.5.0
import 'aufgaben.dart'; // 1.9.0
import 'befehle.dart'; // 1.10.0
import 'fremde_arbeit.dart'; // 1.11.0
import 'gedaechtnis.dart'; // 1.9.0
import 'befunde.dart'; // 1.12.0
import 'beobachter.dart'; // 1.20.0
import 'projekte.dart'; // 1.15.0
import 'vorgaenge_ansicht.dart'; // 1.34.0
import 'eingang.dart'; // 1.36.0
import 'faden_liste.dart'; // 1.41.0
import 'faden_aktionen.dart'; // 1.43.0 D2
import 'seiten_chat.dart'; // 1.43.0 D2
import 'faden_karte.dart'; // 1.44.0 D3
import 'verlaufsleiste.dart'; // 1.45.0 D4
import 'upload_vorschau.dart'; // 1.46.0
import 'konto_menue.dart'; // 1.47.0 D5
import 'antwort_aktionen.dart'; // 1.50.0 D6
import 'audio.dart';
import 'galerie.dart'; // 1.5.0
import 'suche.dart'; // 1.5.0
import 'verlauf.dart'; // 1.5.0
import 'warteschlange.dart'; // 1.8.0
import 'einstellungen.dart';
import 'hinweise.dart'; // 1.4.0
import 'hoeren.dart';
import 'wortmodell_onnx.dart'; // 1.3.0
import 'update.dart';
import 'ipc.dart';
import 'kacheln.dart';
import 'linux_hotkey.dart';
import 'markdown.dart'; // 1.6.0
import 'zwischenablage.dart'; // 1.6.0
import 'modell.dart';
import 'schnellfrage.dart'; // 1.7.0
import 'stopp_knopf.dart'; // 1.14.1
import 'server.dart';
import 'transfer.dart';
import 'package:desktop_drop/desktop_drop.dart';

part 'sitzung_fenster.dart';
part 'sitzung_sprache.dart';
part 'sitzung_senden.dart';
part 'sitzung_oberflaeche.dart';
part 'sitzung_gespraeche.dart';
part 'sitzung_befehle.dart'; // 1.10.0
part 'sitzung_unterhaltung.dart'; // 1.58.0 G1

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
  // Phase 5 H1 — Beweisläufe im iOS-Simulator: Startwerte aus einer einmaligen Datei im Datenordner der App
  // (`simctl get_app_container … data`/Documents/alfred-start.json, {"koppeln": "...", "sende": "..."}); simctl reicht unter iOS
  // weder Argumente noch Umgebung an Dart weiter. Nur in Debug-Builds, die Datei wird sofort gelöscht.
  if (istHandy) { // 1.54.2 — echter Datenordner vor dem ersten Lesen der Einstellungen (HOME fehlt im iOS-Prozess)
    WidgetsFlutterBinding.ensureInitialized();
    try { handyDatenOrdnerSetzen((await getApplicationSupportDirectory()).path); } catch (_) {}
  }
  if (istHandy && kDebugMode) {
    WidgetsFlutterBinding.ensureInitialized(); // path_provider braucht die Bindung
    try {
      final f = File('${(await getApplicationDocumentsDirectory()).path}/alfred-start.json'); // iOS: HOME aus der Umgebung ist nicht der Datenordner
      if (f.existsSync()) { final j = jsonDecode(f.readAsStringSync()) as Map<String, dynamic>; f.deleteSync(); for (final e in j.entries) { m[e.key] = '${e.value}'; } }
    } catch (_) { /* ohne Startwerte weiter */ }
  }
  startArgs = m;
  WidgetsFlutterBinding.ensureInitialized();
  einstellungenLaden(); // 1.1.0 — Farbschema vor dem ersten Bild
  if (istDesktop) { // Phase 5 H1 — Fenster, Kürzel, Desktop-Benachrichtigungen, Autostart nur auf dem Desktop
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
  } // istDesktop
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
  /// 1.54.0 — Handy: laufende Aufnahme ist ein Diktat (Text ins Eingabefeld statt senden; Owner 19.10.)
  bool diktat = false;
  /// 1.53.0+91 — Halten am Handy-Mikrofon: schon losgelassen, während das Mikrofon noch startete (halte_knopf.dart)
  bool losgelassen = false;
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
  String? projekteAnfang; // 1.16.1 G2 — Projekt, das die Live-Leiste öffnet
  String? befundeFilter; // 1.12.0 — Startfilter der Ansicht „Befunde" (z. B. 'haus-check' aus der Kachel)
  /// 1.1.0 — Redesign Stufe 1: Symbolleiste links (Chat, Lage, Bestätigungen, Einstellungen), einklappbare Seitenleiste,
  /// Chat mittig mit Datumstrennern, Eingabekarte mit Stufenwahl.
  Ansicht ansicht = Ansicht.chat;
  bool seitenleisteOffen = seitenleisteGespeichert();
  bool navBreit = navBreitGespeichert(); // 1.36.0
  String? tierWahl; // null = Automatisch, sonst fast/default/strong
  List<Map<String, dynamic>> vorgaenge = [];
  List<dynamic>? vorgangSchritte; // 1.9.0 — Schritte für den Vorgangs-Dialog
  int aufgabenFaelligZahl = 0; // 1.9.0 — überfällig + heute (Symbolleiste)
  final Map<String, Erinnerung> erinnerungBekannt = {}; // 1.9.0 — bis zur Meldung, auch nach dem Auslösen am Server
  final Set<String> erinnerungGemeldet = {};
  final Map<String, DateTime> erinnerungTexte = {}; // gemeldeter Text → Zeit (keine Doppelmeldung, falls der Server sie auch schickt)
  Timer? erinnerungTakt;
  bool paletteOffen = false; // 1.10.0 B1
  final Map<String, FremdeArbeit> fremdeArbeit = {}; // 1.11.0 — Alfred arbeitet an einer Anfrage aus Telegram/anderem Gerät
  String _traySignatur = ''; // 1.10.0 B2 — Menü nur bei Änderung neu setzen
  Timer? trayTakt;
  DateTime updateGeprueft = DateTime.fromMillisecondsSinceEpoch(0); // 1.10.0 — stilles Update sucht selbst
  Timer? vorgaengeTakt;
  bool hoeren = false; // Meilenstein 4 — Echtzeit-Hören mit Aktivierungswort
  HoerClient? hoerClient;
  SatzendeErkenner? erkenner;
  DateTime gespraechsfensterBis = DateTime.fromMillisecondsSinceEpoch(0);
  int verlaufAbruf = 0; // 1.52.0 — nur der jüngste Verlaufsabruf schreibt (Handy: Konfiguration und Verbinden fielen zusammen → alles doppelt)
  // 1.3.0 — Aktivierungswort lokal (ONNX): nur Äußerungen mit erkanntem Wort (oder im Gesprächsfenster) gehen ans Relais
  OnnxWortModell? wortModell;
  WortErkenner? wortErkenner;
  bool wortLokal = wortLokalGespeichert();
  DateTime letzterWortTreffer = DateTime.fromMillisecondsSinceEpoch(0);
  int wortVerworfen = 0;
  // 1.4.0 — Owner-Befund 10.10. 19:46: lange Antworten im Zuhören wurden als „nicht an mich" verworfen, weil das
  // Gesprächsfenster erst am Ende der Transkription geprüft wurde. Jetzt zählt der Zustand beim Beginn der Äußerung.
  int hinweiseOffen = 0; // 1.4.0 — Zähler der Sammlung Hinweise (Symbolleiste)
  bool aeusserungImFenster = false;
  /// 1.4.1 — gehörter Text, der eintraf, während Alfred noch antwortete; wird danach gesendet statt verworfen.
  String? nachreichen;
  Uint8List? letzteAeusserung; // für den Ersatzweg, wenn das Relais die Transkription nicht liefert (Timeout 3804)
  String gehoert = '';
  /// Hineingezogene Dateien warten als Anhänge in der Eingabezeile, bis gesendet wird (Owner 09.10.: nicht sofort schicken).
  final List<File> anhaenge = [];
  /// M6 — Selbstupdate über den Server: eigene Version, gefundenes Update, Prüf-Takt.
  String appVersion = '';
  UpdateInfo? update;
  /// 1.47.0 D5 — Kontomenü: Kosten und verbundene Geräte (null = noch nicht geladen), Fehlertext.
  final kontoStand = ValueNotifier<(KontoKosten?, List<KontoGeraet>, String?)>((null, const [], null));
  bool updateLaeuft = false;
  Timer? updateTakt;
  Timer? abfrage;
  int benachrichtigungNr = 0;
  late final AppVerbindung ipc; // Phase 5 H1 — Desktop: IPC zum Satelliten, Handy: direkt (handy_verbindung.dart)
  /// Phase 5 H2 — Push auf dem Handy (null am Desktop); Token wird nach jedem Verbinden gemeldet
  HandyPush? push;
  bool _pushStartGeprueft = false;
  final HotKey tastenkuerzel = HotKey(key: PhysicalKeyboardKey.space, modifiers: [HotKeyModifier.control, HotKeyModifier.alt], scope: HotKeyScope.system);

  @override
  void initState() {
    super.initState();
    HardwareKeyboard.instance.addHandler(_schnellTaste); // 1.7.1
    scroll.addListener(_leisteNachScroll); // 1.45.2 — gerade sichtbare Frage in der Verlaufsleiste
    if (istDesktop) { // Phase 5 H1
      windowManager.addListener(this);
      trayManager.addListener(this);
      windowManager.setPreventClose(true);
      _trayEinrichten();
      trayTakt = Timer.periodic(const Duration(seconds: 5), (_) => _trayAktualisieren()); // 1.10.0 B2
      _tastenkuerzelEinrichten();
    } else {
      sichtbar = true; // Handy: App vorne = sichtbar (Hintergrund trennt die Verbindung)
    }
    if (istHandy) push = HandyPush(aufToken: _pushTokenMelden, aufGeoeffnet: _pushOeffnen); // Phase 5 H2
    if (istHandy) zonenAnIos(); // v1522 — überwachte Zonen = Einstellungen (iOS prüft dabei den aktuellen Stand)
    ipc = _verbindung(
      aufStatus: (s) {
        final wieder = s.verbunden && satellit?.verbunden != true; // 1.6.0 — nach Wiederverbinden verpasste Bestätigungen holen
        setState(() => satellit = s);
        // 1.17.1 — startet die App, solange der Server nicht erreichbar ist, scheitern die einmaligen Abrufe still:
        // nach dem Wiederverbinden Gespräche, Spiegel-Schalter und Verlauf nachladen (sonst nur „Hauptgespräch“)
        if (wieder) { _holeBestaetigungen(); _nachsenden(); _faedenLaden(); _spiegelungLaden(); _gespraechNachladen(); } // 1.8.0 Warteschlange
        if (wieder && push != null) { _pushAnmelden(); _telegramStummLaden(); _ablageHolen(); handyZustand().then((z) { if (mounted) setState(() { audioAusgang = '${z['audio'] ?? ''}'; bewegungJetzt = '${z['bewegung'] ?? ''}'; fokusVorlesen = z['fokusVorlesen'] == true; }); }); } // Phase 5 H2; 1.54.0 Ablage; 1.54.3 Audio
      },
      aufEreignis: (art, text, zeit, anhang, faden) {
        if (art == 'gespraech') { // 1.2.1 / v1330 — das Gespräch lief anderswo weiter (Telegram, andere App): nachladen
          if (text == server?.chatId) return; // eigene Nachricht
          if (faden == server?.faden) { _gespraechNachladen(); } else { _faedenLaden(); }
          return;
        }
        if (art == 'arbeit') { _fremdeArbeit(text, faden); return; } // 1.11.0 / v1354
        if (art == 'nachricht' && text.startsWith('⏹') && DateTime.now().difference(abgebrochenUm).inMinutes < 5) { _protokolliere(Eintrag(Art.hinweis, 'Server bestätigt: $text')); return; } // 1.7.0
        if (art == 'nachricht') { // v1318 — Ergebnis nach Freigabe; 1.0.5 — mit Anhang (Foto, Bildschirmfoto, Datei)
          if (faden != server?.faden) { // 1.2.0 — Antwort gehört zu einem anderen Gespräch: Hinweis mit Sprungmarke
            _zeile(Eintrag(Art.hinweis, '💬 Antwort im Gespräch „${_fadenTitel(faden)}“: ${text.isEmpty && anhang != null ? '📎 ${anhang.name}' : (text.length > 80 ? '${text.substring(0, 80)}…' : text)} — in der Seitenleiste öffnen'));
            _faedenLaden();
            _neueNachrichtMelden(text, anhang, faden: faden, andererFaden: true); // 1.6.0 — Klick öffnet dieses Gespräch
            return;
          }
          // 1.2.5 — Anhang ohne Text direkt nach einer Alfred-Antwort: an diese hängen statt eigene Zeile (zwei Pushes vom Server)
          if (text.isEmpty && anhang != null && verlauf.isNotEmpty && verlauf.last.art == Art.alfred && zeit.difference(verlauf.last.zeit).inSeconds.abs() <= 10) {
            setState(() => verlauf.last.anhaenge.add(anhang)); _nachUnten(); return;
          }
          _zeile(Eintrag(Art.alfred, text.isEmpty && anhang != null ? '📎 ${anhang.name}' : text, zeit: zeit, anhaenge: anhang == null ? null : [anhang]));
          if (stimme && text.isNotEmpty) _sprichKurz(text);
          if (!_erinnerungSchonGemeldet(text)) _neueNachrichtMelden(text, anhang); // 1.5.0 — Punkt 3; 1.9.0 keine Doppelmeldung
          return;
        }
        _zeile(Eintrag(Art.satellit, text, zeit: zeit));
      },
      aufBestaetigung: _meldeNeu,
      aufKonfig: (k) {
        final erste = server == null;
        // 1.33.0 — Realfall 16.10.: nach jedem Satelliten-Neustart (Selbst-Update) fragt die App die Konfiguration neu ab; die neue
        // Serververbindung begann mit faden = null, die Ansicht zeigte weiter den offenen Faden — Nachrichten landeten still im
        // Hauptgespräch. Gleiche Konfiguration: Verbindung bleibt. Geänderte: neue Verbindung, der offene Faden bleibt gesetzt.
        final alt = server;
        final gleich = alt != null && alt.k.server == k.server && alt.k.geraetId == k.geraetId && alt.k.token == k.token && alt.k.insecure == k.insecure;
        setState(() { konfig = k; if (!gleich) server = Server(k)..faden = alt?.faden; });
        _titel();
        if (erste) _holeVerlauf(); // v1314 — was zuletzt besprochen wurde
        _holeBestaetigungen();
        // 1.6.0 — Punkt 11: neue Bestätigungen meldet der Satellit sofort (IPC „bestaetigung"); die Abfrage räumt nur noch
        // erledigte weg und fängt verpasste Meldungen auf — 30 s statt 4 s, zusätzlich beim Zurückholen des Fensters
        abfrage ??= Timer.periodic(const Duration(seconds: 30), (_) => _holeBestaetigungen());
        if (erste) { _updatePruefen(); updateTakt ??= Timer.periodic(const Duration(hours: 6), (_) => _updatePruefen()); stillTakt ??= Timer.periodic(const Duration(minutes: 5), (_) => _stillPruefen()); } // M6; 1.8.0 still
        if (erste && !warteschlange.leer) { _zeile(Eintrag(Art.hinweis, '⏳ ${warteschlange.eintraege.length} Nachricht(en) aus der letzten Sitzung warten auf das Nachsenden.')); _wartenStarten(); } // 1.8.0
        if (erste) { _vorgaengeLaden(); _hinweiseZaehlen(); _aufgabenZaehlen(); vorgaengeTakt ??= Timer.periodic(const Duration(seconds: 60), (_) { _vorgaengeLaden(); _hinweiseZaehlen(); _aufgabenZaehlen(); }); erinnerungTakt ??= Timer.periodic(const Duration(seconds: 15), (_) { _erinnerungenPruefen(); _fremdeArbeitAufraeumen(); }); } // 1.1.0 Seitenleiste; 1.5.1 Hinweis-Zähler; 1.9.0 Aufgaben/Erinnerungen
        if (erste) { _faedenLaden(); _kontoLaden(); _stufenLaden(); } // 1.2.0 Gespräche; 1.47.0 Kosten für den Kontoknopf
        if (erste) _spiegelungLaden(); // 1.2.3
        if (erste) {
          final auto = startArgs['sende'];
          if (auto != null && auto.isNotEmpty) { eingabe.text = auto; Future.delayed(const Duration(milliseconds: 800), _senden); }
          final wav = startArgs['sprachtest'];
          if (wav != null && wav.isNotEmpty) Future.delayed(const Duration(milliseconds: 800), () => _sprachtest(wav));
          if (startArgs['kacheln'] == 'an') setState(() { kachelnOffen = true; ansicht = Ansicht.kacheln; }); // Beweislauf: Kacheln sofort öffnen
          final start = Ansicht.values.where((a) => a.name == startArgs['ansicht']).firstOrNull; // 1.10.0 — Beweislauf: --ansicht aufgaben|gedaechtnis|…
          if (start != null) setState(() { ansicht = start; if (start == Ansicht.kacheln) kachelnOffen = true; });
          if (startArgs['hoeren'] == 'an') Future.delayed(const Duration(milliseconds: 800), _hoerenStart); // Meilenstein 4
          final hoertest = startArgs['hoertest'];
          if (hoertest != null && hoertest.isNotEmpty) Future.delayed(const Duration(milliseconds: 800), () => _hoertest(hoertest));
          final wortprobe = startArgs['wortprobe']; // 1.3.0 — Beweislauf Aktivierungswort: WAV nur durch den lokalen Erkenner
          if (wortprobe != null && wortprobe.isNotEmpty) Future.delayed(const Duration(milliseconds: 800), () => _wortprobe(wortprobe));
          final datei = startArgs['datei']; // Meilenstein 3: Beweislauf Datei zum Gehirn
          if (datei != null && datei.isNotEmpty) Future.delayed(const Duration(milliseconds: 800), () { _dateienAbgelegt([datei]); _senden(); }); // Beweislauf: Anhang + sofort senden
        }
      },
      aufZustand: (z) => setState(() => ipcZustand = z),
    );
    if (istDesktop) {
      ipc.start();
    } else {
      // 1.52.1 — Handy: Version vor dem Verbinden lesen (Manifest „app-<Version>“); am Desktop füllt sie die Update-Prüfung
      PackageInfo.fromPlatform().then((p) => appVersion = p.version, onError: (_) {}).whenComplete(ipc.start);
    }
    AnhangSpeicher.standard().aufraeumen(); // 1.5.0 — Gerätespeicher der Anhänge: älter als 30 Tage weg (wie am Server)
    _zeile(Eintrag(Art.hinweis, istHandy ? 'Alfred — direkt mit deinem Server verbunden (Schlüssel geprüft).' : 'Alfred-App — Verlauf, Chat und Bestätigungen laufen über den Satelliten dieses Geräts. Strg+Alt+Leertaste: sprechen (auch aus anderen Programmen).'));
  }

  /// Phase 5 H1 — Desktop hängt am Satelliten (IPC), das Handy verbindet sich selbst (gleiche Rückrufe).
  AppVerbindung _verbindung({required void Function(SatellitStatus) aufStatus, required void Function(String, String, DateTime, Anhang?, String?) aufEreignis, required void Function(Bestaetigung) aufBestaetigung, required void Function(Konfig) aufKonfig, required void Function(String) aufZustand}) {
    if (istDesktop) return IpcVerbindung(aufStatus: aufStatus, aufEreignis: aufEreignis, aufBestaetigung: aufBestaetigung, aufKonfig: aufKonfig, aufZustand: aufZustand);
    return HandyVerbindung(aufStatus: aufStatus, aufEreignis: aufEreignis, aufBestaetigung: aufBestaetigung, aufKonfig: aufKonfig, version: () => appVersion, aufHinweis: (t) => _zeile(Eintrag(Art.hinweis, t)), aufAudio: (a) { if (mounted) setState(() => audioAusgang = a); }, aufBewegung: (b) { if (mounted) setState(() => bewegungJetzt = b); },
      aufZustand: (z) { if (z.contains('neu koppeln')) { setState(() { konfig = null; server = null; }); } aufZustand(z); });
  }

  /// Phase 5 H2 — Erlaubnis (nur beim ersten Mal ein Dialog) und Anmeldung; iOS liefert das Token dann über den Kanal.
  /// Beim ersten Verbinden nach einem Start durch Antippen einer Mitteilung wird deren Ziel geöffnet.
  Future<void> _pushAnmelden() async {
    final p = push; if (p == null) return;
    await p.anmelden();
    if (_pushStartGeprueft) return;
    _pushStartGeprueft = true;
    final z = await p.startZiel();
    if (z != null) _pushOeffnen(z);
  }

  /// 1.54.0 — Ablage vom Server holen. Nach dem Antippen der Mitteilung wird genau dieser Eintrag kopiert; beim Öffnen ohne
  /// Antippen erscheint nur der Hinweis „Alfred hat etwas zum Kopieren“ (die Zwischenablage wird nie ungefragt überschrieben).
  Future<void> _ablageHolen({String? kopiereId}) async {
    final s = server; if (s == null) return;
    try {
      final j = await s.json('/api/geraete/ablage');
      final alle = ((j['eintraege'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>();
      // 1.54.1 — Dateien kommen ohne Rückfrage dazu (überschreiben nie): gleich speichern, ältere zuerst
      for (final d in alle.where((e) => e['art'] == 'datei').toList().reversed) { await _ablageDateiSpeichern(d); }
      final l = alle.where((e) => e['art'] != 'datei').toList();
      final ziel = kopiereId == null ? null : l.where((e) => e['id'] == kopiereId).firstOrNull;
      if (ziel != null) { await _ablageKopieren(ziel); return; }
      if (mounted) _neu(() => ablageOffen = l);
    } catch (_) { /* alter Server oder getrennt */ }
  }

  Future<void> _ablageDateiSpeichern(Map<String, dynamic> e) async {
    final s = server; if (s == null) return;
    try {
      final res = await s.hole('/api/geraete/ablage/${e['id']}/datei');
      if (res.statusCode != 200) { await res.drain<void>(); return; }
      final b = BytesBuilder(copy: false); await for (final t in res) { b.add(t); }
      final wo = await dateiAblegen(e['ordner'] as String?, '${e['name'] ?? 'datei'}', b.takeBytes());
      try { await s.json('/api/geraete/ablage/${e['id']}', methode: 'DELETE'); } catch (_) {}
      _zeile(Eintrag(Art.hinweis, '📥 $wo gespeichert'));
    } catch (err) { _zeile(Eintrag(Art.fehler, 'Datei von Alfred nicht gespeichert: ${'$err'.replaceFirst('Exception: ', '')}')); }
  }

  Future<void> _ablageKopieren(Map<String, dynamic> e) async {
    final ok = await handyKopieren('${e['text'] ?? ''}', vertraulich: e['vertraulich'] == true);
    if (!ok) { _zeile(Eintrag(Art.fehler, 'Zwischenablage nicht gesetzt')); return; }
    try { await server?.json('/api/geraete/ablage/${e['id']}', methode: 'DELETE'); } catch (_) {}
    _neu(() => ablageOffen = ablageOffen.where((x) => x['id'] != e['id']).toList());
    _zeile(Eintrag(Art.hinweis, '📋 In die Zwischenablage kopiert${e['vertraulich'] == true ? ' (nur dieses Gerät, verfällt nach 2 min)' : ''}.'));
  }

  Future<void> _pushTokenMelden(String token, String umgebung) async {
    final s = server; if (s == null) return; // nach dem Verbinden meldet _pushAnmelden erneut
    try { await s.json('/api/geraete/push', methode: 'POST', koerper: {'art': 'apns', 'token': token, 'umgebung': umgebung}); }
    catch (e) { _zeile(Eintrag(Art.hinweis, 'Mitteilungen: Anmeldung am Server fehlgeschlagen ($e)')); }
  }

  /// Angetippte Mitteilung: Bestätigung → Chat mit den offenen Bestätigungen, Hinweis → Sammlung, Antwort → ihr Gespräch.
  void _pushOeffnen(PushZiel z) {
    switch (z.art) {
      case 'bestaetigung': _neu(() => ansicht = Ansicht.chat); _holeBestaetigungen();
      case 'hinweis': _neu(() => ansicht = Ansicht.hinweise);
      case 'antwort': if (server != null && server!.faden != z.faden) { _fadenWechseln(z.faden); } else { _neu(() => ansicht = Ansicht.chat); }
      case 'zwischenablage': _ablageHolen(kopiereId: z.id); // 1.54.0 — Antippen kopiert genau diesen Text
      case 'datei': _ablageHolen(); // 1.54.1 — Antippen speichert die Datei(en)
    }
  }

  /// Phase 5 H1 — Handy ohne Kopplung: Kopplungsansicht statt Chat.
  bool get _handyUngekoppelt => istHandy && konfig == null && (ipcZustand == 'nicht gekoppelt' || ipcZustand.contains('neu koppeln'));

  /// C1 — setState ist @protected; die ausgelagerten Teile (Extensions) rufen es über diesen Helfer.
  void _neu(VoidCallback f) => setState(f);

  @override
  void dispose() {
    abfrage?.cancel();
    vorgaengeTakt?.cancel();
    erinnerungTakt?.cancel(); // 1.9.0
    trayTakt?.cancel(); // 1.10.0
    // 1.41.0 — Löschen, dessen Rückgängig-Frist noch läuft, gilt beim Schließen als bestätigt
    for (final e in loeschenAusstehend.entries) { e.value.cancel(); server?.json('/api/geraete/faeden/${e.key}', methode: 'DELETE').catchError((_) => <String, dynamic>{}); }
    for (final s in _signale) { s.cancel(); }
    hoerClient?.schluss();
    ipc.stop();
    if (istDesktop) windowManager.removeListener(this);
    HardwareKeyboard.instance.removeHandler(_schnellTaste);
    if (istDesktop) { trayManager.removeListener(this); hotKeyManager.unregisterAll(); }
    audio.dispose();
    super.dispose();
  }

  List<StreamSubscription<ProcessSignal>> _signale = [];

  // ── 1.7.0 Schnellfrage (Punkt 4): kleines Fenster über allem, nur Eingabe + Antwort ──────────────────────────────
  final HotKey schnellKuerzel = HotKey(key: PhysicalKeyboardKey.keyA, modifiers: [HotKeyModifier.control, HotKeyModifier.alt], scope: HotKeyScope.system);
  bool schnell = false;
  Rect? _rahmenVorher;
  bool _sichtbarVorher = true;
  bool _maximiertVorher = false;
  DateTime? schnellSeit;

  /// 1.7.1 — Esc schließt die Schnellfrage unabhängig vom Fokus (VM-Beweis 12:26: ohne Fokus kam Esc nicht an).
  bool _schnellTaste(KeyEvent ev) {
    if (schnell && ev is KeyDownEvent && ev.logicalKey == LogicalKeyboardKey.escape) { _schnellfrageSchliessen(); return true; }
    // 1.10.0 B1 — Strg+K (macOS ⌘K) öffnet die Befehlspalette
    if (!schnell && ev is KeyDownEvent && ev.logicalKey == LogicalKeyboardKey.keyK && (HardwareKeyboard.instance.isControlPressed || HardwareKeyboard.instance.isMetaPressed) && !HardwareKeyboard.instance.isAltPressed) { _paletteOeffnen(); return true; }
    if (!schnell && ev is KeyDownEvent) return _kuerzel(ev.logicalKey); // 1.43.0 D2
    return false;
  }

  @override
  void onWindowClose() async {
    // Schließen = in den Tray; Beenden über das Tray-Menü
    if (schnell) { _sichtbarVorher = false; await _schnellfrageSchliessen(); return; } // 1.7.0 — X an der Schnellfrage
    await windowManager.hide();
    setState(() => sichtbar = false);
  }

  @override
  void onWindowFocus() { sichtbar = true; fokussiert = true; letzteAktivitaet = DateTime.now(); _gesehenMerken(); _holeBestaetigungen(); }

  @override
  void onWindowBlur() { fokussiert = false; } // 1.8.0 — stilles Update nur, wenn die App nicht im Vordergrund ist

  @override
  void onWindowMinimize() { sichtbar = false; } // 1.5.0 — minimiert zählt wie ausgeblendet (Benachrichtigung, „neu")

  @override
  void onWindowRestore() { sichtbar = true; _gesehenMerken(); }

  @override
  void onTrayIconMouseDown() { _zeigen(); }

  @override
  void onTrayIconRightMouseDown() { trayManager.popUpContextMenu(); }

  @override
  void onTrayMenuItemClick(MenuItem menuItem) {
    switch (menuItem.key) {
      case 'zeigen': _zeigen();
      case 'sprechen': _talkUmschalten();
      case 'schnellfrage': _schnellfrageOeffnen();
      case 'hoeren': _hoerenUmschalten(); // 1.10.0 B2
      case 'hinweise': _zeigen(); setState(() => ansicht = Ansicht.hinweise);
      case 'aufgaben': _zeigen(); setState(() => ansicht = Ansicht.aufgaben);
      case 'bestaetigungen': _zeigen(); setState(() { ansicht = Ansicht.chat; seitenleisteOffen = true; });
      case 'beenden': _beenden();
    }
  }

  /// 1.6.0 — Punkt 8: Fehler der App gehen ins Server-Log (Logzeile „v1351 App-Meldung"), damit sie auffallen, ohne dass
  /// der Owner sie meldet. Gleicher Text höchstens alle 10 min (der Server begrenzt zusätzlich).
  final Map<String, DateTime> _gemeldeteFehler = {};
  // ── 1.6.0 Ältere Nachrichten (Punkt 2): bisher endete der Verlauf nach 60 Nachrichten ─────────────────────────────
  String? aeltesteZeit;
  bool mehrAeltere = false;
  bool laedtAeltere = false;

  // ── 1.5.0 Suche (Punkt 4): Treffer öffnet die Fundstelle im Chat ─────────────────────────────────────────────────
  Map<String, dynamic>? fundstelle;
  String letzteSuche = ''; // „Zur Suche" zeigt die letzte Anfrage wieder
  final GlobalKey fundSchluessel = GlobalKey();

  // ── 1.8.0 Warteschlange (Punkt 9) und stille Updates (Punkt 10) ─────────────────────────────────────────────────
  final Warteschlange warteschlange = Warteschlange.standard()..lade();
  Timer? warteTakt;
  bool _sendetNach = false;
  Timer? stillTakt;
  bool fokussiert = true;
  DateTime letzteAktivitaet = DateTime.now();
  bool stillUpdate = stillUpdateGespeichert();

  // ── 1.7.0 Antwort abbrechen (Punkt 5) ──────────────────────────────────────────────────────────────────────────
  Vorleser? vorleserLaufend;
  bool abbruch = false;
  DateTime abgebrochenUm = DateTime.fromMillisecondsSinceEpoch(0);

  // ── Oberfläche ──────────────────────────────────────────────────────────────────────────────────────────────────
  @override
  // ── 1.1.0 Redesign Stufe 1 (Owner-Vorlage 09.10.): Symbolleiste | Seitenleiste | Hauptbereich ──────────────────────
  Widget build(BuildContext context) {
    final seite = _seite(context);
    final u = unterhaltung; // 1.58.0 G1 — Unterhaltung liegt über allem; der Chat darunter füllt sich mit
    if (u == null) return seite;
    return Stack(children: [seite, Positioned.fill(child: UnterhaltungsAnsicht(stand: u, spielt: () => audio.spielt, stufe: {'fast': 'Schnell', 'default': 'Normal', 'strong': 'Stark'}[_uStufe],
      aufKugel: _unterhaltungUnterbrechen, aufStumm: _unterhaltungStumm, aufBeenden: _unterhaltungEnde))]);
  }

  Widget _seite(BuildContext context) {
    final theme = Theme.of(context);
    if (_handyUngekoppelt) { // Phase 5 H1
      return KopplungsAnsicht(version: appVersion, hinweis: ipcZustand == 'nicht gekoppelt' ? null : ipcZustand, aufGekoppelt: (k) => (ipc as HandyVerbindung).gekoppelt(k), automatisch: startArgs['koppeln']);
    }
    if (schnell) { // 1.7.0
      return Scaffold(body: Schnellfrage(
        eingabe: eingabe, fokus: fokus, ziel: _fadenTitel(server?.faden), antwortet: antwortet, status: fluechtig, antwort: _schnellAntwort,
        aufSenden: _schnellSenden, aufStopp: _abbrechen, aufSchliessen: _schnellfrageSchliessen, aufFensterOeffnen: () => _schnellfrageSchliessen(insFenster: true),
      ));
    }
    final inhalt = switch (ansicht) {
          Ansicht.hinweise => server == null ? const Center(child: Text('Noch nicht mit dem Satelliten verbunden.')) : Hinweise(json: server!.json, aufMeldung: (t) => _zeile(Eintrag(Art.hinweis, t)), aufAnzahl: (n) { if (mounted && n != hinweiseOffen) setState(() => hinweiseOffen = n); }, aufNachfragen: (text) { setState(() { bezug = Eintrag(Art.alfred, text); ansicht = Ansicht.chat; }); fokus.requestFocus(); }), // 1.4.0
          Ansicht.kacheln => server == null ? const Center(child: Text('Noch nicht mit dem Satelliten verbunden.')) : Kacheln(server: server!, aufHinweis: (t) => _zeile(Eintrag(Art.hinweis, t)), aufMeldung: (t) { _protokolliere(Eintrag(Art.hinweis, t)); _vorgaengeLaden(); }, aufNachfragen: _nachfragen, aufVorgaenge: () => setState(() => ansicht = Ansicht.vorgaenge), aufBefunde: (q) => setState(() { befundeFilter = q; ansicht = Ansicht.befunde; })),
          Ansicht.eingang => server == null ? const Center(child: Text('Noch nicht mit dem Satelliten verbunden.')) : Eingang(json: server!.json, bestaetigungen: List.of(offen), aufEntscheiden: _entscheide, aufMeldung: (t) => _zeile(Eintrag(Art.hinweis, t)), aufNachfragen: _nachfragen, aufGeaendert: () { _vorgaengeLaden(); _hinweiseZaehlen(); _aufgabenZaehlen(); }), // 1.36.0
          Ansicht.vorgaenge => server == null ? const Center(child: Text('Noch nicht mit dem Satelliten verbunden.')) : VorgaengeAnsicht(json: server!.json, aufMeldung: (t) => _zeile(Eintrag(Art.hinweis, t)), aufNachfragen: _nachfragen, aufGeaendert: _vorgaengeLaden), // 1.34.0
          Ansicht.aufgaben => server == null ? const Center(child: Text('Noch nicht mit dem Satelliten verbunden.')) : Aufgaben(json: server!.json, aufMeldung: (t) => _zeile(Eintrag(Art.hinweis, t)), aufStand: _aufgabenStand), // 1.9.0 A1
          Ansicht.gedaechtnis => server == null ? const Center(child: Text('Noch nicht mit dem Satelliten verbunden.')) : Gedaechtnis(json: server!.json, aufMeldung: (t) => _protokolliere(Eintrag(Art.hinweis, t))), // 1.9.0 A3
          Ansicht.befunde => server == null ? const Center(child: Text('Noch nicht mit dem Satelliten verbunden.')) : Befunde(key: ValueKey(befundeFilter), json: server!.json, aufNachfragen: _nachfragen, anfang: befundeFilter, aufMeldung: (t) => _zeile(Eintrag(Art.hinweis, t))), // 1.12.0
          Ansicht.beobachter => server == null ? const Center(child: Text('Noch nicht mit dem Satelliten verbunden.')) : Beobachter(json: server!.json, aufMeldung: (t) => _zeile(Eintrag(Art.hinweis, t))), // 1.20.0
          Ansicht.projekte => server == null ? const Center(child: Text('Noch nicht mit dem Satelliten verbunden.')) : Projekte(key: ValueKey(projekteAnfang), json: server!.json, anfang: projekteAnfang, aufMeldung: (t) => _zeile(Eintrag(Art.hinweis, t)), aufGespraech: (f) => _fadenWechseln(f)), // 1.15.0, 1.16.1 anfang
          Ansicht.suche => server == null ? const Center(child: Text('Noch nicht mit dem Satelliten verbunden.')) : Suche(json: server!.json, aufOeffnen: _fundstelleOeffnen, anfang: letzteSuche, aufAnfrage: (q) => letzteSuche = q), // 1.5.0
          Ansicht.anhaenge => server == null ? const Center(child: Text('Noch nicht mit dem Satelliten verbunden.')) : Galerie(json: server!.json, lade: server!.anhang, aufOeffnen: _anhangOeffnen, aufSpeichern: _anhangSpeichern, aufGespraech: _fadenWechseln), // 1.5.0
          Ansicht.einstellungen => _einstellungen(theme),
          Ansicht.chat => _chat(theme),
        };
    // Phase 5 H1 (Spec §20.4) — schmal (Handy, unter 700 px): Navigation und Gespräche in der Schublade, Inhalt volle Breite
    if (MediaQuery.sizeOf(context).width < 700) return _schmal(theme, inhalt);
    return Scaffold(
      body: Row(children: [
        _leiste(theme),
        if (seitenleisteOffen && ansicht == Ansicht.chat) _seitenleiste(theme), // 1.36.0 — Gespräche nur im Chat
        const VerticalDivider(width: 1),
        Expanded(child: inhalt),
        // 1.43.0 D2 — Seiten-Chat neben dem Hauptchat (eigener Faden, eigene Verbindung)
        if (seitenChatOffen && ansicht == Ansicht.chat && konfig != null && seitenChats[server?.faden ?? 'haupt'] != null) ...[
          const VerticalDivider(width: 1),
          SizedBox(width: 380, child: SeitenChat(
            key: ValueKey(seitenChats[server?.faden ?? 'haupt']!.$1), konfig: konfig!,
            faden: seitenChats[server?.faden ?? 'haupt']!.$1, titel: seitenChats[server?.faden ?? 'haupt']!.$2,
            aufSchliessen: () => _neu(() => seitenChatOffen = false),
            aufAlsHauptchat: () { final f = seitenChats[server?.faden ?? 'haupt']!.$1; _neu(() => seitenChatOffen = false); _fadenWechseln(f); },
            aufGeaendert: _faedenLaden)),
        ],
      ]),
    );
  }

  /// Phase 5 H1 — schmale Oberfläche: Schublade mit Navigation (Symbole) und Gesprächsliste, Inhalt im sicheren Bereich.
  /// Nach einer Auswahl (andere Ansicht oder anderer Faden) schließt sich die Schublade selbst.
  final GlobalKey<ScaffoldState> _schublade = GlobalKey<ScaffoldState>();
  String _auswahlVorher = '';
  Widget _schmal(ThemeData theme, Widget inhalt) {
    final auswahl = '${ansicht.name}|${server?.faden}|$archiv';
    if (auswahl != _auswahlVorher) {
      _auswahlVorher = auswahl;
      WidgetsBinding.instance.addPostFrameCallback((_) { if (_schublade.currentState?.isDrawerOpen == true) _schublade.currentState?.closeDrawer(); });
    }
    final titel = ansicht == Ansicht.chat ? _fadenTitel(server?.faden) : ansicht.name[0].toUpperCase() + ansicht.name.substring(1);
    return Scaffold(
      key: _schublade,
      drawer: Drawer(width: MediaQuery.sizeOf(context).width.clamp(0, 380).toDouble(), child: SafeArea(child: Row(children: [
        _leiste(theme, breit: false),
        Expanded(child: _seitenleiste(theme)),
      ]))),
      appBar: AppBar(
        key: const Key('handy-leiste'), toolbarHeight: 44, titleSpacing: 0,
        leading: IconButton(key: const Key('handy-menue'), tooltip: 'Menü', icon: const Icon(Icons.menu), onPressed: () => _schublade.currentState?.openDrawer()),
        title: ansicht == Ansicht.chat ? null : Text(titel, maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.titleMedium), // Chat hat seine eigene Kopfzeile
        actions: [
          if (offen.isNotEmpty) IconButton(tooltip: 'Bestätigungen', onPressed: () => _neu(() => ansicht = Ansicht.chat), icon: Badge.count(count: offen.length, child: const Icon(Icons.notifications_none))),
          Padding(padding: const EdgeInsets.only(right: 12), child: Icon(Icons.circle, size: 10, color: satellit?.verbunden == true ? Colors.green : theme.colorScheme.error)),
        ],
      ),
      body: SafeArea(top: false, child: Column(children: [
        // 1.54.0 H3 — kein Weg zum Server (außerhalb des Heim-WLANs ohne VPN): klar sagen, Erneut-Knopf
        if (satellit?.verbunden != true && ipcZustand == serverUnerreichbar) Material(key: const Key('netz-hinweis'), color: theme.colorScheme.errorContainer, child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 6, 8, 6),
          child: Row(children: [
            Icon(Icons.wifi_off, size: 18, color: theme.colorScheme.onErrorContainer),
            const SizedBox(width: 10),
            Expanded(child: Text(serverUnerreichbar, style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onErrorContainer))),
            TextButton(onPressed: () => (ipc as HandyVerbindung).jetztVerbinden(pause: Duration.zero), child: const Text('Erneut')),
          ]),
        )),
        // 1.54.0 — Ablage: Alfred wollte etwas in die Zwischenablage legen, während die App im Hintergrund war
        if (ablageOffen.isNotEmpty) Material(key: const Key('ablage-hinweis'), color: theme.colorScheme.primaryContainer, child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 6, 8, 6),
          child: Row(children: [
            Icon(Icons.content_paste, size: 18, color: theme.colorScheme.onPrimaryContainer),
            const SizedBox(width: 10),
            Expanded(child: Text(ablageOffen.length == 1 ? 'Alfred hat etwas zum Kopieren' : 'Alfred hat ${ablageOffen.length} Texte zum Kopieren (neuester zuerst)', style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onPrimaryContainer))),
            TextButton(onPressed: () => _ablageKopieren(ablageOffen.first), child: const Text('Kopieren')),
          ]),
        )),
        Expanded(child: inhalt),
      ])),
    );
  }

  // ── 1.2.0 Gesprächsfäden (Redesign Stufe 2, v1328): Hauptgespräch + beliebig viele Fäden je Gerät ────────────────
  List<Map<String, dynamic>> faeden = [];

  String? archiv; // 1.2.1 — geöffnete alte Kanal-Sitzung (nur lesen)
  bool alleFaeden = false; // 1.41.0 — „Weitere“ aufgeklappt
  bool archivOffen = false; // 1.41.0 — Abschnitt „Archiv“ aufgeklappt
  String fadenFilter = ''; // 1.41.0 — Filter nach Titel (ab mehr als 12 Fäden)
  final Map<String, Timer> loeschenAusstehend = {}; // 1.41.0 — Löschen mit Rückgängig (8 s)
  List<Map<String, dynamic>> projekteKurz = []; // 1.42.0 D1 — aktive Projekte vom Server (Seitenleiste, Zuordnen)
  bool projekteZu = false; // 1.42.0 — Abschnitt „Projekte“ eingeklappt
  final Set<String> projekteGeschlossen = {}; // 1.42.0 — eingeklappte Projektordner
  final Set<String> projekteAlleFaeden = {}; // 1.42.0 — Projekte mit aufgeklapptem „Weitere“
  bool seitenChatOffen = false; // 1.43.0 D2 — Seiten-Chat rechts
  bool karteOffen = false; // 1.44.0 D3 — angeheftete Zusammenfassung oben rechts
  Map<String, int> bewertungen = {}; // 1.50.0 D6a — 👍 (1) / 👎 (-1) je Antwort des offenen Fadens (Schlüssel = Prüfsumme)
  StufenStand stufenStand = const StufenStand(); // 1.50.0 D6b — Modell und Gründlichkeit je Stufe, zuletzt antwortendes Modell
  Set<String> lesezeichen = {}; // 1.45.0 D4 — Lesezeichen des offenen Fadens (Schlüssel = Prüfsumme der Frage)
  final Expando<GlobalKey> _anker = Expando(); // 1.45.0 — Sprungziel je Verlaufseintrag
  double breiteChat = 920; // 1.45.3 — aktuelle Breite des Chatbereichs (für Nachrichten im Verlauf)
  int? leisteAktuell; // 1.45.2 — Verlaufs-Index der gerade sichtbaren eigenen Frage (heller Strich)
  bool _leisteGeplant = false;
  final Map<String, (String, String)> seitenChats = {}; // 1.43.0 — Hauptfaden (oder „haupt“) → (Faden, Titel) des Seiten-Chats
  Eintrag? bezug; // 1.2.2 — Alfred-Nachricht, auf die die nächste Eingabe antwortet (Owner-Freigabe 09.10.)
  bool? spiegelung; // 1.2.3 — Spiegel-Schalter (null = noch nicht geladen)
  bool? telegramStumm; // 1.53.0 H2 — „Telegram stumm, wenn Push zugestellt“ (nur Handy; null = noch nicht geladen)
  /// 1.54.0 — Texte, die Alfred in die Zwischenablage legen wollte, während die App im Hintergrund war
  List<Map<String, dynamic>> ablageOffen = const [];
  bool autoVorlesen = autoVorlesenGespeichert(); // 1.54.0 — bei Kopfhörer/Bluetooth/Auto Antworten vorlesen (Standard an)
  String audioAusgang = ''; // 1.54.3 — aktueller Audio-Ausgang des Handys (für das Vorlese-Symbol)
  /// 1.54.3 — automatisches Vorlesen greift gerade (Handy, Schalter an, Kopfhörer/Bluetooth/Auto)
  String bewegungJetzt = ''; // v1526 — auto, rad, laeuft, geht, still
  /// v1526 — auch im Auto (Bewegung), nicht nur mit Kopfhörern/CarPlay
  bool get vorlesenAutomatisch => istHandy && autoVorlesen && (vorleseAusgaenge.contains(audioAusgang) || bewegungJetzt == 'auto' || fokusVorlesen);
  bool fokusVorlesen = false; // v1528 — Fokusfilter „Antworten vorlesen“
  UnterhaltungsStand? unterhaltung; // 1.58.0 G1 — Unterhaltungsmodus läuft
  SatzendeErkenner? uErkenner;
  bool uBeschaeftigt = false;
  DateTime uRuheBis = DateTime.fromMillisecondsSinceEpoch(0);

}

// Hilfen der Sitzung (C1: aus der Klasse gelöst, damit die ausgelagerten Teile sie ohne Klassennamen nutzen)
bool _gleicherTag(DateTime a, DateTime b) => a.year == b.year && a.month == b.month && a.day == b.day;

/// 1.2.5 — Zitatzeile (↩ „…“) und Anhang-Zeile (📎 …) aus einer eigenen Nachricht entfernen, bevor sie wiederholt wird.
/// 1.2.8 — lange eigene Nachrichten (Upload-Listen) eingeklappt zeigen; nie Alfreds Antworten, nie die neueste Nachricht
/// (Owner-Freigabe 09.10. 21:55). Aufgeklappt bleibt aufgeklappt, bis das Gespräch neu geladen wird.
const klappAb = 1500;
String _ohneZitat(String t) => t.split('\n').where((z) => !z.startsWith('↩ „') && !z.startsWith('📎 ')).join('\n').trim();

String _fadenZeit(String iso) {
  final d = DateTime.tryParse(iso)?.toLocal();
  if (d == null) return '';
  final h = DateTime.now();
  final z = '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  return _gleicherTag(d, h) ? 'heute, $z' : '${d.day.toString().padLeft(2, '0')}.${d.month.toString().padLeft(2, '0')}., $z';
}
