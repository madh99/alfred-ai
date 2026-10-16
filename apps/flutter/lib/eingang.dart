/// 1.36.0 — Eingang (Owner 16.10.: „was fällt dir noch ein …" → ein Ort für alles, was eine Reaktion braucht). Führt vier Quellen
/// zusammen: offene Bestätigungen (vom Satelliten), Vorgänge für dich (/api/vorgaenge), fällige Aufgaben (/api/geraete/aufgaben)
/// und offene Hinweise (/api/geraete/hinweise). Je Art die passenden Knöpfe; Reihenfolge nach Dringlichkeit; Filter; „Alle gelesen".
/// Keine neue Server-Route — die Aktionen sind dieselben wie in den Einzelansichten.
library;

import 'package:flutter/material.dart';

import 'aufgaben.dart';
import 'hinweise.dart' show Hinweis;
import 'modell.dart' show Bestaetigung;
import 'vorgaenge.dart';
import 'vorgaenge_ansicht.dart' show vorgangGruppen;

enum EingangArt { bestaetigung, vorgang, aufgabe, hinweis }

class EingangEintrag {
  EingangEintrag(this.art, this.id, this.titel, {this.text, this.zeit, this.rang = 9, this.roh});
  final EingangArt art;
  final String id, titel;
  final String? text;
  final DateTime? zeit;
  final int rang;
  final Object? roh;
}

/// Alles, was eine Reaktion braucht, in Dringlichkeits-Reihenfolge: Bestätigungen · wartende Vorgänge · überfällige/heutige
/// Aufgaben · Vorgänge bei dir · Hinweise (neueste zuerst). Vorgänge bei Alfred und zurückgestellte gehören nicht hierher.
/// 1.39.0 — Hinweis für die Anzeige: ohne Listennummer und Markdown-Fettung; ist der Titel nur der abgeschnittene Anfang
/// des Texts, zeigt die Zeile den Text allein (vorher „5. **Hinweis: …**“ roh und der Titel doppelt).
({String titel, String? text}) hinweisAnzeige(String titel, String text) {
  String glatt(String s) => s.replaceAll(RegExp(r'\*\*|__'), '').replaceFirst(RegExp(r'^\s*\d+\.\s+'), '').trim();
  final ti = glatt(titel), te = glatt(text);
  if (ti.isEmpty) return (titel: te, text: null);
  if (te.isEmpty || te == ti) return (titel: ti, text: null);
  return te.startsWith(ti) ? (titel: te, text: null) : (titel: ti, text: te);
}

List<EingangEintrag> eingangEintraege({required List<Bestaetigung> bestaetigungen, required List<Map<String, dynamic>> vorgaenge, required List<Aufgabe> aufgaben, required List<Hinweis> hinweise, required DateTime jetzt}) {
  final aus = <EingangEintrag>[
    for (final b in bestaetigungen) EingangEintrag(EingangArt.bestaetigung, b.id, b.text, zeit: b.seit, rang: 0, roh: b),
    for (final v in vorgangGruppen(vorgaenge, jetzt).fuerDich)
      EingangEintrag(EingangArt.vorgang, '${v['id']}', '${v['titel'] ?? ''}', text: v['naechsterSchritt'] as String?, zeit: DateTime.tryParse('${v['frist'] ?? v['erstellt'] ?? ''}')?.toLocal(), rang: v['status'] == 'wartet' ? 1 : 3, roh: v),
    for (final a in aufgaben.where((a) => !a.erledigt && const ['Überfällig', 'Heute'].contains(aufgabenGruppe(a, jetzt))))
      EingangEintrag(EingangArt.aufgabe, a.id, a.titel, text: aufgabenGruppe(a, jetzt), zeit: a.faellig, rang: 2, roh: a),
    for (final h in hinweise.where((h) => h.offen))
      for (final z in [hinweisAnzeige(h.titel, h.text)]) EingangEintrag(EingangArt.hinweis, h.id, z.titel, text: z.text, zeit: h.zeit, rang: h.dringlichkeit == 'urgent' ? 1 : 4, roh: h),
  ];
  aus.sort((a, b) {
    final r = a.rang.compareTo(b.rang);
    if (r != 0) return r;
    final za = a.zeit, zb = b.zeit;
    if (za == null || zb == null) return 0;
    return a.art == EingangArt.hinweis ? zb.compareTo(za) : za.compareTo(zb);
  });
  return aus;
}

