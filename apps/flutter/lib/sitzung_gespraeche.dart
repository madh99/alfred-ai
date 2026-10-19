part of 'main.dart';

/// C1 (11.10.) — aus main.dart ausgelagert, Verhalten unverändert: Gesprächsfäden, Archiv, Spiegelung, Zähler der Seitenleiste.
extension _Gespraeche on _SitzungState {
  /// 1.17.2 — Titel über dem Chat: Hauptgespräch, Name des Fadens oder „Neues Gespräch“ (noch ohne Eintrag in der Liste).
  String _kopfTitel() {
    if (archiv != null) { final a = faeden.where((x) => x['archiv'] == archiv).toList(); return 'Archiv: ${a.isEmpty ? 'frühere Sitzung' : a.first['titel'] ?? 'frühere Sitzung'}'; }
    final faden = server?.faden;
    if (faden == null) return 'Hauptgespräch';
    final f = faeden.where((x) => x['faden'] == faden).toList();
    final t = f.isEmpty ? '' : '${f.first['titel'] ?? ''}'.trim();
    return t.isEmpty ? 'Neues Gespräch' : t;
  }

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
      final p = ((j['projekte'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>(); // 1.42.0 D1
      if (mounted) _neu(() { faeden = l; projekteKurz = p; });
    } catch (_) { /* Seitenleiste ist Komfort */ }
  }


  /// Zu einem Gespräch wechseln (null = Hauptgespräch): Verlauf vom Server, Eingabe bleibt.
  Future<void> _fadenWechseln(String? faden) async {
    final s = server; if (s == null) return;
    if (antwortet) { _zeile(Eintrag(Art.hinweis, 'Bitte warten, bis die Antwort fertig ist.')); return; }
    s.faden = faden;
    _neu(() { verlauf.clear(); laufend = null; ansicht = Ansicht.chat; archiv = null; fundstelle = null; mehrAeltere = false; });
    await _holeVerlauf();
    if (!warteschlange.leer) Future.microtask(_nachsenden); // 1.8.0
    if (verlauf.isEmpty && faden != null) _zeile(Eintrag(Art.hinweis, 'Neues Gespräch — was möchtest du besprechen?'));
    if (faden != null && faeden.any((x) => x['faden'] == faden && x['archiviert'] == true)) _zeile(Eintrag(Art.hinweis, 'Archiviertes Gespräch — wenn du hier schreibst, kommt es zurück in die Liste.')); // 1.41.0
    fokus.requestFocus();
  }


  void _neuerChat() {
    final id = DateTime.now().millisecondsSinceEpoch.toRadixString(36);
    _fadenWechseln(id);
  }


  /// 1.2.1 — Gespräch wurde auf einem anderen Kanal fortgeführt: Verlauf vom Server neu laden, lokale Hinweise behalten.
  Future<void> _gespraechNachladen() async {
    if (antwortet || fundstelle != null) return; // 1.5.0 — Fundstelle bleibt stehen, bis sie verlassen wird
    final hinweise = verlauf.where((e) => e.art != Art.du && e.art != Art.alfred && !e.text.startsWith('Verlauf geladen:')).toList(); // 1.52.0 — Hinweis kommt neu
    _neu(() { verlauf.clear(); laufend = null; });
    await _holeVerlauf();
    if (hinweise.isNotEmpty) _neu(() { verlauf.addAll(hinweise); verlauf.sort((a, b) => a.zeit.compareTo(b.zeit)); });
    _nachUnten();
    _faedenLaden();
  }


  Future<void> _spiegelungLaden() async {
    final s = server; if (s == null) return;
    try { final j = await s.json('/api/geraete/spiegelung'); if (mounted) _neu(() => spiegelung = j['an'] == true); } catch (_) { /* kein Owner-Gerät oder alter Server */ }
  }


  Future<void> _spiegelungSetzen(bool an) async {
    final s = server; if (s == null) return;
    try { final j = await s.json('/api/geraete/spiegelung', methode: 'POST', koerper: {'an': an}); _neu(() => spiegelung = j['an'] == true); _zeile(Eintrag(Art.hinweis, 'Spiegelung nach Telegram: ${j['an'] == true ? 'an' : 'aus'}')); }
    catch (e) { _zeile(Eintrag(Art.fehler, 'Spiegelung nicht umgeschaltet: $e')); }
  }


  Future<void> _archivOeffnen(String chatId) async {
    final s = server; if (s == null) return;
    _neu(() { verlauf.clear(); laufend = null; ansicht = Ansicht.chat; archiv = chatId; fundstelle = null; mehrAeltere = false; });
    try {
      final j = await s.json('/api/geraete/verlauf?limit=100&archiv=${Uri.encodeQueryComponent(chatId)}');
      final n = (j['nachrichten'] as List<dynamic>? ?? []).cast<Map<String, dynamic>>();
      _neu(() { verlauf.addAll(n.map((m) => _mitAnhaengen(Eintrag(m['rolle'] == 'user' ? Art.du : Art.alfred, '${m['text']}', zeit: DateTime.tryParse('${m['zeit']}')?.toLocal()), m))); });
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


  /// 1.41.0 — Löschen mit Rückgängig (Owner-Entscheidung 18.10.): sofort ausblenden, erst nach 8 s wirklich löschen.
  Future<void> _fadenLoeschen(String faden, String titel) async {
    final s = server; if (s == null) return;
    loeschenAusstehend.remove(faden)?.cancel();
    if (s.faden == faden) await _fadenWechseln(null);
    _neu(() => loeschenAusstehend[faden] = Timer(const Duration(seconds: 8), () => _fadenEndgueltigLoeschen(faden)));
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(
      content: Text('Gelöscht: $titel'),
      action: SnackBarAction(label: 'Rückgängig', onPressed: () { loeschenAusstehend.remove(faden)?.cancel(); _neu(() {}); }),
      persist: false, // wie 1.12.1: Meldung mit Knopf verschwindet von selbst
      duration: const Duration(seconds: 8),
    ));
  }

  Future<void> _fadenEndgueltigLoeschen(String faden) async {
    final s = server; if (s == null) return;
    try {
      await s.json('/api/geraete/faeden/$faden', methode: 'DELETE');
      await _faedenLaden();
    } catch (e) { _zeile(Eintrag(Art.fehler, 'Gespräch nicht gelöscht: $e')); }
    if (mounted) _neu(() => loeschenAusstehend.remove(faden));
  }

  /// 1.41.0 — anheften/lösen, archivieren/zurückholen. Archivieren des offenen Fadens führt ins Hauptgespräch.
  Future<void> _fadenSetzen(String faden, Map<String, dynamic> aenderung) async {
    final s = server; if (s == null) return;
    try {
      await s.json('/api/geraete/faeden/$faden', methode: 'PATCH', koerper: aenderung);
      if (aenderung['archiviert'] == true && s.faden == faden) await _fadenWechseln(null);
      await _faedenLaden();
    } catch (e) { _zeile(Eintrag(Art.fehler, 'Gespräch nicht geändert: $e')); }
  }

  /// 1.45.0 D4 — Sprungziel eines Verlaufseintrags.
  GlobalKey _ankerVon(Eintrag e) => _anker[e] ??= GlobalKey();

  /// 1.45.0 D4 — Lesezeichen des offenen Fadens laden (nach jedem Laden des Verlaufs).
  Future<void> _lesezeichenLaden() async {
    final s = server; if (s == null) return;
    try {
      final j = await s.json('/api/geraete/faeden/${s.faden ?? 'haupt'}/lesezeichen');
      final l = ((j['lesezeichen'] as List<dynamic>?) ?? []).whereType<Map<String, dynamic>>().map((x) => '${x['schluessel']}').toSet();
      if (mounted) _neu(() => lesezeichen = l);
    } catch (_) { /* Komfort */ }
    _bewertungenLaden(); // 1.50.0 D6a — gleiche Gelegenheiten wie die Lesezeichen
  }

  /// 1.50.0 D6a — Bewertungen des offenen Fadens.
  Future<void> _bewertungenLaden() async {
    final s = server; if (s == null) return;
    try {
      final j = await s.json('/api/geraete/faeden/${s.faden ?? 'haupt'}/bewertung');
      final b = {for (final x in ((j['bewertungen'] as List<dynamic>?) ?? []).whereType<Map<String, dynamic>>()) '${x['schluessel']}': (x['wert'] as num?)?.toInt() ?? 0};
      if (mounted) _neu(() => bewertungen = b);
    } catch (_) { /* Komfort */ }
  }

  /// 1.50.0 D6a — 👍/👎 setzen oder (erneut tippen) zurücknehmen; 👎 fragt nach dem Grund (optional). Mit Grund wird es
  /// eine Korrektur, die Alfred künftig beachtet.
  Future<void> _bewerten(Eintrag e, int wert) async {
    final s = server; if (s == null) return;
    final k = lesezeichenSchluessel(e.text);
    final vorher = bewertungen[k] ?? 0;
    final neu = vorher == wert ? 0 : wert;
    String? grund;
    if (neu == -1) {
      grund = await _grundFragen();
      if (grund == null) return; // abgebrochen
    }
    _neu(() => neu == 0 ? bewertungen.remove(k) : bewertungen[k] = neu);
    try {
      final i = verlauf.indexOf(e);
      final r = await s.json('/api/geraete/faeden/${s.faden ?? 'haupt'}/bewertung', methode: 'POST', koerper: {
        'schluessel': k, 'wert': neu,
        if (grund != null && grund.isNotEmpty) 'grund': grund,
        if (neu != 0) 'frage': i < 0 ? '' : frageVor(verlauf, i),
        if (neu != 0) 'antwort': e.text.length > 1200 ? e.text.substring(0, 1200) : e.text,
      });
      if (r['korrektur'] == 'gespeichert' || r['korrektur'] == 'aufgefrischt') {
        _neu(() => fluechtig = '👎 gespeichert — Alfred beachtet die Korrektur künftig');
      } else if (neu != 0) {
        _neu(() => fluechtig = neu == 1 ? '👍 gespeichert' : '👎 gespeichert');
      }
    } catch (err) {
      _neu(() => vorher == 0 ? bewertungen.remove(k) : bewertungen[k] = vorher);
      _zeile(Eintrag(Art.fehler, 'Bewertung nicht gespeichert: $err'));
    }
  }

  /// Grund für ein 👎 (leer erlaubt). null = abgebrochen.
  Future<String?> _grundFragen() {
    final c = TextEditingController();
    return showDialog<String>(context: context, builder: (ctx) => AlertDialog(
      title: const Text('Was war nicht gut?'),
      content: SizedBox(width: 440, child: TextField(key: const Key('bewertung-grund'), controller: c, autofocus: true, maxLines: 4, minLines: 2,
        decoration: const InputDecoration(hintText: 'z. B. „Die Summe gilt nur bis August.“ (optional — mit Grund merkt sich Alfred die Korrektur)'))),
      actions: [
        TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('Abbrechen')),
        FilledButton(key: const Key('bewertung-senden'), onPressed: () => Navigator.of(ctx).pop(c.text.trim()), child: const Text('👎 senden')),
      ],
    ));
  }

  /// 1.50.0 D6a — Antwort (Klartext) ins Gedächtnis.
  Future<void> _merken(Eintrag e) async {
    final s = server; if (s == null) return;
    final t = ohneMarkdown(e.text);
    try {
      await s.json('/api/geraete/gedaechtnis', methode: 'POST', koerper: {'text': t.length > 4000 ? t.substring(0, 4000) : t});
      _neu(() => fluechtig = 'im Gedächtnis gespeichert');
    } catch (err) { _zeile(Eintrag(Art.fehler, 'Nicht gemerkt: $err')); }
  }

  /// 1.50.0 D6b — Stufen (Modell, Gründlichkeit) und Modell der letzten Antwort.
  Future<void> _stufenLaden() async {
    final s = server; if (s == null) return;
    try {
      final j = await s.json('/api/geraete/stufen${s.faden == null ? '' : '?faden=${s.faden}'}');
      if (mounted) _neu(() => stufenStand = StufenStand.aus(j));
    } catch (_) { /* Komfort: ohne Server-Unterstützung bleibt die Wahl wie bisher */ }
  }

  Future<void> _lesezeichenUmschalten(Eintrag e) async {
    final s = server; if (s == null) return;
    final k = lesezeichenSchluessel(e.text);
    final an = !lesezeichen.contains(k);
    _neu(() => an ? lesezeichen.add(k) : lesezeichen.remove(k));
    try { await s.json('/api/geraete/faeden/${s.faden ?? 'haupt'}/lesezeichen', methode: 'POST', koerper: {'schluessel': k, 'text': e.text.length > 200 ? e.text.substring(0, 200) : e.text, 'an': an}); }
    catch (err) { _neu(() => an ? lesezeichen.remove(k) : lesezeichen.add(k)); _zeile(Eintrag(Art.fehler, 'Lesezeichen nicht gespeichert: $err')); }
  }

  /// 1.45.0 D4 — zur Nachricht [i] springen (1.45.2: über springeZu, mit einer echten umgekehrten Liste getestet).
  Future<void> _zuNachricht(int i) async {
    if (i < 0 || i >= verlauf.length) return;
    final ok = await springeZu(scroll, _ankerVon(verlauf[i]), (verlauf.length - 1 - i) / verlauf.length);
    if (ok) _neu(() => leisteAktuell = i);
  }

  /// 1.45.2 — nach dem Scrollen (einmal je Bild): welche eigene Frage steht gerade oben im sichtbaren Bereich?
  void _leisteNachScroll() {
    if (_leisteGeplant) return;
    _leisteGeplant = true;
    WidgetsBinding.instance.addPostFrameCallback((_) { _leisteGeplant = false; _leisteAktuellBerechnen(); });
  }

  void _leisteAktuellBerechnen() {
    if (!mounted || !scroll.hasClients) return;
    final vp = scroll.position.context.storageContext.findRenderObject();
    if (vp is! RenderBox || !vp.hasSize) return;
    int? oben; double obenY = double.negativeInfinity;
    int? sichtbar; double sichtbarY = double.infinity;
    for (final e in leistenEintraege(verlauf)) {
      final ro = _anker[verlauf[e.index]]?.currentContext?.findRenderObject();
      if (ro is! RenderBox || !ro.attached || !ro.hasSize) continue;
      final y = ro.localToGlobal(Offset.zero, ancestor: vp).dy;
      if (y + ro.size.height < 0 || y > vp.size.height) continue; // außerhalb des sichtbaren Bereichs
      if (y <= vp.size.height * 0.35 && y > obenY) { oben = e.index; obenY = y; }
      if (y < sichtbarY) { sichtbar = e.index; sichtbarY = y; }
    }
    final neu = oben ?? sichtbar;
    if (neu != null && neu != leisteAktuell) _neu(() => leisteAktuell = neu);
  }

  /// 1.43.0 D2 — Eintrag des offenen Fadens aus der Liste (null im Hauptgespräch).
  Map<String, dynamic>? _offenerFaden() {
    final f = server?.faden;
    if (f == null) return null;
    return faeden.where((x) => x['faden'] == f).firstOrNull ?? {'faden': f, 'titel': ''};
  }

  /// 1.43.0 D2 — Tastenkürzel (globaler Handler; nur, wenn kein Dialog offen ist). true = verbraucht.
  bool _kuerzel(LogicalKeyboardKey k) {
    final hw = HardwareKeyboard.instance;
    final strg = hw.isControlPressed || hw.isMetaPressed;
    if (!strg || !mounted || ModalRoute.of(context)?.isCurrent == false) return false;
    final alt = hw.isAltPressed, umschalt = hw.isShiftPressed;
    final f = _offenerFaden();
    if (!alt && !umschalt && k == LogicalKeyboardKey.keyN) { _neu(() => ansicht = Ansicht.chat); _neuerChat(); return true; }
    if (!alt && !umschalt && k == LogicalKeyboardKey.keyB) { _neu(() => seitenleisteOffen = !seitenleisteOffen); seitenleisteSpeichern(seitenleisteOffen); return true; }
    if (!alt && !umschalt && k == LogicalKeyboardKey.comma) { _neu(() => ansicht = Ansicht.einstellungen); return true; }
    if (alt && !umschalt && k == LogicalKeyboardKey.keyS) { _seitenChatUmschalten(); return true; }
    if (alt && !umschalt && k == LogicalKeyboardKey.keyR && f != null) { _fadenUmbenennen('${f['faden']}', '${f['titel'] ?? ''}'); return true; }
    if (alt && !umschalt && k == LogicalKeyboardKey.keyP && f != null) { _fadenSetzen('${f['faden']}', {'angeheftet': f['angeheftet'] != true}); return true; }
    if (!alt && umschalt && k == LogicalKeyboardKey.keyA && f != null) { _fadenSetzen('${f['faden']}', {'archiviert': f['archiviert'] != true}); return true; }
    return false;
  }

  /// 1.43.0 D2 — Abzweigen: neuer Faden mit dem Verlauf bis [bis] (ohne: alles), danach dorthin wechseln.
  Future<void> _fadenAbzweigen(String? faden, {DateTime? bis}) async {
    final s = server; if (s == null) return;
    try {
      final r = await s.json('/api/geraete/faeden/${faden ?? 'haupt'}/abzweigen', methode: 'POST', koerper: {if (bis != null) 'bis': bis.toUtc().toIso8601String()});
      await _faedenLaden();
      await _fadenWechseln('${r['faden']}');
      _zeile(Eintrag(Art.hinweis, 'Abgezweigt: ${r['kopiert']} Nachrichten übernommen — hier geht es getrennt weiter.'));
    } catch (e) { _zeile(Eintrag(Art.fehler, 'Nicht abgezweigt: $e')); }
  }

  /// 1.43.0 D2 — ganzer Faden als Markdown (Kopieren, Exportieren).
  Future<(String, String)?> _fadenMarkdown(String? faden) async {
    final s = server; if (s == null) return null;
    final j = await s.json('/api/geraete/verlauf?limit=200${faden == null ? '' : '&faden=${Uri.encodeQueryComponent(faden)}'}');
    final titel = _fadenTitel(faden);
    return (titel, fadenAlsMarkdown(titel, (j['nachrichten'] as List<dynamic>? ?? []).cast<Map<String, dynamic>>()));
  }

  Future<void> _fadenKopieren(String? faden) async {
    try { final m = await _fadenMarkdown(faden); if (m == null) return; await Clipboard.setData(ClipboardData(text: m.$2)); _neu(() => fluechtig = 'Gespräch als Markdown kopiert'); }
    catch (e) { _zeile(Eintrag(Art.fehler, 'Nicht kopiert: $e')); }
  }

  void _letzteAntwortKopieren() {
    final a = verlauf.lastWhere((e) => e.art == Art.alfred && e.text.trim().isNotEmpty, orElse: () => Eintrag(Art.hinweis, ''));
    if (a.text.isEmpty) { _zeile(Eintrag(Art.hinweis, 'Noch keine Antwort in diesem Gespräch.')); return; }
    Clipboard.setData(ClipboardData(text: a.text)); _neu(() => fluechtig = 'letzte Antwort kopiert');
  }

  Future<void> _fadenExportieren(String? faden) async {
    try {
      final m = await _fadenMarkdown(faden); if (m == null) return;
      final dir = await getDownloadsDirectory() ?? await getApplicationDocumentsDirectory();
      final datei = File('${dir.path}${Platform.pathSeparator}${exportDateiname(m.$1, DateTime.now())}');
      await datei.writeAsString(m.$2);
      _zeile(Eintrag(Art.hinweis, '💾 exportiert: ${datei.path}'));
    } catch (e) { _zeile(Eintrag(Art.fehler, 'Nicht exportiert: $e')); }
  }

  void _fadenImBrowser(String? faden) {
    final k = konfig; if (k == null) return;
    oeffneLink('${k.server}/alfred/chat/${faden == null ? '' : '?faden=${Uri.encodeQueryComponent(faden)}'}');
  }

  /// 1.43.0 D2 — Seiten-Chat zum offenen Faden ein/aus; beim ersten Öffnen eigener Faden „Neben: <Titel>“ (gleiches Projekt).
  Future<void> _seitenChatUmschalten() async {
    if (seitenChatOffen) { _neu(() => seitenChatOffen = false); return; }
    final s = server; if (s == null) return;
    final schluessel = s.faden ?? 'haupt';
    if (seitenChats[schluessel] == null) {
      final id = DateTime.now().millisecondsSinceEpoch.toRadixString(36);
      final titel = 'Neben: ${_fadenTitel(s.faden).replaceAll(RegExp(r'^🔨\s*'), '')}';
      try {
        await s.json('/api/geraete/faeden/$id', methode: 'PATCH', koerper: {'titel': titel.length > 80 ? titel.substring(0, 80) : titel});
        final projekt = _offenerFaden()?['projekt'];
        if (projekt is Map && projekt['id'] != null) await s.json('/api/geraete/faeden/$id', methode: 'PATCH', koerper: {'projekt': '${projekt['id']}'});
      } catch (_) { /* Titel ist Komfort; der Faden entsteht spätestens mit der ersten Frage */ }
      seitenChats[schluessel] = (id, titel);
      _faedenLaden();
    }
    _neu(() { seitenChatOffen = true; ansicht = Ansicht.chat; });
  }

  /// 1.43.0 D2 — geplante Aufgabe aus dem Faden; das Ergebnis jedes Laufs kommt in diesen Faden.
  Future<void> _aufgabeAusFaden(String? faden) async {
    final s = server; if (s == null) return;
    final letzte = verlauf.lastWhere((e) => e.art == Art.du && e.text.trim().isNotEmpty, orElse: () => Eintrag(Art.du, '')).text;
    final name = TextEditingController(text: _fadenTitel(faden).replaceAll(RegExp(r'^🔨\s*'), ''));
    final auftrag = TextEditingController(text: letzte);
    final uhrzeit = TextEditingController(text: '08:00');
    var rhythmus = 'taeglich'; var tag = DateTime.monday; DateTime? datum;
    final ok = await showDialog<bool>(context: context, builder: (ctx) => StatefulBuilder(builder: (ctx, setD) => AlertDialog(
      title: const Text('Geplante Aufgabe hinzufügen'),
      content: SizedBox(width: 460, child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        TextField(controller: name, decoration: const InputDecoration(labelText: 'Name')),
        const SizedBox(height: 8),
        TextField(controller: auftrag, minLines: 2, maxLines: 6, decoration: const InputDecoration(labelText: 'Was Alfred jedes Mal tun soll')),
        const SizedBox(height: 12),
        Row(children: [
          DropdownButton<String>(value: rhythmus, items: const [DropdownMenuItem(value: 'taeglich', child: Text('täglich')), DropdownMenuItem(value: 'woechentlich', child: Text('wöchentlich')), DropdownMenuItem(value: 'einmalig', child: Text('einmalig'))], onChanged: (v) => setD(() => rhythmus = v ?? rhythmus)),
          const SizedBox(width: 12),
          if (rhythmus == 'woechentlich') DropdownButton<int>(value: tag, items: [for (var i = 1; i <= 7; i++) DropdownMenuItem(value: i, child: Text(const ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'][i - 1]))], onChanged: (v) => setD(() => tag = v ?? tag)),
          if (rhythmus == 'einmalig') TextButton(onPressed: () async { final d = await showDatePicker(context: ctx, firstDate: DateTime.now(), lastDate: DateTime.now().add(const Duration(days: 365)), initialDate: datum ?? DateTime.now()); if (d != null) setD(() => datum = d); }, child: Text(datum == null ? 'Datum wählen' : '${datum!.day}.${datum!.month}.${datum!.year}')),
          const SizedBox(width: 12),
          SizedBox(width: 80, child: TextField(controller: uhrzeit, decoration: const InputDecoration(labelText: 'Uhrzeit'))),
        ]),
        const SizedBox(height: 8),
        Text('Das Ergebnis jedes Laufs kommt in dieses Gespräch.', style: Theme.of(ctx).textTheme.bodySmall),
      ])),
      actions: [TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Abbrechen')), FilledButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('Planen'))],
    )));
    if (ok != true) return;
    final plan = zeitplanAus(rhythmus: rhythmus, uhrzeit: uhrzeit.text, wochentag: tag, datum: datum);
    if (plan == null || name.text.trim().isEmpty || auftrag.text.trim().isEmpty) { _zeile(Eintrag(Art.fehler, 'Nicht geplant: Name, Auftrag, Uhrzeit (HH:MM) und bei „einmalig“ ein Datum angeben.')); return; }
    try {
      final r = await s.json('/api/geraete/faeden/${faden ?? 'haupt'}/aufgabe', methode: 'POST', koerper: {'name': name.text.trim(), 'auftrag': auftrag.text.trim(), 'art': plan.art, 'wert': plan.wert});
      _zeile(Eintrag(r['ok'] == true ? Art.hinweis : Art.fehler, '⏰ ${r['text'] ?? ''}'));
    } catch (e) { _zeile(Eintrag(Art.fehler, 'Nicht geplant: $e')); }
  }

  /// 1.43.0 D2 — Menü „…“ der Kopfzeile: alle Aktionen zum offenen Gespräch.
  Widget _kopfMenue() {
    final f = _offenerFaden();
    final id = f == null ? null : '${f['faden']}';
    final angeheftet = f?['angeheftet'] == true, archiviert = f?['archiviert'] == true;
    PopupMenuItem<String> e(String w, IconData i, String t, [String? k]) => PopupMenuItem(value: w, child: ListTile(dense: true, leading: Icon(i, size: 18), title: Text(t), trailing: k == null ? null : Text(k, style: const TextStyle(fontSize: 11))));
    return PopupMenuButton<String>(
      key: const Key('kopf-menue'), tooltip: 'Mehr zu diesem Gespräch', icon: const Icon(Icons.more_horiz, size: 20),
      onSelected: (w) {
        switch (w) {
          case 'umbenennen': _fadenUmbenennen(id!, '${f!['titel'] ?? ''}');
          case 'anheften': _fadenSetzen(id!, {'angeheftet': !angeheftet});
          case 'seiten': _seitenChatUmschalten();
          case 'abzweigen': _fadenAbzweigen(id);
          case 'aufgabe': _aufgabeAusFaden(id);
          case 'kopieren': _fadenKopieren(id);
          case 'letzte': _letzteAntwortKopieren();
          case 'export': _fadenExportieren(id);
          case 'browser': _fadenImBrowser(id);
          case 'projekt': _fadenProjektWaehlen(id!);
          case 'projekt_loesen': _fadenSetzen(id!, {'projekt': null});
          case 'archiv': _fadenSetzen(id!, {'archiviert': !archiviert});
          case 'loeschen': _fadenLoeschen(id!, fadenTitelText(f!));
        }
      },
      itemBuilder: (_) => [
        if (f != null) e('umbenennen', Icons.edit_outlined, 'Umbenennen', 'Strg+Alt+R'),
        if (f != null && !archiviert) e('anheften', angeheftet ? Icons.push_pin : Icons.push_pin_outlined, angeheftet ? 'Lösen' : 'Anheften', 'Strg+Alt+P'),
        e('seiten', Icons.vertical_split_outlined, seitenChatOffen ? 'Seiten-Chat schließen' : 'Neuer Seiten-Chat', 'Strg+Alt+S'),
        e('abzweigen', Icons.call_split, 'Abzweigen'),
        e('aufgabe', Icons.schedule, 'Geplante Aufgabe hinzufügen …'),
        const PopupMenuDivider(),
        e('kopieren', Icons.copy_all_outlined, 'Gespräch kopieren (Markdown)'),
        e('letzte', Icons.content_copy, 'Letzte Antwort kopieren'),
        e('export', Icons.download_outlined, 'Exportieren (.md)'),
        e('browser', Icons.open_in_browser, 'Im Browser öffnen'),
        if (f != null && !archiviert && !istProjektFaden(f)) ...[
          const PopupMenuDivider(),
          fadenProjektId(f) == null ? e('projekt', Icons.drive_file_move_outlined, 'Einem Projekt zuordnen …') : e('projekt_loesen', Icons.drive_file_move_rtl_outlined, 'Aus Projekt lösen'),
        ],
        if (f != null) ...[
          const PopupMenuDivider(),
          e('archiv', archiviert ? Icons.unarchive_outlined : Icons.archive_outlined, archiviert ? 'Zurückholen' : 'Archivieren', 'Strg+Umschalt+A'),
          e('loeschen', Icons.delete_outline, 'Löschen'),
        ],
      ],
    );
  }

  /// 1.42.0 D1 — Faden einem Projekt zuordnen (Auswahl der aktiven Projekte) oder lösen.
  Future<void> _fadenProjektWaehlen(String faden) async {
    if (projekteKurz.isEmpty) { _zeile(Eintrag(Art.hinweis, 'Es gibt noch kein aktives Projekt.')); return; }
    final id = await showDialog<String>(context: context, builder: (ctx) => SimpleDialog(
      title: const Text('Einem Projekt zuordnen'),
      children: [for (final p in projekteKurz) SimpleDialogOption(onPressed: () => Navigator.of(ctx).pop('${p['id']}'), child: Row(children: [const Icon(Icons.folder_outlined, size: 18), const SizedBox(width: 10), Expanded(child: Text('${p['name']}'))]))],
    ));
    if (id != null) await _fadenSetzen(faden, {'projekt': id});
  }

  /// 1.41.0 — Menü je Faden: Anheften, Umbenennen, Archivieren, Löschen.
  Widget _fadenMenue(Map<String, dynamic> f) {
    final id = '${f['faden']}'; final titel = fadenTitelText(f);
    final archiviert = f['archiviert'] == true; final angeheftet = f['angeheftet'] == true;
    return PopupMenuButton<String>(
      tooltip: 'Mehr', iconSize: 18, padding: EdgeInsets.zero,
      onSelected: (w) {
        switch (w) {
          case 'anheften': _fadenSetzen(id, {'angeheftet': !angeheftet});
          case 'umbenennen': _fadenUmbenennen(id, '${f['titel'] ?? ''}');
          case 'archiv': _fadenSetzen(id, {'archiviert': !archiviert});
          case 'projekt': _fadenProjektWaehlen(id); // 1.42.0 D1
          case 'abzweigen': _fadenAbzweigen(id); // 1.43.0 D2
          case 'export': _fadenExportieren(id);
          case 'projekt_loesen': _fadenSetzen(id, {'projekt': null});
          case 'loeschen': _fadenLoeschen(id, titel);
        }
      },
      itemBuilder: (_) => [
        if (!archiviert) PopupMenuItem(value: 'anheften', child: ListTile(dense: true, leading: Icon(angeheftet ? Icons.push_pin : Icons.push_pin_outlined, size: 18), title: Text(angeheftet ? 'Lösen' : 'Anheften'))),
        const PopupMenuItem(value: 'umbenennen', child: ListTile(dense: true, leading: Icon(Icons.edit_outlined, size: 18), title: Text('Umbenennen'))),
        const PopupMenuItem(value: 'abzweigen', child: ListTile(dense: true, leading: Icon(Icons.call_split, size: 18), title: Text('Abzweigen'))), // 1.43.0 D2
        const PopupMenuItem(value: 'export', child: ListTile(dense: true, leading: Icon(Icons.download_outlined, size: 18), title: Text('Exportieren (.md)'))),
        if (!archiviert && !istProjektFaden(f)) fadenProjektId(f) == null
            ? const PopupMenuItem(value: 'projekt', child: ListTile(dense: true, leading: Icon(Icons.drive_file_move_outlined, size: 18), title: Text('Einem Projekt zuordnen …')))
            : const PopupMenuItem(value: 'projekt_loesen', child: ListTile(dense: true, leading: Icon(Icons.drive_file_move_rtl_outlined, size: 18), title: Text('Aus Projekt lösen'))),
        PopupMenuItem(value: 'archiv', child: ListTile(dense: true, leading: Icon(archiviert ? Icons.unarchive_outlined : Icons.archive_outlined, size: 18), title: Text(archiviert ? 'Zurückholen' : 'Archivieren'))),
        const PopupMenuItem(value: 'loeschen', child: ListTile(dense: true, leading: Icon(Icons.delete_outline, size: 18), title: Text('Löschen'))),
      ],
    );
  }


  /// 1.5.1 — Zähler offener Hinweise ohne geöffnete Ansicht (Owner 11.10.); kein Owner-Gerät/alter Server → bleibt still.
  Future<void> _hinweiseZaehlen() async {
    final s = server; if (s == null) return;
    try {
      final n = offeneHinweise(await s.json('/api/geraete/hinweise'));
      if (mounted && n != hinweiseOffen) _neu(() => hinweiseOffen = n);
    } catch (_) { /* Zähler ist Komfort */ }
  }


  Future<void> _vorgaengeLaden() async {
    final s = server; if (s == null) return;
    try {
      final v = await s.json('/api/vorgaenge?limit=12');
      final offene = ((v['offene'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>();
      if (mounted) _neu(() { vorgaenge = offene; vorgangSchritte = v['schritte'] as List<dynamic>?; });
    } catch (_) { /* Seitenleiste ist Komfort */ }
  }

  // ── 1.9.0 A1/A4 — Aufgaben-Zähler, fällige Erinnerungen, Vorgangs-Dialog ─────────────────────────────────────────
  Future<void> _aufgabenZaehlen() async {
    final s = server; if (s == null) return;
    try {
      final j = await s.json('/api/geraete/aufgaben');
      _aufgabenStand(((j['aufgaben'] as List<dynamic>?) ?? []).whereType<Map<String, dynamic>>().map(Aufgabe.new).toList(),
          ((j['erinnerungen'] as List<dynamic>?) ?? []).whereType<Map<String, dynamic>>().map(Erinnerung.new).toList());
    } catch (_) { /* Zähler ist Komfort; kein Owner-Gerät → 403 */ }
  }

  void _aufgabenStand(List<Aufgabe> aufgaben, List<Erinnerung> erinnerungen) {
    final jetzt = DateTime.now();
    erinnerungenAbgleichen(erinnerungBekannt, erinnerungen, jetzt);
    final n = aufgabenFaellig(aufgaben, jetzt);
    if (mounted && n != aufgabenFaelligZahl) _neu(() => aufgabenFaelligZahl = n);
    _erinnerungenPruefen();
  }

  /// Fällige Erinnerung als Systembenachrichtigung (auch bei sichtbarem Fenster — sie ist zeitkritisch) und Zeile im Chat.
  Future<void> _erinnerungenPruefen() async {
    final jetzt = DateTime.now();
    for (final e in faelligeErinnerungen(erinnerungBekannt.values.toList(), jetzt, erinnerungGemeldet)) {
      erinnerungGemeldet.add(e.id);
      erinnerungTexte[e.text] = jetzt;
      _zeile(Eintrag(Art.hinweis, '⏰ Erinnerung: ${e.text}'));
      try {
        final n = LocalNotification(title: 'Alfred — Erinnerung', body: e.text.length > 180 ? '${e.text.substring(0, 180)}…' : e.text);
        n.onClick = () { _zeigen(); _neu(() => ansicht = Ansicht.aufgaben); };
        await n.show();
      } catch (_) {}
    }
  }

  /// Der Server schickt Erinnerungen auch an verknüpfte Kanäle („⏰ Reminder: …"). Hat die App sie eben selbst gemeldet,
  /// bleibt es bei der Zeile im Chat — keine zweite Systembenachrichtigung.
  bool _erinnerungSchonGemeldet(String text) {
    const vorsatz = '⏰ Reminder: ';
    if (!text.startsWith(vorsatz)) return false;
    erinnerungTexte.removeWhere((_, t) => DateTime.now().difference(t) > const Duration(minutes: 10));
    return erinnerungTexte.containsKey(text.substring(vorsatz.length).trim());
  }

  // ── 1.11.0 — Alfred arbeitet an einer Anfrage aus einem anderen Kanal (v1354) ─────────────────────────────────────
  void _fremdeArbeit(String json, String? faden) {
    final k = konfig; if (k == null) return;
    final r = fremdeArbeitAnwenden(fremdeArbeit, json, faden, k.geraetId, DateTime.now());
    if (r == null) return;
    final (phase, a) = r;
    if (phase == 'start') {
      // Frage sofort im offenen Gespräch zeigen; die fertige Antwort lädt das Gespräch ohnehin neu (Ereignis „gespraech")
      // 1.17.3 — ein Projektlauf ist keine Frage des Owners: nicht als eigene Nachricht einfügen
      if (a.projekt == null && a.faden == server?.faden && archiv == null && fundstelle == null && a.frage.trim().isNotEmpty) _zeile(Eintrag(Art.du, a.frage));
      _protokolliere(Eintrag(Art.hinweis, a.projekt != null ? '🔨 ${a.frage}' : 'Alfred arbeitet an einer Anfrage aus ${a.kanal}${a.faden != server?.faden ? ' (${_gespraechName(a.faden)})' : ''}'));
    }
    _neu(() {});
  }

  /// „Gespräch „Strompreise““ bzw. „Hauptgespräch" — ohne doppeltes „Gespräch" bei Fäden ohne eigenen Titel.
  String _gespraechName(String? faden) { final t = _fadenTitel(faden); return t.startsWith('Gespräch') || t.startsWith('Hauptgespräch') ? t : 'Gespräch „$t“'; }

  void _fremdeArbeitAufraeumen() { if (fremdeArbeitAufraeumen(fremdeArbeit, DateTime.now())) _neu(() {}); }

  Future<void> _fremdeArbeitStoppen(FremdeArbeit a) async {
    final s = server; if (s == null) return;
    try {
      final r = await s.json('/api/geraete/abbrechen', methode: 'POST', koerper: {'arbeit': a.id});
      _zeile(Eintrag(Art.hinweis, r['abgebrochen'] == true ? '⏹ Anfrage aus ${a.kanal} abgebrochen.' : '⏹ Die Anfrage war schon fertig.'));
    } catch (e) { _zeile(Eintrag(Art.fehler, 'Abbrechen nicht möglich: $e')); }
  }

  void _nachfragen(String text) { eingabe.text = text; fokus.requestFocus(); _neu(() => ansicht = Ansicht.chat); }
  // 1.42.0 D1 — _vorgangOeffnen entfällt mit dem Abschnitt „Vorgänge“; Vorgänge öffnen sich in ihrer Ansicht (Eingang/Vorgänge)
}
