part of 'main.dart';

/// C1 (11.10.) — aus main.dart ausgelagert, Verhalten unverändert: Sprache: Push-to-Talk, Echtzeit-Hören, Aktivierungswort, Beweisläufe.
extension _Sprache on _SitzungState {
  // ── Sprache ─────────────────────────────────────────────────────────────────────────────────────────────────────
  Future<void> _talkUmschalten() async {
    if (aufnahme) { await _talkStop(); return; }
    if (antwortet) return;
    if (hoeren) { _zeile(Eintrag(Art.hinweis, '🎧 Zuhören läuft — einfach „${konfig?.aktivierungswort ?? 'Alfred'}, …“ sagen.')); return; }
    bool ok;
    try { ok = await audio.aufnehmen(); } catch (e) { _zeile(Eintrag(Art.fehler, 'Mikrofon: $e')); return; } // 1.0.4 — Fehler sichtbar statt verschluckt (VM ohne Mikrofon)
    if (!ok) { _zeile(Eintrag(Art.fehler, 'Mikrofon nicht verfügbar oder nicht erlaubt')); return; }
    _neu(() { aufnahme = true; fluechtig = '● Aufnahme läuft — Strg+Alt+Leertaste stoppt'; });
  }


  /// 1.54.0 (Owner 19.10.) — Handy: Antippen = Diktat. Erster Tipp startet, zweiter stoppt; der erkannte Text kommt ins
  /// Eingabefeld (prüfen, ändern, selbst senden). Gedrückt halten = sprechen und beim Loslassen senden (_haltenStart/_haltenEnde).
  Future<void> _diktatUmschalten() async {
    if (aufnahme) { if (diktat) { await _diktatStop(); } else { await _talkStop(); } return; }
    if (antwortet) return;
    if (await _aufnahmeStarten('● Diktat läuft — antippen beendet')) _neu(() => diktat = true);
  }

  Future<void> _haltenStart() async {
    if (aufnahme || antwortet) return;
    final ok = await _aufnahmeStarten('● Sprich — loslassen sendet');
    // schon losgelassen, während das Mikrofon startete: gleich beenden (sonst bliebe die Aufnahme hängen)
    if (ok && losgelassen) await _talkStop();
  }

  Future<void> _haltenEnde() async { if (aufnahme && !diktat) await _talkStop(); }

  Future<bool> _aufnahmeStarten(String hinweis) async {
    bool ok;
    try { ok = await audio.aufnehmen(); } catch (e) { _zeile(Eintrag(Art.fehler, 'Mikrofon: $e')); return false; }
    if (!ok) { _zeile(Eintrag(Art.fehler, 'Mikrofon nicht verfügbar oder nicht erlaubt')); return false; }
    _neu(() { aufnahme = true; diktat = false; fluechtig = hinweis; });
    return true;
  }

  Future<void> _diktatStop() async {
    _neu(() { aufnahme = false; diktat = false; fluechtig = '… schreibe mit'; });
    final daten = await audio.stop();
    final s = server;
    try {
      if (s == null) return;
      if (daten.length < 2000) { _zeile(Eintrag(Art.hinweis, '🎙 Aufnahme zu kurz.')); return; }
      final text = (await s.transkribiere(daten, 'audio/wav')).trim();
      if (text.isEmpty) { _zeile(Eintrag(Art.hinweis, '🎙 Nichts verstanden.')); return; }
      final alt = eingabe.text.trimRight();
      eingabe.text = alt.isEmpty ? text : '$alt $text';
      eingabe.selection = TextSelection.collapsed(offset: eingabe.text.length);
      fokus.requestFocus();
    } catch (e) { _zeile(Eintrag(Art.fehler, '🎙 $e')); }
    finally { _neu(() => fluechtig = ''); }
  }


  Future<void> _talkStop() async {
    _neu(() { aufnahme = false; fluechtig = '… höre zu'; });
    final daten = await audio.stop();
    await _sprachEingabe(daten, 'audio/wav');
  }


