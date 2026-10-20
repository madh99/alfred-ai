/// 1.71.0 (Owner 20.10.: „1–5 wie vorgeschlagen“) — Kosten in den Apps: Verlauf je Tag (LLM), Aufteilung je Modell, Budget,
/// und getrennt davon die Code-Agenten (Claude Code, Codex …) und die Herkunft. Code-Agenten zählen zu den Gesamtkosten, nie zum
/// API-Tagesbudget (Owner-Regel). Daten: /api/geraete/nutzung (Tage × Modelle) und /api/geraete/konto (Agenten, Herkunft, Budget).
library;

import 'dart:math';

import 'package:flutter/material.dart';

import 'aufgaben.dart' show JsonAbruf;

String usd(num? v) => v == null ? '—' : '${v.toStringAsFixed(v >= 100 ? 0 : 2)} \$';

/// Summe je Modell über alle Tage, absteigend.
List<({String modell, double usd, int aufrufe})> summeJeModell(List<Map<String, dynamic>> tage) {
  final m = <String, ({double usd, int aufrufe})>{};
  for (final t in tage) {
    for (final r in ((t['models'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>()) {
      final k = '${r['model']}';
      final alt = m[k] ?? (usd: 0.0, aufrufe: 0);
      m[k] = (usd: alt.usd + ((r['costUsd'] as num?) ?? 0).toDouble(), aufrufe: alt.aufrufe + ((r['calls'] as num?) ?? 0).toInt());
    }
  }
  return [for (final e in m.entries) (modell: e.key, usd: e.value.usd, aufrufe: e.value.aufrufe)]..sort((a, b) => b.usd.compareTo(a.usd));
}

class KostenAnsicht extends StatefulWidget {
  const KostenAnsicht({super.key, required this.json});
  final JsonAbruf json;
  @override
  State<KostenAnsicht> createState() => _KostenAnsichtState();
}

class _KostenAnsichtState extends State<KostenAnsicht> {
  int tage = 30;
  Map<String, dynamic>? nutzung, konto;
  String? fehler;

  @override
  void initState() { super.initState(); _laden(); }

  Future<void> _laden() async {
    try {
      final n = await widget.json('/api/geraete/nutzung?tage=$tage');
      Map<String, dynamic>? k;
      try { k = await widget.json('/api/geraete/konto'); } catch (_) { k = null; }
      if (mounted) setState(() { nutzung = n; konto = k; fehler = null; });
    } catch (e) { if (mounted) setState(() => fehler = '$e'); }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    if (nutzung == null && fehler == null) return const Center(child: CircularProgressIndicator());
    final liste = ((nutzung?['tage'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>();
    final summe = liste.fold<double>(0, (s, x) => s + ((x['totalCostUsd'] as num?) ?? 0).toDouble());
    final modelle = summeJeModell(liste);
    final k = konto?['kosten'] as Map<String, dynamic>?;
    final agenten = ((k?['agenten'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>();
    final herkunft = ((k?['herkunftMonat'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>();
    final budget = (k?['tagesbudgetUsd'] as num?)?.toDouble();
    final llm = k?['llm'] as Map<String, dynamic>?;
    final dim = t.colorScheme.onSurfaceVariant;
    Widget karte(String titel, Widget kind) => Card(elevation: 0, color: t.colorScheme.surfaceContainerLow, margin: const EdgeInsets.only(bottom: 12),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18), side: BorderSide(color: t.colorScheme.outlineVariant.withValues(alpha: 0.6))),
      child: Padding(padding: const EdgeInsets.all(14), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(titel, style: t.textTheme.titleSmall), const SizedBox(height: 8), kind])));
    return RefreshIndicator(onRefresh: _laden, child: ListView(padding: const EdgeInsets.fromLTRB(12, 12, 12, 24), children: [
      if (fehler != null) Text('Kosten: $fehler', style: TextStyle(color: t.colorScheme.error)),
      SegmentedButton<int>(segments: const [ButtonSegment(value: 7, label: Text('7 Tage')), ButtonSegment(value: 30, label: Text('30 Tage')), ButtonSegment(value: 90, label: Text('90 Tage'))],
        selected: {tage}, onSelectionChanged: (s) { setState(() => tage = s.first); _laden(); }),
      const SizedBox(height: 12),
      karte('Modelle (API) · $tage Tage', Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Wrap(spacing: 16, runSpacing: 6, children: [
          _zahl(t, usd(summe), 'gesamt'),
          _zahl(t, usd(liste.isEmpty ? 0 : summe / max(1, liste.length)), 'je Tag'),
          if (llm != null) _zahl(t, usd(llm['heute'] as num?), budget != null ? 'heute von ${usd(budget)}' : 'heute'),
        ]),
        const SizedBox(height: 12),
        SizedBox(height: 120, child: CustomPaint(size: Size.infinite, painter: _Balken([for (final x in liste) ((x['totalCostUsd'] as num?) ?? 0).toDouble()], t.colorScheme.primary, budget, t.colorScheme.error))),
        if (liste.isNotEmpty) Row(children: [Text('${liste.first['date']}', style: t.textTheme.labelSmall?.copyWith(color: dim)), const Spacer(), Text('${liste.last['date']}', style: t.textTheme.labelSmall?.copyWith(color: dim))]),
      ])),
      karte('Je Modell', Column(children: [
        if (modelle.isEmpty) const Text('Keine Nutzung im Zeitraum.'),
        for (final m in modelle.take(12)) Padding(padding: const EdgeInsets.only(bottom: 8), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [Expanded(child: Text(m.modell, style: t.textTheme.bodySmall, overflow: TextOverflow.ellipsis)), Text('${usd(m.usd)} · ${m.aufrufe}×', style: t.textTheme.bodySmall?.copyWith(color: dim))]),
          const SizedBox(height: 3),
          ClipRRect(borderRadius: BorderRadius.circular(3), child: LinearProgressIndicator(value: summe <= 0 ? 0 : m.usd / summe, minHeight: 5)),
        ])),
      ])),
      if (agenten.isNotEmpty) karte('Code-Agenten (zählen nicht zum API-Budget)', Column(children: [
        for (final a in agenten) Padding(padding: const EdgeInsets.only(bottom: 6), child: Row(children: [
          Expanded(child: Text('${a['agent']}', style: t.textTheme.bodySmall)),
          Text('heute ${usd(a['heute'] as num?)} · Woche ${usd(a['woche'] as num?)} · Monat ${usd(a['monat'] as num?)}', style: t.textTheme.bodySmall?.copyWith(color: dim)),
        ])),
      ])),
      if (herkunft.isNotEmpty) karte('Wofür (Monat)', Column(children: [
        for (final h in herkunft.take(10)) Padding(padding: const EdgeInsets.only(bottom: 6), child: Row(children: [
          Expanded(child: Text('${h['herkunft']}', style: t.textTheme.bodySmall, overflow: TextOverflow.ellipsis)),
          Text('${usd(h['kosten'] as num?)} · ${h['aufrufe']}×', style: t.textTheme.bodySmall?.copyWith(color: dim)),
        ])),
      ])),
      if (k != null) Text('Gesamt inkl. Agenten: heute ${usd(k['heute'] as num?)} · Woche ${usd(k['woche'] as num?)} · Monat ${usd(k['monat'] as num?)}', style: t.textTheme.bodySmall?.copyWith(color: dim)),
    ]));
  }

  Widget _zahl(ThemeData t, String wert, String text) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
    Text(wert, style: t.textTheme.titleLarge), Text(text, style: t.textTheme.labelSmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
  ]);
}

/// Tageskosten als Balken; über dem Tagesbudget rot, Budget als gestrichelte Linie.
class _Balken extends CustomPainter {
  _Balken(this.werte, this.farbe, this.budget, this.warn);
  final List<double> werte;
  final Color farbe, warn;
  final double? budget;
  @override
  void paint(Canvas c, Size s) {
    if (werte.isEmpty) return;
    final hoechst = max(werte.reduce(max), budget ?? 0) * 1.1;
    if (hoechst <= 0) return;
    final b = s.width / werte.length;
    for (var i = 0; i < werte.length; i++) {
      final h = s.height * werte[i] / hoechst;
      c.drawRRect(RRect.fromRectAndRadius(Rect.fromLTWH(i * b + b * 0.15, s.height - h, b * 0.7, h), const Radius.circular(2)), Paint()..color = budget != null && werte[i] > budget! ? warn : farbe);
    }
    if (budget != null) {
      final y = s.height - s.height * budget! / hoechst;
      final p = Paint()..color = warn.withValues(alpha: 0.7)..strokeWidth = 1;
      for (var x = 0.0; x < s.width; x += 8) { c.drawLine(Offset(x, y), Offset(min(x + 4, s.width), y), p); }
    }
  }
  @override
  bool shouldRepaint(covariant _Balken alt) => alt.werte != werte || alt.budget != budget;
}
