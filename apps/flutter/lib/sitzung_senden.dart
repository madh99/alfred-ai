part of 'main.dart';

/// C1 (11.10.) — aus main.dart ausgelagert, Verhalten unverändert: Update, Dateien, Verlauf, Bestätigungen, Warteschlange, Abbrechen und Senden.
extension _Senden on _SitzungState {
  // ── Selbstupdate (M6): Server kennt den neuesten Installer je Plattform ──────────────────────────────────────────
  Future<void> _updatePruefen() async {
    if (!istDesktop) return; // Phase 5 H1 — Handy: Updates über TestFlight bzw. Play
    final s = server; if (s == null) return;
    updateGeprueft = DateTime.now(); // 1.10.0
    if (appVersion.isEmpty) { try { final p = await PackageInfo.fromPlatform(); appVersion = p.version; } catch (_) { appVersion = '0.0.0'; } }
    final u = await AppUpdate(s, appVersion).pruefe();
    if (!mounted || u == null) return;
    if (update?.version != u.version) {
      _neu(() => update = u);
      _zeile(Eintrag(Art.hinweis, '⬆ Update ${u.version} verfügbar (du hast $appVersion) — Knopf in der Titelleiste installiert es.'));
      if (startArgs['update'] == 'sofort') _updateInstallieren(); // Beweislauf: ohne Klick installieren
    }
  }


  Future<void> _updateInstallieren() async {
    final s = server; final u = update;
    if (s == null || u == null || updateLaeuft) return;
    _neu(() => updateLaeuft = true);
    try {
      final f = await AppUpdate(s, appVersion).lade(u, fortschritt: (g, ges) => _neu(() => fluechtig = '⬆ ${u.datei}: ${ges > 0 ? (100 * g / ges).round() : 0} %'));
      _zeile(Eintrag(Art.hinweis, '⬆ ${u.datei} geladen, Prüfsumme stimmt — Installer startet.'));
      final beenden = await AppUpdate(s, appVersion).installiere(f, melde: (t) => _zeile(Eintrag(Art.hinweis, '⬆ $t')));
      if (beenden) { await Future.delayed(const Duration(milliseconds: 800)); exit(0); }
    } catch (e) { _zeile(Eintrag(Art.fehler, '⬆ Update: $e')); }
    finally { if (mounted) _neu(() { updateLaeuft = false; fluechtig = ''; }); }
  }


  // ── Verlauf, Bestätigungen, Chat (Meilenstein 1) ────────────────────────────────────────────────────────────────
  // ── Dateien (Meilenstein 3): per Drag-and-drop ins Fenster → Dateispeicher des Owners, dann Alfred Bescheid geben ──
  /// Hineingezogene Dateien werden Anhänge der Eingabezeile; hochgeladen wird erst beim Senden (mit oder ohne Text).
  void _dateienAbgelegt(List<String> pfade) {
    for (final p in pfade) {
      final f = File(p);
      if (!f.existsSync()) { _zeile(Eintrag(Art.fehler, 'Keine Datei: $p')); continue; }
      if (anhaenge.any((a) => a.path == f.path)) continue;
      _neu(() => anhaenge.add(f));
    }
    fokus.requestFocus();
  }


  /// Anhänge blockweise in den Dateispeicher des Owners laden; liefert die Zeilen für die Nachricht an Alfred.
  Future<List<String>> _anhaengeHochladen() async {
    final k = konfig!;
    final t = Transfer(k);
    final zeilen = <String>[];
    for (final f in List<File>.of(anhaenge)) {
      final name = f.uri.pathSegments.last;
      final t0 = DateTime.now();
      _neu(() => fluechtig = '📎 $name wird hochgeladen …');
      final r = await t.hochladen(f, fortschritt: (g, s) => _neu(() => fluechtig = '📎 $name: ${(100 * g / s).round()} %'));
      final sek = DateTime.now().difference(t0).inMilliseconds / 1000;
      _zeile(Eintrag(Art.hinweis, '📎 $name (${(r.groesse / 1024 / 1024).toStringAsFixed(1)} MB) in ${sek.toStringAsFixed(1)} s hochgeladen · Schlüssel ${r.key} · SHA-256 ${r.sha256}'));
      zeilen.add('Datei „$name" (${r.groesse} Bytes, SHA-256 ${r.sha256}) liegt in deinem Dateispeicher, Schlüssel: ${r.key}.');
    }
    _neu(() { anhaenge.clear(); fluechtig = ''; });
    return zeilen;
  }


