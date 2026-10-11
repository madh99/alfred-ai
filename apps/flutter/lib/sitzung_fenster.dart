part of 'main.dart';

/// C1 (11.10.) — aus main.dart ausgelagert, Verhalten unverändert: Tray, Fenster, Tastenkürzel, Schnellfrage und Benachrichtigungen.
extension _Fenster on _SitzungState {
  // ── Tray, Fenster, Tastenkürzel (Meilenstein 2) ──────────────────────────────────────────────────────────────────
  Future<void> _trayEinrichten() async {
    try {
      await trayManager.setIcon(Platform.isWindows ? 'assets/alfred.ico' : 'assets/alfred.png'); // M5: macOS/Linux brauchen PNG
      await trayManager.setToolTip('Alfred');
      await trayManager.setContextMenu(Menu(items: [
        MenuItem(key: 'zeigen', label: 'Alfred öffnen'),
        MenuItem(key: 'sprechen', label: 'Sprechen (Strg+Alt+Leertaste)'),
        MenuItem(key: 'schnellfrage', label: 'Schnellfrage (Strg+Alt+A)'),
        MenuItem.separator(),
        MenuItem(key: 'beenden', label: 'Beenden'),
      ]));
    } catch (e) { _zeile(Eintrag(Art.fehler, 'Tray nicht verfügbar: $e')); }
  }


  Future<void> _tastenkuerzelEinrichten() async {
    if (Platform.isLinux) {
      // 1.0.3 — Wayland: keybinder kann nicht binden; GNOME-Kürzel + SIGUSR1/SIGUSR2 (linux_hotkey.dart). Unter X11 zusätzlich wie bisher.
      _signale = LinuxHotkey.hoere(_talkUmschalten, _schnellfrageUmschalten);
      final m = await LinuxHotkey.einrichten();
      if (m != null) _zeile(Eintrag(Art.hinweis, m));
      if (LinuxHotkey.wayland) return;
    }
    try {
      await hotKeyManager.register(tastenkuerzel, keyDownHandler: (_) => _talkUmschalten());
    } catch (e) { _zeile(Eintrag(Art.fehler, 'Tastenkürzel nicht registriert: $e')); }
    try {
      await hotKeyManager.register(schnellKuerzel, keyDownHandler: (_) => _schnellfrageUmschalten()); // 1.7.0
    } catch (e) { _zeile(Eintrag(Art.fehler, 'Tastenkürzel Schnellfrage nicht registriert: $e')); }
  }


  Future<void> _schnellfrageUmschalten() async { if (schnell) { await _schnellfrageSchliessen(); } else { await _schnellfrageOeffnen(); } }


  Future<void> _schnellfrageOeffnen() async {
    if (schnell) return;
    try { _rahmenVorher = await windowManager.getBounds(); _sichtbarVorher = await windowManager.isVisible() && !await windowManager.isMinimized(); _maximiertVorher = await windowManager.isMaximized(); } catch (_) {}
    _neu(() { schnell = true; schnellSeit = null; ansicht = Ansicht.chat; });
    try {
      // 1.7.1 — VM-Beweis 12:24: ein maximiertes Fenster ignoriert setSize → erst zurücksetzen, beim Schließen wieder maximieren
      if (_maximiertVorher) { await windowManager.unmaximize(); await Future<void>.delayed(const Duration(milliseconds: 150)); }
      await windowManager.setMinimumSize(const Size(420, 110));
      await windowManager.setSize(const Size(680, 130));
      await windowManager.center();
      await windowManager.setAlwaysOnTop(true);
      await windowManager.show();
      await windowManager.focus();
    } catch (_) {}
    sichtbar = true;
    fokus.requestFocus();
    _protokolliere(Eintrag(Art.hinweis, '⚡ Schnellfrage geöffnet'));
  }


