/// 1.58.0 G1 (Owner 20.10.: „wie empfohlen g1–g4 freigegeben“) — Unterhaltungsmodus: freies Gespräch mit Alfred.
/// Eine Kugel in der Mitte zeigt, was gerade passiert (zuhören, verstehen, nachdenken, sprechen). Halbduplex: während Alfred
/// spricht, hört er nicht zu (sonst transkribiert er sich selbst); Antippen der Kugel unterbricht ihn. Alles Gesagte steht
/// danach ganz normal im Chat. Die Steuerung (Mikrofon, Satzende, Senden) liegt in sitzung_unterhaltung.dart.
library;

import 'dart:math';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

enum UPhase { hoert, versteht, denkt, spricht }

class UnterhaltungsStand extends ChangeNotifier {
  UPhase _phase = UPhase.hoert;
  bool _stumm = false;
  String du = '', alfred = '';
  int wechsel = 0;
  /// Lautstärke des Mikrofons 0..1 (für die Kugel), träge geglättet
  double pegel = 0;
  /// 1.68.0 B — Frequenzbänder des Mikrofons 0..1 (tief, mittel, hoch), geglättet
  double tief = 0, mittel = 0, hoch = 0;
  final Baender _baender = Baender();
  /// 1.68.0 E — Stimmung der laufenden Antwort (aus dem Text, feste Regeln)
  Stimmung stimmung = Stimmung.neutral;

  UPhase get phase => _phase;
  bool get stumm => _stumm;
  set phase(UPhase p) { if (p != _phase) { _phase = p; notifyListeners(); } }
  set stumm(bool s) { if (s != _stumm) { _stumm = s; if (s) pegel = 0; notifyListeners(); } }
  void texte({String? du, String? alfred}) {
    if (du != null) this.du = du;
    if (alfred != null) { this.alfred = alfred; stimmung = alfred.isEmpty ? Stimmung.neutral : stimmungAus(alfred); }
    notifyListeners();
  }
  void neuerPegel(double roh) { pegel = roh > pegel ? pegel * 0.4 + roh * 0.6 : pegel * 0.85 + roh * 0.15; }
  /// 1.68.0 B — Mikrofonblock in Bänder zerlegen und glätten
  void neueBaender(Uint8List pcm) {
    final (t, m, h) = _baender.schiebe(pcm);
    double glatt(double alt, double neu) => neu > alt ? alt * 0.5 + neu * 0.5 : alt * 0.85 + neu * 0.15;
    tief = glatt(tief, t); mittel = glatt(mittel, m); hoch = glatt(hoch, h);
  }
  /// ohne neue Blöcke (Alfred spricht, stumm) klingen die Bänder ab
  void abklingen() { tief *= 0.9; mittel *= 0.9; hoch *= 0.9; }
}

/// 1.68.0 B — drei einfache Bänder aus 16-kHz-PCM: Tiefpass ~300 Hz (Stimmgrund), Rest bis ~2 kHz (Vokale), darüber (Zischlaute).
/// Zwei einpolige Tiefpässe, Zustand bleibt zwischen den Blöcken erhalten. Ergebnis je Band 0..1 wie [pegelAusRms].
class Baender {
  double _lp300 = 0, _lp2000 = 0;
  static const double _a300 = 0.111, _a2000 = 0.545; // 1 - e^(-2π·fc/fs) für fs 16 kHz
  (double, double, double) schiebe(Uint8List pcm) {
    final n = pcm.length ~/ 2;
    if (n == 0) return (0, 0, 0);
    final bd = ByteData.sublistView(pcm);
    var st = 0.0, sm = 0.0, sh = 0.0;
    for (var i = 0; i < n; i++) {
      final x = bd.getInt16(i * 2, Endian.little).toDouble();
      _lp300 += _a300 * (x - _lp300);
      _lp2000 += _a2000 * (x - _lp2000);
      final t = _lp300, m = _lp2000 - _lp300, h = x - _lp2000;
      st += t * t; sm += m * m; sh += h * h;
    }
    // hohe Anteile sind leiser — angehoben, damit Zischlaute sichtbar werden
    return (pegelAusRms(sqrt(st / n)), pegelAusRms(sqrt(sm / n) * 1.4), pegelAusRms(sqrt(sh / n) * 2.5));
  }
}

