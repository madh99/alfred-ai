part of 'main.dart';

/// C1 (11.10.) — aus main.dart ausgelagert, Verhalten unverändert: Gesprächsfäden, Archiv, Spiegelung, Zähler der Seitenleiste.
extension _Gespraeche on _SitzungState {
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
      if (mounted) _neu(() => vorgaenge = offene);
    } catch (_) { /* Seitenleiste ist Komfort */ }
  }
}
