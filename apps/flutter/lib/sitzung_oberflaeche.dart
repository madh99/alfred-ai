part of 'main.dart';

/// C1 (11.10.) — aus main.dart ausgelagert, Verhalten unverändert: Oberfläche: Symbolleiste, Seitenleiste, Chat, Eingabe, Einstellungen, Einträge.
extension _Oberflaeche on _SitzungState {
  /// 1.36.0 — Navigation mit Beschriftung und Gruppen (Owner 16.10.: „sehr plump in der UI"; vorher 15 unbeschriftete Symbole):
  /// Chat · Eingang (Vorgänge, Hinweise, Aufgaben, Bestätigungen) · Haus & Systeme (Lage, Befunde, Beobachter) · Arbeit (Projekte) ·
  /// Wissen (Gedächtnis, Suche, Anhänge) · unten Befehle und Einstellungen. Breit (mit Text) oder schmal (nur Symbole), gemerkt.
  Widget _leiste(ThemeData theme, {bool? breit}) { // Phase 5 H1 — in der Handy-Schublade nur Symbole
    return _leisteBauen(theme, breit ?? navBreit);
  }

  Widget _leisteBauen(ThemeData theme, bool breit) {
    final cs = theme.colorScheme;
    final ohneServer = server == null;
    Widget eintrag(IconData icon, IconData aktivIcon, String text, bool aktiv, VoidCallback? auf, {int zaehler = 0, String? tip}) {
      final farbe = auf == null ? cs.onSurfaceVariant.withValues(alpha: 0.45) : aktiv ? cs.onPrimaryContainer : cs.onSurfaceVariant;
      final symbol = Icon(aktiv ? aktivIcon : icon, size: 20, color: farbe);
      final inhalt = breit
          ? Row(children: [
              symbol, const SizedBox(width: 12),
              Expanded(child: Text(text, maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodyMedium?.copyWith(color: farbe, fontWeight: aktiv ? FontWeight.w600 : FontWeight.w500))),
              if (zaehler > 0) Container(padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 1), decoration: BoxDecoration(color: aktiv ? cs.primary : cs.secondaryContainer, borderRadius: BorderRadius.circular(10)),
                  child: Text('$zaehler', style: theme.textTheme.labelSmall?.copyWith(color: aktiv ? cs.onPrimary : cs.onSecondaryContainer, fontWeight: FontWeight.w700))),
            ])
          : Center(child: zaehler > 0 ? Badge.count(count: zaehler, backgroundColor: cs.secondary, child: symbol) : symbol);
      return Padding(padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 1), child: Tooltip(message: breit ? (tip ?? '') : (tip ?? text), child: Material(
        color: aktiv ? cs.primaryContainer : Colors.transparent,
        borderRadius: BorderRadius.circular(10),
        child: InkWell(borderRadius: BorderRadius.circular(10), onTap: auf, child: SizedBox(height: 38, child: Padding(padding: EdgeInsets.symmetric(horizontal: breit ? 12 : 0), child: inhalt))),
      )));
    }
    Widget gruppe(String name) => breit
        ? Padding(padding: const EdgeInsets.fromLTRB(22, 14, 12, 4), child: Text(name.toUpperCase(), style: theme.textTheme.labelSmall?.copyWith(color: cs.onSurfaceVariant, letterSpacing: 0.8, fontWeight: FontWeight.w600)))
        : Padding(padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 8), child: Divider(height: 1, color: cs.outlineVariant));
    void zu(Ansicht a, [void Function()? dazu]) => _neu(() { dazu?.call(); ansicht = a; });
    return Container(
      width: breit ? 224 : 68,
      decoration: BoxDecoration(color: cs.surfaceContainerLow, border: Border(right: BorderSide(color: cs.outlineVariant))),
      child: Column(children: [
        Padding(padding: EdgeInsets.fromLTRB(breit ? 18 : 0, 14, breit ? 8 : 0, 6), child: Row(mainAxisAlignment: breit ? MainAxisAlignment.start : MainAxisAlignment.center, children: [
          ClipRRect(borderRadius: BorderRadius.circular(8), child: Image.asset('assets/alfred.png', width: 30, height: 30, filterQuality: FilterQuality.medium)),
          if (breit) ...[const SizedBox(width: 10), Expanded(child: Text('Alfred', style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)))],
        ])),
        Expanded(child: ListView(padding: const EdgeInsets.only(bottom: 6), children: [
          const SizedBox(height: 4),
          eintrag(Icons.chat_bubble_outline, Icons.chat_bubble, 'Chat', ansicht == Ansicht.chat, () => zu(Ansicht.chat)),
          gruppe('Eingang'),
          eintrag(Icons.inbox_outlined, Icons.inbox, 'Eingang', ansicht == Ansicht.eingang, ohneServer ? null : () => zu(Ansicht.eingang), zaehler: eingangZahl(bestaetigungen: offen.length, vorgaenge: vorgaenge, aufgabenFaellig: aufgabenFaelligZahl, hinweiseOffen: hinweiseOffen, jetzt: DateTime.now()), tip: 'Alles, was dich braucht — das Dringendste zuerst'), // 1.36.0
          eintrag(Icons.assignment_outlined, Icons.assignment, 'Vorgänge', ansicht == Ansicht.vorgaenge, ohneServer ? null : () => zu(Ansicht.vorgaenge), zaehler: vorgangAktivZahl(vorgaenge, DateTime.now()), tip: 'Offene Vorgänge: entscheiden, ausführen, später'), // 1.34.0; 1.83.0 ohne Zurückgestellte (wie Eingang)
          eintrag(Icons.lightbulb_outline, Icons.lightbulb, 'Hinweise', ansicht == Ansicht.hinweise, ohneServer ? null : () => zu(Ansicht.hinweise), zaehler: hinweiseOffen), // 1.4.0
          eintrag(Icons.checklist, Icons.checklist_rtl, 'Aufgaben', ansicht == Ansicht.aufgaben, ohneServer ? null : () => zu(Ansicht.aufgaben), zaehler: aufgabenFaelligZahl, tip: 'Aufgaben & Erinnerungen'), // 1.9.0 A1
          eintrag(Icons.notifications_none, Icons.notifications, 'Bestätigungen', false, () => _neu(() { ansicht = Ansicht.chat; seitenleisteOffen = true; }), zaehler: offen.length, tip: offen.isEmpty ? 'Keine offenen Bestätigungen' : '${offen.length} offene Bestätigung(en) — in der Seitenleiste'),
          gruppe('Haus & Systeme'),
          eintrag(Icons.dashboard_outlined, Icons.dashboard, 'Lage', ansicht == Ansicht.kacheln, ohneServer ? null : () => zu(Ansicht.kacheln, () => kachelnOffen = true), tip: 'Lage: Befunde, Vorgänge, Geräte'),
          eintrag(Icons.report_problem_outlined, Icons.report_problem, 'Befunde', ansicht == Ansicht.befunde, ohneServer ? null : () => zu(Ansicht.befunde, () => befundeFilter = null), tip: 'Was Alfred als auffällig führt (Haus-Check u. a.)'), // 1.12.0
          eintrag(Icons.published_with_changes_outlined, Icons.published_with_changes, 'Changes', ansicht == Ansicht.changes, ohneServer ? null : () => zu(Ansicht.changes), zaehler: changesOffen, tip: 'Infrastruktur-Changes: was läuft, was angehalten ist, was auf Freigabe wartet'), // 1.75.0
          eintrag(Icons.visibility_outlined, Icons.visibility, 'Beobachter', ansicht == Ansicht.beobachter, ohneServer ? null : () => zu(Ansicht.beobachter)), // 1.20.0
          eintrag(Icons.payments_outlined, Icons.payments, 'Kosten', ansicht == Ansicht.kosten, ohneServer ? null : () => zu(Ansicht.kosten), tip: 'Kosten je Tag und Modell, Code-Agenten getrennt'), // 1.71.0
          gruppe('Arbeit'),
          eintrag(Icons.construction_outlined, Icons.construction, 'Projekte', ansicht == Ansicht.projekte, ohneServer ? null : () => zu(Ansicht.projekte), tip: 'Projekte auf Geräten'), // 1.15.0
          gruppe('Wissen'),
          eintrag(Icons.psychology_outlined, Icons.psychology, 'Gedächtnis', ansicht == Ansicht.gedaechtnis, ohneServer ? null : () => zu(Ansicht.gedaechtnis), tip: 'Was Alfred über dich weiß'), // 1.9.0 A3
          eintrag(Icons.sticky_note_2_outlined, Icons.sticky_note_2, 'Notizen', ansicht == Ansicht.notizen, ohneServer ? null : () => zu(Ansicht.notizen), tip: 'Notizen lesen, suchen, anlegen'), // 1.71.0
          eintrag(Icons.hub_outlined, Icons.hub, 'Wissen', ansicht == Ansicht.wissen, ohneServer ? null : () => zu(Ansicht.wissen), tip: 'Wissen, Interessen und Ziele'), // 1.71.0
          eintrag(Icons.search, Icons.manage_search, 'Suche', ansicht == Ansicht.suche, ohneServer ? null : () => zu(Ansicht.suche), tip: 'Suche im Verlauf'), // 1.5.0
          eintrag(Icons.photo_library_outlined, Icons.photo_library, 'Anhänge', ansicht == Ansicht.anhaenge, ohneServer ? null : () => zu(Ansicht.anhaenge), tip: 'Fotos und Dateien'), // 1.5.0
        ])),
        Divider(height: 1, color: cs.outlineVariant),
        const SizedBox(height: 6),
        _kontoKnopf(theme, breit), // 1.47.0 D5 — Kontomenü (Einstellungen, Befehle, Hilfe, Kosten, Geräte, Update)
        if (istDesktop) eintrag(breit ? Icons.keyboard_double_arrow_left : Icons.keyboard_double_arrow_right, Icons.keyboard_double_arrow_left, breit ? 'Einklappen' : 'Ausklappen', false, () { _neu(() => navBreit = !navBreit); navBreitSpeichern(navBreit); }), // 1.52.1 — nur Desktop; in der Handy-Schublade fest eingeklappt
        const SizedBox(height: 8),
      ]),
    );
  }


  /// Einklappbare Seitenleiste: Gerät, „Neuer Chat", offene Bestätigungen, Vorgänge, letzte Fragen, Satellitenstatus.
  Widget _seitenleiste(ThemeData theme) {
    final dim = theme.colorScheme.onSurfaceVariant;
    final geraet = konfig?.name ?? satellit?.name ?? '…';
    Widget abschnitt(String t) => Padding(padding: const EdgeInsets.fromLTRB(16, 14, 16, 4), child: Text(t, style: theme.textTheme.labelMedium?.copyWith(color: dim)));
    final gruppen = fadenGruppen(faeden, alle: alleFaeden, filter: fadenFilter, ausgeblendet: loeschenAusstehend.keys.toSet(), projekte: projekteKurz, offeneProjekte: projekteAlleFaeden); // 1.41.0, 1.42.0 Projekte
    Widget fadenZeile(Map<String, dynamic> f, IconData symbol, {bool angeheftet = false}) => ListTile(
      dense: true, selected: server?.faden == f['faden'],
      leading: Icon(symbol, size: 18, color: angeheftet ? theme.colorScheme.primary : null),
      title: Text(fadenTitelText(f), maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall),
      subtitle: Text(_fadenZeit('${f['zeit'] ?? ''}'), style: theme.textTheme.labelSmall?.copyWith(color: dim)),
      trailing: _fadenMenue(f),
      onTap: () => _fadenWechseln('${f['faden']}'));
    return Material( // 1.52.0 — Material statt Container(color): ListTiles brauchen es für Hintergrund und Tipp-Welle (Debug-Prüfung in der Handy-Schublade)
      color: theme.colorScheme.surfaceContainerLow,
      child: SizedBox(width: 270,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Padding(padding: const EdgeInsets.fromLTRB(16, 12, 6, 0), child: Row(children: [
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Gespräche', style: theme.textTheme.titleMedium), // 1.36.0 — „Alfred" steht schon in der Navigation
            Text(geraet, style: theme.textTheme.bodySmall?.copyWith(color: dim), overflow: TextOverflow.ellipsis),
          ])),
          IconButton(tooltip: 'Seitenleiste einklappen', onPressed: () { _neu(() => seitenleisteOffen = false); seitenleisteSpeichern(false); }, icon: const Icon(Icons.view_sidebar_outlined, size: 20)),
        ])),
        Padding(padding: const EdgeInsets.fromLTRB(10, 10, 10, 0), child: ListTile(dense: true, leading: const Icon(Icons.edit_square, size: 20), title: const Text('Neuer Chat'), subtitle: Text('Eigenes Gespräch mit Alfred', style: theme.textTheme.labelSmall?.copyWith(color: dim)), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)), tileColor: theme.colorScheme.surfaceContainerHigh, onTap: _neuerChat)),
        Expanded(child: ListView(padding: const EdgeInsets.only(bottom: 8), children: [
          // 1.42.0 D1 (App-Spec §11) — Projekte mit ihren Fäden, getrennt von den Gesprächen
          if (gruppen.projekte.isNotEmpty) ...[
            Padding(padding: const EdgeInsets.fromLTRB(16, 14, 4, 0), child: Row(children: [
              Expanded(child: InkWell(onTap: () => _neu(() => projekteZu = !projekteZu), child: Row(children: [Text('Projekte', style: theme.textTheme.labelMedium?.copyWith(color: dim)), Icon(projekteZu ? Icons.chevron_right : Icons.expand_more, size: 16, color: dim)]))),
              IconButton(tooltip: 'Alle Projekte', iconSize: 16, visualDensity: VisualDensity.compact, onPressed: () => _neu(() { projekteAnfang = null; ansicht = Ansicht.projekte; }), icon: const Icon(Icons.more_horiz)),
              IconButton(tooltip: 'Neues Projekt (im Gespräch beschreiben)', iconSize: 16, visualDensity: VisualDensity.compact, onPressed: () { _neuerChat(); eingabe.text = 'Neues Projekt: '; fokus.requestFocus(); }, icon: const Icon(Icons.add)),
            ])),
            if (!projekteZu) for (final p in gruppen.projekte) ...[
              ListTile(dense: true, contentPadding: const EdgeInsets.only(left: 8, right: 12),
                leading: IconButton(tooltip: projekteGeschlossen.contains(p.id) ? 'Fäden zeigen' : 'Fäden ausblenden', iconSize: 18, visualDensity: VisualDensity.compact,
                  onPressed: () => _neu(() { if (!projekteGeschlossen.remove(p.id)) projekteGeschlossen.add(p.id); }),
                  icon: Icon(projekteGeschlossen.contains(p.id) ? Icons.folder_outlined : Icons.folder_open_outlined)),
                title: Text(p.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall?.copyWith(fontWeight: FontWeight.w600)),
                onTap: () => _neu(() { projekteAnfang = p.id; ansicht = Ansicht.projekte; })),
              if (!projekteGeschlossen.contains(p.id)) ...[
                for (final f in p.faeden) Padding(padding: const EdgeInsets.only(left: 18), child: fadenZeile(f, Icons.chat_bubble_outline)), // 1.43.0 — 🔨 steht schon im Titel des Projektfadens
                if (p.weitere > 0) Padding(padding: const EdgeInsets.only(left: 18), child: ListTile(dense: true, leading: const Icon(Icons.expand_more, size: 18), title: Text('Weitere (${p.weitere})', style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.primary)), onTap: () => _neu(() => projekteAlleFaeden.add(p.id)))),
              ],
            ],
          ],
          abschnitt('Gespräche'),
          ListTile(dense: true, selected: server?.faden == null, leading: const Icon(Icons.forum_outlined, size: 18), title: Text('Hauptgespräch', style: theme.textTheme.bodySmall), onTap: () => _fadenWechseln(null)),
          // 1.41.0 (v1497) — angeheftete oben, dann die neuesten 12 mit „Weitere“, Filter ab 13 Fäden; Archiv getrennt
          for (final f in gruppen.angeheftet) fadenZeile(f, Icons.push_pin, angeheftet: true),
          for (final f in gruppen.gespraeche) fadenZeile(f, Icons.chat_bubble_outline),
          if (gruppen.weitere > 0) ListTile(dense: true, leading: const Icon(Icons.expand_more, size: 18), title: Text('Weitere (${gruppen.weitere})', style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.primary)), onTap: () => _neu(() => alleFaeden = true)),
          if (alleFaeden && gruppen.filterSinnvoll && fadenFilter.isEmpty) ListTile(dense: true, leading: const Icon(Icons.expand_less, size: 18), title: Text('Weniger anzeigen', style: theme.textTheme.bodySmall?.copyWith(color: dim)), onTap: () => _neu(() => alleFaeden = false)),
          if (gruppen.filterSinnvoll || fadenFilter.isNotEmpty) Padding(padding: const EdgeInsets.fromLTRB(16, 4, 16, 4), child: TextField(
            decoration: InputDecoration(isDense: true, prefixIcon: const Icon(Icons.search, size: 18), hintText: 'Gespräche filtern', border: const OutlineInputBorder(),
              suffixIcon: fadenFilter.isEmpty ? null : IconButton(tooltip: 'Filter löschen', iconSize: 16, onPressed: () => _neu(() => fadenFilter = ''), icon: const Icon(Icons.close))),
            style: theme.textTheme.bodySmall, onChanged: (v) => _neu(() => fadenFilter = v))),
          if (offen.isNotEmpty) ...[
            abschnitt('Bestätigungen (${offen.length})'),
            for (final b in offen) ListTile(dense: true, leading: Icon(Icons.notifications_active, size: 18, color: Colors.amber.shade700), title: Text(b.text, maxLines: 2, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall), onTap: () => _neu(() => ansicht = Ansicht.chat)),
          ],
          // 1.42.0 D1 — Archiv mit den früheren Gerätesitzungen (vorher eigener Abschnitt)
          if (gruppen.archiviert.isNotEmpty || gruppen.sitzungen.isNotEmpty) ...[
            ListTile(dense: true, leading: Icon(archivOffen ? Icons.expand_less : Icons.expand_more, size: 18), title: Text('Archiv (${gruppen.archiviert.length + gruppen.sitzungen.length})', style: theme.textTheme.labelMedium?.copyWith(color: dim)), onTap: () => _neu(() => archivOffen = !archivOffen)),
            if (archivOffen || fadenFilter.isNotEmpty) for (final f in gruppen.archiviert) fadenZeile(f, Icons.archive_outlined),
            if (archivOffen && gruppen.sitzungen.isNotEmpty) ...[
              Padding(padding: const EdgeInsets.fromLTRB(16, 6, 16, 2), child: Text('Frühere Sitzungen', style: theme.textTheme.labelSmall?.copyWith(color: dim))),
              for (final f in gruppen.sitzungen.take(6)) ListTile(dense: true, selected: archiv == f['archiv'], leading: const Icon(Icons.inventory_2_outlined, size: 18), title: Text('${f['titel']}', maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall), subtitle: Text('${_fadenZeit('${f['zeit'] ?? ''}')} · ${f['anzahl']} Nachrichten', style: theme.textTheme.labelSmall?.copyWith(color: dim)), onTap: () => _archivOeffnen('${f['archiv']}')),
            ],
          ],
          // 1.42.0 D1 — „Vorgänge“ (Eingang in der Navigation zählt sie) und „Letzte“ (zeigen die Fäden) entfallen
        ])),
        // 1.47.0 D5 — die Satelliten-Zeile ist ins Kontomenü unten links gewandert
      ]),
    ));
  }

  /// 1.47.0 D5 — Kosten und Geräte für das Kontomenü laden (Fehler bleiben im Menü sichtbar, kein Abbruch).
  Future<void> _kontoLaden() async {
    final s = server;
    if (s == null) return;
    try {
      final j = await s.json('/api/geraete/konto');
      final geraete = [for (final g in (j['geraete'] as List? ?? const [])) KontoGeraet.aus(g as Map<String, dynamic>)]; // 1.48.0 Details je Gerät
      kontoStand.value = (KontoKosten.aus(j['kosten'] as Map<String, dynamic>), geraete, null);
    } catch (e) {
      kontoStand.value = (kontoStand.value.$1, kontoStand.value.$2, 'Kosten nicht geladen: $e');
    }
    if (mounted) _neu(() {}); // Kostenzeile im Knopf
  }

  /// 1.47.0 D5 — Knopf unten links: Gerät, Verbindung, Kosten heute; öffnet das Kontomenü darüber.
  Widget _kontoKnopf(ThemeData theme, bool breit) {
    final cs = theme.colorScheme;
    final verbunden = satellit?.verbunden == true;
    final heute = kontoStand.value.$1?.heute;
    final name = konfig?.name ?? satellit?.name ?? 'Gerät';
    final symbol = Stack(clipBehavior: Clip.none, children: [
      CircleAvatar(radius: 14, backgroundColor: cs.primaryContainer, child: Text(name.isEmpty ? '?' : name.characters.first.toUpperCase(), style: theme.textTheme.labelLarge?.copyWith(color: cs.onPrimaryContainer, fontWeight: FontWeight.w700))),
      Positioned(right: -1, bottom: -1, child: Container(width: 10, height: 10, decoration: BoxDecoration(color: verbunden ? Colors.green : cs.error, shape: BoxShape.circle, border: Border.all(color: cs.surfaceContainerLow, width: 2)))),
    ]);
    return Padding(padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2), child: Tooltip(message: breit ? '' : 'Konto: $name', child: Material(color: Colors.transparent, borderRadius: BorderRadius.circular(10), child: InkWell(
      key: const Key('konto-knopf'), borderRadius: BorderRadius.circular(10), onTap: _kontoOeffnen,
      child: SizedBox(height: 48, child: breit
          ? Padding(padding: const EdgeInsets.symmetric(horizontal: 10), child: Row(children: [
              symbol, const SizedBox(width: 10),
              Expanded(child: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
                Text(heute == null ? (verbunden ? 'verbunden' : 'nicht verbunden') : 'heute ${kostenText(heute)}', maxLines: 1, style: theme.textTheme.labelSmall?.copyWith(color: cs.onSurfaceVariant)),
              ])),
              Icon(Icons.unfold_more, size: 16, color: cs.onSurfaceVariant),
            ]))
          : Center(child: symbol)),
    ))));
  }

  /// 1.47.0 D5 — Kontomenü über dem Knopf unten links öffnen; Kosten werden beim Öffnen frisch geladen.
  Future<void> _kontoOeffnen() async {
    _kontoLaden();
    final sat = satellit;
    final versionen = [
      if (appVersion.isNotEmpty) 'App $appVersion',
      if (sat != null) 'Satellit ${sat.version}',
      if (sat?.serverVersion != null) 'Alfred ${sat!.serverVersion}',
      if (sat == null) ipcZustand,
    ].join(' · ');
    void schliessenUnd(VoidCallback f) { Navigator.of(context).pop(); f(); }
    await showGeneralDialog<void>(context: context, barrierDismissible: true, barrierLabel: 'Kontomenü', barrierColor: Colors.transparent,
      transitionDuration: const Duration(milliseconds: 120),
      pageBuilder: (ctx, _, _) => SafeArea(child: Align(alignment: Alignment.bottomLeft, child: Padding(padding: const EdgeInsets.fromLTRB(8, 8, 8, 60),
        child: ConstrainedBox(constraints: BoxConstraints(maxHeight: MediaQuery.of(ctx).size.height - 80), child: ValueListenableBuilder(valueListenable: kontoStand, builder: (_, st, _) => KontoMenue(
          geraet: konfig?.name ?? sat?.name ?? 'Gerät', verbunden: sat?.verbunden == true, versionen: versionen,
          kosten: st.$1, fehler: st.$3, geraete: st.$2,
          aufEinstellungen: () => schliessenUnd(() => _neu(() => ansicht = Ansicht.einstellungen)),
          aufBefehle: () => schliessenUnd(_paletteOeffnen),
          aufKuerzel: () => schliessenUnd(_kuerzelZeigen),
          aufKosten: () => schliessenUnd(() => _neu(() => ansicht = Ansicht.kosten)), // 1.71.0
          aufWeb: konfig == null ? null : () => schliessenUnd(() => zeigeWebSeiten(context, konfig!.server)), // 1.71.0
          updateText: update != null ? 'Update ${update!.version} installieren' : 'Nach Update suchen',
          aufUpdate: () => schliessenUnd(() { if (update != null) { _updateInstallieren(); } else { _updatePruefen(); } }),
          aufProjekt: (id) => schliessenUnd(() => _neu(() { projekteAnfang = id; ansicht = Ansicht.projekte; })), // 1.49.0
        )))))),
    );
  }


  /// Hauptbereich Chat: Kopfzeile, Verlauf (mittig, Datumstrenner), Bestätigungskarten, Eingabekarte.
  Widget _chat(ThemeData theme) {
    if (istHandy) return _chatHandy(theme); // 1.69.0
    final dim = theme.colorScheme.onSurfaceVariant;
    final geraet = konfig?.name ?? satellit?.name ?? '…';
    // 1.1.1 — Owner 16:12: Dateien ließen sich nicht mehr hineinziehen. Die Ablagezone deckte nur den Verlauf ab,
    // nicht die Eingabekarte; jetzt liegt sie über dem ganzen Chat-Bereich (zusätzlich zum Plus-Knopf).
    return LayoutBuilder(builder: (context, groesse) { breiteChat = chatBreite(groesse.maxWidth); return _ablage(Column(children: [ // 1.45.3 Breite; Phase 5 H1 Ablage nur Desktop
      SizedBox(height: 48, child: Row(children: [
        if (!seitenleisteOffen) IconButton(tooltip: 'Seitenleiste', onPressed: () { _neu(() => seitenleisteOffen = true); seitenleisteSpeichern(true); }, icon: const Icon(Icons.view_sidebar_outlined, size: 20)),
        const SizedBox(width: 12),
        // 1.17.2 — Owner 13.10.: welches Gespräch gerade offen ist, steht über dem Chat (Gerät dahinter, gedämpft)
        // 1.43.0 D2 — Ordner-Symbol bei Fäden eines Projekts (Projektname im Tooltip)
        if (_offenerFaden() != null && fadenProjektId(_offenerFaden()!) != null) Padding(padding: const EdgeInsets.only(right: 6), child: Tooltip(message: 'Projekt: ${(_offenerFaden()!['projekt'] as Map)['name']}', child: Icon(Icons.folder_outlined, size: 18, color: dim))),
        // 1.45.3 — Owner 19.10.: Symbole an den rechten Rand. Flexible + Spacer teilten den freien Platz; was der Titel nicht brauchte, blieb rechts leer
        Expanded(child: Text.rich(TextSpan(children: [TextSpan(text: _kopfTitel()), TextSpan(text: '  ·  $geraet', style: TextStyle(color: dim))]), key: const Key('chat-kopf'), maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.titleSmall)),
        if (archiv == null) IconButton(key: const Key('karte-knopf'), tooltip: karteOffen ? 'Zusammenfassung ausblenden' : 'Angeheftete Zusammenfassung ein', onPressed: () => _neu(() => karteOffen = !karteOffen), icon: Icon(Icons.fact_check_outlined, size: 20, color: karteOffen ? theme.colorScheme.primary : null)), // 1.44.0 D3
        if (archiv == null) IconButton(key: const Key('seiten-chat-knopf'), tooltip: seitenChatOffen ? 'Seiten-Chat schließen (Strg+Alt+S)' : 'Seiten-Chat (Strg+Alt+S)', onPressed: _seitenChatUmschalten, icon: Icon(Icons.vertical_split_outlined, size: 20, color: seitenChatOffen ? theme.colorScheme.primary : null)),
        if (archiv == null) _kopfMenue(),
        if (update != null) Padding(padding: const EdgeInsets.only(right: 8), child: ActionChip(avatar: updateLaeuft ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.system_update_alt, size: 18), label: Text('Update ${update!.version}'), tooltip: 'Herunterladen und installieren (${(update!.groesse / 1024 / 1024).toStringAsFixed(1)} MB)', onPressed: updateLaeuft ? null : _updateInstallieren)),
        IconButton(key: const Key('vorlesen-knopf'), tooltip: stimme ? 'Antworten vorlesen: an' : vorlesenAutomatisch ? 'Vorlesen automatisch (${audioAusgang == 'auto' || bewegungJetzt == 'auto' ? 'im Auto' : 'Kopfhörer'})' : 'Antworten vorlesen: aus', onPressed: () => _neu(() => stimme = !stimme),
          icon: Icon(stimme ? Icons.volume_up : vorlesenAutomatisch ? (audioAusgang == 'auto' || (bewegungJetzt == 'auto' && !vorleseAusgaenge.contains(audioAusgang)) ? Icons.directions_car : Icons.headphones) : Icons.volume_off, size: 20, color: !stimme && vorlesenAutomatisch ? Colors.green : null)), // 1.54.3 — grün, wenn automatisch vorgelesen wird
        const SizedBox(width: 8),
      ])),
      const Divider(height: 1),
      if (fundstelle != null) Material(color: theme.colorScheme.primaryContainer, child: Padding(padding: const EdgeInsets.fromLTRB(16, 4, 8, 4), child: Row(children: [ // 1.5.0
        Icon(Icons.manage_search, size: 18, color: theme.colorScheme.onPrimaryContainer),
        const SizedBox(width: 8),
        Expanded(child: Text('Fundstelle in „${fundstelle!['gespraech'] ?? 'Gespräch'}“ — Schreiben setzt das Gespräch mit den neuesten Nachrichten fort.', style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onPrimaryContainer), overflow: TextOverflow.ellipsis)),
        TextButton(onPressed: () => _neu(() => ansicht = Ansicht.suche), child: const Text('Zur Suche')),
        TextButton(onPressed: _fundstelleVerlassen, child: const Text('Zum Gespräch')),
      ]))),
      Expanded(child: Stack(children: [Positioned.fill(child: _verlaufInhalt(theme, EdgeInsets.fromLTRB(_mitVerlaufsleiste ? 38 : 20, 12, 20, 12))
      ), if (_mitVerlaufsleiste) Positioned(left: 2, top: 0, bottom: 0, width: 28, child: Verlaufsleiste(eintraege: leistenEintraege(verlauf), markiert: lesezeichen, aufSprung: _zuNachricht, aktuell: leisteAktuell, aufLesezeichen: (e) => _lesezeichenUmschalten(verlauf[e.index]))), // 1.45.0 D4, 1.45.2 aktuell + Karte
        if (karteOffen && archiv == null && ansicht == Ansicht.chat) Positioned(top: 8, right: 16, child: _karte(theme))])), // 1.44.0 D3
      if (offen.isNotEmpty) Center(child: ConstrainedBox(constraints: BoxConstraints(maxWidth: breiteChat), child: _bestaetigungen(theme))),
      if (fremdeArbeit.isNotEmpty) Center(child: ConstrainedBox(constraints: BoxConstraints(maxWidth: breiteChat), child: _arbeitsLeiste(theme))), // 1.11.0
      Center(child: ConstrainedBox(constraints: BoxConstraints(maxWidth: breiteChat), child: _eingabekarte(theme))),
    ])); });
  }


  /// 1.44.0 D3 — Karte oben rechts: Projektkarte in Fäden eines Projekts, sonst Zusammenfassung des Fadens.
  Widget _karte(ThemeData theme) {
    final s = server;
    if (s == null) return const SizedBox.shrink();
    final f = _offenerFaden();
    final projektId = f == null ? null : fadenProjektId(f);
    return Card(key: const Key('faden-karte'), elevation: 3, child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 340, maxHeight: 440), child: SingleChildScrollView(child: SizedBox(width: 340, child: projektId != null
        ? ProjektKarte(key: ValueKey('p-$projektId'), json: s.json, projektId: projektId, dieserRechner: konfig?.name ?? satellit?.name ?? '',
            aufProjektansicht: () => _neu(() { projekteAnfang = projektId; ansicht = Ansicht.projekte; }), aufMeldung: (t) => _zeile(Eintrag(Art.hinweis, t)))
        : FadenKarte(key: ValueKey('f-${s.faden ?? 'haupt'}'), json: s.json, faden: s.faden, aufBestaetigungen: () => _neu(() => ansicht = Ansicht.eingang))))));
  }

  bool _eingeklappt(Eintrag e) {
    if (e.art != Art.du || e.aufgeklappt || e.text.length <= klappAb) return false;
    final i = verlauf.lastIndexWhere((x) => x.art == Art.du || x.art == Art.alfred);
    return i >= 0 && !identical(verlauf[i], e);
  }


  Widget _datumstrenner(DateTime d, ThemeData theme) {
    final heute = DateTime.now();
    final tag = _gleicherTag(d, heute) ? 'heute' : _gleicherTag(d, heute.subtract(const Duration(days: 1))) ? 'gestern' : '${d.day.toString().padLeft(2, '0')}.${d.month.toString().padLeft(2, '0')}.${d.year}';
    final zeit = '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
    return Padding(padding: const EdgeInsets.symmetric(vertical: 10), child: Center(child: Text('$tag, $zeit', style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.onSurfaceVariant))));
  }


  /// 1.69.0 — Verlauf bzw. leerer Zustand; `innen` = Abstand (am Handy Platz für die schwebenden Leisten darüber).
  Widget _verlaufInhalt(ThemeData theme, EdgeInsets innen) {
    final dim = theme.colorScheme.onSurfaceVariant;
    return verlauf.isEmpty
          ? Padding(padding: innen, child: Center(child: Column(mainAxisSize: MainAxisSize.min, children: [Icon(Icons.auto_awesome, size: 40, color: dim), const SizedBox(height: 12), Text('Was kann ich für dich tun?', style: theme.textTheme.headlineSmall)])))
          : Center(child: ConstrainedBox(constraints: BoxConstraints(maxWidth: breiteChat), child: ListView.builder(
              controller: scroll,
              reverse: true, // 1.2.7 — von unten verankert: Öffnen eines Gesprächs zeigt die letzte Nachricht
              keyboardDismissBehavior: istHandy ? ScrollViewKeyboardDismissBehavior.onDrag : ScrollViewKeyboardDismissBehavior.manual, // 1.67.5 — Scrollen schließt die Tastatur
              padding: innen, // 1.45.1 Platz für die Verlaufsleiste; 1.69.0 am Handy für Kopf und Eingabe darüber
              itemCount: verlauf.length + (mehrAeltere ? 1 : 0),
              itemBuilder: (context, ri) {
                if (ri == verlauf.length) { // 1.6.0 — ganz oben: ältere Nachrichten
                  return Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Center(child: laedtAeltere
                      ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                      : TextButton.icon(onPressed: _aeltereLaden, icon: const Icon(Icons.expand_less, size: 18), label: const Text('Ältere Nachrichten laden'))));
                }
                final i = verlauf.length - 1 - ri;
                final e = verlauf[i];
                final neuerTag = i == 0 || !_gleicherTag(verlauf[i - 1].zeit, e.zeit);
                final roh = _eintrag(e, theme);
                final w = e.fund // 1.5.0 — Treffer der Suche hervorheben
                    ? Container(key: fundSchluessel, padding: const EdgeInsets.only(left: 8), decoration: BoxDecoration(color: theme.colorScheme.primaryContainer.withValues(alpha: 0.3), border: Border(left: BorderSide(color: theme.colorScheme.primary, width: 3))), child: roh)
                    : roh;
                return KeyedSubtree(key: _ankerVon(e), child: neuerTag ? Column(children: [_datumstrenner(e.zeit, theme), w]) : w); // 1.45.0 D4 Sprungziel
              },
            )));
  }

  /// 1.0.3/1.69.0 — das Eingabefeld (ein Feld für Desktop-Karte und Handy-Leiste; der Schlüssel hält Fokus und Text beim Umbau).
  Widget _eingabeFeld(ThemeData theme) {
    final dim = theme.colorScheme.onSurfaceVariant;
    return KeyedSubtree(key: feldSchluessel, child: // 1.0.3 — mehrzeiliges Feld: Enter sendet, Umschalt+Enter macht eine neue Zeile (onSubmitted feuert bei maxLines > 1 nicht).
        Focus(
          onKeyEvent: (node, ev) {
            // 1.6.0 — Strg+V / ⌘V: liegt ein Bild in der Zwischenablage, wird es Anhang (Text fügt das Feld wie gewohnt ein)
            if (ev is KeyDownEvent && ev.logicalKey == LogicalKeyboardKey.keyV && (Platform.isMacOS ? HardwareKeyboard.instance.isMetaPressed : HardwareKeyboard.instance.isControlPressed)) {
              _bildEinfuegen();
              return KeyEventResult.ignored;
            }
            if (ev is KeyDownEvent && ev.logicalKey == LogicalKeyboardKey.escape && antwortet) { _abbrechen(); return KeyEventResult.handled; } // 1.7.0
            if (ev is KeyDownEvent && (ev.logicalKey == LogicalKeyboardKey.enter || ev.logicalKey == LogicalKeyboardKey.numpadEnter) && !HardwareKeyboard.instance.isShiftPressed) {
              if (!antwortet) _senden();
              return KeyEventResult.handled;
            }
            return KeyEventResult.ignored;
          },
          child: TextField(
            controller: eingabe,
            focusNode: fokus,
            // 1.54.2 — Handy: im Kontextmenü auch „Bild einfügen“ (das Feld selbst setzt nur Text ein)
            contextMenuBuilder: istHandy ? (c, st) => AdaptiveTextSelectionToolbar.buttonItems(anchors: st.contextMenuAnchors, buttonItems: [
              ...st.contextMenuButtonItems,
              ContextMenuButtonItem(label: 'Bild einfügen', onPressed: () { ContextMenuController.removeAny(); _bildEinfuegen(); }),
            ]) : null,
            autofocus: !istHandy, // 1.67.5 — am Handy erst beim Antippen
            enabled: !antwortet,
            minLines: 1,
            maxLines: 6,
            decoration: InputDecoration.collapsed(hintText: anhaenge.isEmpty ? (istHandy ? 'Nachricht an Alfred …' : 'Nachricht an Alfred … (Umschalt+Enter: neue Zeile, Dateien hineinziehen)') : 'Was soll Alfred mit ${anhaenge.length == 1 ? 'der Datei' : 'den Dateien'} tun? (leer = nur ablegen)', hintStyle: TextStyle(color: dim)),
            onSubmitted: (_) => _senden(),
          ),
        ));
  }

  /// 1.50.0 D6b/1.69.0 — Stufenwahl (am Handy nur im aufgeklappten Zustand).
  Widget _stufenWahl(ThemeData theme) {
    final dim = theme.colorScheme.onSurfaceVariant;
    const stufen = {null: 'Automatisch', 'fast': 'Schnell', 'default': 'Normal', 'strong': 'Stark'};
    return PopupMenuButton<String?>(
            // 1.50.0 D6b — hinter jeder Stufe Modell und Gründlichkeit; „Automatisch“ zeigt, was gerade dahinter steht
            tooltip: [
              'Stufe: wie gründlich Alfred denkt (Kosten, Tempo)',
              if (stufenStand.fuer(tierWahl) != null) '${stufen[tierWahl] ?? 'Automatisch'}: ${stufeZeile(stufenStand.fuer(tierWahl))}',
              if (stufenStand.zuletztModell != null) 'Letzte Antwort: ${stufenStand.zuletztModell}',
            ].join('\n'),
            initialValue: tierWahl,
            onOpened: _stufenLaden,
            onSelected: (v) => _neu(() => tierWahl = v == '' ? null : v),
            itemBuilder: (_) => [
              for (final s in stufen.entries) PopupMenuItem<String?>(value: s.key ?? '', child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                Text(s.key == null && stufenStand.fuer(null) != null ? 'Automatisch (${stufen[stufenStand.automatisch] ?? stufenStand.automatisch})' : s.value),
                if (stufenStand.fuer(s.key) != null) Text(stufeZeile(stufenStand.fuer(s.key)), style: theme.textTheme.bodySmall?.copyWith(color: dim)),
              ])),
              if (stufenStand.zuletztModell != null) PopupMenuItem<String?>(enabled: false, child: Text('Letzte Antwort: ${stufenStand.zuletztModell}', style: theme.textTheme.bodySmall?.copyWith(color: dim))),
            ],
            child: Padding(padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6), child: Row(mainAxisSize: MainAxisSize.min, children: [
              Text('${stufen[tierWahl] ?? 'Automatisch'}${stufenStand.fuer(tierWahl) == null || istHandy ? '' : ' · ${stufenStand.fuer(tierWahl)!.modell}'}', key: const Key('stufe-knopf'), style: theme.textTheme.bodySmall?.copyWith(color: dim)),
              Icon(Icons.expand_more, size: 16, color: dim),
            ])),
          );
  }

  /// 1.69.0 (Owner 20.10.: „1–3 wie vorgeschlagen, Weg A“) — iPhone-Chat: ein schwebender Kopf (Menü links, Neuer Chat und „…“
  /// rechts), die Eingabe als Leiste unten, beides aus Milchglas; der Verlauf läuft darunter durch. Herunterwischen schließt die
  /// Tastatur, auch im leeren Chat.
  Widget _chatHandy(ThemeData theme) {
    final oben = MediaQuery.paddingOf(context).top;
    const kopf = 50.0;
    return LayoutBuilder(builder: (context, groesse) {
      breiteChat = chatBreite(groesse.maxWidth);
      return GestureDetector(
        behavior: HitTestBehavior.translucent,
        onVerticalDragUpdate: (d) { if (d.delta.dy > 6 && fokus.hasFocus) fokus.unfocus(); },
        child: Stack(children: [
          Positioned.fill(child: _verlaufInhalt(theme, EdgeInsets.fromLTRB(16, oben + kopf + 14, 16, unterHoehe + 8))),
          if (karteOffen && archiv == null) Positioned(top: oben + kopf + 10, right: 12, child: _karte(theme)),
          Positioned(top: oben + 6, left: 12, right: 12, child: _kopfHandy(theme)),
          Positioned(left: 0, right: 0, bottom: 0, child: Messen(aufGroesse: (g) { if ((g.height - unterHoehe).abs() > 0.5) _neu(() => unterHoehe = g.height); }, child: Column(mainAxisSize: MainAxisSize.min, children: [
            if (fundstelle != null) Padding(padding: const EdgeInsets.fromLTRB(12, 0, 12, 4), child: Glas(child: Padding(padding: const EdgeInsets.fromLTRB(14, 2, 4, 2), child: Row(children: [
              Expanded(child: Text('Fundstelle — Schreiben setzt das Gespräch fort', style: theme.textTheme.bodySmall, overflow: TextOverflow.ellipsis)),
              TextButton(onPressed: _fundstelleVerlassen, child: const Text('Zum Gespräch')),
            ])))),
            if (offen.isNotEmpty) _bestaetigungen(theme),
            if (fremdeArbeit.isNotEmpty) _arbeitsLeiste(theme),
            _eingabeHandy(theme),
          ]))),
        ]),
      );
    });
  }

  /// 1.69.0 — schwebender Kopf: links Menü (Punkt = Verbindung, Zahl = offene Bestätigungen), Mitte Gesprächsname (nicht im
  /// leeren Chat), rechts Neuer Chat und „…“.
  Widget _kopfHandy(ThemeData theme) {
    final verbunden = satellit?.verbunden == true;
    final hatInhalt = verlauf.any((e) => e.art == Art.du || e.art == Art.alfred);
    return Row(children: [
      Glas(rund: true, child: SizedBox(width: 46, height: 46, child: Stack(alignment: Alignment.center, children: [
        IconButton(key: const Key('handy-menue'), tooltip: 'Menü', icon: const Icon(Icons.menu), onPressed: () => _schublade.currentState?.openDrawer()),
        Positioned(right: 10, top: 10, child: IgnorePointer(child: Container(width: 8, height: 8, decoration: BoxDecoration(shape: BoxShape.circle, color: verbunden ? Colors.green : theme.colorScheme.error)))),
        if (offen.isNotEmpty) Positioned(right: 1, bottom: 1, child: IgnorePointer(child: Badge.count(count: offen.length))),
      ]))),
      const SizedBox(width: 10),
      Expanded(child: hatInhalt ? Text(_kopfTitel(), key: const Key('chat-kopf'), textAlign: TextAlign.center, maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.titleSmall?.copyWith(color: theme.colorScheme.onSurfaceVariant)) : const SizedBox.shrink()),
      const SizedBox(width: 10),
      Glas(child: Row(mainAxisSize: MainAxisSize.min, children: [
        IconButton(key: const Key('neuer-chat'), tooltip: 'Neuer Chat', icon: const Icon(Icons.edit_square), onPressed: _neuerChat),
        if (archiv == null) _kopfMenue(handy: true) else const SizedBox(width: 6),
      ])),
    ]);
  }

  /// 1.69.0 — Eingabe am Handy in zwei Zuständen. Eingeklappt (leer, nicht aktiv): eine Leiste [+] Feld [Mikrofon] [Gespräch].
  /// Aufgeklappt (aktiv oder Inhalt): Feld oben, darunter [+] Stufe [Mikrofon] [Senden]. Nur das Feld öffnet die Tastatur.
  Widget _eingabeHandy(ThemeData theme) {
    final dim = theme.colorScheme.onSurfaceVariant;
    final auf = fokus.hasFocus || eingabe.text.trim().isNotEmpty || anhaenge.isNotEmpty || bezug != null || aufnahme;
    final plus = IconButton(tooltip: 'Datei anhängen', onPressed: antwortet ? null : _anhangWaehlen, icon: const Icon(Icons.add, size: 26), visualDensity: VisualDensity.compact);
    final mikro = HalteKnopf(key: const Key('mikro-handy'), aktiv: !aufnahme && !antwortet,
      aufTipp: _diktatUmschalten, aufHalten: () { losgelassen = false; _haltenStart(); }, aufLoslassen: () { losgelassen = true; _haltenEnde(); },
      icon: Icon(aufnahme ? (diktat ? Icons.stop_circle : Icons.mic) : Icons.mic_none, size: 24, color: aufnahme ? theme.colorScheme.error : null));
    final rechts = antwortet
      ? StoppKnopf(key: const Key('stopp'), aufStopp: _abbrechen)
      : ValueListenableBuilder<TextEditingValue>(valueListenable: eingabe, builder: (context, wert, _) => wert.text.trim().isEmpty && anhaenge.isEmpty && !aufnahme
          ? IconButton.filled(key: const Key('unterhaltung-start'), tooltip: 'Unterhaltung', onPressed: server == null ? null : _unterhaltungStart, style: IconButton.styleFrom(backgroundColor: const Color(0xFF1F6FEB), foregroundColor: Colors.white), icon: const Icon(Icons.graphic_eq, size: 20))
          : IconButton.filled(key: const Key('senden'), tooltip: 'Senden (Enter)', onPressed: () => _senden(), icon: const Icon(Icons.arrow_upward, size: 20)));
    return Padding(padding: const EdgeInsets.fromLTRB(12, 2, 12, 8), child: Column(mainAxisSize: MainAxisSize.min, children: [
      if (fluechtig.isNotEmpty) Padding(padding: const EdgeInsets.only(bottom: 4), child: Text(fluechtig, maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall?.copyWith(color: aufnahme ? theme.colorScheme.error : dim))),
      Glas(radius: auf ? 24 : 28, child: Padding(padding: EdgeInsets.fromLTRB(auf ? 14 : 2, auf ? 10 : 2, 6, auf ? 6 : 2), child: auf
        ? Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            if (bezug != null) Padding(padding: const EdgeInsets.only(bottom: 6), child: Row(children: [
              Icon(Icons.reply, size: 16, color: theme.colorScheme.primary), const SizedBox(width: 6),
              Expanded(child: Text('Antwort auf Alfred: ${bezug!.text.replaceAll('\n', ' ')}', maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall?.copyWith(color: dim))),
              IconButton(tooltip: 'Bezug entfernen', onPressed: () => _neu(() => bezug = null), icon: const Icon(Icons.close, size: 16), visualDensity: VisualDensity.compact),
            ])),
            if (anhaenge.isNotEmpty) Padding(padding: const EdgeInsets.only(bottom: 6), child: Wrap(spacing: 6, runSpacing: 4, children: [
              for (final f in anhaenge) InputChip(label: Text(f.uri.pathSegments.last, overflow: TextOverflow.ellipsis), onDeleted: () => _neu(() => anhaenge.remove(f))),
            ])),
            _eingabeFeld(theme),
            const SizedBox(height: 4),
            Row(children: [plus, const Spacer(), _stufenWahl(theme), mikro, const SizedBox(width: 4), rechts]),
          ])
        : Row(children: [plus, Expanded(child: _eingabeFeld(theme)), mikro, const SizedBox(width: 4), rechts]),
      )),
    ]));
  }

  /// Eingabekarte wie in der Vorlage: Textfeld oben, darunter Anhang, Stufenwahl, Status, Mikrofon, Zuhören, Senden.
  /// 1.11.0 — Leiste über der Eingabe: Alfred arbeitet an einer Anfrage aus Telegram oder einem anderen Gerät.
  Widget _arbeitsLeiste(ThemeData theme) {
    final dim = theme.colorScheme.onSurfaceVariant;
    return Padding(padding: const EdgeInsets.fromLTRB(16, 4, 16, 0), child: Column(children: [
      for (final a in fremdeArbeit.values.take(3)) Card(key: Key('arbeit-${a.id}'), color: theme.colorScheme.secondaryContainer.withValues(alpha: 0.5), margin: const EdgeInsets.only(bottom: 4), child: Padding(padding: const EdgeInsets.fromLTRB(12, 6, 4, 6), child: Row(children: [
        const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)),
        const SizedBox(width: 10),
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(a.projekt != null ? '🔨 ${a.frage}' : 'Alfred arbeitet · aus ${a.kanal}${a.faden != server?.faden ? ' · ${_gespraechName(a.faden)}' : ''}', maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.labelMedium), // 1.16.1 G2
          Text(a.status?.isNotEmpty == true ? a.status! : (a.projekt != null ? a.kanal : a.frage.length > 90 ? '${a.frage.substring(0, 90)}…' : a.frage), maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall?.copyWith(color: dim)),
        ])),
        if (a.projekt != null) TextButton(key: Key('arbeit-projekt-${a.id}'), onPressed: () => _neu(() { projekteAnfang = a.projekt; ansicht = Ansicht.projekte; }), child: const Text('Öffnen')) // 1.16.1 G2
        else if (a.faden != server?.faden) TextButton(onPressed: () => _fadenWechseln(a.faden), child: const Text('Öffnen')),
        if (a.projekt == null) IconButton(tooltip: 'Anfrage abbrechen', onPressed: () => _fremdeArbeitStoppen(a), icon: const Icon(Icons.stop_circle_outlined)),
      ]))),
    ]));
  }

  Widget _eingabekarte(ThemeData theme) {
    final dim = theme.colorScheme.onSurfaceVariant;
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
            IconButton(tooltip: 'Bezug entfernen', onPressed: () => _neu(() => bezug = null), icon: const Icon(Icons.close, size: 16), visualDensity: VisualDensity.compact),
          ]),
        )),
        if (anhaenge.isNotEmpty) Padding(padding: const EdgeInsets.only(bottom: 6), child: Wrap(spacing: 6, runSpacing: 4, children: [
          for (final f in anhaenge) InputChip(avatar: const Icon(Icons.insert_drive_file_outlined, size: 18), label: Text(f.uri.pathSegments.last, overflow: TextOverflow.ellipsis), tooltip: f.path, onDeleted: () => _neu(() => anhaenge.remove(f))),
        ])),
        _eingabeFeld(theme),
        const SizedBox(height: 6),
        Row(children: [
          IconButton(tooltip: 'Datei anhängen', onPressed: antwortet ? null : _anhangWaehlen, icon: const Icon(Icons.add_circle_outline, size: 22), visualDensity: VisualDensity.compact),
          _stufenWahl(theme),
          const SizedBox(width: 8),
          if (fluechtig.isNotEmpty) Expanded(child: Text(fluechtig, style: theme.textTheme.bodySmall?.copyWith(color: aufnahme ? theme.colorScheme.error : dim), overflow: TextOverflow.ellipsis)) else const Spacer(),
          if (istHandy) HalteKnopf( // 1.53.0+91 — Antippen = Diktat, Halten (0,4 s) = sprechen, Loslassen sendet
            key: const Key('mikro-handy'), aktiv: !aufnahme && !antwortet,
            aufTipp: _diktatUmschalten, aufHalten: () { losgelassen = false; _haltenStart(); }, aufLoslassen: () { losgelassen = true; _haltenEnde(); },
            icon: Icon(aufnahme ? (diktat ? Icons.stop_circle : Icons.mic) : Icons.mic_none, size: 22, color: aufnahme ? theme.colorScheme.error : null))
          else IconButton(tooltip: aufnahme ? 'Aufnahme stoppen' : 'Sprechen (Strg+Alt+Leertaste)', onPressed: _talkUmschalten, icon: Icon(aufnahme ? Icons.stop_circle : Icons.mic_none, size: 22, color: aufnahme ? theme.colorScheme.error : null), visualDensity: VisualDensity.compact),
          if (istDesktop) hoeren // Phase 5 H1 — Aktivierungswort gibt es auf dem Handy nicht (Spec §20.4)
            ? IconButton.filledTonal(tooltip: 'Zuhören aus', onPressed: _hoerenUmschalten, icon: const Icon(Icons.headset_mic, size: 20), visualDensity: VisualDensity.compact)
            : IconButton(tooltip: 'Zuhören mit Aktivierungswort „${konfig?.aktivierungswort ?? 'Alfred'}“', onPressed: server == null ? null : _hoerenUmschalten, icon: const Icon(Icons.headset, size: 22), visualDensity: VisualDensity.compact),
          if (istDesktop) IconButton(key: const Key('unterhaltung-start'), tooltip: 'Unterhaltung (freies Gespräch)', onPressed: server == null || antwortet ? null : _unterhaltungStart, icon: const Icon(Icons.graphic_eq, size: 22), visualDensity: VisualDensity.compact), // 1.58.0 G4
          const SizedBox(width: 4),
          antwortet // 1.7.0 — während der Antwort wird Senden zu Stopp (Owner-Freigabe 11.10., Punkt 5)
            ? StoppKnopf(key: const Key('stopp'), aufStopp: _abbrechen) // 1.14.1 — Lauf-Kreis um Stopp (wie bis 1.6 um Senden)
            // 1.58.0 G1 (Owner 20.10.) — Handy: leeres Eingabefeld → blauer Unterhaltungsknopf, sobald getippt wird → Senden-Pfeil
            : ValueListenableBuilder<TextEditingValue>(valueListenable: eingabe, builder: (context, wert, _) => istHandy && wert.text.trim().isEmpty && anhaenge.isEmpty && !aufnahme
                ? IconButton.filled(key: const Key('unterhaltung-start'), tooltip: 'Unterhaltung', onPressed: server == null ? null : _unterhaltungStart, style: IconButton.styleFrom(backgroundColor: const Color(0xFF1F6FEB), foregroundColor: Colors.white), icon: const Icon(Icons.graphic_eq, size: 20))
                : IconButton.filled(key: const Key('senden'), tooltip: 'Senden (Enter)', onPressed: () => _senden(), icon: const Icon(Icons.arrow_upward, size: 20))),
        ]),
      ]),
    );
  }


  /// 1.6.0 — Punkt 3: Bild aus der Zwischenablage als Anhang der Eingabezeile.
  /// 1.59.0 (v1529) — Ablage-Ordner am Satelliten ändern („+ pfad“ / „- pfad“); Ergebnis als Hinweis, Liste neu laden.
  Future<void> _ablageAendern(String arg) async {
    try {
      final r = await (ipc as IpcVerbindung).ablageOrdner(arg: arg);
      if (r.text != null) _zeile(Eintrag(r.ok ? Art.hinweis : Art.fehler, '📁 ${r.text}'));
    } catch (e) { _zeile(Eintrag(Art.fehler, '📁 $e')); }
    _neu(() => ablageNeu++);
  }

  Future<void> _bildEinfuegen() async {
    if (antwortet) return;
    final f = await bildAusZwischenablage();
    if (f == null || !mounted) return;
    _dateienAbgelegt([f.path]);
    _neu(() => fluechtig = '📎 Bild aus der Zwischenablage angehängt (${(f.lengthSync() / 1024).round()} KB)');
  }


  Future<void> _anhangWaehlen() async {
    if (istHandy) { await _handyAnhangMenue(); return; } // 1.54.2
    try {
      final dateien = await openFiles();
      if (dateien.isNotEmpty) _dateienAbgelegt(dateien.map((x) => x.path).toList());
    } catch (e) { _zeile(Eintrag(Art.fehler, 'Dateiauswahl: $e')); }
  }


  /// 1.54.2 — Handy: Plus-Menü mit Foto aus der Mediathek, Kamera, Datei und Einfügen aus der Zwischenablage.
  Future<void> _handyAnhangMenue() async {
    final wahl = await showModalBottomSheet<String>(context: context, showDragHandle: true, builder: (c) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
      ListTile(key: const Key('anhang-fotos'), leading: const Icon(Icons.photo_library_outlined), title: const Text('Fotos'), onTap: () => Navigator.pop(c, 'fotos')),
      ListTile(key: const Key('anhang-kamera'), leading: const Icon(Icons.photo_camera_outlined), title: const Text('Foto aufnehmen'), onTap: () => Navigator.pop(c, 'kamera')),
      ListTile(key: const Key('anhang-datei'), leading: const Icon(Icons.insert_drive_file_outlined), title: const Text('Datei'), onTap: () => Navigator.pop(c, 'datei')),
      ListTile(key: const Key('anhang-einfuegen'), leading: const Icon(Icons.content_paste), title: const Text('Aus Zwischenablage einfügen'), onTap: () => Navigator.pop(c, 'einfuegen')),
    ])));
    try {
      switch (wahl) {
        case 'fotos': final p = await fotosWaehlen(); if (p.isNotEmpty) _dateienAbgelegt(p);
        case 'kamera': final p = await kameraFoto(); if (p.isNotEmpty) _dateienAbgelegt(p);
        case 'datei': final d = await openFiles(); if (d.isNotEmpty) _dateienAbgelegt(d.map((x) => x.path).toList());
        case 'einfuegen': await _handyEinfuegen();
      }
    } catch (e) { _zeile(Eintrag(Art.fehler, 'Anhang: ${'$e'.replaceFirst('Exception: ', '')}')); }
  }

  /// 1.54.2 — Einfügen am Handy: Bild wird Anhang, sonst kommt Text ins Eingabefeld.
  Future<void> _handyEinfuegen() async {
    final bild = await bildAusZwischenablage();
    if (bild != null) { _dateienAbgelegt([bild.path]); _neu(() => fluechtig = '📎 Bild aus der Zwischenablage angehängt'); return; }
    final t = (await Clipboard.getData(Clipboard.kTextPlain))?.text;
    if (t == null || t.isEmpty) { _neu(() => fluechtig = 'Zwischenablage ist leer'); return; }
    final sel = eingabe.selection;
    final alt = eingabe.text;
    final pos = sel.isValid ? sel.start : alt.length, ende = sel.isValid ? sel.end : alt.length;
    eingabe.text = alt.replaceRange(pos, ende, t);
    eingabe.selection = TextSelection.collapsed(offset: pos + t.length);
    fokus.requestFocus();
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
        SwitchListTile(dense: true, contentPadding: EdgeInsets.zero, title: const Text('Seitenleiste beim Start'), value: seitenleisteOffen, onChanged: (v) { _neu(() => seitenleisteOffen = v); seitenleisteSpeichern(v); }),
      ])),
      karte('Sprache', Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        SwitchListTile(dense: true, contentPadding: EdgeInsets.zero, title: const Text('Antworten vorlesen'), value: stimme, onChanged: (v) => _neu(() => stimme = v)),
        // 1.60.0 G3 (Owner 20.10.: „als Schalter, Standard aus“) — gilt ab der nächsten Unterhaltung
        if (istHandy) SwitchListTile(key: const Key('ins-wort-fallen'), dense: true, contentPadding: EdgeInsets.zero, title: const Text('Unterhaltung: ins Wort fallen'),
          subtitle: Text('Während Alfred spricht, einfach dazwischenreden — er hört auf und hört dir zu. Nutzt die Echounterdrückung von iOS: Alfred klingt dabei etwas leiser. Gilt ab der nächsten Unterhaltung.', style: theme.textTheme.labelSmall?.copyWith(color: dim)),
          value: insWortFallen, onChanged: (v) { _neu(() => insWortFallen = v); insWortFallenSpeichern(v); }),
        // 1.3.0 — lokales Aktivierungswort (Owner-Ok 10.10.): Standard an; gilt ab dem nächsten Start des Zuhörens
        SwitchListTile(dense: true, contentPadding: EdgeInsets.zero, title: const Text('Aktivierungswort in der App erkennen'), subtitle: Text(wortLokal ? 'Nur Äußerungen mit erkanntem Wort gehen an den Server (Modell in der App, 2,8 MB).${wortVerworfen > 0 ? ' Verworfen seit Start: $wortVerworfen.' : ''}' : 'Aus: jede Äußerung geht an den Server, der das Wort im Transkript prüft.', style: theme.textTheme.bodySmall?.copyWith(color: dim)), value: wortLokal, onChanged: (v) { _neu(() => wortLokal = v); wortLokalSpeichern(v); }),
        Text('Sprechen: Strg+Alt+Leertaste (global). Zuhören mit Aktivierungswort „${konfig?.aktivierungswort ?? 'Alfred'}“ über den Kopfhörer-Knopf in der Eingabekarte.', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
      ])),
      karte('Gespräche', Column(crossAxisAlignment: CrossAxisAlignment.start, children: [ // 1.2.3 — Spiegel-Schalter (Owner-Freigabe 09.10., Standard aus)
        SwitchListTile(dense: true, contentPadding: EdgeInsets.zero, title: const Text('Spiegelung nach Telegram'), subtitle: Text(spiegelung == null ? 'Stand wird geladen …' : 'Fragen und Antworten aus App, Web und Terminal erscheinen auch im Telegram-Chat', style: theme.textTheme.labelSmall?.copyWith(color: dim)), value: spiegelung ?? false, onChanged: spiegelung == null ? null : (v) => _spiegelungSetzen(v)),
        if (istHandy) ...[ // 1.54.1 — Ordner für Dateien von Alfred
          const SizedBox(height: 8),
          Text('Ordner für Dateien von Alfred', style: theme.textTheme.titleSmall),
          Text('„Alfred“ ist der Standard (Dateien-App: Auf meinem iPhone → Alfred). Weitere Ordner hier freigeben, z. B. Downloads.', style: theme.textTheme.labelSmall?.copyWith(color: dim)),
          ListTile(dense: true, contentPadding: EdgeInsets.zero, leading: const Icon(Icons.folder_special_outlined, size: 20), title: const Text('Alfred'), subtitle: const Text('Standard')),
          for (final o in ablageOrdnerGespeichert()) ListTile(dense: true, contentPadding: EdgeInsets.zero, leading: const Icon(Icons.folder_outlined, size: 20), title: Text(o.name),
            trailing: IconButton(tooltip: 'Freigabe entfernen', icon: const Icon(Icons.close, size: 18), onPressed: () { ordnerEntfernen(o.name); _neu(() {}); (ipc as HandyVerbindung).jetztVerbinden(); })),
          Align(alignment: Alignment.centerLeft, child: TextButton.icon(key: const Key('ordner-freigeben'), icon: const Icon(Icons.create_new_folder_outlined, size: 18), label: const Text('Ordner freigeben'),
            onPressed: _ordnerFreigebenKnopf)),
        ],
        if (istDesktop && ipc is IpcVerbindung) ...[ // 1.59.0 (v1529) — Ablage-Ordner des Satelliten
          const SizedBox(height: 8),
          Text('Ablage-Ordner ohne Rückfrage', style: theme.textTheme.titleSmall),
          Text('Dateien, die du selbst an Alfred geschickt hast (App, Teilen am iPhone), legt er hier ohne Rückfrage ab — überschrieben wird nie. Alles andere fragt, mehrere Dateien in einer Bestätigung. Nur hier am Gerät änderbar, nie aus dem Chat.', style: theme.textTheme.labelSmall?.copyWith(color: dim)),
          FutureBuilder<({List<String> ordner, bool ok, String? text})>(
            key: ValueKey('ablage-$ablageNeu'),
            future: (ipc as IpcVerbindung).ablageOrdner(),
            builder: (_, st) {
              if (st.hasError) return ListTile(dense: true, contentPadding: EdgeInsets.zero, leading: const Icon(Icons.info_outline, size: 20), title: Text('${st.error}'.replaceFirst('Bad state: ', '')));
              if (!st.hasData) return const ListTile(dense: true, contentPadding: EdgeInsets.zero, title: Text('Stand wird geladen …'));
              final l = st.data!.ordner;
              return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                if (l.isEmpty) const ListTile(dense: true, contentPadding: EdgeInsets.zero, leading: Icon(Icons.folder_off_outlined, size: 20), title: Text('Keiner — jede Datei wird bestätigt')),
                for (final o in l) ListTile(dense: true, contentPadding: EdgeInsets.zero, leading: const Icon(Icons.folder_outlined, size: 20), title: Text(o),
                  trailing: IconButton(tooltip: 'Entfernen', icon: const Icon(Icons.close, size: 18), onPressed: () => _ablageAendern('- $o'))),
              ]);
            }),
          Align(alignment: Alignment.centerLeft, child: TextButton.icon(key: const Key('ablage-hinzu'), icon: const Icon(Icons.create_new_folder_outlined, size: 18), label: const Text('Ordner hinzufügen'),
            onPressed: () async { final d = await getDirectoryPath(confirmButtonText: 'Als Ablage-Ordner'); if (d != null) await _ablageAendern('+ $d'); })),
        ],
        if (istHandy) ...[ // v1522 — Standortzonen
          const SizedBox(height: 8),
          Text('Standortzonen', style: theme.textTheme.titleSmall),
          Text('iOS erkennt die Zonen selbst, auch bei geschlossener App. Zum Server geht nur der Name (z. B. „Zuhause“) bzw. „unterwegs“ — nie Koordinaten. Alfred nutzt das nur intern.', style: theme.textTheme.labelSmall?.copyWith(color: dim)),
          FutureBuilder<String>(future: zonenStatus(), builder: (_, st) {
            final s = st.data ?? '…';
            final text = switch (s) { 'immer' => 'Standort: Immer erlaubt', 'beimBenutzen' => 'Standort nur beim Verwenden — für Zonen „Immer“ erlauben', 'abgelehnt' => 'Standort abgelehnt — in den iOS-Einstellungen unter Alfred → Standort „Immer“ wählen', 'offen' => 'Standort noch nicht erlaubt', _ => s };
            return ListTile(dense: true, contentPadding: EdgeInsets.zero, leading: Icon(s == 'immer' ? Icons.location_on : Icons.location_off_outlined, size: 20, color: s == 'immer' ? Colors.green : null), title: Text(text),
              trailing: s == 'immer' || s == 'abgelehnt' ? null : TextButton(key: const Key('zonen-erlauben'), onPressed: () async { await zonenErlaubnis(); _neu(() {}); }, child: const Text('Erlauben')));
          }),
          for (final z in standortZonenGespeichert()) ListTile(dense: true, contentPadding: EdgeInsets.zero, leading: const Icon(Icons.radio_button_checked, size: 20), title: Text(z.name), subtitle: Text('Umkreis ${z.radius.round()} m'),
            trailing: IconButton(tooltip: 'Zone entfernen', icon: const Icon(Icons.close, size: 18), onPressed: () async { await zoneEntfernen(z.name); _neu(() {}); })),
          Wrap(spacing: 8, children: [
            TextButton.icon(key: const Key('zonen-karte'), icon: const Icon(Icons.map_outlined, size: 18), label: const Text('Zonen auf der Karte'), onPressed: () async { try { if (await zonenStatus() == 'offen') await zonenErlaubnis(); if (await zonenKarteOeffnen()) { _neu(() {}); _zeile(Eintrag(Art.hinweis, '📍 Zonen gespeichert: ${standortZonenGespeichert().map((z) => z.name).join(', ')}')); } } catch (e) { _zeile(Eintrag(Art.fehler, 'Karte: $e')); } }), // v1526
            TextButton.icon(key: const Key('zone-ha'), icon: const Icon(Icons.home_outlined, size: 18), label: const Text('Zuhause aus Home Assistant'), onPressed: _zoneAusHa),
            TextButton.icon(key: const Key('zone-hier'), icon: const Icon(Icons.my_location, size: 18), label: const Text('Aktuellen Ort als Zone'), onPressed: _zoneHier),
          ]),
        ],
        if (istHandy) FutureBuilder<String>(future: bewegungStatus(), builder: (_, st) { // v1526 — Bewegung
          final s = st.data ?? '…';
          final text = switch (s) { 'erlaubt' => 'Bewegung: erlaubt${bewegungJetzt.isEmpty ? '' : ' — jetzt ${const {'auto': 'im Auto', 'rad': 'auf dem Rad', 'laeuft': 'läuft', 'geht': 'zu Fuß', 'still': 'still'}[bewegungJetzt] ?? bewegungJetzt}'}', 'abgelehnt' => 'Bewegung abgelehnt — in den iOS-Einstellungen unter Alfred → Bewegung & Fitness erlauben', 'nichtVerfuegbar' => 'Bewegung auf diesem Gerät nicht verfügbar', 'offen' => 'Bewegung noch nicht erlaubt (im Auto automatisch vorlesen)', _ => s };
          return ListTile(dense: true, contentPadding: EdgeInsets.zero, leading: Icon(Icons.directions_walk, size: 20, color: s == 'erlaubt' ? Colors.green : null), title: Text(text),
            trailing: s == 'offen' ? TextButton(key: const Key('bewegung-erlauben'), onPressed: () async { await bewegungErlaubnis(); _neu(() {}); }, child: const Text('Erlauben')) : null);
        }),
        if (istHandy) SwitchListTile(key: const Key('auto-vorlesen'), dense: true, contentPadding: EdgeInsets.zero, title: const Text('Automatisch vorlesen'), subtitle: Text('Mit Kopfhörern, Bluetooth-Audio oder im Auto werden Antworten auch auf getippte Fragen vorgelesen', style: theme.textTheme.labelSmall?.copyWith(color: dim)), value: autoVorlesen, onChanged: (v) { _neu(() => autoVorlesen = v); autoVorlesenSpeichern(v); }), // 1.54.0
        if (istHandy) SwitchListTile(key: const Key('telegram-stumm'), dense: true, contentPadding: EdgeInsets.zero, title: const Text('Telegram stumm, wenn Mitteilung zugestellt'), subtitle: Text(telegramStumm == null ? 'Stand wird geladen …' : 'Hinweise und Bestätigungen kommen dann nur aufs Handy, solange die Mitteilung ankam', style: theme.textTheme.labelSmall?.copyWith(color: dim)), value: telegramStumm ?? false, onChanged: telegramStumm == null ? null : (v) => _telegramStummSetzen(v)), // 1.53.0 H2
        Text('Alfred kennt den Verlauf aus allen Kanälen immer. In Telegram zeigt „/verlauf" die letzten Nachrichten, „/spiegel an" schaltet dasselbe wie dieser Schalter.', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
      ])),
      karte('Verbindung', Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('Gerät: ${konfig?.name ?? '…'}', style: theme.textTheme.bodyMedium),
        Text('Server: ${konfig?.server ?? '…'}', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
        Text(satellit == null ? ipcZustand : 'Satellit ${satellit!.version} · ${satellit!.verbunden ? 'verbunden mit Alfred ${satellit!.serverVersion ?? ''}' : 'nicht verbunden'}', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
        // 1.70.0 — neues Gerät direkt aus der App koppeln (Code, QR, Befehl mit Schlüsselprüfung)
        if (server != null) Align(alignment: Alignment.centerLeft, child: Padding(padding: const EdgeInsets.only(top: 6), child: OutlinedButton.icon(key: const Key('geraet-koppeln'), icon: const Icon(Icons.add_link, size: 18), label: const Text('Neues Gerät koppeln …'), onPressed: () => zeigeNeuesGeraet(context, server!.json)))),
      ])),
      karte('App', Row(children: [
        Expanded(child: Text('Version ${appVersion.isEmpty ? '…' : appVersion}${update != null ? ' — Update ${update!.version} verfügbar' : ' — aktuell'}', style: theme.textTheme.bodyMedium)),
        if (update != null) FilledButton.tonalIcon(onPressed: updateLaeuft ? null : _updateInstallieren, icon: const Icon(Icons.system_update_alt, size: 18), label: Text(updateLaeuft ? 'läuft …' : 'Installieren')),
        if (update == null) OutlinedButton(onPressed: _updatePruefen, child: const Text('Nach Update suchen')),
      ])),
      SwitchListTile(dense: true, contentPadding: const EdgeInsets.symmetric(horizontal: 14), title: const Text('Updates still installieren'), subtitle: Text(Platform.isLinux ? 'Unter Linux nicht möglich — die Paketinstallation fragt nach dem Passwort.' : 'Wenn die App seit 10 Minuten nicht benutzt wird und nicht im Vordergrund ist (kein Zuhören, keine laufende Antwort).', style: theme.textTheme.bodySmall?.copyWith(color: dim)), value: stillUpdate && !Platform.isLinux, onChanged: Platform.isLinux ? null : (v) { _neu(() => stillUpdate = v); stillUpdateSpeichern(v); }), // 1.8.0
    ]);
  }


  /// 1.78.0 — Owner 26.10.: nur 3 Bestätigungen sichtbar, auf 3 Zeilen gekürzt, Verweis auf eine Seitenleiste ohne Liste → alte und
  /// neue Fragen verwechselt. Jetzt: neueste zuerst mit Uhrzeit, Antippen klappt den ganzen Text auf, „Alle anzeigen“ zeigt jede offene.
  Widget _bestaetigungen(ThemeData theme) {
    final dim = theme.colorScheme.onSurfaceVariant;
    final sortiert = [...offen]..sort((a, b) => (b.seit ?? DateTime(0)).compareTo(a.seit ?? DateTime(0)));
    final sichtbar = bestAlle ? sortiert : sortiert.take(3).toList();
    String zeit(DateTime? d) { if (d == null) return ''; final l = d.toLocal(); final h = DateTime.now(); final hm = '${l.hour.toString().padLeft(2, '0')}:${l.minute.toString().padLeft(2, '0')}'; return l.year == h.year && l.month == h.month && l.day == h.day ? hm : '${l.day}.${l.month}. $hm'; }
    Widget karte(Bestaetigung b) {
      final auf = bestAufgeklappt.contains(b.id);
      final lang = b.text.length > 160 || '\n'.allMatches(b.text).length > 2;
      return Card(
        margin: const EdgeInsets.only(bottom: 6),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: lang ? () => _neu(() => auf ? bestAufgeklappt.remove(b.id) : bestAufgeklappt.add(b.id)) : null,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Padding(padding: const EdgeInsets.only(top: 2), child: Icon(Icons.notifications_active, size: 18, color: Colors.amber.shade700)),
              const SizedBox(width: 10),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text([zeit(b.seit), if (b.quelle == 'geraet') 'Gerät'].where((x) => x.isNotEmpty).join(' · '), style: theme.textTheme.labelSmall?.copyWith(color: dim)),
                SelectionArea(child: Text(b.text, maxLines: auf ? null : 3, overflow: auf ? TextOverflow.visible : TextOverflow.ellipsis, style: theme.textTheme.bodySmall)),
                if (lang) Text(auf ? 'weniger' : 'ganzen Text zeigen', style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.primary)),
                // 1.79.0 — Owner 27.10.: „nur freigeben und ablehnen?“ — Einwand und Ändern lassen sichtbar statt hinter „Nein“ versteckt
                if (_Senden._istChangeFreigabe(b.text)) Wrap(spacing: 4, children: [
                  TextButton.icon(onPressed: () => _entscheide(b, false, einwand: true), icon: const Icon(Icons.record_voice_over_outlined, size: 16), label: const Text('Einwand …')),
                  if (_Senden._changeKurz(b.text) != null) TextButton.icon(onPressed: () => _nachfragen('Change ${_Senden._changeKurz(b.text)} ändern: '), icon: const Icon(Icons.edit_outlined, size: 16), label: const Text('Ändern lassen …')),
                ]),
              ])),
              const SizedBox(width: 8),
              FilledButton(onPressed: () => _entscheide(b, true), child: const Text('Ja')),
              const SizedBox(width: 6),
              OutlinedButton(onPressed: () => _entscheide(b, false), child: const Text('Nein')),
            ]),
          ),
        ),
      );
    }
    final liste = Column(mainAxisSize: MainAxisSize.min, children: [for (final b in sichtbar) karte(b)]);
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 0, 20, 4),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        if (bestAlle && sortiert.length > 3)
          ConstrainedBox(constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.45), child: SingleChildScrollView(child: liste))
        else
          liste,
        if (sortiert.length > 3)
          Align(alignment: Alignment.centerLeft, child: TextButton.icon(
            onPressed: () => _neu(() => bestAlle = !bestAlle),
            icon: Icon(bestAlle ? Icons.expand_less : Icons.expand_more, size: 18),
            label: Text(bestAlle ? 'Nur die neuesten 3 zeigen' : 'Alle ${sortiert.length} offenen Bestätigungen anzeigen'),
          )),
      ]),
    );
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
      if (istHandy) { await handyVorschau(f.path); return; } // 1.54.4 — iOS-Vorschau statt Desktop-Programm
      if (Platform.isWindows) { await Process.start('cmd', ['/c', 'start', '', f.path], mode: ProcessStartMode.detached); }
      else if (Platform.isMacOS) { await Process.start('open', [f.path], mode: ProcessStartMode.detached); }
      else { await Process.start('xdg-open', [f.path], mode: ProcessStartMode.detached); }
    } catch (e) { _zeile(Eintrag(Art.fehler, 'Anhang nicht geöffnet: $e')); }
  }


  Future<void> _anhangSpeichern(Anhang a) async {
    try {
      if (istHandy) { _zeile(Eintrag(Art.hinweis, '💾 gespeichert: ${await dateiAblegen(null, a.name, Uint8List.fromList(a.bytes))}')); return; } // 1.54.4 — Ordner „Alfred“ (Dateien-App)
      final dir = await getDownloadsDirectory() ?? await getApplicationDocumentsDirectory();
      final f = await _anhangAblegen(a, dir);
      _zeile(Eintrag(Art.hinweis, '💾 gespeichert: ${f.path}'));
    } catch (e) { _zeile(Eintrag(Art.fehler, 'Anhang nicht gespeichert: $e')); }
  }


  /// 1.46.0 — Inhalt einer eigenen Datei für Vorschau und Öffnen: lokal gesendet → von der Platte, sonst vom Server.
  Future<Anhang?> _uploadLaden(UploadVerweis d) async {
    if (d.pfad != null) {
      try { final f = File(d.pfad!); return Anhang(name: d.name, mime: d.istBild ? 'image/${d.name.split('.').last.toLowerCase().replaceAll('jpg', 'jpeg')}' : 'application/octet-stream', bytes: await f.readAsBytes()); } catch (_) { return null; }
    }
    final s = server; final k = d.key;
    if (s == null || k == null) return null;
    return s.datei(k, d.name);
  }

  /// v1522 — „Zuhause“ aus Home Assistant (zone.home) übernehmen
  Future<void> _zoneAusHa() async {
    String text;
    try {
      final j = await server!.json('/api/geraete/zonen/vorschlag');
      final v = ((j['vorschlaege'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>().firstOrNull;
      if (v == null) { text = 'Home Assistant liefert keine Heimzone (zone.home)'; }
      else {
        if (await zonenStatus() != 'immer') await zonenErlaubnis();
        await zoneSetzen('${v['name']}', (v['breite'] as num).toDouble(), (v['laenge'] as num).toDouble(), radius: ((v['radius'] as num?) ?? 150).toDouble());
        text = '📍 Zone „${v['name']}“ aus Home Assistant übernommen (Umkreis ${(v['radius'] as num?)?.round() ?? 150} m)';
      }
    } catch (e) { text = 'Zone nicht übernommen: ${'$e'.replaceFirst('Exception: ', '')}'; }
    _neu(() {});
    _zeile(Eintrag(Art.hinweis, text));
    if (mounted) ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(text)));
  }

  /// v1522 — Zone am aktuellen Ort anlegen (Name frei, Vorschlag „Zuhause“ bzw. „Büro“; Umkreis 150 m)
  Future<void> _zoneHier() async {
    final vorhanden = standortZonenGespeichert().map((z) => z.name.toLowerCase()).toSet();
    final feld = TextEditingController(text: vorhanden.contains('zuhause') ? 'Büro' : 'Zuhause');
    final name = await showDialog<String>(context: context, builder: (c) => AlertDialog(
      title: const Text('Zone am aktuellen Ort'),
      content: TextField(controller: feld, autofocus: true, decoration: const InputDecoration(labelText: 'Name der Zone')),
      actions: [TextButton(onPressed: () => Navigator.pop(c), child: const Text('Abbrechen')), FilledButton(onPressed: () => Navigator.pop(c, feld.text.trim()), child: const Text('Anlegen'))],
    ));
    if (name == null || name.isEmpty) return;
    String text;
    try {
      if (await zonenStatus() == 'offen') await zonenErlaubnis();
      final o = await ortJetzt();
      if (o == null) { text = 'Ort nicht ermittelbar — Standort-Erlaubnis prüfen'; }
      else { await zoneSetzen(name, o.breite, o.laenge); text = '📍 Zone „$name“ angelegt (Umkreis 150 m, Ortsgenauigkeit ${o.genau.round()} m)'; }
    } catch (e) { text = 'Zone nicht angelegt: ${'$e'.replaceFirst('Exception: ', '')}'; }
    _neu(() {});
    _zeile(Eintrag(Art.hinweis, text));
    if (mounted) ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(text)));
  }

  /// 1.54.2 — Ordner freigeben mit sichtbarem Ergebnis; jeder Ausgang auch ins Server-Log (Art „ordner“), damit ein
  /// Fehlschlag am Gerät nachvollziehbar ist.
  Future<void> _ordnerFreigebenKnopf() async {
    String text;
    try {
      final r = await ordnerFreigeben();
      text = r.name == null ? 'Ordnerfreigabe: ${r.detail}' : '📁 Ordner „${r.name}“ freigegeben';
      server?.melde(r.name == null ? 'abgebrochen: ${r.detail}' : 'freigegeben: ${r.name} — ${r.detail}', art: 'ordner', version: appVersion, plattform: 'ios');
      if (r.name != null) { _neu(() {}); (ipc as HandyVerbindung).jetztVerbinden(); }
    } catch (e) {
      text = 'Ordnerfreigabe fehlgeschlagen: ${'$e'.replaceFirst('Exception: ', '')}';
      server?.melde(text, art: 'ordner', version: appVersion, plattform: 'ios');
    }
    if (!mounted) return;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(text)));
    _zeile(Eintrag(Art.hinweis, text));
  }

  /// 1.52.1 — Verlaufsleiste nur am Desktop: sie lebt von Maus und Darüberfahren, am Finger ist der 28-px-Rand kaum zu treffen.
  bool get _mitVerlaufsleiste => istDesktop && archiv == null && leistenEintraege(verlauf).length >= 3;

  /// Phase 5 H1 — Dateien ins Fenster ziehen gibt es nur auf dem Desktop.
  Widget _ablage(Widget kind) => istDesktop ? DropTarget(onDragDone: (d) => _dateienAbgelegt(d.files.map((f) => f.path).toList()), child: kind) : kind;

  Widget _eintrag(Eintrag e, ThemeData theme) {
    final zeit = '${e.zeit.hour.toString().padLeft(2, '0')}:${e.zeit.minute.toString().padLeft(2, '0')}';
    final dim = theme.colorScheme.onSurfaceVariant;
    switch (e.art) {
      case Art.du:
        // 1.2.5 — eigene Nachricht wiederholen oder bearbeiten (Owner-Freigabe 09.10.)
        // 1.46.0 — Upload-Zeilen als Vorschaubilder/Kärtchen über der Blase, die Blase zeigt nur den eigenen Text
        final u = uploadZeilenTrennen(e.text);
        final dateien = [...u.dateien, for (final p in e.lokaleDateien) UploadVerweis(name: File(p).uri.pathSegments.last, pfad: p)];
        return Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: Align(alignment: Alignment.centerRight, child: Column(crossAxisAlignment: CrossAxisAlignment.end, mainAxisSize: MainAxisSize.min, children: [
          if (dateien.isNotEmpty) Padding(padding: const EdgeInsets.only(bottom: 6), child: ConstrainedBox(constraints: BoxConstraints(maxWidth: breiteChat * 0.78), child: UploadVorschau(dateien: dateien, laden: _uploadLaden, aufOeffnen: _anhangOeffnen))),
          if (u.text.isNotEmpty) Container(constraints: BoxConstraints(maxWidth: breiteChat * 0.78), padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8), decoration: BoxDecoration(color: theme.colorScheme.primaryContainer, borderRadius: BorderRadius.circular(12)), child: _eingeklappt(e)
            ? Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                SelectableText(gekuerzt(u.text)),
                TextButton.icon(onPressed: () => _neu(() => e.aufgeklappt = true), icon: const Icon(Icons.unfold_more, size: 16), label: Text('mehr anzeigen (${(e.text.length / 1024).toStringAsFixed(0)} KB)'), style: TextButton.styleFrom(visualDensity: VisualDensity.compact)),
              ])
            : SelectableText(u.text)),
          Row(mainAxisSize: MainAxisSize.min, children: [
            IconButton(tooltip: 'Bearbeiten (Text in die Eingabe legen)', onPressed: antwortet ? null : () { eingabe.text = _ohneZitat(u.text); eingabe.selection = TextSelection.collapsed(offset: eingabe.text.length); fokus.requestFocus(); }, icon: Icon(Icons.edit_outlined, size: 16, color: dim), visualDensity: VisualDensity.compact),
            IconButton(tooltip: 'Erneut senden', onPressed: antwortet ? null : () => _senden(text: _ohneZitat(e.text)), icon: Icon(Icons.replay_outlined, size: 16, color: dim), visualDensity: VisualDensity.compact),
            if (archiv == null) IconButton(tooltip: lesezeichen.contains(lesezeichenSchluessel(e.text)) ? 'Lesezeichen entfernen' : 'Lesezeichen (in der Verlaufsleiste hervorgehoben)', onPressed: () => _lesezeichenUmschalten(e), icon: Icon(lesezeichen.contains(lesezeichenSchluessel(e.text)) ? Icons.bookmark : Icons.bookmark_border, size: 16, color: lesezeichen.contains(lesezeichenSchluessel(e.text)) ? theme.colorScheme.primary : dim), visualDensity: VisualDensity.compact), // 1.45.0 D4
          ]),
        ])));
      case Art.alfred:
        // 1.1.0 — Antwort ohne Blase (wie in der Vorlage), darunter Aktionen: kopieren, vorlesen
        return Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Align(alignment: Alignment.centerLeft, child: ConstrainedBox(constraints: BoxConstraints(maxWidth: breiteChat * 0.9), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [Text('Alfred', style: theme.textTheme.labelMedium?.copyWith(color: theme.colorScheme.primary, fontWeight: FontWeight.w600)), Text(' · $zeit', style: theme.textTheme.labelSmall?.copyWith(color: dim))]),
          const SizedBox(height: 4),
          AlfredText(e.text, aufKopiert: (was) => _neu(() => fluechtig = '„${was.length > 40 ? '${was.substring(0, 40)}…' : was}" kopiert')), // 1.6.0 Links, Tabellen, Code-Blöcke; 1.12.1 Text
          for (final a in e.anhaenge) AnhangAnsicht(a, aufOeffnen: _anhangOeffnen, aufSpeichern: _anhangSpeichern, aufAbspielen: (x) => audio.abspielen(x.daten, x.mime).catchError((Object err) => _zeile(Eintrag(Art.fehler, '🔊 $err')))), // 1.5.0 eigenes Widget
          if (e.text.isNotEmpty) Row(children: [
            // 1.50.0 D6a — Kopieren als Klartext (Markdown im Menü), 👍/👎, Antworten, „…“ mit Abzweigen, Aufgabe, Merken
            IconButton(tooltip: 'Kopieren (Text)', onPressed: () { Clipboard.setData(ClipboardData(text: ohneMarkdown(e.text))); _neu(() => fluechtig = 'kopiert'); }, icon: Icon(Icons.copy_outlined, size: 16, color: dim), visualDensity: VisualDensity.compact),
            IconButton(tooltip: 'Vorlesen', onPressed: () => _sprichKurz(e.text), icon: Icon(Icons.volume_up_outlined, size: 16, color: dim), visualDensity: VisualDensity.compact),
            if (archiv == null) ...() {
              final w = bewertungen[lesezeichenSchluessel(e.text)] ?? 0;
              return [
                IconButton(key: Key('gut-${e.zeit.millisecondsSinceEpoch}'), tooltip: w == 1 ? 'Gute Antwort (zurücknehmen)' : 'Gute Antwort', onPressed: () => _bewerten(e, 1), icon: Icon(w == 1 ? Icons.thumb_up : Icons.thumb_up_outlined, size: 16, color: w == 1 ? theme.colorScheme.primary : dim), visualDensity: VisualDensity.compact),
                IconButton(key: Key('schlecht-${e.zeit.millisecondsSinceEpoch}'), tooltip: w == -1 ? 'Schlechte Antwort (zurücknehmen)' : 'Schlechte Antwort (mit Grund: Alfred merkt sich die Korrektur)', onPressed: () => _bewerten(e, -1), icon: Icon(w == -1 ? Icons.thumb_down : Icons.thumb_down_outlined, size: 16, color: w == -1 ? theme.colorScheme.error : dim), visualDensity: VisualDensity.compact),
              ];
            }(),
            IconButton(tooltip: 'Darauf antworten (Alfred weiß dann, worauf du dich beziehst)', onPressed: () { _neu(() => bezug = e); fokus.requestFocus(); }, icon: Icon(Icons.reply_outlined, size: 16, color: bezug == e ? theme.colorScheme.primary : dim), visualDensity: VisualDensity.compact), // 1.2.2
            PopupMenuButton<String>(
              key: Key('mehr-${e.zeit.millisecondsSinceEpoch}'), tooltip: 'Mehr', icon: Icon(Icons.more_horiz, size: 16, color: dim), padding: EdgeInsets.zero, iconSize: 16,
              onSelected: (a) {
                switch (a) {
                  case 'abzweigen': _fadenAbzweigen(server?.faden, bis: e.zeit); // 1.43.0 D2
                  case 'aufgabe': _aufgabeAusPalette(aufgabenTitel(e.text));
                  case 'merken': _merken(e);
                  case 'markdown': Clipboard.setData(ClipboardData(text: e.text)); _neu(() => fluechtig = 'als Markdown kopiert');
                }
              },
              itemBuilder: (_) => [
                if (archiv == null) const PopupMenuItem(value: 'abzweigen', child: ListTile(dense: true, leading: Icon(Icons.call_split, size: 18), title: Text('Ab hier abzweigen'))),
                const PopupMenuItem(value: 'aufgabe', child: ListTile(dense: true, leading: Icon(Icons.add_task, size: 18), title: Text('Als Aufgabe übernehmen'))),
                const PopupMenuItem(value: 'merken', child: ListTile(dense: true, leading: Icon(Icons.psychology_outlined, size: 18), title: Text('Merken (Gedächtnis)'))),
                const PopupMenuItem(value: 'markdown', child: ListTile(dense: true, leading: Icon(Icons.code, size: 18), title: Text('Als Markdown kopieren'))),
              ],
            ),
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