/// 1.68.0 E — Stimmung einer Antwort nach festen Regeln (modellunabhängig): Warnung vor Erledigt vor Neutral.
enum Stimmung { neutral, warnung, erledigt }
final _warnung = RegExp(r'⚠|❌|🚨|\b(achtung|warnung|fehler|störung|ausgefallen|nicht erreichbar|dringend|offline|kritisch|gescheitert|fehlgeschlagen)\b', caseSensitive: false);
final _erledigt = RegExp(r'✅|\b(erledigt|abgelegt|gespeichert|eingeschaltet|ausgeschaltet|gesendet|eingetragen|geplant|fertig|erfolgreich)\b', caseSensitive: false);
Stimmung stimmungAus(String text) => _warnung.hasMatch(text) ? Stimmung.warnung : _erledigt.hasMatch(text) ? Stimmung.erledigt : Stimmung.neutral;
Color stimmungsFarbe(Stimmung s) => switch (s) { Stimmung.neutral => const Color(0xFF3B8CFF), Stimmung.warnung => const Color(0xFFFFA726), Stimmung.erledigt => const Color(0xFF2EC27E) };

/// RMS eines PCM-Blocks (16 Bit) → 0..1, logarithmisch: Ruhe (~100) ≈ 0, normale Sprache (~3000) ≈ 0,7, laut (≥ 10000) = 1.
double pegelAusRms(double rms) {
  if (rms <= 100) return 0;
  return (log(rms / 100) / log(100)).clamp(0.0, 1.0);
}

/// 1.60.0 G3 — Ins Wort fallen: Während Alfred spricht, zählt nur deutlich laute, anhaltende Sprache als Unterbrechung
/// (nach der Echounterdrückung bleibt von Alfreds Stimme ein Rest; kurze Geräusche, Husten, ein „mhm“ zählen nicht).
/// Hält die letzten [vorlaufMs] Ton vor, damit der Anfang des Satzes, der unterbricht, nicht verloren geht.
class InsWortErkenner {
  InsWortErkenner({this.mindestSchwelle = 1500, this.haltenMs = 450, this.vorlaufMs = 700});
  final double mindestSchwelle;
  final int haltenMs, vorlaufMs;
  int _lautMs = 0;
  final List<Uint8List> _vorlauf = [];
  int _vorlaufBytes = 0;

  /// Block während der Wiedergabe; true = unterbrechen. `schwelle` = Sprechschwelle des Satzende-Erkenners (Grundpegel × Faktor).
  bool schiebe(Uint8List pcm, double rms, {double schwelle = 0}) {
    final ms = pcm.length ~/ 32; // 16 kHz, 16 Bit mono = 32 Bytes je ms
    _vorlauf.add(pcm); _vorlaufBytes += pcm.length;
    while (_vorlaufBytes > vorlaufMs * 32 && _vorlauf.length > 1) { _vorlaufBytes -= _vorlauf.removeAt(0).length; }
    final grenze = max(mindestSchwelle, schwelle * 2);
    _lautMs = rms >= grenze ? _lautMs + ms : max(0, _lautMs - ms * 2); // Pausen zwischen Silben bauen schneller ab als Sprache auf
    if (_lautMs < haltenMs) return false;
    _lautMs = 0;
    return true;
  }

  /// Ton vor und während der Unterbrechung (geht an den Satzende-Erkenner), danach leer.
  Uint8List nimmVorlauf() { final b = BytesBuilder(copy: false); for (final x in _vorlauf) { b.add(x); } _vorlauf.clear(); _vorlaufBytes = 0; return b.takeBytes(); }
  void zuruecksetzen() { _lautMs = 0; _vorlauf.clear(); _vorlaufBytes = 0; }
}

