part of 'main.dart';

/// C1 (11.10.) — aus main.dart ausgelagert, Verhalten unverändert: Oberfläche: Symbolleiste, Seitenleiste, Chat, Eingabe, Einstellungen, Einträge.
extension _Oberflaeche on _SitzungState {
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
        knopf(Icons.chat_bubble_outline, Icons.chat_bubble, 'Chat', ansicht == Ansicht.chat, () => _neu(() => ansicht = Ansicht.chat)),
        knopf(Icons.dashboard_outlined, Icons.dashboard, 'Lage: Befunde, Vorgänge, Geräte', ansicht == Ansicht.kacheln, server == null ? null : () => _neu(() { ansicht = Ansicht.kacheln; kachelnOffen = true; })),
        knopf(Icons.lightbulb_outline, Icons.lightbulb, hinweiseOffen == 0 ? 'Hinweise' : '$hinweiseOffen offene Hinweise', ansicht == Ansicht.hinweise, server == null ? null : () => _neu(() => ansicht = Ansicht.hinweise), zaehler: hinweiseOffen), // 1.4.0
        knopf(Icons.checklist, Icons.checklist_rtl, aufgabenFaelligZahl == 0 ? 'Aufgaben & Erinnerungen' : '$aufgabenFaelligZahl Aufgabe(n) heute oder überfällig', ansicht == Ansicht.aufgaben, server == null ? null : () => _neu(() => ansicht = Ansicht.aufgaben), zaehler: aufgabenFaelligZahl), // 1.9.0 A1
        knopf(Icons.psychology_outlined, Icons.psychology, 'Gedächtnis: was Alfred über dich weiß', ansicht == Ansicht.gedaechtnis, server == null ? null : () => _neu(() => ansicht = Ansicht.gedaechtnis)), // 1.9.0 A3
        knopf(Icons.report_problem_outlined, Icons.report_problem, 'Befunde: was Alfred als auffällig führt (Haus-Check u. a.)', ansicht == Ansicht.befunde, server == null ? null : () => _neu(() { befundeFilter = null; ansicht = Ansicht.befunde; })), // 1.12.0
        knopf(Icons.construction_outlined, Icons.construction, 'Projekte auf Geräten', ansicht == Ansicht.projekte, server == null ? null : () => _neu(() => ansicht = Ansicht.projekte)), // 1.15.0
        knopf(Icons.keyboard_command_key, Icons.keyboard_command_key, 'Befehle (Strg+K)', false, () => _paletteOeffnen()), // 1.10.0 B1
        knopf(Icons.search, Icons.manage_search, 'Suche im Verlauf', ansicht == Ansicht.suche, server == null ? null : () => _neu(() => ansicht = Ansicht.suche)), // 1.5.0
        knopf(Icons.photo_library_outlined, Icons.photo_library, 'Anhänge: Fotos und Dateien', ansicht == Ansicht.anhaenge, server == null ? null : () => _neu(() => ansicht = Ansicht.anhaenge)), // 1.5.0
        knopf(Icons.notifications_none, Icons.notifications, offen.isEmpty ? 'Keine offenen Bestätigungen' : '${offen.length} offene Bestätigung(en)', false, () => _neu(() { ansicht = Ansicht.chat; seitenleisteOffen = true; }), zaehler: offen.length),
        const Spacer(),
        knopf(Icons.settings_outlined, Icons.settings, 'Einstellungen', ansicht == Ansicht.einstellungen, () => _neu(() => ansicht = Ansicht.einstellungen)),
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
          IconButton(tooltip: 'Seitenleiste einklappen', onPressed: () { _neu(() => seitenleisteOffen = false); seitenleisteSpeichern(false); }, icon: const Icon(Icons.view_sidebar_outlined, size: 20)),
        ])),
        Padding(padding: const EdgeInsets.fromLTRB(10, 10, 10, 0), child: ListTile(dense: true, leading: const Icon(Icons.edit_square, size: 20), title: const Text('Neuer Chat'), subtitle: Text('Eigenes Gespräch mit Alfred', style: theme.textTheme.labelSmall?.copyWith(color: dim)), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)), tileColor: theme.colorScheme.surfaceContainerHigh, onTap: _neuerChat)),
        Expanded(child: ListView(padding: const EdgeInsets.only(bottom: 8), children: [
          abschnitt('Gespräche'),
          ListTile(dense: true, selected: server?.faden == null, leading: const Icon(Icons.forum_outlined, size: 18), title: Text('Hauptgespräch', style: theme.textTheme.bodySmall), onTap: () => _fadenWechseln(null)),
          for (final f in faeden.where((x) => x['faden'] != null && x['archiv'] == null).take(12)) ListTile(dense: true, selected: server?.faden == f['faden'], leading: const Icon(Icons.chat_bubble_outline, size: 18), title: Text('${(f['titel'] ?? '').toString().isEmpty ? 'Gespräch' : f['titel']}', maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall), subtitle: Text(_fadenZeit('${f['zeit'] ?? ''}'), style: theme.textTheme.labelSmall?.copyWith(color: dim)), trailing: Row(mainAxisSize: MainAxisSize.min, children: [IconButton(tooltip: 'Umbenennen', iconSize: 16, visualDensity: VisualDensity.compact, onPressed: () => _fadenUmbenennen('${f['faden']}', '${f['titel'] ?? ''}'), icon: const Icon(Icons.edit_outlined)), IconButton(tooltip: 'Gespräch löschen', iconSize: 16, visualDensity: VisualDensity.compact, onPressed: () => _fadenLoeschen('${f['faden']}'), icon: const Icon(Icons.delete_outline))]), onTap: () => _fadenWechseln('${f['faden']}')),
          if (offen.isNotEmpty) ...[
            abschnitt('Bestätigungen (${offen.length})'),
            for (final b in offen) ListTile(dense: true, leading: Icon(Icons.notifications_active, size: 18, color: Colors.amber.shade700), title: Text(b.text, maxLines: 2, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall), onTap: () => _neu(() => ansicht = Ansicht.chat)),
          ],
          if (faeden.any((x) => x['archiv'] != null)) ...[
            abschnitt('Archiv (frühere Sitzungen)'),
            for (final f in faeden.where((x) => x['archiv'] != null).take(6)) ListTile(dense: true, selected: archiv == f['archiv'], leading: const Icon(Icons.inventory_2_outlined, size: 18), title: Text('${f['titel']}', maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall), subtitle: Text('${_fadenZeit('${f['zeit'] ?? ''}')} · ${f['anzahl']} Nachrichten', style: theme.textTheme.labelSmall?.copyWith(color: dim)), onTap: () => _archivOeffnen('${f['archiv']}')),
          ],
          abschnitt('Vorgänge${vorgaenge.isEmpty ? '' : ' (${vorgaenge.length})'}'),
          if (vorgaenge.isEmpty) Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: Text('Keine offenen Vorgänge.', style: theme.textTheme.bodySmall?.copyWith(color: dim))),
          for (final v in vorgaenge.take(8)) ListTile(dense: true, leading: const Icon(Icons.assignment_outlined, size: 18), title: Text('${v['titel'] ?? ''}', maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall), subtitle: Text('${v['status'] ?? ''}${v['naechsterSchritt'] != null ? ' · ${v['naechsterSchritt']}' : ''}', maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.labelSmall?.copyWith(color: dim)), onTap: () => _vorgangOeffnen(v)), // 1.9.0 A4 — Details und Entscheidung statt nur Nachfrage
          if (letzte.isNotEmpty) abschnitt('Letzte'),
          for (final e in letzte) ListTile(dense: true, leading: const Icon(Icons.history, size: 18), title: Text(e.text.split('\n').first, maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall), onTap: () { eingabe.text = e.text; fokus.requestFocus(); _neu(() => ansicht = Ansicht.chat); }),
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
        Text('Chat · $geraet', style: theme.textTheme.titleSmall),
        const Spacer(),
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
      Expanded(child: verlauf.isEmpty
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
      ),
      if (offen.isNotEmpty) Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 920), child: _bestaetigungen(theme))),
      if (fremdeArbeit.isNotEmpty) Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 920), child: _arbeitsLeiste(theme))), // 1.11.0
      Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 920), child: _eingabekarte(theme))),
    ]));
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
          Text('Alfred arbeitet · aus ${a.kanal}${a.faden != server?.faden ? ' · ${_gespraechName(a.faden)}' : ''}', style: theme.textTheme.labelMedium),
          Text(a.status?.isNotEmpty == true ? a.status! : (a.frage.length > 90 ? '${a.frage.substring(0, 90)}…' : a.frage), maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall?.copyWith(color: dim)),
        ])),
        if (a.faden != server?.faden) TextButton(onPressed: () => _fadenWechseln(a.faden), child: const Text('Öffnen')),
        IconButton(tooltip: 'Anfrage abbrechen', onPressed: () => _fremdeArbeitStoppen(a), icon: const Icon(Icons.stop_circle_outlined)),
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