  /// Schnellfrage schließen; `insFenster` = ins normale Fenster wechseln statt es wieder wie vorher zu verstecken.
  Future<void> _schnellfrageSchliessen({bool insFenster = false}) async {
    if (!schnell) return;
    if (antwortet && !insFenster) await _abbrechen();
    _neu(() => schnell = false);
    try {
      await windowManager.setAlwaysOnTop(false);
      await windowManager.setMinimumSize(const Size(640, 480));
      final r = _rahmenVorher;
      if (_maximiertVorher) { await windowManager.maximize(); }
      else if (r != null && r.width >= 640 && r.height >= 480) { await windowManager.setBounds(r); } else { await windowManager.setSize(const Size(1180, 800)); await windowManager.center(); }
      if (!insFenster && !_sichtbarVorher) { await windowManager.hide(); sichtbar = false; }
    } catch (_) {}
    if (insFenster) _nachUnten();
  }


  Future<void> _schnellSenden() async {
    if (eingabe.text.trim().isEmpty || antwortet) return;
    schnellSeit = DateTime.now();
    try { await windowManager.setSize(const Size(680, 460)); } catch (_) {}
    await _senden();
    // 1.7.1 — VM-Beweis 12:26: das während der Antwort gesperrte Feld verlor den Fokus, requestFocus kam einen Frame zu früh
    WidgetsBinding.instance.addPostFrameCallback((_) { if (schnell) fokus.requestFocus(); });
  }


  /// Antwort auf die Schnellfrage: die laufende oder die letzte Alfred-Zeile seit dem Senden.
  Eintrag? get _schnellAntwort {
    final seit = schnellSeit; if (seit == null) return null;
    if (laufend != null) return laufend;
    for (final e in verlauf.reversed) { if (e.zeit.isBefore(seit)) break; if (e.art == Art.alfred || e.art == Art.fehler) return e; }
    return null;
  }


  /// 1.5.0 — Punkt 3: Antwort kam, während das Fenster nicht zu sehen war → Systembenachrichtigung; sonst gilt sie als gesehen.
  /// 1.6.0 — Punkt 6: Klick auf die Benachrichtigung öffnet das Gespräch, zu dem die Antwort gehört (vorher nur die App).
  Future<void> _neueNachrichtMelden(String text, Anhang? anhang, {String? faden, bool andererFaden = false}) async {
    if (sichtbar) { if (!andererFaden) _gesehenMerken(); return; }
    try {
      final n = LocalNotification(title: andererFaden ? 'Alfred — ${_fadenTitel(faden)}' : 'Alfred', body: text.isEmpty && anhang != null ? '📎 ${anhang.name}' : (text.length > 180 ? '${text.substring(0, 180)}…' : text));
      n.onClick = () => _gespraechZeigen(faden);
      await n.show();
    } catch (_) {}
  }


  /// Fenster zeigen und in das Gespräch wechseln (null = Hauptgespräch), falls nicht schon offen.
  Future<void> _gespraechZeigen(String? faden) async {
    await _zeigen();
    final s = server; if (s == null) return;
    if (s.faden != faden || fundstelle != null || archiv != null || ansicht != Ansicht.chat) { await _fadenWechseln(faden); }
  }


  /// Neueste sichtbare Alfred-Antwort als gesehen speichern (nur im Live-Verlauf, nicht in Fundstelle/Archiv).
  void _gesehenMerken() {
    if (fundstelle != null || archiv != null) return;
    final t = neuesteAntwort(verlauf);
    if (t == null) return;
    final alt = gesehenGespeichert();
    if (alt == null || t.isAfter(alt)) gesehenSpeichern(t);
  }


  Future<void> _zeigen() async {
    await windowManager.show();
    await windowManager.focus();
    _neu(() => sichtbar = true);
    _gesehenMerken(); // 1.5.0
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
      n.onClick = () { _zeigen(); _neu(() => ansicht = Ansicht.chat); }; // 1.6.0 — Bestätigungskarten stehen im Chat
      await n.show();
    } catch (_) {}
  }
}
