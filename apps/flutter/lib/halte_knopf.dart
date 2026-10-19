/// 1.53.0+91 (Owner 19.10.) — Mikrofonknopf am Handy: Antippen und Halten getrennt, über rohe Fingerereignisse.
/// Realfall Build 90: Mit Kurzinfo (Tooltip) am Knopf zeigte langes Drücken nur die Kurzinfo — sie nahm die Halte-Geste für
/// sich, die Aufnahme startete nie. Hier gibt es keine Kurzinfo und keine Gestenkonkurrenz: Finger auf → nach [halteZeit] gilt
/// es als Halten ([aufHalten]); Finger ab → [aufLoslassen]. Ein kurzer Druck bleibt ein Tipp ([aufTipp]); nach einem Halten
/// löst das Loslassen keinen zusätzlichen Tipp aus.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

class HalteKnopf extends StatefulWidget {
  const HalteKnopf({super.key, required this.icon, required this.aufTipp, required this.aufHalten, required this.aufLoslassen, this.halteZeit = const Duration(milliseconds: 400), this.aktiv = true});
  final Widget icon;
  final VoidCallback aufTipp;
  final VoidCallback aufHalten;
  final VoidCallback aufLoslassen;
  final Duration halteZeit;
  /// false: Halten ist gesperrt (z. B. während einer Antwort oder eines Diktats); Tipps gehen weiter durch
  final bool aktiv;

  @override
  State<HalteKnopf> createState() => _HalteKnopfState();
}

class _HalteKnopfState extends State<HalteKnopf> {
  Timer? _timer;
  bool _gehalten = false;
  bool _tippIgnorieren = false;

  void _runter(PointerDownEvent _) {
    _timer?.cancel();
    if (!widget.aktiv) return;
    _timer = Timer(widget.halteZeit, () {
      _gehalten = true;
      HapticFeedback.mediumImpact();
      widget.aufHalten();
    });
  }

  void _hoch(PointerEvent _) {
    _timer?.cancel(); _timer = null;
    if (!_gehalten) return;
    _gehalten = false;
    _tippIgnorieren = true;
    Future.delayed(const Duration(milliseconds: 400), () => _tippIgnorieren = false); // falls kein Tipp folgt
    widget.aufLoslassen();
  }

  void _tipp() {
    if (_tippIgnorieren) { _tippIgnorieren = false; return; }
    widget.aufTipp();
  }

  @override
  void dispose() { _timer?.cancel(); super.dispose(); }

  @override
  Widget build(BuildContext context) => Listener(
    onPointerDown: _runter, onPointerUp: _hoch, onPointerCancel: _hoch,
    child: IconButton(onPressed: _tipp, icon: widget.icon, visualDensity: VisualDensity.compact),
  );
}