/// Text unter der Kugel.
String phasenText(UPhase p, {required bool stumm, bool insWort = false}) => stumm
    ? 'Mikrofon stumm'
    : switch (p) {
        UPhase.hoert => 'Ich höre zu …',
        UPhase.versteht => 'Verstehe …',
        UPhase.denkt => 'Denke nach …',
        UPhase.spricht => insWort ? 'Sprich einfach dazwischen' : 'Antippen unterbricht',
      };

class UnterhaltungsAnsicht extends StatefulWidget {
  const UnterhaltungsAnsicht({super.key, required this.stand, required this.spielt, required this.aufKugel, required this.aufStumm, required this.aufBeenden, this.stufe, this.insWort = false, this.ausgabePegel});
  final UnterhaltungsStand stand;
  /// Wiedergabe läuft gerade (jedes Bild abgefragt, damit die Kugel im Takt der Ausgabe schwingt)
  final bool Function() spielt;
  final VoidCallback aufKugel, aufStumm, aufBeenden;
  final String? stufe;
  /// 1.60.0 G3 — Ins-Wort-Fallen ist an
  final bool insWort;
  /// 1.68.0 A — Lautstärke von Alfreds Ausgabe 0..1 (iPhone); negativ = unbekannt (Desktop), dann ein ruhiges Muster
  final Future<double> Function()? ausgabePegel;

  @override
  State<UnterhaltungsAnsicht> createState() => _UnterhaltungsAnsichtState();
}

class _UnterhaltungsAnsichtState extends State<UnterhaltungsAnsicht> with SingleTickerProviderStateMixin {
  late final AnimationController _takt = AnimationController(vsync: this, duration: const Duration(seconds: 1))..repeat();
  // 1.68.0 C — Shader einmal laden; scheitert das, bleibt die gezeichnete Kugel
  static Future<ui.FragmentProgram?>? _programm;
  ui.FragmentShader? _shader;
  // 1.68.0 D — Zustände als gleitende Gewichte, damit Übergänge fließen
  double _gHoert = 1, _gDenkt = 0, _gSpricht = 0, _gStumm = 0, _ausgabe = 0;
  Color _farbe = stimmungsFarbe(Stimmung.neutral);
  bool _pegelLaeuft = false;
  final DateTime _start = DateTime.now();

  @override
  void initState() {
    super.initState();
    _programm ??= ui.FragmentProgram.fromAsset('shaders/kugel.frag').then<ui.FragmentProgram?>((p) => p).catchError((Object _) => null);
    _programm!.then((p) { if (mounted && p != null) setState(() => _shader = p.fragmentShader()); });
  }

  @override
  void dispose() { _takt.dispose(); _shader?.dispose(); super.dispose(); }

  /// Ein Bild weiter: Gewichte und Farbe nachführen, Alfreds Ausgabepegel abfragen (ohne Überlappung)
  void _schritt(UnterhaltungsStand st, UPhase phase, bool spielt) {
    double naeher(double ist, double soll, [double k = 0.12]) => ist + (soll - ist) * k;
    _gHoert = naeher(_gHoert, !st.stumm && (phase == UPhase.hoert || phase == UPhase.versteht) ? 1 : 0);
    _gDenkt = naeher(_gDenkt, phase == UPhase.denkt ? 1 : 0, 0.08);
    _gSpricht = naeher(_gSpricht, phase == UPhase.spricht ? 1 : 0);
    _gStumm = naeher(_gStumm, st.stumm ? 1 : 0);
    _farbe = Color.lerp(_farbe, stimmungsFarbe(st.stimmung), 0.06)!;
    final f = widget.ausgabePegel;
    if (spielt && f != null && !_pegelLaeuft) {
      _pegelLaeuft = true;
      f().then((v) { _ausgabe = v < 0 ? -1 : (v > _ausgabe ? _ausgabe * 0.3 + v * 0.7 : _ausgabe * 0.75 + v * 0.25); }).whenComplete(() => _pegelLaeuft = false);
    }
    if (!spielt) _ausgabe *= 0.85;
  }

  double _zeit() => DateTime.now().difference(_start).inMilliseconds / 1000;