  Future<void> _sprachEingabe(List<int> daten, String mime) async {
    final s = server;
    if (s == null) { _neu(() => fluechtig = ''); return; }
    if (daten.length < 2000) { _neu(() => fluechtig = ''); _zeile(Eintrag(Art.hinweis, '🎙 Aufnahme zu kurz — nichts gesendet.')); return; }
    final t0 = DateTime.now();
    try {
      final text = await s.transkribiere(daten, mime);
      if (text.isEmpty) { _neu(() => fluechtig = ''); _zeile(Eintrag(Art.hinweis, '🎙 Nichts verstanden.')); return; }
      _zeile(Eintrag(Art.du, '🎙 $text'));
      await _senden(text: text, sprechen: true, seit: t0); // blockweise vorgelesen, während die Antwort noch kommt
    } catch (e) { _zeile(Eintrag(Art.fehler, '🎙 $e')); }
    finally { _neu(() => fluechtig = ''); }
  }


  Future<void> _sprachtest(String wav) async {
    try {
      final daten = await File(wav).readAsBytes();
      _zeile(Eintrag(Art.hinweis, 'Sprachtest mit $wav (${(daten.length / 1024).round()} KB)'));
      await _sprachEingabe(daten, 'audio/wav');
    } catch (e) { _zeile(Eintrag(Art.fehler, 'Sprachtest: $e')); }
  }



  // ── Echtzeit-Hören (Meilenstein 4): Mikrofonstrom → Satzende lokal → Relais → Aktivierungswort → Nachricht ───────
  Future<void> _hoerenUmschalten() async { if (hoeren) { await _hoerenStop('aus'); } else { await _hoerenStart(); } }


