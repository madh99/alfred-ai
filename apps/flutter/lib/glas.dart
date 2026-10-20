/// 1.69.0 — Milchglas und Größenmessung, gemeinsam für Chat und Lage.
library;

import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
/// 1.69.0 — Milchglas (Weg A): weichgezeichneter Hintergrund, halbdurchsichtige Fläche, feiner heller Rand.
class Glas extends StatelessWidget {
  const Glas({super.key, required this.child, this.radius = 23, this.rund = false});
  final Widget child;
  final double radius;
  final bool rund;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final hell = theme.brightness == Brightness.light;
    final br = BorderRadius.circular(rund ? 999 : radius);
    return DecoratedBox(
      decoration: BoxDecoration(borderRadius: br, boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: hell ? 0.08 : 0.35), blurRadius: 18, offset: const Offset(0, 4))]),
      child: ClipRRect(borderRadius: br, child: BackdropFilter(
        filter: ui.ImageFilter.blur(sigmaX: 18, sigmaY: 18),
        child: DecoratedBox(
          decoration: BoxDecoration(
            borderRadius: br,
            color: (hell ? Colors.white : theme.colorScheme.surfaceContainerHigh).withValues(alpha: hell ? 0.62 : 0.55),
            border: Border.all(color: Colors.white.withValues(alpha: hell ? 0.6 : 0.10), width: 0.8),
          ),
          child: child,
        ),
      )),
    );
  }
}

/// 1.69.0 — meldet die Größe des Kindes nach jedem Layout (Abstand des Verlaufs zur schwebenden Eingabe).
class Messen extends SingleChildRenderObjectWidget {
  const Messen({super.key, required this.aufGroesse, super.child});
  final ValueChanged<Size> aufGroesse;
  @override
  RenderObject createRenderObject(BuildContext context) => _MessenBox(aufGroesse);
  @override
  void updateRenderObject(BuildContext context, covariant _MessenBox r) { r.aufGroesse = aufGroesse; }
}

class _MessenBox extends RenderProxyBox {
  _MessenBox(this.aufGroesse);
  ValueChanged<Size> aufGroesse;
  Size? _alt;
  @override
  void performLayout() {
    super.performLayout();
    if (size != _alt) { _alt = size; final g = size; WidgetsBinding.instance.addPostFrameCallback((_) => aufGroesse(g)); }
  }
}
