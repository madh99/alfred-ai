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
      if (mounted) _neu(() => faeden = l);
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
    fokus.requestFocus();
  }


  void _neuerChat() {
    final id = DateTime.now().millisecondsSinceEpoch.toRadixString(36);
    _fadenWechseln(id);
  }


  /// 1.2.1 — Gespräch wurde auf einem anderen Kanal fortgeführt: Verlauf vom Server neu laden, lokale Hinweise behalten.
  Future<void> _gespraechNachladen() async {
    if (antwortet || fundstelle != null) return; // 1.5.0 — Fundstelle bleibt stehen, bis sie verlassen wird
    final hinweise = verlauf.where((e) => e.art != Art.du && e.art != Art.alfred).toList();
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


  Future<void> _fadenLoeschen(String faden) async {
    final s = server; if (s == null) return;
    try {
      await s.json('/api/geraete/faeden/$faden', methode: 'DELETE');
      if (s.faden == faden) await _fadenWechseln(null);
      await _faedenLaden();
    } catch (e) { _zeile(Eintrag(Art.fehler, 'Gespräch nicht gelöscht: $e')); }
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

  Future<void> _vorgangOeffnen(Map<String, dynamic> v) async {
    final s = server; if (s == null) return;
    if (await zeigeVorgang(context, v: v, schritte: vorgangSchritte, json: s.json, aufMeldung: (t) => _protokolliere(Eintrag(Art.hinweis, t)), aufNachfragen: _nachfragen)) await _vorgaengeLaden();
  }
}