  Future<void> _hoerenStart() async {
    final k = konfig;
    if (k == null) { _zeile(Eintrag(Art.fehler, 'Noch nicht mit dem Satelliten verbunden — $ipcZustand')); return; }
    if (hoeren) return;
    if (aufnahme) await _talkStop();
    final client = HoerClient(k, _hoerEreignis, (grund) { _zeile(Eintrag(Art.fehler, '🎧 Relais: $grund — Zuhören beendet')); _hoerenStop(null); });
    try { await client.verbinde(); } catch (e) { _zeile(Eintrag(Art.fehler, '🎧 Relais nicht erreichbar: $e')); return; }
    final erk = SatzendeErkenner();
    // 1.3.0 — lokales Aktivierungswort: Äußerung wird gesammelt und erst ans Relais gegeben, wenn das Wort darin erkannt
    // wurde oder das Gesprächsfenster offen ist; sonst am Satzende verworfen (Server sieht sie nie — kein Transkript, kein Verkehr)
    final wort = wortLokal ? await _wortModellLaden() : null;
    final erkW = wort == null ? null : (WortErkenner(wort, hopMs: 80, schwelle: 0.95, treffer: 3, sperreMs: 2000)..treffer$.listen((t) { letzterWortTreffer = t.zeit; _protokolliere(Eintrag(Art.hinweis, '🔑 Aktivierungswort erkannt (${t.wahrscheinlichkeit.toStringAsFixed(2)})')); }));
    wort?.zuruecksetzen();
    final puffer = BytesBuilder(copy: false); var offen = false; var gesendet = false;
    final aeusserungTon = BytesBuilder(copy: true); // 1.4.1 — Ton der laufenden Äußerung (Ersatzweg, wenn sie abgebrochen wird)
    bool freigegeben() => erkW == null || aeusserungImFenster || DateTime.now().isBefore(gespraechsfensterBis) || DateTime.now().difference(letzterWortTreffer).inSeconds < 4;
    final ok = await audio.stromStart((pcm) {
      if (antwortet || audio.spielt) { // Halbduplex: während Alfred antwortet oder spricht, nicht hören
        // 1.4.1 — Realfall 10.10. 22:57: lief gerade eine Äußerung, blieb sie beim Transkriptionsdienst offen → 3804 nach 30 s, Satz
        // verloren. Jetzt wird sie sofort abgeschlossen (der bisher gesendete Teil wird transkribiert), der Erkenner beginnt neu.
        if (offen) {
          if (gesendet) { letzteAeusserung = aeusserungTon.toBytes(); client.ende(); }
          offen = false; gesendet = false; puffer.clear(); aeusserungTon.clear(); erk.zuruecksetzen();
        }
        return;
      }
      erkW?.verarbeite(pcm);
      for (final ev in erk.schiebe(pcm)) {
        if (ev is SatzStart) {
          offen = true; gesendet = false; puffer.clear(); puffer.add(ev.audio); aeusserungTon.clear(); aeusserungTon.add(ev.audio);
          // 1.4.0 — Fenster-Zustand beim Beginn festhalten (ein Satz, der im Fenster beginnt, gilt als Antwort, egal wie lang)
          aeusserungImFenster = DateTime.now().isBefore(gespraechsfensterBis) || DateTime.now().difference(letzterWortTreffer).inSeconds < 4;
        }
        else if (ev is SatzEnde) {
          letzteAeusserung = ev.audio; // 1.4.0 — Ersatzweg bei Relais-Timeout
          if (gesendet) { client.ende(); }
          else if (freigegeben()) { client.start(); client.audio(puffer.takeBytes()); client.ende(); }
          else { wortVerworfen++; puffer.clear(); if (wortVerworfen % 10 == 1) _protokolliere(Eintrag(Art.hinweis, '🔑 ohne Aktivierungswort verworfen ($wortVerworfen)')); }
          offen = false; gesendet = false;
        }
      }
      if (erk.spricht && offen) {
        if (!gesendet && freigegeben()) { client.start(); client.audio(puffer.takeBytes()); gesendet = true; }
        if (gesendet) { client.audio(pcm); } else { puffer.add(pcm); }
        aeusserungTon.add(pcm);
      }
    }, (grund) { _zeile(Eintrag(Art.fehler, '🎧 Mikrofon: $grund')); _hoerenStop(null); });
    if (!ok) { client.schluss(); _zeile(Eintrag(Art.fehler, 'Mikrofon nicht verfügbar oder nicht erlaubt')); return; }
    hoerClient = client; erkenner = erk; wortErkenner = erkW;
    _neu(() => hoeren = true);
    _zeile(Eintrag(Art.hinweis, '🎧 Höre zu — sag „${k.aktivierungswort}, …". Nach einer Antwort 20 s ohne Wort. „${k.aktivierungswort}, stopp" bricht die Wiedergabe ab.'));
  }


  Future<void> _hoerenStop(String? meldung) async {
    final c = hoerClient; hoerClient = null; erkenner = null;
    final w = wortErkenner; wortErkenner = null; w?.schliesse(); // 1.3.0
    await audio.stromStop();
    try { c?.schluss(); } catch (_) {}
    if (!mounted) return;
    _neu(() { hoeren = false; if (fluechtig.startsWith('🎧')) fluechtig = ''; });
    if (meldung != null) _zeile(Eintrag(Art.hinweis, '🎧 Zuhören $meldung.'));
  }