  /// Lautstärke, die die Kugel bewegt: beim Sprechen Alfreds Ausgabe (unbekannt: ruhiges Silbenmuster), sonst das Mikrofon
  double _pegelFuer(UPhase phase, UnterhaltungsStand st, double t) {
    if (phase != UPhase.spricht) return st.stumm ? 0 : st.pegel;
    if (_ausgabe >= 0) return _ausgabe;
    return 0.35 + (sin(t * 2 * pi * 2.1) * 0.5 + sin(t * 2 * pi * 3.3) * 0.5).abs() * 0.4;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    const tief = Color(0xFF0B1426);
    return Material(
      key: const Key('unterhaltung'),
      color: tief,
      child: SafeArea(child: ListenableBuilder(listenable: widget.stand, builder: (context, _) {
        final st = widget.stand;
        final phase = widget.spielt() ? UPhase.spricht : st.phase;
        final weiss = Colors.white.withValues(alpha: 0.92);
        final blass = Colors.white.withValues(alpha: 0.55);
        return Column(children: [
          Padding(padding: const EdgeInsets.fromLTRB(20, 12, 12, 0), child: Row(children: [
            Icon(Icons.graphic_eq, color: blass, size: 18),
            const SizedBox(width: 8),
            Text('Unterhaltung${widget.stufe == null ? '' : ' · ${widget.stufe}'}', style: theme.textTheme.titleSmall?.copyWith(color: blass)),
            const Spacer(),
            if (st.wechsel > 0) Text('${st.wechsel} Wortwechsel', style: theme.textTheme.bodySmall?.copyWith(color: blass)),
          ])),
          const Spacer(),
          GestureDetector(
            key: const Key('kugel'),
            behavior: HitTestBehavior.opaque,
            onTap: widget.aufKugel,
            child: AnimatedBuilder(animation: _takt, builder: (context, _) {
              st.neuerPegel(0); // ohne neue Blöcke klingt die Kugel ab
              final spielt = widget.spielt();
              final ph = spielt ? UPhase.spricht : st.phase;
              if (ph == UPhase.spricht || st.stumm) st.abklingen();
              _schritt(st, ph, spielt);
              final t = _zeit();
              final sh = _shader;
              if (sh == null) return CustomPaint(size: const Size(240, 240), painter: _Kugel(phase: ph, stumm: st.stumm, pegel: _pegelFuer(ph, st, t), t: t));
              return CustomPaint(size: const Size(280, 280), painter: _KugelShader(sh, [
                t, _pegelFuer(ph, st, t), st.tief, st.mittel, st.hoch, _gHoert, _gDenkt, _gSpricht, _gStumm,
                _farbe.r, _farbe.g, _farbe.b, tief.r, tief.g, tief.b,
              ]));
            }),
          ),
          const SizedBox(height: 28),
          Text(phasenText(phase, stumm: st.stumm, insWort: widget.insWort), key: const Key('unterhaltung-phase'), style: theme.textTheme.titleMedium?.copyWith(color: weiss)),
          const SizedBox(height: 16),
          Padding(padding: const EdgeInsets.symmetric(horizontal: 28), child: Column(children: [
            if (st.du.isNotEmpty) Text(st.du, textAlign: TextAlign.center, maxLines: 2, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodyMedium?.copyWith(color: blass)),
            if (st.alfred.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 8), child: Text(st.alfred, textAlign: TextAlign.center, maxLines: 3, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodyMedium?.copyWith(color: weiss))),
          ])),
          const Spacer(),
          Padding(padding: const EdgeInsets.only(bottom: 24), child: Row(mainAxisAlignment: MainAxisAlignment.spaceEvenly, children: [
            _rund(key: const Key('unterhaltung-stumm'), icon: st.stumm ? Icons.mic_off : Icons.mic, tooltip: st.stumm ? 'Mikrofon an' : 'Mikrofon stumm', aktiv: st.stumm, onTap: widget.aufStumm),
            _rund(key: const Key('unterhaltung-ende'), icon: Icons.close, tooltip: 'Unterhaltung beenden', aktiv: false, onTap: widget.aufBeenden, rot: true),
          ])),
        ]);
      })),
    );
  }

  Widget _rund({required Key key, required IconData icon, required String tooltip, required bool aktiv, required VoidCallback onTap, bool rot = false}) {
    final hinter = rot ? const Color(0xFFB3261E) : aktiv ? Colors.white : Colors.white.withValues(alpha: 0.14);
    return Tooltip(message: tooltip, child: Material(color: hinter, shape: const CircleBorder(), child: InkWell(key: key, customBorder: const CircleBorder(), onTap: onTap,
      child: SizedBox(width: 64, height: 64, child: Icon(icon, size: 28, color: aktiv && !rot ? const Color(0xFF0B1426) : Colors.white)))));
  }
}

