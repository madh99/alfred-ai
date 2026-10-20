part of 'main.dart';

/// 1.58.0 G1/G2/G4 — Unterhaltungsmodus: Mikrofonstrom → Satzende lokal (wie Echtzeit-Hören, aber ohne Relais und ohne
/// Aktivierungswort — jeder Satz ist an Alfred gerichtet) → Spracherkennung am Server → Antwort wird beim Entstehen
/// vorgelesen → wieder zuhören. Halbduplex: während Alfred denkt oder spricht, wird das Mikrofon ignoriert (es läuft weiter,
/// damit iOS die Audiositzung bei gesperrtem Bildschirm nicht beendet — G2). Standard ist die schnelle Stufe, außer der
/// Owner hat in der Eingabekarte ausdrücklich eine gewählt.
extension _Unterhaltung on _SitzungState {
  String get _uStufe => tierWahl ?? 'fast';

  Future<void> _unterhaltungStart() async {
    if (unterhaltung != null) return;
    if (server == null) { _zeile(Eintrag(Art.fehler, 'Noch nicht verbunden — $ipcZustand')); return; }
    if (antwortet) return;
    if (hoeren) await _hoerenStop(null); // Desktop: Aktivierungswort-Zuhören und Unterhaltung teilen sich das Mikrofon
    if (aufnahme) { await audio.stop(); _neu(() { aufnahme = false; diktat = false; fluechtig = ''; }); }
    final stand = UnterhaltungsStand();
    final erk = SatzendeErkenner(endeMs: 800); // etwas mehr Pause als beim Zuhören: im freien Gespräch denkt man beim Reden
    uErkenner = erk; uBeschaeftigt = false;
    bool ok;
    try {
      ok = await audio.stromStart((pcm) => _unterhaltungTon(stand, erk, pcm), (grund) { _zeile(Eintrag(Art.fehler, '🗣 Mikrofon: $grund')); _unterhaltungEnde(); });
    } catch (e) { _zeile(Eintrag(Art.fehler, '🗣 Mikrofon: $e')); return; }
    if (!ok) { _zeile(Eintrag(Art.fehler, 'Mikrofon nicht verfügbar oder nicht erlaubt')); return; }
    _neu(() => unterhaltung = stand);
    _protokolliere(Eintrag(Art.hinweis, '🗣 Unterhaltung gestartet (Stufe $_uStufe)'));
  }

  void _unterhaltungTon(UnterhaltungsStand stand, SatzendeErkenner erk, Uint8List pcm) {
    if (!identical(unterhaltung, stand)) return;
    final still = stand.stumm || uBeschaeftigt || antwortet || audio.spielt || DateTime.now().isBefore(uRuheBis);
    if (still) { // Halbduplex — angefangene Äußerung verwerfen, sonst hängt der Nachhall der Ausgabe daran
      if (erk.spricht) erk.zuruecksetzen();
      if (stand.phase == UPhase.versteht) stand.phase = UPhase.hoert;
      return;
    }
    stand.neuerPegel(pegelAusRms(rms16(pcm)));
    for (final ev in erk.schiebe(pcm)) {
      if (ev is SatzStart) { stand.phase = UPhase.versteht; }
      else if (ev is SatzEnde) { _unterhaltungAeusserung(stand, ev.audio); }
      else if (ev is SatzVerworfen) { stand.phase = UPhase.hoert; }
    }
  }

  Future<void> _unterhaltungAeusserung(UnterhaltungsStand stand, Uint8List pcm) async {
    final s = server;
    if (s == null || uBeschaeftigt) return;
    uBeschaeftigt = true;
    stand.phase = UPhase.denkt;
    try {
      final text = (await s.transkribiere(pcmZuWav(pcm), 'audio/wav')).trim();
      if (!identical(unterhaltung, stand)) return;
      if (text.isEmpty || RegExp(r'^[\s.,!?…-]*$').hasMatch(text)) return; // Husten, Geräusch
      stand.texte(du: text, alfred: '');
      _zeile(Eintrag(Art.du, '🗣 $text'));
      await _senden(text: text, sprechen: true, tier: _uStufe);
      if (identical(unterhaltung, stand)) _neu(() => stand.wechsel++);
    } catch (e) {
      _zeile(Eintrag(Art.fehler, '🗣 $e'));
    } finally {
      uBeschaeftigt = false;
      uRuheBis = DateTime.now().add(const Duration(milliseconds: 350)); // Nachhall der letzten Silbe nicht als neuen Satz nehmen
      uErkenner?.zuruecksetzen();
      if (identical(unterhaltung, stand)) stand.phase = UPhase.hoert;
    }
  }

  /// Kugel antippen: Alfred sofort unterbrechen (Antwort und Vorlesen) und wieder zuhören.
  Future<void> _unterhaltungUnterbrechen() async {
    final stand = unterhaltung; if (stand == null) return;
    if (antwortet) { await _abbrechen(); }
    else if (audio.spielt) { vorleserLaufend?.stopp(); await audio.abbrechen(); }
    else if (stand.stumm) { stand.stumm = false; }
  }

  void _unterhaltungStumm() { final st = unterhaltung; if (st == null) return; st.stumm = !st.stumm; uErkenner?.zuruecksetzen(); }

  Future<void> _unterhaltungEnde() async {
    final stand = unterhaltung; if (stand == null) return;
    _neu(() => unterhaltung = null);
    uErkenner = null;
    if (antwortet) { await _abbrechen(); } else { vorleserLaufend?.stopp(); await audio.abbrechen(); }
    await audio.stromStop();
    _protokolliere(Eintrag(Art.hinweis, '🗣 Unterhaltung beendet (${stand.wechsel} Wortwechsel)'));
    stand.dispose();
  }
}