  void _hoerEreignis(HoerEreignis e) {
    final k = konfig; if (k == null) return;
    if (e.typ == 'delta') { gehoert += e.text ?? ''; _neu(() => fluechtig = '🎧 ${gehoert.length > 100 ? gehoert.substring(gehoert.length - 100) : gehoert}'); }
    else if (e.typ == 'fertig') {
      final text = (e.text ?? '').trim(); gehoert = '';
      _neu(() => fluechtig = '');
      if (text.isEmpty) return;
      // 1.4.0 — Fenster gilt, wenn die Äußerung darin begonnen hat (nicht erst am Ende der Transkription)
      final imFenster = aeusserungImFenster || DateTime.now().isBefore(gespraechsfensterBis);
      aeusserungImFenster = false; letzteAeusserung = null;
      final a = pruefeAktivierung(text, k.aktivierungswort, imFenster);
      switch (a.art) {
        case AktivierungsArt.ignoriert: _zeile(Eintrag(Art.hinweis, '(nicht an mich: $text)'));
        case AktivierungsArt.stopp: audio.abbrechen(); _zeile(Eintrag(Art.hinweis, '⏹ gestoppt')); gespraechsfensterBis = DateTime.now().add(const Duration(seconds: 20));
        case AktivierungsArt.nurWort: gespraechsfensterBis = DateTime.now().add(const Duration(seconds: 20)); _zeile(Eintrag(Art.du, '🎧 $text')); _sprichKurz('Ja?');
        case AktivierungsArt.nachricht:
          if (antwortet) { // 1.4.1 — sonst verwirft _senden den Text still
            nachreichen = nachreichen == null ? a.text : '$nachreichen ${a.text}';
            _zeile(Eintrag(Art.hinweis, '🎧 „${a.text}“ — wird nach der Antwort gesendet'));
            return;
          }
          _zeile(Eintrag(Art.du, '🎧 ${a.text}'));
          _senden(text: a.text, sprechen: true).then((_) { gespraechsfensterBis = DateTime.now().add(const Duration(seconds: 20)); });
      }
    }
    else if (e.typ == 'fehler' && letzteAeusserung != null && RegExp(r'3804|[Tt]imeout').hasMatch(e.grund ?? '')) {
      // 1.4.0 — Realfall 19:45: Transkriptionsdienst lieferte bei einer langen Äußerung nicht (3804) → Satz ging verloren.
      // Ersatzweg: dieselbe Äußerung als WAV über /api/transcribe (wie Strg+Alt+Leertaste), dann normal weiter.
      final pcm = letzteAeusserung!; letzteAeusserung = null;
      _zeile(Eintrag(Art.hinweis, '🎧 Transkription hing — Ersatzweg (${(pcm.length / 32000).toStringAsFixed(1)} s)'));
      final s = server;
      if (s != null) {
        s.transkribiere(pcmZuWav(pcm), 'audio/wav').then((t) { _hoerEreignis(HoerEreignis('fertig', text: t)); }).catchError((Object err) { _zeile(Eintrag(Art.fehler, '🎧 Ersatzweg: $err')); });
      }
    }
    else if (e.typ == 'fehler' || e.typ == 'limit') _zeile(Eintrag(Art.fehler, '🎧 ${e.typ}: ${e.grund ?? ''}'));
  }


  Future<void> _sprichKurz(String text) async {
    final s = server; if (s == null) return;
    try { final (b, mime) = await s.sprich(text); await audio.abspielen(Uint8List.fromList(b), mime); } catch (e) { _zeile(Eintrag(Art.fehler, '🔊 $e')); }
  }


  /// 1.3.0 — ONNX-Modelle einmal laden (2,8 MB aus den Assets); bei Fehler bleibt es beim Serverpfad (Wort im Transkript).
  Future<OnnxWortModell?> _wortModellLaden() async {
    if (wortModell != null) return wortModell;
    try {
      wortModell = await OnnxWortModell.lade();
      _zeile(Eintrag(Art.hinweis, '🔑 Aktivierungswort lokal: Modelle geladen (Mel, Einbettung, Kopf)'));
    } catch (e) { _zeile(Eintrag(Art.fehler, '🔑 Aktivierungswort lokal nicht verfügbar: $e — Erkennung über den Server')); }
    return wortModell;
  }


