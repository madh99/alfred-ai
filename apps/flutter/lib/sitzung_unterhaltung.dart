part of 'main.dart';

/// 1.58.0 G1/G2/G4 — Unterhaltungsmodus: Mikrofonstrom → Satzende lokal (wie Echtzeit-Hören, aber ohne Relais und ohne
/// Aktivierungswort — jeder Satz ist an Alfred gerichtet) → Spracherkennung am Server → Antwort wird beim Entstehen
/// vorgelesen → wieder zuhören. Halbduplex: während Alfred denkt oder spricht, wird das Mikrofon ignoriert (es läuft weiter,
/// damit iOS die Audiositzung bei gesperrtem Bildschirm nicht beendet — G2). Standard ist die schnelle Stufe, außer der
/// Owner hat in der Eingabekarte ausdrücklich eine gewählt.
extension _Unterhaltung on _SitzungState {
  String get _uStufe => tierWahl ?? 'fast';

  /// 1.67.0 — „Hey Siri, Unterhaltung mit Alfred“: Wunsch abholen; nach einem kalten Start erst auf die Verbindung warten.
  Future<void> _unterhaltungAusSiri() async {
    if (!istHandy || !await handyUnterhaltungAusstehend()) return;
    for (var i = 0; i < 60 && (server == null || satellit?.verbunden != true); i++) { await Future<void>.delayed(const Duration(milliseconds: 250)); }
    if (mounted) await _unterhaltungStart();
  }

  Future<void> _unterhaltungStart() async {
    if (unterhaltung != null) return;
    if (server == null) { _zeile(Eintrag(Art.fehler, 'Noch nicht verbunden — $ipcZustand')); return; }
    if (antwortet) return;
    if (hoeren) await _hoerenStop(null); // Desktop: Aktivierungswort-Zuhören und Unterhaltung teilen sich das Mikrofon
    if (aufnahme) { await audio.stop(); _neu(() { aufnahme = false; diktat = false; fluechtig = ''; }); }
    fokus.unfocus(); // 1.67.5 — Tastatur zu, die Unterhaltung liegt über dem Chat
    final stand = UnterhaltungsStand();
    final erk = SatzendeErkenner(endeMs: 800); // etwas mehr Pause als beim Zuhören: im freien Gespräch denkt man beim Reden
    uErkenner = erk; uBeschaeftigt = false; uUnterbrochen = false; uWartend = null;
    final insWort = istHandy && insWortFallen; // 1.60.0 G3 — nur am iPhone (Echounterdrückung des Systems), Schalter Standard aus
    uInsWort = insWort ? InsWortErkenner() : null;
    bool ok;
    try {
      ok = await audio.stromStart((pcm) => _unterhaltungTon(stand, erk, pcm), (grund) { _zeile(Eintrag(Art.fehler, '🗣 Mikrofon: $grund')); _unterhaltungEnde(); }, echo: insWort);
    } catch (e) { _zeile(Eintrag(Art.fehler, '🗣 Mikrofon: $e')); return; }
    if (!ok) { _zeile(Eintrag(Art.fehler, 'Mikrofon nicht verfügbar oder nicht erlaubt')); return; }
    _neu(() => unterhaltung = stand);
    _protokolliere(Eintrag(Art.hinweis, '🗣 Unterhaltung gestartet (Stufe $_uStufe${insWort ? ', ins Wort fallen an' : ''})'));
  }

  void _unterhaltungTon(UnterhaltungsStand stand, SatzendeErkenner erk, Uint8List pcm) {
    if (!identical(unterhaltung, stand)) return;
    // 1.60.0 G3 — Alfred spricht: laute, anhaltende Sprache unterbricht ihn; der Ton davor geht an den Satzende-Erkenner
    final iw = uInsWort;
    if (iw != null && audio.spielt && !uUnterbrochen && !stand.stumm) {
      if (!iw.schiebe(pcm, rms16(pcm), schwelle: erk.schwelle)) return;
      uUnterbrochen = true;
      _protokolliere(Eintrag(Art.hinweis, '🗣 ins Wort gefallen'));
      vorleserLaufend?.stopp(); audio.abbrechen();
      if (antwortet) _abbrechen();
      erk.zuruecksetzen();
      pcm = iw.nimmVorlauf();
    }
    // unterbrochen: zuhören, auch solange die abgebrochene Antwort noch ausläuft
    final still = stand.stumm || DateTime.now().isBefore(uRuheBis) || (!uUnterbrochen && (uBeschaeftigt || antwortet || audio.spielt));
    if (still) { // Halbduplex — angefangene Äußerung verwerfen, sonst hängt der Nachhall der Ausgabe daran
      if (erk.spricht) erk.zuruecksetzen();
      if (stand.phase == UPhase.versteht) stand.phase = UPhase.hoert;
      return;
    }
    stand.neuerPegel(pegelAusRms(rms16(pcm)));
    for (final ev in erk.schiebe(pcm)) {
      if (ev is SatzStart) { stand.phase = UPhase.versteht; }
      else if (ev is SatzEnde) { _unterhaltungAeusserung(stand, ev.audio); }
      else if (ev is SatzVerworfen) { stand.phase = UPhase.hoert; uUnterbrochen = false; }
    }
  }

  Future<void> _unterhaltungAeusserung(UnterhaltungsStand stand, Uint8List pcm) async {
    final s = server;
    if (s == null) return;
    if (uBeschaeftigt) { if (uUnterbrochen) uWartend = pcm; return; } // G3 — kommt dran, sobald die abgebrochene Antwort beendet ist
    uBeschaeftigt = true; uUnterbrochen = false; uInsWort?.zuruecksetzen();
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
      final w = uWartend; uWartend = null;
      if (w != null && identical(unterhaltung, stand)) {
        Future.microtask(() => _unterhaltungAeusserung(stand, w)); // G3 — der Satz, mit dem der Owner unterbrochen hat
      } else if (uUnterbrochen) {
        if (identical(unterhaltung, stand)) stand.phase = UPhase.versteht; // G3 — Owner spricht noch: Erkenner nicht zurücksetzen
      } else {
        uRuheBis = DateTime.now().add(const Duration(milliseconds: 350)); // Nachhall der letzten Silbe nicht als neuen Satz nehmen
        uErkenner?.zuruecksetzen();
        if (identical(unterhaltung, stand)) stand.phase = UPhase.hoert;
      }
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
    uErkenner = null; uInsWort = null; uUnterbrochen = false; uWartend = null;
    if (antwortet) { await _abbrechen(); } else { vorleserLaufend?.stopp(); await audio.abbrechen(); }
    await audio.stromStop();
    _protokolliere(Eintrag(Art.hinweis, '🗣 Unterhaltung beendet (${stand.wechsel} Wortwechsel)'));
    stand.dispose();
  }
}