const _artName = {EingangArt.bestaetigung: 'Bestätigungen', EingangArt.vorgang: 'Vorgänge', EingangArt.aufgabe: 'Aufgaben', EingangArt.hinweis: 'Hinweise'};
const _artEinzeln = {EingangArt.bestaetigung: 'Bestätigung', EingangArt.vorgang: 'Vorgang', EingangArt.aufgabe: 'Aufgabe', EingangArt.hinweis: 'Hinweis'};

/// Zahl für die Navigation: Bestätigungen + Vorgänge für dich + fällige Aufgaben + offene Hinweise.
int eingangZahl({required int bestaetigungen, required List<Map<String, dynamic>> vorgaenge, required int aufgabenFaellig, required int hinweiseOffen, required DateTime jetzt}) =>
    bestaetigungen + vorgangGruppen(vorgaenge, jetzt).fuerDich.length + aufgabenFaellig + hinweiseOffen;

class Eingang extends StatefulWidget {
  const Eingang({super.key, required this.json, required this.bestaetigungen, required this.aufEntscheiden, required this.aufMeldung, this.aufNachfragen, this.aufGeaendert});
  final JsonAbruf json;
  final List<Bestaetigung> bestaetigungen;
  final Future<void> Function(Bestaetigung b, bool ja) aufEntscheiden;
  final void Function(String) aufMeldung;
  final void Function(String text)? aufNachfragen;
  /// Zähler in Navigation und Seitenleiste neu laden
  final VoidCallback? aufGeaendert;
  @override
  State<Eingang> createState() => _EingangState();
}

class _EingangState extends State<Eingang> {
  List<Map<String, dynamic>> vorgaenge = [];
  List<dynamic>? schritte;
  List<Aufgabe> aufgaben = [];
  List<Hinweis> hinweise = [];
  bool geladen = false;
  String? fehler;
  EingangArt? filter;

  @override
  void initState() { super.initState(); laden(); }

  Future<void> laden() async {
    final fehlerTeile = <String>[];
    Future<Map<String, dynamic>?> hole(String p) async { try { return await widget.json(p); } catch (e) { fehlerTeile.add('$p: $e'); return null; } }
    final r = await Future.wait([hole('/api/vorgaenge'), hole('/api/geraete/aufgaben'), hole('/api/geraete/hinweise')]);
    if (!mounted) return;
    setState(() {
      if (r[0] != null) { vorgaenge = ((r[0]!['offene'] as List<dynamic>?) ?? []).whereType<Map<String, dynamic>>().toList(); schritte = r[0]!['schritte'] as List<dynamic>?; }
      if (r[1] != null) aufgaben = ((r[1]!['aufgaben'] as List<dynamic>?) ?? []).whereType<Map<String, dynamic>>().map(Aufgabe.new).toList();
      if (r[2] != null) hinweise = ((r[2]!['hinweise'] as List<dynamic>?) ?? []).whereType<Map<String, dynamic>>().map(Hinweis.new).toList();
      geladen = true;
      fehler = fehlerTeile.isEmpty ? null : fehlerTeile.join(' · ');
    });
  }

  Future<void> _nach([bool geaendert = true]) async { if (geaendert) { await laden(); widget.aufGeaendert?.call(); } }

  Future<void> _hinweis(Hinweis h, String aktion) async {
    try {
      final r = await widget.json('/api/geraete/hinweise/${h.id}', methode: 'POST', koerper: {'aktion': aktion});
      if (r['ok'] != true) widget.aufMeldung('💡 Nicht möglich: ${r['grund'] ?? 'unbekannt'}');
    } catch (e) { widget.aufMeldung('💡 Fehler: $e'); }
    await _nach();
  }

  Future<void> _alleGelesen() async {
    for (final h in hinweise.where((h) => h.offen).toList()) {
      try { await widget.json('/api/geraete/hinweise/${h.id}', methode: 'POST', koerper: {'aktion': 'gelesen'}); } catch (_) { /* nächster */ }
    }
    widget.aufMeldung('💡 Alle Hinweise als gelesen markiert');
    await _nach();
  }