class _Kugel extends CustomPainter {
  _Kugel({required this.phase, required this.stumm, required this.pegel, required this.t});
  final UPhase phase;
  final bool stumm;
  final double pegel, t;

  @override
  void paint(Canvas canvas, Size size) {
    final mitte = size.center(Offset.zero);
    final basis = size.shortestSide * 0.32;
    final atmen = sin(t * 2 * pi / 3) * 0.03; // ruhiges Atmen in jeder Phase
    final schwung = switch (phase) {
      UPhase.hoert => stumm ? 0.0 : pegel * 0.28,
      UPhase.versteht => 0.06 + sin(t * 2 * pi * 1.2) * 0.04,
      UPhase.denkt => 0.0,
      UPhase.spricht => 0.10 + (sin(t * 2 * pi * 2.1) * 0.5 + sin(t * 2 * pi * 3.3) * 0.5).abs() * 0.12,
    };
    final r = basis * (1 + atmen + schwung);
    final hell = stumm ? const Color(0xFF6B7A90) : const Color(0xFF7CC4FF);
    final kraeftig = stumm ? const Color(0xFF3A4556) : const Color(0xFF1F6FEB);
    // Schein außen
    canvas.drawCircle(mitte, r * 1.45, Paint()..shader = RadialGradient(colors: [hell.withValues(alpha: 0.28), hell.withValues(alpha: 0)]).createShader(Rect.fromCircle(center: mitte, radius: r * 1.45)));
    // Kugel
    canvas.drawCircle(mitte, r, Paint()..shader = RadialGradient(center: const Alignment(-0.35, -0.4), colors: [Colors.white.withValues(alpha: 0.95), hell, kraeftig], stops: const [0, 0.35, 1]).createShader(Rect.fromCircle(center: mitte, radius: r)));
    if (phase == UPhase.denkt) { // drehender Lichtbogen
      final bogen = Paint()..style = PaintingStyle.stroke..strokeWidth = 4..strokeCap = StrokeCap.round..color = Colors.white.withValues(alpha: 0.75);
      final a = t * 2 * pi * 0.8;
      canvas.drawArc(Rect.fromCircle(center: mitte, radius: r * 1.18), a, pi * 0.6, false, bogen);
      canvas.drawArc(Rect.fromCircle(center: mitte, radius: r * 1.18), a + pi, pi * 0.6, false, bogen..color = Colors.white.withValues(alpha: 0.35));
    }
  }

  @override
  bool shouldRepaint(covariant _Kugel alt) => true;
}

/// 1.68.0 C — die Shader-Kugel: Größe + Werte in der Reihenfolge der Uniforms von shaders/kugel.frag.
class _KugelShader extends CustomPainter {
  _KugelShader(this.shader, this.werte);
  final ui.FragmentShader shader;
  final List<double> werte;

  @override
  void paint(Canvas canvas, Size size) {
    shader.setFloat(0, size.width);
    shader.setFloat(1, size.height);
    for (var i = 0; i < werte.length; i++) { shader.setFloat(2 + i, werte[i]); }
    canvas.drawRect(Offset.zero & size, Paint()..shader = shader);
  }

  @override
  bool shouldRepaint(covariant _KugelShader alt) => true;
}
