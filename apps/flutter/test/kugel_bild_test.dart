// 1.68.0 — Sichtprüfung der Shader-Kugel: rendert Zustände als PNG nach build/kugel_*.png (nur mit ALFRED_KUGEL_BILD=1).
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final an = Platform.environment['ALFRED_KUGEL_BILD'] == '1';
  testWidgets('Kugel als Bild', (t) async {
    final p = await ui.FragmentProgram.fromAsset('shaders/kugel.frag');
    Future<void> bild(String name, List<double> w) async {
      final sh = p.fragmentShader();
      final rec = ui.PictureRecorder();
      final c = Canvas(rec);
      const g = 280.0;
      sh.setFloat(0, g); sh.setFloat(1, g);
      for (var i = 0; i < w.length; i++) { sh.setFloat(2 + i, w[i]); }
      c.drawRect(const Rect.fromLTWH(0, 0, g, g), Paint()..shader = sh);
      final img = await rec.endRecording().toImage(g.toInt(), g.toInt());
      final png = await img.toByteData(format: ui.ImageByteFormat.png);
      File('build/kugel_$name.png')..createSync(recursive: true)..writeAsBytesSync(png!.buffer.asUint8List());
    }
    const bg = [0.043, 0.078, 0.149];
    const blau = [0.231, 0.549, 1.0], gelb = [1.0, 0.655, 0.149];
    await t.runAsync(() async {
      await bild('hoert', [3.0, 0.5, 0.6, 0.3, 0.2, 1, 0, 0, 0, ...blau, ...bg]);
      await bild('denkt', [5.0, 0.0, 0, 0, 0, 0, 1, 0, 0, ...blau, ...bg]);
      await bild('spricht', [7.3, 0.8, 0, 0, 0, 0, 0, 1, 0, ...blau, ...bg]);
      await bild('warnung', [7.3, 0.6, 0, 0, 0, 0, 0, 1, 0, ...gelb, ...bg]);
      await bild('stumm', [2.0, 0.0, 0, 0, 0, 0, 0, 0, 1, ...blau, ...bg]);
    });
  }, skip: !an);
}