  Future<void> _aufgabeErledigt(Aufgabe a) async {
    try { await widget.json('/api/geraete/aufgaben/${a.id}', methode: 'POST', koerper: {'erledigt': true}); widget.aufMeldung('✅ Erledigt: ${a.titel}'); }
    catch (e) { widget.aufMeldung('✅ Nicht erledigt: $e'); }
    await _nach();
  }

  String _zeit(DateTime? d) => d == null ? '' : '${d.day}.${d.month}. ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';

  Widget _symbol(ThemeData t, EingangArt a) {
    final (icon, farbe) = switch (a) {
      EingangArt.bestaetigung => (Icons.notifications_active_outlined, Colors.amber.shade700),
      EingangArt.vorgang => (Icons.assignment_outlined, t.colorScheme.primary),
      EingangArt.aufgabe => (Icons.checklist, t.colorScheme.secondary),
      EingangArt.hinweis => (Icons.lightbulb_outline, t.colorScheme.tertiary),
    };
    return Container(width: 34, height: 34, decoration: BoxDecoration(color: farbe.withValues(alpha: 0.13), borderRadius: BorderRadius.circular(10)), child: Icon(icon, size: 18, color: farbe));
  }

  List<Widget> _knoepfe(ThemeData t, EingangEintrag e) {
    const dicht = ButtonStyle(visualDensity: VisualDensity.compact);
    switch (e.art) {
      case EingangArt.bestaetigung:
        final b = e.roh as Bestaetigung;
        return [
          FilledButton.icon(style: dicht, onPressed: () async { await widget.aufEntscheiden(b, true); await _nach(); }, icon: const Icon(Icons.check, size: 16), label: const Text('Ja')),
          OutlinedButton.icon(style: dicht, onPressed: () async { await widget.aufEntscheiden(b, false); await _nach(); }, icon: const Icon(Icons.close, size: 16), label: const Text('Nein')),
        ];
      case EingangArt.vorgang:
        final v = e.roh as Map<String, dynamic>;
        return [
          if ((v['vorschlag'] as Map<String, dynamic>?)?['ausfuehrbar'] == true) FilledButton.tonalIcon(style: dicht, onPressed: () async => _nach(await vorgangAusfuehren(context, v: v, json: widget.json, aufMeldung: widget.aufMeldung)), icon: const Icon(Icons.play_arrow, size: 16), label: const Text('Ausführen…')),
          OutlinedButton.icon(style: dicht, onPressed: () async => _nach(await zeigeVorgang(context, v: v, schritte: schritte, json: widget.json, aufMeldung: widget.aufMeldung, aufNachfragen: widget.aufNachfragen)), icon: const Icon(Icons.open_in_new, size: 16), label: const Text('Öffnen')),
          PopupMenuButton<String>(tooltip: 'Später: zurückstellen', onSelected: (w) async => _nach(await vorgangSpaeter(e.id, w, json: widget.json, aufMeldung: widget.aufMeldung, titel: e.titel)), itemBuilder: (_) => [for (final x in spaeterWahl.entries) PopupMenuItem(value: x.key, child: Text(x.value))],
              child: Padding(padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6), child: Row(mainAxisSize: MainAxisSize.min, children: [Icon(Icons.schedule, size: 16, color: t.colorScheme.primary), const SizedBox(width: 4), Text('Später', style: t.textTheme.labelLarge?.copyWith(color: t.colorScheme.primary))]))),
        ];
      case EingangArt.aufgabe:
        return [FilledButton.tonalIcon(style: dicht, onPressed: () => _aufgabeErledigt(e.roh as Aufgabe), icon: const Icon(Icons.done, size: 16), label: const Text('Erledigt'))];
      case EingangArt.hinweis:
        final h = e.roh as Hinweis;
        return [
          if (h.aktion != null) FilledButton.tonalIcon(style: dicht, onPressed: () => _hinweis(h, 'ausfuehren'), icon: const Icon(Icons.play_arrow, size: 16), label: Text(h.aktion!)),
          OutlinedButton(style: dicht, onPressed: () => _hinweis(h, 'gelesen'), child: const Text('Gelesen')),
          IconButton(tooltip: 'Nützlich', onPressed: () => _hinweis(h, 'nuetzlich'), icon: const Icon(Icons.thumb_up_outlined, size: 18)),
          IconButton(tooltip: 'Nicht nützlich', onPressed: () => _hinweis(h, 'nicht_nuetzlich'), icon: const Icon(Icons.thumb_down_outlined, size: 18)),
          if (widget.aufNachfragen != null) IconButton(tooltip: 'Nachfragen', onPressed: () { _hinweis(h, 'besprochen'); widget.aufNachfragen!('Zum Hinweis „${h.titel.isEmpty ? h.text : h.titel}": '); }, icon: const Icon(Icons.reply_outlined, size: 18)),
        ];
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final dim = t.colorScheme.onSurfaceVariant;
    final alle = eingangEintraege(bestaetigungen: widget.bestaetigungen, vorgaenge: vorgaenge, aufgaben: aufgaben, hinweise: hinweise, jetzt: DateTime.now());
    final sichtbar = filter == null ? alle : alle.where((e) => e.art == filter).toList();
    int anzahl(EingangArt a) => alle.where((e) => e.art == a).length;
    return Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 920), child: Column(children: [
      Padding(padding: const EdgeInsets.fromLTRB(20, 20, 20, 0), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Text('Eingang', style: t.textTheme.headlineSmall),
          const SizedBox(width: 12),
          if (geladen) Text('${alle.length} brauchen dich', style: t.textTheme.bodyMedium?.copyWith(color: dim)),
          const Spacer(),
          if (anzahl(EingangArt.hinweis) > 0) TextButton.icon(onPressed: _alleGelesen, icon: const Icon(Icons.done_all, size: 18), label: const Text('Alle Hinweise gelesen')),
          IconButton(tooltip: 'Neu laden', onPressed: laden, icon: const Icon(Icons.refresh)),
        ]),
        Text('Bestätigungen, Vorgänge für dich, fällige Aufgaben und neue Hinweise — das Dringendste zuerst.', style: t.textTheme.bodySmall?.copyWith(color: dim)),
        const SizedBox(height: 10),
        Wrap(spacing: 6, runSpacing: 6, children: [
          ChoiceChip(label: Text('Alle (${alle.length})'), selected: filter == null, onSelected: (_) => setState(() => filter = null)),
          for (final a in EingangArt.values) if (anzahl(a) > 0) ChoiceChip(label: Text('${_artName[a]} (${anzahl(a)})'), selected: filter == a, onSelected: (_) => setState(() => filter = a)),
        ]),
        if (fehler != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text('Teilweise nicht geladen: $fehler', style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.error))),
        const SizedBox(height: 8),
      ])),
      Expanded(child: !geladen
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(onRefresh: laden, child: ListView(padding: const EdgeInsets.fromLTRB(20, 4, 20, 24), children: [
              if (sichtbar.isEmpty) Padding(padding: const EdgeInsets.symmetric(vertical: 32), child: Text('Nichts offen — alles erledigt. 🎉', style: t.textTheme.bodyLarge?.copyWith(color: dim))),
              for (final e in sichtbar) Card(margin: const EdgeInsets.only(bottom: 8), child: Padding(padding: const EdgeInsets.fromLTRB(12, 10, 8, 6), child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                _symbol(t, e.art),
                const SizedBox(width: 12),
                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(e.titel, style: t.textTheme.titleSmall, maxLines: 3, overflow: TextOverflow.ellipsis),
                  if ((e.text ?? '').trim().isNotEmpty) Padding(padding: const EdgeInsets.only(top: 2), child: Text(e.text!, style: t.textTheme.bodySmall?.copyWith(color: dim), maxLines: 2, overflow: TextOverflow.ellipsis)),
                  Padding(padding: const EdgeInsets.only(top: 2), child: Text([_artEinzeln[e.art]!, if (e.zeit != null) '${e.art == EingangArt.vorgang && (e.roh as Map<String, dynamic>)['frist'] != null ? 'Frist ' : e.art == EingangArt.aufgabe ? 'fällig ' : ''}${_zeit(e.zeit)}'].join(' · '), style: t.textTheme.labelSmall?.copyWith(color: dim))),
                  Padding(padding: const EdgeInsets.only(top: 4), child: Wrap(spacing: 4, runSpacing: 2, crossAxisAlignment: WrapCrossAlignment.center, children: _knoepfe(t, e))),
                ])),
              ]))),
            ]))),
    ])));
  }
}
