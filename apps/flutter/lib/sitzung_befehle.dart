part of 'main.dart';

/// 1.10.0 — B1 Befehlspalette (Strg+K / ⌘K) und B2 Tray-Menü mit Zählern (Owner-Freigabe 11.10.).
extension _Befehle on _SitzungState {
  List<Befehl> _befehle() {
    void zeige(Ansicht a) => _neu(() { ansicht = a; if (a == Ansicht.kacheln) kachelnOffen = true; });
    return [
      Befehl(titel: 'Chat', icon: Icons.chat_bubble_outline, stichworte: 'gesprach unterhaltung', aktion: (_) => zeige(Ansicht.chat)),
      Befehl(titel: 'Lage', untertitel: 'Befunde, Vorgänge, Geräte', icon: Icons.dashboard_outlined, stichworte: 'kacheln dashboard befunde vorgange gerate', aktion: (_) => zeige(Ansicht.kacheln)),
      Befehl(titel: 'Hinweise', untertitel: hinweiseOffen == 0 ? null : '$hinweiseOffen offen', icon: Icons.lightbulb_outline, stichworte: 'insights', aktion: (_) => zeige(Ansicht.hinweise)),
      Befehl(titel: 'Eingang', untertitel: 'alles, was dich braucht', icon: Icons.inbox_outlined, stichworte: 'inbox offen erledigen bestaetigungen', aktion: (_) => zeige(Ansicht.eingang)), // 1.36.0
      Befehl(titel: 'Vorgänge', untertitel: vorgaenge.isEmpty ? 'alle offenen Vorgänge' : '${vorgaenge.length} offen', icon: Icons.assignment_outlined, stichworte: 'vorgang aufgaben entscheiden ausfuehren spaeter', aktion: (_) => zeige(Ansicht.vorgaenge)), // 1.34.0
      Befehl(titel: 'Aufgaben & Erinnerungen', untertitel: aufgabenFaelligZahl == 0 ? null : '$aufgabenFaelligZahl heute oder überfällig', icon: Icons.checklist, stichworte: 'todo todos erinnerung reminder', aktion: (_) => zeige(Ansicht.aufgaben)),
      Befehl(titel: 'Gedächtnis', untertitel: 'was Alfred über dich weiß', icon: Icons.psychology_outlined, stichworte: 'memory erinnerungen wissen fakten', aktion: (_) => zeige(Ansicht.gedaechtnis)),
      Befehl(titel: 'Befunde', untertitel: 'was Alfred als auffällig führt', icon: Icons.report_problem_outlined, stichworte: 'auffallig probleme warnungen', aktion: (_) { befundeFilter = null; zeige(Ansicht.befunde); }), // 1.12.0
      Befehl(titel: 'Haus-Check', untertitel: 'Home Assistant nach festen Regeln geprüft', icon: Icons.home_work_outlined, stichworte: 'home assistant automationen gerate melder hauscheck', aktion: (_) { befundeFilter = 'haus-check'; zeige(Ansicht.befunde); }), // 1.12.0
      Befehl(titel: 'Beobachter', untertitel: 'Ordner auf Geräten beobachten, Regeln ein/aus', icon: Icons.visibility_outlined, stichworte: 'beobachten ordner datei downloads regel überwachen', aktion: (_) => zeige(Ansicht.beobachter)), // 1.20.0
      Befehl(titel: 'Projekte', untertitel: 'auf Geräten: Läufe, Stand, weiterarbeiten', icon: Icons.construction_outlined, stichworte: 'projekt claude code bauen etappen entwicklung', aktion: (_) => zeige(Ansicht.projekte)), // 1.15.0
      Befehl(titel: 'Suche im Verlauf', icon: Icons.search, stichworte: 'finden', aktion: (_) => zeige(Ansicht.suche)),
      Befehl(titel: 'Anhänge', untertitel: 'Fotos und Dateien', icon: Icons.photo_library_outlined, stichworte: 'galerie bilder dateien', aktion: (_) => zeige(Ansicht.anhaenge)),
      Befehl(titel: 'Einstellungen', icon: Icons.settings_outlined, stichworte: 'optionen', aktion: (_) => zeige(Ansicht.einstellungen)),
      Befehl(titel: 'Neuer Chat', icon: Icons.add_comment_outlined, stichworte: 'faden gesprach neu', aktion: (_) { zeige(Ansicht.chat); _neuerChat(); }),
      Befehl(titel: 'Gespräch: Hauptgespräch', icon: Icons.forum_outlined, stichworte: 'faden', aktion: (_) { zeige(Ansicht.chat); _fadenWechseln(null); }),
      for (final f in faeden.where((x) => x['faden'] != null && x['archiv'] == null && x['archiviert'] != true)) // 1.43.0 alle aktiven Fäden
        Befehl(titel: 'Gespräch: ${(f['titel'] ?? '').toString().isEmpty ? 'Gespräch' : f['titel']}', untertitel: _fadenZeit('${f['zeit'] ?? ''}'), icon: Icons.chat_bubble_outline, stichworte: 'faden', aktion: (_) { zeige(Ansicht.chat); _fadenWechseln('${f['faden']}'); }),
      // 1.43.0 D2 — Projekte, Aktionen zum offenen Gespräch, Tastenkürzel
      for (final p in projekteKurz) Befehl(titel: 'Projekt: ${p['name']}', icon: Icons.folder_outlined, stichworte: 'projekt ordner', aktion: (_) => _neu(() { projekteAnfang = '${p['id']}'; ansicht = Ansicht.projekte; })),
      Befehl(titel: 'Seiten-Chat ein/aus', untertitel: 'Strg+Alt+S', icon: Icons.vertical_split_outlined, stichworte: 'zwischenfrage nebenbei', aktion: (_) => _seitenChatUmschalten()),
      Befehl(titel: 'Gespräch abzweigen', untertitel: 'neuer Faden mit dem bisherigen Verlauf', icon: Icons.call_split, stichworte: 'fork kopie verzweigen', aktion: (_) { zeige(Ansicht.chat); _fadenAbzweigen(server?.faden); }),
      Befehl(titel: 'Geplante Aufgabe aus diesem Gespräch', icon: Icons.schedule, stichworte: 'planen regelmaessig taeglich', aktion: (_) { zeige(Ansicht.chat); _aufgabeAusFaden(server?.faden); }),
      Befehl(titel: 'Gespräch kopieren (Markdown)', icon: Icons.copy_all_outlined, stichworte: 'zwischenablage', aktion: (_) => _fadenKopieren(server?.faden)),
      Befehl(titel: 'Gespräch exportieren (.md)', icon: Icons.download_outlined, stichworte: 'speichern datei markdown', aktion: (_) => _fadenExportieren(server?.faden)),
      Befehl(titel: 'Gespräch im Browser öffnen', icon: Icons.open_in_browser, stichworte: 'web', aktion: (_) => _fadenImBrowser(server?.faden)),
      Befehl(titel: 'Tastenkürzel', icon: Icons.keyboard_outlined, stichworte: 'hilfe shortcuts tasten', aktion: (_) => _kuerzelZeigen()),
      Befehl(titel: 'Schnellfrage', untertitel: 'Strg+Alt+A', icon: Icons.bolt_outlined, aktion: (_) => _schnellfrageOeffnen()),
      Befehl(titel: hoeren ? 'Zuhören beenden' : 'Zuhören starten', untertitel: 'Aktivierungswort', icon: hoeren ? Icons.hearing_disabled : Icons.hearing, stichworte: 'mikrofon horen', aktion: (_) => _hoerenUmschalten()),
      Befehl(titel: stimme ? 'Antworten vorlesen: aus' : 'Antworten vorlesen: an', icon: stimme ? Icons.volume_off : Icons.volume_up, stichworte: 'stimme sprache ton', aktion: (_) => _neu(() => stimme = !stimme)),
      Befehl(titel: seitenleisteOffen ? 'Seitenleiste ausblenden' : 'Seitenleiste einblenden', icon: Icons.view_sidebar_outlined, aktion: (_) { _neu(() => seitenleisteOffen = !seitenleisteOffen); seitenleisteSpeichern(seitenleisteOffen); }),
      Befehl(titel: 'Farbschema: hell', icon: Icons.light_mode_outlined, stichworte: 'thema theme', aktion: (_) => themaSpeichern(ThemeMode.light)),
      Befehl(titel: 'Farbschema: dunkel', icon: Icons.dark_mode_outlined, stichworte: 'thema theme', aktion: (_) => themaSpeichern(ThemeMode.dark)),
      Befehl(titel: 'Farbschema: wie das System', icon: Icons.brightness_auto_outlined, stichworte: 'thema theme', aktion: (_) => themaSpeichern(ThemeMode.system)),
      Befehl(titel: 'Nach Update suchen', untertitel: appVersion.isEmpty ? null : 'installiert: $appVersion', icon: Icons.system_update_alt, aktion: (_) => _updatePruefen()),
      // mit eingetipptem Text — harmlos zuerst: ohne Treffer wählt Enter „suchen", nie „senden" (1.10.1, VM-Befund:
      // ein Tippfehler ging als Nachricht ins Hauptgespräch)
      Befehl(titel: 'Im Verlauf suchen:', icon: Icons.manage_search, mitText: true, aktion: (t) { if (t.isEmpty) return; letzteSuche = t; zeige(Ansicht.suche); }),
      Befehl(titel: 'Als Aufgabe anlegen:', icon: Icons.add_task, mitText: true, aktion: (t) => _aufgabeAusPalette(t)),
      Befehl(titel: 'An Alfred senden:', icon: Icons.send, mitText: true, aktion: (t) { if (t.isEmpty) return; zeige(Ansicht.chat); eingabe.text = t; _senden(); }),
    ];
  }

