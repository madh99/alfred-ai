/// 1.58.0 G1 (Owner 20.10.: „wie empfohlen g1–g4 freigegeben“) — Unterhaltungsmodus: freies Gespräch mit Alfred.
/// Eine Kugel in der Mitte zeigt, was gerade passiert (zuhören, verstehen, nachdenken, sprechen). Halbduplex: während Alfred
/// spricht, hört er nicht zu (sonst transkribiert er sich selbst); Antippen der Kugel unterbricht ihn. Alles Gesagte steht
/// danach ganz normal im Chat. Die Steuerung (Mikrofon, Satzende, Senden) liegt in sitzung_unterhaltung.dart.
library;

import 'dart:math';
import 'dart:typed_data';

import 'package:flutter/material.dart';

enum UPhase { hoert, versteht, denkt, spricht }

class UnterhaltungsStand extends ChangeNotifier {
  UPhase _phase = UPhase.hoert;
  bool _stumm = false;
  String du = '', alfred = '';
  int wechsel = 0;
  /// Lautstärke des Mikrofons 0..1 (für die Kugel), träge geglättet
  double pegel = 0;

  UPhase get phase => _phase;
  bool get stumm => _stumm;
  set phase(UPhase p) { if (p != _phase) { _phase = p; notifyListeners(); } }
  set stumm(bool s) { if (s != _stumm) { _stumm = s; if (s) pegel = 0; notifyListeners(); } }
  void texte({String? du, String? alfred}) { if (du != null) this.du = du; if (alfred != null) this.alfred = alfred; notifyListeners(); }
  void neuerPegel(double roh) { pegel = roh > pegel ? pegel * 0.4 + roh * 0.6 : pegel * 0.85 + roh * 0.15; }
}

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
  const UnterhaltungsAnsicht({super.key, required this.stand, required this.spielt, required this.aufKugel, required this.aufStumm, required this.aufBeenden, this.stufe, this.insWort = false});
  final UnterhaltungsStand stand;
  /// Wiedergabe läuft gerade (jedes Bild abgefragt, damit die Kugel im Takt der Ausgabe schwingt)
  final bool Function() spielt;
  final VoidCallback aufKugel, aufStumm, aufBeenden;
  final String? stufe;
  /// 1.60.0 G3 — Ins-Wort-Fallen ist an
  final bool insWort;

  @override
  State<UnterhaltungsAnsicht> createState() => _UnterhaltungsAnsichtState();
}

class _UnterhaltungsAnsichtState extends State<UnterhaltungsAnsicht> with SingleTickerProviderStateMixin {
  late final AnimationController _takt = AnimationController(vsync: this, duration: const Duration(seconds: 1))..repeat();

  @override
  void dispose() { _takt.dispose(); super.dispose(); }

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
              return CustomPaint(size: const Size(240, 240), painter: _Kugel(phase: widget.spielt() ? UPhase.spricht : st.phase, stumm: st.stumm, pegel: st.pegel, t: DateTime.now().millisecondsSinceEpoch / 1000));
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
