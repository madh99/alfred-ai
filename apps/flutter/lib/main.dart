import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:hotkey_manager/hotkey_manager.dart';
import 'package:local_notifier/local_notifier.dart';
import 'package:tray_manager/legacy.dart'; // trayManager, Menu, MenuItem, TrayListener (0.5-kompatible API)
import 'package:window_manager/window_manager.dart';

import 'audio.dart';
import 'ipc.dart';
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
  try { await localNotifier.setup(appName: 'Alfred', shortcutPolicy: ShortcutPolicy.requireCreate); } catch (_) { /* ohne Benachrichtigungen weiter */ }
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
      aufEreignis: (art, text, zeit) => _zeile(Eintrag(Art.satellit, text, zeit: zeit)),
      aufBestaetigung: _meldeNeu,
      aufKonfig: (k) {
        final erste = server == null;
        setState(() { konfig = k; server = Server(k); });
        _titel();
        _holeBestaetigungen();
        abfrage ??= Timer.periodic(const Duration(seconds: 4), (_) => _holeBestaetigungen());
        if (erste) {
          final auto = startArgs['sende'];
          if (auto != null && auto.isNotEmpty) { eingabe.text = auto; Future.delayed(const Duration(milliseconds: 800), _senden); }
          final wav = startArgs['sprachtest'];
          if (wav != null && wav.isNotEmpty) Future.delayed(const Duration(milliseconds: 800), () => _sprachtest(wav));
          final datei = startArgs['datei']; // Meilenstein 3: Beweislauf Datei zum Gehirn
          if (datei != null && datei.isNotEmpty) Future.delayed(const Duration(milliseconds: 800), () => _dateienAbgelegt([datei]));
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
      await trayManager.setIcon('assets/alfred.ico');
      await trayManager.setToolTip('Alfred');
      await trayManager.setContextMenu(Menu(items: [
        MenuItem(key: 'zeigen', label: 'Alfred öffnen'),
        MenuItem(key: 'sprechen', label: 'Sprechen (Strg+Alt+Leertaste)'),
        MenuItem.separator(),
        MenuItem(key: 'beenden', label: 'Beenden'),
      ]));
    } catch (e) { _zeile(Eintrag(Art.fehler, 'Tray nicht verfügbar: $e')); }
  }

  Future<void> _tastenkuerzelEinrichten() async {
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
    final ok = await audio.aufnehmen();
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

  // ── Verlauf, Bestätigungen, Chat (Meilenstein 1) ────────────────────────────────────────────────────────────────
  // ── Dateien (Meilenstein 3): per Drag-and-drop ins Fenster → Dateispeicher des Owners, dann Alfred Bescheid geben ──
  Future<void> _dateienAbgelegt(List<String> pfade) async {
    final k = konfig;
    if (k == null) { _zeile(Eintrag(Art.fehler, 'Noch nicht mit dem Satelliten verbunden — $ipcZustand')); return; }
    final t = Transfer(k);
    for (final p in pfade) {
      final f = File(p);
      if (!f.existsSync()) { _zeile(Eintrag(Art.fehler, 'Keine Datei: $p')); continue; }
      final name = f.uri.pathSegments.last;
      final t0 = DateTime.now();
      try {
        setState(() => fluechtig = '📎 $name wird hochgeladen …');
        final r = await t.hochladen(f, fortschritt: (g, s) => setState(() => fluechtig = '📎 $name: ${(100 * g / s).round()} %'));
        final sek = DateTime.now().difference(t0).inMilliseconds / 1000;
        _zeile(Eintrag(Art.hinweis, '📎 $name (${(r.groesse / 1024 / 1024).toStringAsFixed(1)} MB) in ${sek.toStringAsFixed(1)} s hochgeladen · Schlüssel ${r.key} · SHA-256 ${r.sha256}'));
        await _senden(text: 'Ich habe die Datei „$name" (${r.groesse} Bytes, SHA-256 ${r.sha256}) in deinen Dateispeicher gelegt, Schlüssel: ${r.key}. Bestätige kurz den Empfang.');
      } catch (e) { _zeile(Eintrag(Art.fehler, '📎 $name: $e')); }
      finally { setState(() => fluechtig = ''); }
    }
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
    final t = (text ?? eingabe.text).trim();
    final s = server;
    if (t.isEmpty || antwortet) return null;
    if (s == null) { _zeile(Eintrag(Art.fehler, 'Noch nicht mit dem Satelliten verbunden — $ipcZustand')); return null; }
    if (text == null) { eingabe.clear(); _zeile(Eintrag(Art.du, t)); }
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
          IconButton(tooltip: stimme ? 'Antworten vorlesen: an' : 'Antworten vorlesen: aus', onPressed: () => setState(() => stimme = !stimme), icon: Icon(stimme ? Icons.volume_up : Icons.volume_off)),
          IconButton(tooltip: aufnahme ? 'Aufnahme stoppen' : 'Sprechen (Strg+Alt+Leertaste)', onPressed: _talkUmschalten, icon: Icon(aufnahme ? Icons.stop_circle : Icons.mic, color: aufnahme ? Colors.redAccent : null)),
          if (offen.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(right: 12, left: 4),
              child: Chip(avatar: const Icon(Icons.notifications_active, size: 18), label: Text('${offen.length} ${offen.length == 1 ? 'Bestätigung' : 'Bestätigungen'}'), backgroundColor: Colors.amber.shade900),
            ),
        ],
      ),
      body: DropTarget(
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
          if (fluechtig.isNotEmpty) Padding(padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4), child: Align(alignment: Alignment.centerLeft, child: Text(fluechtig, style: theme.textTheme.bodySmall?.copyWith(color: aufnahme ? Colors.redAccent : Colors.white54)))),
          const Divider(height: 1),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: eingabe,
                    focusNode: fokus,
                    autofocus: true,
                    enabled: !antwortet,
                    minLines: 1,
                    maxLines: 5,
                    decoration: const InputDecoration(hintText: 'Nachricht an Alfred … (Enter sendet)', border: OutlineInputBorder(), isDense: true),
                    onSubmitted: (_) => _senden(),
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

  Widget _eintrag(Eintrag e, ThemeData theme) {
    final zeit = '${e.zeit.hour.toString().padLeft(2, '0')}:${e.zeit.minute.toString().padLeft(2, '0')}';
    switch (e.art) {
      case Art.du:
        return Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: Align(alignment: Alignment.centerRight, child: Container(constraints: const BoxConstraints(maxWidth: 720), padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8), decoration: BoxDecoration(color: theme.colorScheme.primaryContainer, borderRadius: BorderRadius.circular(12)), child: SelectableText(e.text))));
      case Art.alfred:
        return Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: Align(alignment: Alignment.centerLeft, child: Container(constraints: const BoxConstraints(maxWidth: 820), padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8), decoration: BoxDecoration(color: theme.colorScheme.surfaceContainerHigh, borderRadius: BorderRadius.circular(12)), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text('Alfred · $zeit', style: theme.textTheme.labelSmall?.copyWith(color: Colors.cyanAccent)), const SizedBox(height: 4), SelectableText.rich(markdown(e.text.isEmpty ? '…' : e.text, theme))]))));
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