  /// 1.3.0 — Beweislauf: WAV (16 kHz mono) in 80-ms-Blöcken nur durch den lokalen Erkenner; schreibt Treffer-Zeitpunkte,
  /// Höchstwert und Rechenzeit je Hop ins Protokoll. Vergleich mit `tools/wakeword/ref.py` (gleiche Rechnung in Python).
  Future<void> _wortprobe(String wav) async {
    try {
      final pcm = wavZuPcm16k(await File(wav).readAsBytes());
      final modell = await _wortModellLaden();
      if (modell == null) { _zeile(Eintrag(Art.fehler, 'Wortprobe: kein Modell')); return; }
      modell.zuruecksetzen();
      final treffer = <double>[]; var maxP = 0.0; var hops = 0;
      final erk = WortErkenner(modell, hopMs: 80, schwelle: 0.95, treffer: 3, sperreMs: 2000);
      var verarbeitet = 0;
      erk.treffer$.listen((t) => treffer.add(verarbeitet / 32000));
      final t0 = DateTime.now();
      for (var off = 0; off < pcm.length; off += 2560) {
        final block = Uint8List.sublistView(pcm, off, off + 2560 > pcm.length ? pcm.length : off + 2560);
        await erk.verarbeite(block); verarbeitet = off + block.length;
        hops++;
      }
      await Future<void>.delayed(const Duration(milliseconds: 50));
      maxP = 0; // Höchstwert liefert das Modell nicht gesammelt — Treffer und Rechenzeit sind die Messgrößen
      final ms = DateTime.now().difference(t0).inMilliseconds;
      _zeile(Eintrag(Art.hinweis, 'WORTPROBE ${wav.split(RegExp(r'[\\/]')).last}: ${(pcm.length / 32000).toStringAsFixed(1)} s, $hops Blöcke in $ms ms (${modell.msJeAufruf.toStringAsFixed(1)} ms je Modellaufruf, ${modell.aufrufe} Aufrufe), Treffer ${treffer.length}: ${treffer.map((t) => t.toStringAsFixed(2)).join(' ')}${maxP > 0 ? '' : ''}'));
      erk.schliesse();
    } catch (e) { _zeile(Eintrag(Art.fehler, 'Wortprobe: $e')); }
  }


  /// Beweislauf: WAV durch dieselbe Kette (Satzende → Relais → Aktivierung) schicken, in Echtzeit-Blöcken von 80 ms.
  Future<void> _hoertest(String wav) async {
    try {
      final pcm = wavZuPcm16k(await File(wav).readAsBytes());
      _zeile(Eintrag(Art.hinweis, 'Hörtest mit $wav (${(pcm.length / 32000).toStringAsFixed(1)} s Audio); Gesprächsfenster offen, als hätte Alfred gerade geantwortet'));
      final k = konfig!;
      final erk = SatzendeErkenner();
      final client = HoerClient(k, _hoerEreignis, (grund) => _zeile(Eintrag(Art.fehler, '🎧 Relais: $grund')));
      await client.verbinde();
      gespraechsfensterBis = DateTime.now().add(const Duration(seconds: 60));
      final t0 = DateTime.now();
      var saetze = 0;
      for (var off = 0; off < pcm.length; off += 2560) {
        final block = Uint8List.sublistView(pcm, off, off + 2560 > pcm.length ? pcm.length : off + 2560);
        for (final ev in erk.schiebe(block)) {
          if (ev is SatzStart) { client.start(); client.audio(ev.audio); saetze++; }
          else if (ev is SatzEnde) { client.ende(); _zeile(Eintrag(Art.hinweis, '🎧 Satzende nach ${ev.dauerMs} ms Sprache (${DateTime.now().difference(t0).inMilliseconds} ms)')); }
        }
        if (erk.spricht) client.audio(block);
        await Future.delayed(const Duration(milliseconds: 80));
      }
      for (final ev in erk.schliesse()) { if (ev is SatzEnde) { client.ende(); _zeile(Eintrag(Art.hinweis, '🎧 Satzende am Stromende nach ${ev.dauerMs} ms Sprache')); } }
      _zeile(Eintrag(Art.hinweis, '🎧 Hörtest: Audio gesendet, $saetze Äußerung(en) erkannt'));
      await Future.delayed(const Duration(seconds: 8));
      client.schluss();
    } catch (e) { _zeile(Eintrag(Art.fehler, 'Hörtest: $e')); }
  }
}
