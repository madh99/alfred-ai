part of 'main.dart';

/// C1 (11.10.) — aus main.dart ausgelagert, Verhalten unverändert: Oberfläche: Symbolleiste, Seitenleiste, Chat, Eingabe, Einstellungen, Einträge.
extension _Oberflaeche on _SitzungState {
  /// 1.36.0 — Navigation mit Beschriftung und Gruppen (Owner 16.10.: „sehr plump in der UI"; vorher 15 unbeschriftete Symbole):
  /// Chat · Eingang (Vorgänge, Hinweise, Aufgaben, Bestätigungen) · Haus & Systeme (Lage, Befunde, Beobachter) · Arbeit (Projekte) ·
  /// Wissen (Gedächtnis, Suche, Anhänge) · unten Befehle und Einstellungen. Breit (mit Text) oder schmal (nur Symbole), gemerkt.
  Widget _leiste(ThemeData theme) {
    final cs = theme.colorScheme;
    final breit = navBreit;
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
          eintrag(Icons.assignment_outlined, Icons.assignment, 'Vorgänge', ansicht == Ansicht.vorgaenge, ohneServer ? null : () => zu(Ansicht.vorgaenge), zaehler: vorgaenge.length, tip: 'Offene Vorgänge: entscheiden, ausführen, später'), // 1.34.0
          eintrag(Icons.lightbulb_outline, Icons.lightbulb, 'Hinweise', ansicht == Ansicht.hinweise, ohneServer ? null : () => zu(Ansicht.hinweise), zaehler: hinweiseOffen), // 1.4.0
          eintrag(Icons.checklist, Icons.checklist_rtl, 'Aufgaben', ansicht == Ansicht.aufgaben, ohneServer ? null : () => zu(Ansicht.aufgaben), zaehler: aufgabenFaelligZahl, tip: 'Aufgaben & Erinnerungen'), // 1.9.0 A1
          eintrag(Icons.notifications_none, Icons.notifications, 'Bestätigungen', false, () => _neu(() { ansicht = Ansicht.chat; seitenleisteOffen = true; }), zaehler: offen.length, tip: offen.isEmpty ? 'Keine offenen Bestätigungen' : '${offen.length} offene Bestätigung(en) — in der Seitenleiste'),
          gruppe('Haus & Systeme'),
          eintrag(Icons.dashboard_outlined, Icons.dashboard, 'Lage', ansicht == Ansicht.kacheln, ohneServer ? null : () => zu(Ansicht.kacheln, () => kachelnOffen = true), tip: 'Lage: Befunde, Vorgänge, Geräte'),
          eintrag(Icons.report_problem_outlined, Icons.report_problem, 'Befunde', ansicht == Ansicht.befunde, ohneServer ? null : () => zu(Ansicht.befunde, () => befundeFilter = null), tip: 'Was Alfred als auffällig führt (Haus-Check u. a.)'), // 1.12.0
          eintrag(Icons.visibility_outlined, Icons.visibility, 'Beobachter', ansicht == Ansicht.beobachter, ohneServer ? null : () => zu(Ansicht.beobachter)), // 1.20.0
          gruppe('Arbeit'),
          eintrag(Icons.construction_outlined, Icons.construction, 'Projekte', ansicht == Ansicht.projekte, ohneServer ? null : () => zu(Ansicht.projekte), tip: 'Projekte auf Geräten'), // 1.15.0
          gruppe('Wissen'),
          eintrag(Icons.psychology_outlined, Icons.psychology, 'Gedächtnis', ansicht == Ansicht.gedaechtnis, ohneServer ? null : () => zu(Ansicht.gedaechtnis), tip: 'Was Alfred über dich weiß'), // 1.9.0 A3
          eintrag(Icons.search, Icons.manage_search, 'Suche', ansicht == Ansicht.suche, ohneServer ? null : () => zu(Ansicht.suche), tip: 'Suche im Verlauf'), // 1.5.0
          eintrag(Icons.photo_library_outlined, Icons.photo_library, 'Anhänge', ansicht == Ansicht.anhaenge, ohneServer ? null : () => zu(Ansicht.anhaenge), tip: 'Fotos und Dateien'), // 1.5.0
        ])),
        Divider(height: 1, color: cs.outlineVariant),
        const SizedBox(height: 6),
        eintrag(Icons.keyboard_command_key, Icons.keyboard_command_key, 'Befehle', false, () => _paletteOeffnen(), tip: 'Befehle (Strg+K)'), // 1.10.0 B1
        eintrag(Icons.settings_outlined, Icons.settings, 'Einstellungen', ansicht == Ansicht.einstellungen, () => zu(Ansicht.einstellungen)),
        eintrag(breit ? Icons.keyboard_double_arrow_left : Icons.keyboard_double_arrow_right, Icons.keyboard_double_arrow_left, breit ? 'Einklappen' : 'Ausklappen', false, () { _neu(() => navBreit = !navBreit); navBreitSpeichern(navBreit); }),
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
    return Container(
      width: 270,
      color: theme.colorScheme.surfaceContainerLow,
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
        const Divider(height: 1),
        Padding(padding: const EdgeInsets.fromLTRB(16, 8, 12, 10), child: Row(children: [
          Icon(Icons.circle, size: 9, color: satellit?.verbunden == true ? Colors.green : theme.colorScheme.error),
          const SizedBox(width: 6),
          Expanded(child: Text(satellit == null ? ipcZustand : 'Satellit ${satellit!.version}${satellit!.verbunden ? ' · Alfred ${satellit!.serverVersion ?? ''}' : ' · nicht verbunden'}', style: theme.textTheme.labelSmall?.copyWith(color: dim), overflow: TextOverflow.ellipsis)),
        ])),
      ]),
    );
  }


  /// Hauptbereich Chat: Kopfzeile, Verlauf (mittig, Datumstrenner), Bestätigungskarten, Eingabekarte.
  Widget _chat(ThemeData theme) {
    final dim = theme.colorScheme.onSurfaceVariant;
    final geraet = konfig?.name ?? satellit?.name ?? '…';
    // 1.1.1 — Owner 16:12: Dateien ließen sich nicht mehr hineinziehen. Die Ablagezone deckte nur den Verlauf ab,
    // nicht die Eingabekarte; jetzt liegt sie über dem ganzen Chat-Bereich (zusätzlich zum Plus-Knopf).
    return DropTarget(onDragDone: (d) => _dateienAbgelegt(d.files.map((f) => f.path).toList()), child: Column(children: [
      SizedBox(height: 48, child: Row(children: [
        if (!seitenleisteOffen) IconButton(tooltip: 'Seitenleiste', onPressed: () { _neu(() => seitenleisteOffen = true); seitenleisteSpeichern(true); }, icon: const Icon(Icons.view_sidebar_outlined, size: 20)),
        const SizedBox(width: 12),
        // 1.17.2 — Owner 13.10.: welches Gespräch gerade offen ist, steht über dem Chat (Gerät dahinter, gedämpft)
        // 1.43.0 D2 — Ordner-Symbol bei Fäden eines Projekts (Projektname im Tooltip)
        if (_offenerFaden() != null && fadenProjektId(_offenerFaden()!) != null) Padding(padding: const EdgeInsets.only(right: 6), child: Tooltip(message: 'Projekt: ${(_offenerFaden()!['projekt'] as Map)['name']}', child: Icon(Icons.folder_outlined, size: 18, color: dim))),
        Flexible(child: Text.rich(TextSpan(children: [TextSpan(text: _kopfTitel()), TextSpan(text: '  ·  $geraet', style: TextStyle(color: dim))]), key: const Key('chat-kopf'), maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.titleSmall)),
        const Spacer(),
        if (archiv == null) IconButton(key: const Key('karte-knopf'), tooltip: karteOffen ? 'Zusammenfassung ausblenden' : 'Angeheftete Zusammenfassung ein', onPressed: () => _neu(() => karteOffen = !karteOffen), icon: Icon(Icons.fact_check_outlined, size: 20, color: karteOffen ? theme.colorScheme.primary : null)), // 1.44.0 D3
        if (archiv == null) IconButton(key: const Key('seiten-chat-knopf'), tooltip: seitenChatOffen ? 'Seiten-Chat schließen (Strg+Alt+S)' : 'Seiten-Chat (Strg+Alt+S)', onPressed: _seitenChatUmschalten, icon: Icon(Icons.vertical_split_outlined, size: 20, color: seitenChatOffen ? theme.colorScheme.primary : null)),
        if (archiv == null) _kopfMenue(),
        if (update != null) Padding(padding: const EdgeInsets.only(right: 8), child: ActionChip(avatar: updateLaeuft ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.system_update_alt, size: 18), label: Text('Update ${update!.version}'), tooltip: 'Herunterladen und installieren (${(update!.groesse / 1024 / 1024).toStringAsFixed(1)} MB)', onPressed: updateLaeuft ? null : _updateInstallieren)),
        IconButton(tooltip: stimme ? 'Antworten vorlesen: an' : 'Antworten vorlesen: aus', onPressed: () => _neu(() => stimme = !stimme), icon: Icon(stimme ? Icons.volume_up : Icons.volume_off, size: 20)),
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
      Expanded(child: Stack(children: [Positioned.fill(child: verlauf.isEmpty
          ? Center(child: Column(mainAxisSize: MainAxisSize.min, children: [Icon(Icons.auto_awesome, size: 40, color: dim), const SizedBox(height: 12), Text('Was kann ich für dich tun?', style: theme.textTheme.headlineSmall)]))
          : Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 920), child: ListView.builder(
              controller: scroll,
              reverse: true, // 1.2.7 — von unten verankert: Öffnen eines Gesprächs zeigt die letzte Nachricht
              padding: const EdgeInsets.fromLTRB(20, 12, 20, 12),
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
                return neuerTag ? Column(children: [_datumstrenner(e.zeit, theme), w]) : w;
              },
            ))),
      ), if (karteOffen && archiv == null && ansicht == Ansicht.chat) Positioned(top: 8, right: 16, child: _karte(theme))])), // 1.44.0 D3
      if (offen.isNotEmpty) Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 920), child: _bestaetigungen(theme))),
      if (fremdeArbeit.isNotEmpty) Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 920), child: _arbeitsLeiste(theme))), // 1.11.0
      Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 920), child: _eingabekarte(theme))),
    ]));
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
            IconButton(tooltip: 'Bezug entfernen', onPressed: () => _neu(() => bezug = null), icon: const Icon(Icons.close, size: 16), visualDensity: VisualDensity.compact),
          ]),
        )),
        if (anhaenge.isNotEmpty) Padding(padding: const EdgeInsets.only(bottom: 6), child: Wrap(spacing: 6, runSpacing: 4, children: [
          for (final f in anhaenge) InputChip(avatar: const Icon(Icons.insert_drive_file_outlined, size: 18), label: Text(f.uri.pathSegments.last, overflow: TextOverflow.ellipsis), tooltip: f.path, onDeleted: () => _neu(() => anhaenge.remove(f))),
        ])),
        // 1.0.3 — mehrzeiliges Feld: Enter sendet, Umschalt+Enter macht eine neue Zeile (onSubmitted feuert bei maxLines > 1 nicht).
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
            onSelected: (v) => _neu(() => tierWahl = v == '' ? null : v),
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
          antwortet // 1.7.0 — während der Antwort wird Senden zu Stopp (Owner-Freigabe 11.10., Punkt 5)
            ? StoppKnopf(key: const Key('stopp'), aufStopp: _abbrechen) // 1.14.1 — Lauf-Kreis um Stopp (wie bis 1.6 um Senden)
            : IconButton.filled(tooltip: 'Senden (Enter)', onPressed: () => _senden(), icon: const Icon(Icons.arrow_upward, size: 20)),
        ]),
      ]),
    );
  }


  /// 1.6.0 — Punkt 3: Bild aus der Zwischenablage als Anhang der Eingabezeile.
  Future<void> _bildEinfuegen() async {
    if (antwortet) return;
    final f = await bildAusZwischenablage();
    if (f == null || !mounted) return;
    _dateienAbgelegt([f.path]);
    _neu(() => fluechtig = '📎 Bild aus der Zwischenablage angehängt (${(f.lengthSync() / 1024).round()} KB)');
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
        SwitchListTile(dense: true, contentPadding: EdgeInsets.zero, title: const Text('Seitenleiste beim Start'), value: seitenleisteOffen, onChanged: (v) { _neu(() => seitenleisteOffen = v); seitenleisteSpeichern(v); }),
      ])),
      karte('Sprache', Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        SwitchListTile(dense: true, contentPadding: EdgeInsets.zero, title: const Text('Antworten vorlesen'), value: stimme, onChanged: (v) => _neu(() => stimme = v)),
        // 1.3.0 — lokales Aktivierungswort (Owner-Ok 10.10.): Standard an; gilt ab dem nächsten Start des Zuhörens
        SwitchListTile(dense: true, contentPadding: EdgeInsets.zero, title: const Text('Aktivierungswort in der App erkennen'), subtitle: Text(wortLokal ? 'Nur Äußerungen mit erkanntem Wort gehen an den Server (Modell in der App, 2,8 MB).${wortVerworfen > 0 ? ' Verworfen seit Start: $wortVerworfen.' : ''}' : 'Aus: jede Äußerung geht an den Server, der das Wort im Transkript prüft.', style: theme.textTheme.bodySmall?.copyWith(color: dim)), value: wortLokal, onChanged: (v) { _neu(() => wortLokal = v); wortLokalSpeichern(v); }),
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
      SwitchListTile(dense: true, contentPadding: const EdgeInsets.symmetric(horizontal: 14), title: const Text('Updates still installieren'), subtitle: Text(Platform.isLinux ? 'Unter Linux nicht möglich — die Paketinstallation fragt nach dem Passwort.' : 'Wenn die App seit 10 Minuten nicht benutzt wird und nicht im Vordergrund ist (kein Zuhören, keine laufende Antwort).', style: theme.textTheme.bodySmall?.copyWith(color: dim)), value: stillUpdate && !Platform.isLinux, onChanged: Platform.isLinux ? null : (v) { _neu(() => stillUpdate = v); stillUpdateSpeichern(v); }), // 1.8.0
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
                TextButton.icon(onPressed: () => _neu(() => e.aufgeklappt = true), icon: const Icon(Icons.unfold_more, size: 16), label: Text('mehr anzeigen (${(e.text.length / 1024).toStringAsFixed(0)} KB)'), style: TextButton.styleFrom(visualDensity: VisualDensity.compact)),
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
          AlfredText(e.text, aufKopiert: (was) => _neu(() => fluechtig = '„${was.length > 40 ? '${was.substring(0, 40)}…' : was}" kopiert')), // 1.6.0 Links, Tabellen, Code-Blöcke; 1.12.1 Text
          for (final a in e.anhaenge) AnhangAnsicht(a, aufOeffnen: _anhangOeffnen, aufSpeichern: _anhangSpeichern, aufAbspielen: (x) => audio.abspielen(x.daten, x.mime).catchError((Object err) => _zeile(Eintrag(Art.fehler, '🔊 $err')))), // 1.5.0 eigenes Widget
          if (e.text.isNotEmpty) Row(children: [
            IconButton(tooltip: 'Kopieren', onPressed: () { Clipboard.setData(ClipboardData(text: e.text)); _neu(() => fluechtig = 'kopiert'); }, icon: Icon(Icons.copy_outlined, size: 16, color: dim), visualDensity: VisualDensity.compact),
            IconButton(tooltip: 'Vorlesen', onPressed: () => _sprichKurz(e.text), icon: Icon(Icons.volume_up_outlined, size: 16, color: dim), visualDensity: VisualDensity.compact),
            if (archiv == null) IconButton(tooltip: 'Ab hier abzweigen (neues Gespräch mit dem Verlauf bis hier)', onPressed: () => _fadenAbzweigen(server?.faden, bis: e.zeit), icon: Icon(Icons.call_split, size: 16, color: dim), visualDensity: VisualDensity.compact), // 1.43.0 D2
            IconButton(tooltip: 'Darauf antworten (Alfred weiß dann, worauf du dich beziehst)', onPressed: () { _neu(() => bezug = e); fokus.requestFocus(); }, icon: Icon(Icons.reply_outlined, size: 16, color: bezug == e ? theme.colorScheme.primary : dim), visualDensity: VisualDensity.compact), // 1.2.2
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