  /// 1.43.0 D2 — Liste aller Tastenkürzel (Hilfe).
  Future<void> _kuerzelZeigen() => showDialog<void>(context: context, builder: (ctx) => AlertDialog(
    title: const Text('Tastenkürzel'),
    content: SizedBox(width: 440, child: Column(mainAxisSize: MainAxisSize.min, children: [
      for (final (k, was) in appKuerzel) Padding(padding: const EdgeInsets.symmetric(vertical: 3), child: Row(children: [SizedBox(width: 170, child: Text(Platform.isMacOS ? k.replaceAll('Strg', '⌘') : k, style: const TextStyle(fontWeight: FontWeight.w600))), Expanded(child: Text(was))])),
    ])),
    actions: [TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('Schließen'))],
  ));

  Future<void> _paletteOeffnen() async {
    if (paletteOffen || schnell || !mounted) return;
    paletteOffen = true;
    try { await zeigeBefehlspalette(context, _befehle()); } finally { paletteOffen = false; }
  }

  Future<void> _aufgabeAusPalette(String titel) async {
    final s = server; if (s == null || titel.isEmpty) return;
    try {
      await s.json('/api/geraete/aufgaben', methode: 'POST', koerper: {'titel': titel});
      _protokolliere(Eintrag(Art.hinweis, '✅ Aufgabe angelegt: $titel'));
      _aufgabenZaehlen();
    } catch (e) { _zeile(Eintrag(Art.fehler, 'Aufgabe nicht angelegt: $e')); }
  }

  /// B2 — Tray-Menü mit Zählern und Zuhören-Schalter; Tooltip mit Zusammenfassung, unter macOS die Zahl neben dem Symbol.
  /// Wird alle 5 s aufgerufen und setzt das Menü nur neu, wenn sich etwas geändert hat.
  Future<void> _trayAktualisieren({bool erzwingen = false}) async {
    final teile = [
      if (hinweiseOffen > 0) '$hinweiseOffen ${hinweiseOffen == 1 ? 'Hinweis' : 'Hinweise'}',
      if (aufgabenFaelligZahl > 0) '$aufgabenFaelligZahl ${aufgabenFaelligZahl == 1 ? 'Aufgabe' : 'Aufgaben'} fällig',
      if (offen.isNotEmpty) '${offen.length} ${offen.length == 1 ? 'Bestätigung' : 'Bestätigungen'}',
    ];
    final signatur = '${teile.join('|')}#$hoeren';
    if (!erzwingen && signatur == _traySignatur) return;
    _traySignatur = signatur;
    try {
      await trayManager.setContextMenu(Menu(items: [
        MenuItem(key: 'zeigen', label: 'Alfred öffnen'),
        MenuItem(key: 'schnellfrage', label: 'Schnellfrage (Strg+Alt+A)'),
        MenuItem(key: 'sprechen', label: 'Sprechen (Strg+Alt+Leertaste)'),
        MenuItem(key: 'hoeren', label: hoeren ? 'Zuhören beenden' : 'Zuhören starten'),
        MenuItem.separator(),
        MenuItem(key: 'hinweise', label: hinweiseOffen == 0 ? 'Hinweise' : 'Hinweise ($hinweiseOffen offen)'),
        MenuItem(key: 'aufgaben', label: aufgabenFaelligZahl == 0 ? 'Aufgaben' : 'Aufgaben ($aufgabenFaelligZahl fällig)'),
        if (offen.isNotEmpty) MenuItem(key: 'bestaetigungen', label: 'Bestätigungen (${offen.length})'),
        MenuItem.separator(),
        MenuItem(key: 'beenden', label: 'Beenden'),
      ]));
    } catch (_) { /* Tray-Menü ist Komfort */ }
    try { await trayManager.setToolTip(teile.isEmpty ? 'Alfred' : 'Alfred — ${teile.join(' · ')}'); } catch (_) {}
    // macOS: Zahl neben dem Symbol nur für das, was eine Entscheidung braucht (überfällige Aufgaben stehen im Tooltip)
    if (Platform.isMacOS) { try { final n = hinweiseOffen + offen.length; await trayManager.setTitle(n == 0 ? '' : '$n'); } catch (_) {} }
  }
}