  void _zeile(Eintrag e) {
    _neu(() => verlauf.add(e));
    _protokolliere(e);
    _nachUnten();
    if (e.art == Art.fehler) _fehlerMelden(e.text);
  }


  Future<void> _fehlerMelden(String text) async {
    final s = server; if (s == null) return;
    final jetzt = DateTime.now();
    final vorher = _gemeldeteFehler[text];
    if (vorher != null && jetzt.difference(vorher).inMinutes < 10) return;
    _gemeldeteFehler[text] = jetzt;
    if (appVersion.isEmpty) { try { appVersion = (await PackageInfo.fromPlatform()).version; } catch (_) {} }
    await s.melde(text, version: appVersion, plattform: Platform.operatingSystem);
  }


  void _protokolliere(Eintrag e, [String? quelle]) {
    final p = startArgs['protokoll'];
    if (p == null) return;
    try { File(p).writeAsStringSync('${e.zeit.toIso8601String()} ${quelle == null ? '' : '$quelle '}${e.art.name} ${e.text.replaceAll('\n', ' ')}\n', mode: FileMode.append, flush: true); } catch (_) {}
  }


  /// 1.2.7 — die Liste ist von unten verankert (`reverse: true`); Offset 0 = neueste Zeile. Damit landet man beim Öffnen
  /// eines Gesprächs immer bei der letzten Nachricht, auch bei sehr langen Einträgen (maxScrollExtent ist bei lazy
  /// gebauten Listen nur geschätzt und griff vorher zu kurz).
  void _nachUnten() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (scroll.hasClients) scroll.animateTo(0, duration: const Duration(milliseconds: 150), curve: Curves.easeOut);
    });
  }


  void _meldeNeu(Bestaetigung b) {
    if (gemeldet.contains(b.id)) return;
    gemeldet.add(b.id);
    _neu(() => offen.add(b));
    _zeile(Eintrag(Art.bestaetigung, '${b.quelle == 'geraet' ? '(Gerät) ' : ''}${b.text}'));
    _titel();
    _benachrichtige(b);
  }


  /// Verlauf der Gerätesitzung vom Gehirn (`/api/geraete/verlauf`, v1314) — vor den Zeilen dieses Starts einsortiert.
  Future<void> _holeVerlauf({String? um}) async {
    final s = server; if (s == null) return;
    final abruf = ++verlaufAbruf;
    _lesezeichenLaden(); // 1.45.0 D4
    WidgetsBinding.instance.addPostFrameCallback((_) => _leisteNachScroll()); // 1.45.2
    try {
      // 1.2.0 je Faden; 1.2.6: 60 sichtbare Zeilen; 1.5.0 `um` = Fundstelle der Suche (20 Zeilen rund um den Treffer)
      final j = await s.json('/api/geraete/verlauf?limit=${um == null ? 60 : 20}${s.faden == null ? '' : '&faden=${s.faden}'}${um == null ? '' : '&um=${Uri.encodeQueryComponent(um)}'}');
      if (abruf != verlaufAbruf) return; // inzwischen neuer abgerufen
      final n = (j['nachrichten'] as List<dynamic>? ?? []).cast<Map<String, dynamic>>();
      if (n.isEmpty) return;
      // Zuordnung Server-Zeile → Eintrag in verlauf.dart (testbar); Anhänge kommen im Hintergrund nach (1.4.2)
      final zeilen = n.where((m) => '${m['text'] ?? ''}'.trim().isNotEmpty).toList();
      if (um == null) { aeltesteZeit = '${n.first['zeit']}'; mehrAeltere = n.length >= 60; } // 1.6.0 — „Ältere Nachrichten laden"
      final alte = <Eintrag>[for (final m in zeilen) _mitAnhaengen(eintragAusVerlauf(m), m)..fund = um != null && '${m['zeit']}' == um];
      // 1.5.0 — Punkt 3: Antworten seit dem letzten Blick (App war zu/ausgeblendet) mit Trennzeile markieren
      final neu = um == null ? neueAntworten(alte, gesehenGespeichert()) : null;
      if (neu != null) alte.insert(neu.ab, Eintrag(Art.hinweis, '── ${neu.anzahl == 1 ? '1 neue Antwort' : '${neu.anzahl} neue Antworten'} seit deinem letzten Blick ──', zeit: alte[neu.ab].zeit));
      _neu(() => verlauf.insertAll(0, alte));
      for (final e in alte) _protokolliere(e, 'verlauf'); // 1.2.7 — geladene Zeilen im Protokoll (Beweis, Fehlersuche)
      if (um == null) _zeile(Eintrag(Art.hinweis, 'Verlauf geladen: ${zeilen.length} Nachrichten aus früheren Sitzungen dieses Geräts.'));
      if (sichtbar) _gesehenMerken();
      _nachUnten();
    } catch (e) { _zeile(Eintrag(Art.hinweis, 'Verlauf nicht geladen: $e')); }
  }


  Future<void> _aeltereLaden() async {
    final s = server; final vor = aeltesteZeit;
    if (s == null || vor == null || laedtAeltere) return;
    _neu(() => laedtAeltere = true);
    try {
      final j = await s.json('/api/geraete/verlauf?limit=60${s.faden == null ? '' : '&faden=${s.faden}'}&vor=${Uri.encodeQueryComponent(vor)}');
      final n = (j['nachrichten'] as List<dynamic>? ?? []).cast<Map<String, dynamic>>();
      final alte = <Eintrag>[for (final m in n.where((m) => '${m['text'] ?? ''}'.trim().isNotEmpty)) _mitAnhaengen(eintragAusVerlauf(m), m)];
      if (!mounted) return;
      _neu(() {
        verlauf.insertAll(0, alte); // Liste ist von unten verankert: oben anfügen verschiebt die Ansicht nicht
        if (n.isNotEmpty) aeltesteZeit = '${n.first['zeit']}';
        mehrAeltere = n.length >= 60;
      });
      _protokolliere(Eintrag(Art.hinweis, 'Ältere Nachrichten: ${alte.length} geladen (vor $vor)'));
    } catch (e) { _zeile(Eintrag(Art.fehler, 'Ältere Nachrichten nicht geladen: $e')); }
    finally { if (mounted) _neu(() => laedtAeltere = false); }
  }


  Future<void> _fundstelleOeffnen(Map<String, dynamic> t) async {
    final s = server; if (s == null) return;
    if (antwortet) { _zeile(Eintrag(Art.hinweis, 'Bitte warten, bis die Antwort fertig ist.')); return; }
    final faden = t['faden'] is String ? t['faden'] as String : null;
    s.faden = faden;
    _neu(() { verlauf.clear(); laufend = null; ansicht = Ansicht.chat; archiv = null; fundstelle = t; mehrAeltere = false; });
    await _holeVerlauf(um: '${t['zeit']}');
    _protokolliere(Eintrag(Art.hinweis, 'Fundstelle ${t['gespraech']} ${t['zeit']} geöffnet (${verlauf.where((e) => e.fund).length} Treffer markiert)'));
    WidgetsBinding.instance.addPostFrameCallback((_) { final c = fundSchluessel.currentContext; if (c != null) Scrollable.ensureVisible(c, alignment: 0.4, duration: const Duration(milliseconds: 200)); });
  }


  /// Fundstelle verlassen: dasselbe Gespräch mit den neuesten Nachrichten.
  Future<void> _fundstelleVerlassen() async {
    final s = server; if (s == null) return;
    await _fadenWechseln(s.faden);
  }


  /// 1.4.2 — Owner 10.10. 23:40: nach erneutem Öffnen des Hauptgesprächs fehlte das Foto. Der Verlauf liefert jetzt Verweise
  /// (Server v1347); die Bilder kommen im Hintergrund nach und erscheinen in ihrer Nachricht.
  Eintrag _mitAnhaengen(Eintrag e, Map<String, dynamic> m) {
    final s = server; final liste = m['anhaenge'];
    if (s == null || liste is! List) return e;
    for (final v in liste.whereType<Map<String, dynamic>>()) {
      s.anhang(v).then((a) { if (a != null && mounted) _neu(() => e.anhaenge.add(a)); }).catchError((Object _) {});
    }
    return e;
  }


  Future<void> _holeBestaetigungen() async {
    final s = server;
    if (s == null) return;
    try {
      final liste = await s.offeneBestaetigungen();
      final ids = liste.map((b) => b.id).toSet();
      var geaendert = false;
      for (final b in offen.where((b) => !ids.contains(b.id)).toList()) {
        _neu(() => offen.remove(b));
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
      _neu(() => offen.remove(b));
      _titel();
      _zeile(Eintrag(Art.hinweis, '${ja ? '✅ Freigegeben' : '❌ Abgelehnt'}: ${b.text.length > 100 ? b.text.substring(0, 100) : b.text}'));
    } else if (r.startsWith('fehlgeschlagen: ')) { // 1.51.0 — freigegeben, aber die Aktion scheiterte
      _neu(() => offen.remove(b));
      _titel();
      _zeile(Eintrag(Art.fehler, '❌ Freigegeben, aber fehlgeschlagen: ${r.substring(16)} — ${b.text.length > 80 ? b.text.substring(0, 80) : b.text}'));
    } else {
      _zeile(Eintrag(Art.fehler, 'Entscheidung nicht angenommen ($r)'));
    }
  }


  void _wartenStarten() { warteTakt ??= Timer.periodic(const Duration(seconds: 15), (_) => _nachsenden()); }


  /// Nächste wartende Nachricht des offenen Gesprächs senden (eine je Takt, in Reihenfolge).
  Future<void> _nachsenden() async {
    final s = server;
    if (s == null || antwortet || _sendetNach || fundstelle != null || archiv != null) return;
    for (final alt in warteschlange.verfallene()) {
      _zeile(Eintrag(Art.hinweis, '⏳ Nicht nachgesendet (älter als 24 Stunden): „${alt.text.length > 80 ? '${alt.text.substring(0, 80)}…' : alt.text}“ — bitte bei Bedarf neu senden.'));
    }
    if (warteschlange.leer) { warteTakt?.cancel(); warteTakt = null; return; }
    final w = warteschlange.naechster(s.faden);
    if (w == null) return; // wartet in einem anderen Gespräch — wird dort nachgesendet, sobald es offen ist
    _sendetNach = true;
    try {
      if (!verlauf.any((e) => e.art == Art.du && e.text == w.text)) _zeile(Eintrag(Art.du, w.text, zeit: w.zeit)); // nach App-Neustart wieder sichtbar
      await _senden(text: w.text, nachsenden: w);
    } finally { _sendetNach = false; }
  }


  /// Alle 5 Minuten: Update vorhanden und App unbenutzt → still installieren (Windows, macOS).
  Future<void> _stillPruefen() async {
    // 1.10.0 — vorher installierte das stille Update nur, was die 6-h-Prüfung schon gefunden hatte; jetzt sucht es alle 30 min selbst
    if (update == null && !updateLaeuft && DateTime.now().difference(updateGeprueft) >= const Duration(minutes: 30)) await _updatePruefen();
    final u = update;
    if (u == null || updateLaeuft) return;
    final erlaubt = stillesUpdateErlaubt(
      eingeschaltet: stillUpdate, plattformStill: Platform.isWindows || (Platform.isMacOS && AppUpdate.eigenesBundle() != null),
      antwortet: antwortet, hoeren: hoeren, aufnahme: aufnahme, schnellfrage: schnell, imVordergrund: fokussiert && sichtbar,
      letzteAktivitaet: letzteAktivitaet,
    );
    if (!erlaubt) return;
    _protokolliere(Eintrag(Art.hinweis, '⬆ stilles Update auf ${u.version} (App seit ${DateTime.now().difference(letzteAktivitaet).inMinutes} min unbenutzt)'));
    await server?.melde('Stilles Update $appVersion → ${u.version}', art: 'update', version: appVersion, plattform: Platform.operatingSystem);
    await _updateInstallieren();
  }


  /// Stopp: Anzeige und Vorlesen sofort beenden, den Server bitten, vor dem nächsten Schritt aufzuhören (v1352).
  Future<void> _abbrechen() async {
    final s = server; if (s == null || !antwortet) return;
    abbruch = true; abgebrochenUm = DateTime.now();
    vorleserLaufend?.stopp(); audio.abbrechen();
    final lief = await s.abbrechen();
    _protokolliere(Eintrag(Art.hinweis, '⏹ Abbruch angefordert (am Server lief ${lief ? 'eine Anfrage' : 'nichts mehr'})'));
  }


  /// Sendet `text` (oder die Eingabezeile) und liefert den Endtext der Antwort.
  /// `sprechen`: Antwort satzweise vorlesen, sobald Sätze vollständig sind (erster Ton nach dem ersten Satz, nicht nach dem Ende).
  Future<String?> _senden({String? text, bool sprechen = false, DateTime? seit, Wartend? nachsenden}) async {
    letzteAktivitaet = DateTime.now(); // 1.8.0
    // 1.54.0 — Handy mit Kopfhörer, Bluetooth-Audio oder im Auto: auch getippte Fragen werden vorgelesen (Schalter, Standard an)
    if (!sprechen && istHandy && autoVorlesen && vorleseAusgaenge.contains((await handyZustand())['audio'])) sprechen = true;
    var t = (text ?? eingabe.text).trim();
    final s = server;
    final mitAnhang = text == null && anhaenge.isNotEmpty;
    if ((t.isEmpty && !mitAnhang) || antwortet) return null;
    if (s == null) { _zeile(Eintrag(Art.fehler, 'Noch nicht mit dem Satelliten verbunden — $ipcZustand')); return null; }
    if (fundstelle != null) await _fundstelleVerlassen(); // 1.5.0 — weiter im Gespräch mit den neuesten Nachrichten, nicht unter der Fundstelle
    // 1.2.5 — `/faden …` in der App lokal: die App hat ihre eigene Seitenleiste, der Server-Stand gilt für Telegram/Terminal
    if (text == null && RegExp(r'^/faden\b', caseSensitive: false).hasMatch(t)) {
      eingabe.clear();
      final arg = t.replaceFirst(RegExp(r'^/faden\s*', caseSensitive: false), '').trim();
      final teile = arg.split(RegExp(r'\s+'));
      if (arg.isEmpty) { _neu(() { seitenleisteOffen = true; }); _zeile(Eintrag(Art.hinweis, 'Gespräche stehen in der Seitenleiste. /faden neu [Titel] · /faden haupt · /faden <Kennung>')); return null; }
      if (teile.first == 'haupt') { await _fadenWechseln(null); return null; }
      if (teile.first == 'neu') { final id = DateTime.now().millisecondsSinceEpoch.toRadixString(36); await _fadenWechseln(id); final titel = teile.skip(1).join(' ').trim(); if (titel.isNotEmpty) { try { await s.json('/api/geraete/faeden/$id', methode: 'PATCH', koerper: {'titel': titel}); await _faedenLaden(); } catch (_) {} } return null; }
      if (RegExp(r'^[a-z0-9-]{1,40}$').hasMatch(teile.first)) { await _fadenWechseln(teile.first); return null; }
      _zeile(Eintrag(Art.hinweis, 'Unbekannt: /faden $arg')); return null;
    }
    if (text == null) {
      eingabe.clear();
      final pfade = anhaenge.map((f) => f.path).toList(); // 1.46.0 — Vorschau über der Blase statt „📎 Namen“
      final zitat = bezug == null ? '' : '↩ „${bezug!.text.replaceAll('\n', ' ').substring(0, bezug!.text.length > 80 ? 80 : bezug!.text.length)}${bezug!.text.length > 80 ? '…' : ''}“\n'; // 1.2.2
      _zeile(Eintrag(Art.du, '$zitat$t', lokaleDateien: pfade));
      if (mitAnhang) {
        // Anhänge zuerst hochladen, dann Alfred mit Text und Schlüsseln ansprechen (Datei + Frage in einer Nachricht)
        List<String> zeilen;
        try { zeilen = await _anhaengeHochladen(); } catch (e) { _zeile(Eintrag(Art.fehler, '📎 $e')); _neu(() => fluechtig = ''); return null; }
        t = t.isEmpty ? '${zeilen.join('\n')}\nBestätige kurz den Empfang.' : '$t\n\n${zeilen.join('\n')}';
      }
    }
    _neu(() { antwortet = true; fluechtig = '… denkt'; });
    final e = Eintrag(Art.alfred, '');
    var gezeigt = '';
    String? ergebnis;
    final start = seit ?? DateTime.now();
    final vorleser = (sprechen || stimme)
      ? Vorleser(s.sprich, audio, beiErstemTon: () { final sek = DateTime.now().difference(start).inMilliseconds / 1000; _zeile(Eintrag(Art.hinweis, '🔊 erster Ton nach ${sek.toStringAsFixed(1)} s')); })
      : null;
    vorleserLaufend = vorleser; abbruch = false; // 1.7.0 Stopp-Knopf
    try {
      final bezugText = bezug?.text; // 1.2.2 — Antwort-Bezug geht mit, dann ist er erledigt
      if (bezug != null) _neu(() => bezug = null);
      final ende = await s.sende(t, tier: tierWahl, bezug: bezugText, // 1.1.0 — Stufenwahl aus der Eingabekarte
        aufDelta: (d) {
          if (laufend == null) { laufend = e; _neu(() { verlauf.add(e); fluechtig = ''; }); }
          gezeigt += d;
          vorleser?.fuege(d);
          _neu(() => e.text = gezeigt);
          _nachUnten();
        },
        aufStatus: (st) => _neu(() => fluechtig = st.isEmpty ? '' : '… ${st.length > 100 ? st.substring(0, 100) : st}'),
        aufAnhang: (a) { if (laufend == null) { laufend = e; _neu(() { verlauf.add(e); fluechtig = ''; }); } _neu(() => e.anhaenge.add(a)); _nachUnten(); }, // 1.0.5
      );
      if (laufend == null) { _zeile(Eintrag(Art.alfred, ende.isEmpty ? '(keine Antwort)' : ende)); }
      else { if (ende.trim().isNotEmpty && ende.trim() != gezeigt.trim()) _neu(() => e.text = ende); _protokolliere(e); }
      ergebnis = ende.isNotEmpty ? ende : gezeigt;
      if (nachsenden != null) { warteschlange.entferne(nachsenden); _protokolliere(Eintrag(Art.hinweis, '✓ nachgesendet: ${nachsenden.text.length > 60 ? nachsenden.text.substring(0, 60) : nachsenden.text}')); } // 1.8.0
      _faedenLaden(); // 1.2.0 — Titel/Zeit des Gesprächs in der Seitenleiste nachziehen
      if (vorleser != null && ergebnis.trim().isNotEmpty) {
        _neu(() => fluechtig = '🔊 …');
        await vorleser.schluss(ganzerText: gezeigt.trim().isEmpty ? ergebnis : null);
        if (vorleser.fehler != null) _zeile(Eintrag(Art.fehler, '🔊 ${vorleser.fehler}'));
      }
    } catch (err) {
      if (abbruch) { // 1.7.0 — vom Owner abgebrochen: kein Fehler, das bisher Gezeigte bleibt mit Vermerk stehen
        if (laufend != null) _neu(() => e.text = gezeigt.trim().isEmpty ? '⏹ Abgebrochen.' : '$gezeigt\n\n⏹ abgebrochen');
        else _zeile(Eintrag(Art.hinweis, '⏹ Abgebrochen.'));
      } else if (laufend == null && istVerbindungsfehler(err) && t.trim().isNotEmpty) { // 1.8.0 — Punkt 9: nicht verlieren, nachsenden
        if (nachsenden == null) {
          warteschlange.hinzu(Wartend(text: t, faden: s.faden, tier: tierWahl));
          _zeile(Eintrag(Art.hinweis, '⏳ Keine Verbindung zum Server — die Nachricht wird automatisch nachgesendet, sobald er wieder antwortet.'));
        }
        _wartenStarten();
      } else {
        _zeile(Eintrag(Art.fehler, 'Fehler: $err'));
      }
    } finally {
      vorleserLaufend = null;
      _neu(() { antwortet = false; fluechtig = ''; laufend = null; });
      fokus.requestFocus();
      final rest = nachreichen; nachreichen = null; // 1.4.1
      if (rest != null && hoeren) {
        _zeile(Eintrag(Art.du, '🎧 $rest'));
        Future.microtask(() => _senden(text: rest, sprechen: true).then((_) { gespraechsfensterBis = DateTime.now().add(const Duration(seconds: 20)); }));
      }
    }
    return ergebnis;
  }
}
