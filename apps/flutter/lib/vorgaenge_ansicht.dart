/// 1.34.0 — Ansicht „Vorgänge" (Owner 16.10.: „man hat nirgends die Möglichkeit, auf alle offenen Vorgänge zu reagieren — unter
/// Vorgänge erscheinen nicht alle"). Alle offenen Vorgänge, gruppiert: wartet auf dich · bei Alfred · zurückgestellt, dazu die in
/// den letzten 7 Tagen abgeschlossenen. Je Vorgang die passenden Knöpfe: Ausführen (vorgeschlagene Aktion, Server v1480), Später,
/// Abschließen („Was war es?"), Nachfragen. Ähnliche offene Vorgänge (Dubletten) werden markiert.
library;

import 'package:flutter/material.dart';

import 'aufgaben.dart' show JsonAbruf;
import 'vorgaenge.dart';

/// Gruppen der offenen Vorgänge. Zurückgestellte zuerst aussortiert; „für dich" = wartet oder beim Owner.
({List<Map<String, dynamic>> fuerDich, List<Map<String, dynamic>> beiAlfred, List<Map<String, dynamic>> zurueck}) vorgangGruppen(List<Map<String, dynamic>> offene, DateTime jetzt) {
  final fuerDich = <Map<String, dynamic>>[], beiAlfred = <Map<String, dynamic>>[], zurueck = <Map<String, dynamic>>[];
  for (final v in offene) {
    if (zurueckBis(v, jetzt) != null) { zurueck.add(v); continue; }
    (v['status'] == 'wartet' || v['besitzer'] == 'user' ? fuerDich : beiAlfred).add(v);
  }
  int frist(Map<String, dynamic> v) => DateTime.tryParse('${v['frist'] ?? ''}')?.millisecondsSinceEpoch ?? 1 << 62;
  fuerDich.sort((a, b) => frist(a).compareTo(frist(b)));
  zurueck.sort((a, b) => '${a['zurueckBis']}'.compareTo('${b['zurueckBis']}'));
  return (fuerDich: fuerDich, beiAlfred: beiAlfred, zurueck: zurueck);
}

Set<String> _woerter(String t) => t.toLowerCase().replaceAll(RegExp(r'[^a-zäöüß0-9 ]'), ' ').split(RegExp(r'\s+')).where((w) => w.length >= 4).toSet();

/// Ähnliche offene Vorgänge: mindestens zwei gemeinsame Wörter (≥ 4 Zeichen) und die Hälfte des kürzeren Titels. id → Titel des ähnlichen.
Map<String, String> aehnlicheVorgaenge(List<Map<String, dynamic>> offene) {
  final aus = <String, String>{};
  for (var i = 0; i < offene.length; i++) {
    for (var j = i + 1; j < offene.length; j++) {
      final a = _woerter('${offene[i]['titel'] ?? ''}'), b = _woerter('${offene[j]['titel'] ?? ''}');
      final gemeinsam = a.intersection(b).length;
      final kleiner = a.length < b.length ? a.length : b.length;
      if (gemeinsam >= 2 && kleiner > 0 && gemeinsam * 2 >= kleiner) {
        aus.putIfAbsent('${offene[i]['id']}', () => '${offene[j]['titel']}');
        aus.putIfAbsent('${offene[j]['id']}', () => '${offene[i]['titel']}');
      }
    }
  }
  return aus;
}

class VorgaengeAnsicht extends StatefulWidget {
  const VorgaengeAnsicht({super.key, required this.json, required this.aufMeldung, this.aufNachfragen, this.aufGeaendert});
  final JsonAbruf json;
  final void Function(String) aufMeldung;
  final void Function(String text)? aufNachfragen;
  /// Seitenleiste/Kachel neu laden, wenn sich etwas geändert hat
  final VoidCallback? aufGeaendert;
  @override
  State<VorgaengeAnsicht> createState() => _VorgaengeAnsichtState();
}

class _VorgaengeAnsichtState extends State<VorgaengeAnsicht> {
  List<Map<String, dynamic>>? offene;
  List<Map<String, dynamic>> abgeschlossen = [];
  List<dynamic>? schritte;
  String? fehler;
  bool zurueckZeigen = false, erledigtZeigen = false;

  @override
  void initState() { super.initState(); laden(); }

  Future<void> laden() async {
    try {
      final j = await widget.json('/api/vorgaenge');
      if (!mounted) return;
      setState(() {
        offene = ((j['offene'] as List<dynamic>?) ?? []).whereType<Map<String, dynamic>>().toList();
        abgeschlossen = ((j['abgeschlossene'] as List<dynamic>?) ?? []).whereType<Map<String, dynamic>>().toList();
        schritte = j['schritte'] as List<dynamic>?;
        fehler = null;
      });
    } catch (e) { if (mounted) setState(() => fehler = '$e'); }
  }

  Future<void> _nach(bool geaendert) async { if (geaendert) { await laden(); widget.aufGeaendert?.call(); } }

  String _datum(String? iso) { final d = DateTime.tryParse(iso ?? '')?.toLocal(); return d == null ? '' : '${d.day}.${d.month}. ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}'; }

  Widget _zustand(ThemeData t, Map<String, dynamic> v, DateTime jetzt) {
    final zb = zurueckBis(v, jetzt);
    final (text, farbe) = zb != null ? ('zurückgestellt bis ${_datum(v['zurueckBis'] as String?)}', t.colorScheme.outline)
        : v['status'] == 'wartet' ? ('wartet auf dich', Colors.amber.shade700)
        : v['besitzer'] == 'user' ? ('bei dir', t.colorScheme.primary)
        : ('bei Alfred', t.colorScheme.tertiary);
    return Container(padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2), decoration: BoxDecoration(color: farbe.withValues(alpha: 0.14), borderRadius: BorderRadius.circular(10)),
        child: Text(text, style: t.textTheme.labelSmall?.copyWith(color: farbe, fontWeight: FontWeight.w600)));
  }

  Widget _karte(ThemeData t, Map<String, dynamic> v, DateTime jetzt, Map<String, String> aehnlich, {bool abgeschlossenListe = false}) {
    final dim = t.colorScheme.onSurfaceVariant;
    final vs = v['vorschlag'] as Map<String, dynamic>?;
    final ausfuehrbar = !abgeschlossenListe && vs?['ausfuehrbar'] == true;
    final zb = zurueckBis(v, jetzt);
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: () async => _nach(await zeigeVorgang(context, v: v, schritte: schritte, json: widget.json, aufMeldung: widget.aufMeldung, aufNachfragen: widget.aufNachfragen)),
        child: Padding(padding: const EdgeInsets.fromLTRB(14, 12, 10, 8), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(child: Text('${v['titel'] ?? ''}', style: t.textTheme.titleSmall?.copyWith(decoration: abgeschlossenListe ? TextDecoration.lineThrough : null))),
            const SizedBox(width: 8),
            if (!abgeschlossenListe) _zustand(t, v, jetzt) else Text('${v['status'] ?? ''}', style: t.textTheme.labelSmall?.copyWith(color: dim)),
          ]),
          const SizedBox(height: 4),
          Text([
            if ((v['naechsterSchritt'] ?? '').toString().isNotEmpty && !abgeschlossenListe) 'Nächster Schritt: ${v['naechsterSchritt']}',
            if (v['frist'] != null) 'Frist ${_datum(v['frist'] as String?)}',
            if (v['erstellt'] != null) 'seit ${_datum(v['erstellt'] as String?)}',
            if (abgeschlossenListe && v['ergebnis'] != null) '${v['ergebnis']}',
          ].join(' · '), style: t.textTheme.bodySmall?.copyWith(color: dim), maxLines: 2, overflow: TextOverflow.ellipsis),
          if (vs != null && !abgeschlossenListe) Padding(padding: const EdgeInsets.only(top: 6), child: Row(children: [
            Icon(ausfuehrbar ? Icons.bolt : Icons.block, size: 14, color: ausfuehrbar ? t.colorScheme.primary : dim),
            const SizedBox(width: 4),
            Expanded(child: Text('${vs['text'] ?? ''}', style: t.textTheme.labelSmall?.copyWith(color: dim, fontFamily: 'monospace'), maxLines: 1, overflow: TextOverflow.ellipsis)),
          ])),
          if (aehnlich[v['id']] != null && !abgeschlossenListe) Padding(padding: const EdgeInsets.only(top: 6), child: Row(children: [
            Icon(Icons.content_copy, size: 13, color: Colors.amber.shade700),
            const SizedBox(width: 4),
            Expanded(child: Text('Ähnlich wie: ${aehnlich[v['id']]}', style: t.textTheme.labelSmall?.copyWith(color: Colors.amber.shade800), maxLines: 1, overflow: TextOverflow.ellipsis)),
          ])),
          if (!abgeschlossenListe) Padding(padding: const EdgeInsets.only(top: 6), child: Wrap(spacing: 4, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
            if (ausfuehrbar) FilledButton.tonalIcon(style: const ButtonStyle(visualDensity: VisualDensity.compact), onPressed: () async => _nach(await vorgangAusfuehren(context, v: v, json: widget.json, aufMeldung: widget.aufMeldung)), icon: const Icon(Icons.play_arrow, size: 16), label: const Text('Ausführen…')),
            OutlinedButton.icon(style: const ButtonStyle(visualDensity: VisualDensity.compact), onPressed: () async => _nach(await zeigeVorgang(context, v: v, schritte: schritte, json: widget.json, aufMeldung: widget.aufMeldung, aufNachfragen: widget.aufNachfragen)), icon: const Icon(Icons.task_alt, size: 16), label: const Text('Abschließen…')),
            if (zb != null) TextButton.icon(style: const ButtonStyle(visualDensity: VisualDensity.compact), onPressed: () async => _nach(await vorgangSpaeter('${v['id']}', 'zurueck', json: widget.json, aufMeldung: widget.aufMeldung, titel: '${v['titel'] ?? ''}')), icon: const Icon(Icons.undo, size: 16), label: const Text('Wieder aufnehmen'))
            else PopupMenuButton<String>(
              tooltip: 'Später: zurückstellen',
              onSelected: (w) async => _nach(await vorgangSpaeter('${v['id']}', w, json: widget.json, aufMeldung: widget.aufMeldung, titel: '${v['titel'] ?? ''}')),
              itemBuilder: (_) => [for (final e in spaeterWahl.entries) PopupMenuItem(value: e.key, child: Text(e.value))],
              child: Padding(padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6), child: Row(mainAxisSize: MainAxisSize.min, children: [Icon(Icons.schedule, size: 16, color: t.colorScheme.primary), const SizedBox(width: 4), Text('Später', style: t.textTheme.labelLarge?.copyWith(color: t.colorScheme.primary))])),
            ),
            if (widget.aufNachfragen != null) TextButton.icon(style: const ButtonStyle(visualDensity: VisualDensity.compact), onPressed: () => widget.aufNachfragen!('Wie steht es um „${v['titel'] ?? ''}“?'), icon: const Icon(Icons.reply_outlined, size: 16), label: const Text('Nachfragen')),
          ])),
        ])),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final dim = t.colorScheme.onSurfaceVariant;
    final jetzt = DateTime.now();
    final o = offene;
    Widget kopf(String text, int n, {IconData? icon}) => Padding(padding: const EdgeInsets.fromLTRB(2, 16, 0, 8), child: Row(children: [
          if (icon != null) ...[Icon(icon, size: 18, color: t.colorScheme.primary), const SizedBox(width: 6)],
          Text(text, style: t.textTheme.titleMedium),
          const SizedBox(width: 8),
          Text('$n', style: t.textTheme.titleMedium?.copyWith(color: dim)),
        ]));
    return Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 920), child: Column(children: [
      Padding(padding: const EdgeInsets.fromLTRB(20, 20, 20, 0), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Text('Vorgänge', style: t.textTheme.headlineSmall),
          const SizedBox(width: 12),
          if (o != null) Text('${o.length} offen', style: t.textTheme.bodyMedium?.copyWith(color: dim)),
          const Spacer(),
          IconButton(tooltip: 'Neu laden', onPressed: laden, icon: const Icon(Icons.refresh)),
        ]),
        Text('Was gerade läuft oder eine Entscheidung braucht. Ausführen führt genau die Aktion aus, die Alfred vorgeschlagen hat.', style: t.textTheme.bodySmall?.copyWith(color: dim)),
      ])),
      Expanded(child: fehler != null
          ? Center(child: Text('Vorgänge nicht geladen: $fehler'))
          : o == null
              ? const Center(child: CircularProgressIndicator())
              : Builder(builder: (_) {
                  final g = vorgangGruppen(o, jetzt);
                  final aehnlich = aehnlicheVorgaenge([...g.fuerDich, ...g.beiAlfred]);
                  return RefreshIndicator(onRefresh: laden, child: ListView(padding: const EdgeInsets.fromLTRB(20, 0, 20, 24), children: [
                    if (o.isEmpty) Padding(padding: const EdgeInsets.symmetric(vertical: 32), child: Text('Keine offenen Vorgänge. 🎉', style: t.textTheme.bodyLarge?.copyWith(color: dim))),
                    if (g.fuerDich.isNotEmpty) ...[kopf('Für dich', g.fuerDich.length, icon: Icons.person_outline), for (final v in g.fuerDich) _karte(t, v, jetzt, aehnlich)],
                    if (g.beiAlfred.isNotEmpty) ...[kopf('Bei Alfred', g.beiAlfred.length, icon: Icons.smart_toy_outlined), for (final v in g.beiAlfred) _karte(t, v, jetzt, aehnlich)],
                    if (g.zurueck.isNotEmpty) ...[
                      TextButton.icon(onPressed: () => setState(() => zurueckZeigen = !zurueckZeigen), icon: Icon(zurueckZeigen ? Icons.expand_less : Icons.expand_more), label: Text('Zurückgestellt (${g.zurueck.length})')),
                      if (zurueckZeigen) for (final v in g.zurueck) _karte(t, v, jetzt, aehnlich),
                    ],
                    if (abgeschlossen.isNotEmpty) ...[
                      TextButton.icon(onPressed: () => setState(() => erledigtZeigen = !erledigtZeigen), icon: Icon(erledigtZeigen ? Icons.expand_less : Icons.expand_more), label: Text('In den letzten 7 Tagen abgeschlossen (${abgeschlossen.length})')),
                      if (erledigtZeigen) for (final v in abgeschlossen) _karte(t, v, jetzt, aehnlich, abgeschlossenListe: true),
                    ],
                  ]));
                })),
    ])));
  }
}
