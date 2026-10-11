/// 1.9.0 — A3 (Owner-Freigabe 11.10.): Gedächtnis nativ — was Alfred über den Owner weiß, einsehen, korrigieren, löschen.
/// Liest `/api/geraete/gedaechtnis` (Server v1353, nur Geräte des Owners). Ohne Filter blendet der Server interne
/// Buchführung aus (zugestellte Hinweise, KG-Verknüpfungen); die Typ-Chips zeigen sie auf Wunsch trotzdem.
/// Korrigieren ersetzt den Text (Quelle „manual", volle Sicherheit) — bisher ging das nur per Chat.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import 'aufgaben.dart' show JsonAbruf;

class Erinnerungsstueck {
  Erinnerungsstueck(Map<String, dynamic> j)
      : id = '${j['id']}', schluessel = '${j['schluessel'] ?? ''}', text = '${j['text'] ?? ''}', typ = '${j['typ'] ?? 'general'}',
        quelle = '${j['quelle'] ?? ''}', geaendert = DateTime.tryParse('${j['geaendert'] ?? ''}')?.toLocal();
  final String id, schluessel, typ, quelle;
  String text;
  final DateTime? geaendert;
}

/// Anzeigename je Typ (memories.type).
String typName(String t) => switch (t) {
      'fact' => 'Fakten',
      'preference' => 'Vorlieben',
      'correction' => 'Korrekturen',
      'rule' => 'Regeln',
      'entity' => 'Personen & Dinge',
      'pattern' => 'Muster',
      'decision' => 'Entscheidungen',
      'general' => 'Allgemein',
      'feedback' => 'Zugestellte Hinweise',
      'connection' => 'Verknüpfungen',
      _ => t,
    };

/// Interne Typen — nur auf ausdrücklichen Klick (wie der Server: ohne Filter ausgeblendet).
const gedaechtnisIntern = {'feedback', 'connection'};

/// Schlüssel lesbar machen: `correction_house_battery_low` → „correction house battery low".
String schluesselLesbar(String k) => k.replaceAll(RegExp(r'[_:]+'), ' ').trim();

class Gedaechtnis extends StatefulWidget {
  const Gedaechtnis({super.key, required this.json, required this.aufMeldung});
  final JsonAbruf json;
  final void Function(String text) aufMeldung;
  @override
  State<Gedaechtnis> createState() => _GedaechtnisState();
}

class _GedaechtnisState extends State<Gedaechtnis> {
  List<Erinnerungsstueck>? liste;
  Map<String, int> typen = {};
  String? typ;
  String? fehler;
  final suche = TextEditingController();
  Timer? tipp;
  final ganz = <String>{};

  @override
  void initState() { super.initState(); laden(); }

  @override
  void dispose() { tipp?.cancel(); suche.dispose(); super.dispose(); }

  Future<void> laden() async {
    final q = suche.text.trim();
    final p = <String>[if (typ != null) 'typ=${Uri.encodeQueryComponent(typ!)}', if (q.isNotEmpty) 'q=${Uri.encodeQueryComponent(q)}'];
    try {
      final j = await widget.json('/api/geraete/gedaechtnis${p.isEmpty ? '' : '?${p.join('&')}'}');
      final l = ((j['eintraege'] as List<dynamic>?) ?? []).whereType<Map<String, dynamic>>().map(Erinnerungsstueck.new).toList();
      final t = ((j['typen'] as Map<String, dynamic>?) ?? {}).map((k, v) => MapEntry(k, (v as num).toInt()));
      if (!mounted) return;
      setState(() { liste = l; typen = t; fehler = null; });
    } catch (e) { if (mounted) setState(() => fehler = '$e'); }
  }

  void _getippt(String _) { tipp?.cancel(); tipp = Timer(const Duration(milliseconds: 350), laden); }

  Future<void> korrigieren(Erinnerungsstueck e) async {
    final c = TextEditingController(text: e.text);
    final neu = await showDialog<String>(context: context, builder: (ctx) => AlertDialog(
      title: const Text('Eintrag korrigieren'),
      content: SizedBox(width: 560, child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(schluesselLesbar(e.schluessel), style: Theme.of(ctx).textTheme.labelSmall),
        const SizedBox(height: 8),
        TextField(controller: c, autofocus: true, minLines: 3, maxLines: 10, maxLength: 4000, decoration: const InputDecoration(border: OutlineInputBorder())),
      ])),
      actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Abbrechen')), FilledButton(onPressed: () => Navigator.pop(ctx, c.text), child: const Text('Speichern'))],
    ));
    if (neu == null || neu.trim().isEmpty || neu.trim() == e.text) return;
    try {
      await widget.json('/api/geraete/gedaechtnis/${e.id}', methode: 'POST', koerper: {'text': neu.trim()});
      setState(() => e.text = neu.trim());
      widget.aufMeldung('🧠 Gedächtnis korrigiert: ${schluesselLesbar(e.schluessel)}');
    } catch (err) { widget.aufMeldung('🧠 Nicht gespeichert: $err'); }
  }

  Future<void> loeschen(Erinnerungsstueck e) async {
    final ok = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(
      title: const Text('Eintrag löschen?'),
      content: Text('Alfred vergisst: „${e.text.length > 200 ? '${e.text.substring(0, 200)}…' : e.text}“'),
      actions: [TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Abbrechen')), FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Löschen'))],
    ));
    if (ok != true) return;
    try {
      await widget.json('/api/geraete/gedaechtnis/${e.id}', methode: 'DELETE');
      setState(() { liste?.remove(e); typen[e.typ] = (typen[e.typ] ?? 1) - 1; });
      widget.aufMeldung('🧠 Gelöscht: ${schluesselLesbar(e.schluessel)}');
    } catch (err) { widget.aufMeldung('🧠 Nicht gelöscht: $err'); }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dim = theme.colorScheme.onSurfaceVariant;
    final l = liste;
    final sichtbar = typen.entries.where((e) => !gedaechtnisIntern.contains(e.key)).fold<int>(0, (s, e) => s + e.value);
    int intern(String t) => gedaechtnisIntern.contains(t) ? 1 : 0;
    final reihenfolge = typen.keys.where((t) => typen[t]! > 0).toList()..sort((a, b) => intern(a) != intern(b) ? intern(a) - intern(b) : typen[b]!.compareTo(typen[a]!)); // interne zuletzt, sonst nach Anzahl
    String datum(DateTime d) => '${d.day}.${d.month}.${d.year}';

    Widget karte(Erinnerungsstueck e) {
      final offen = ganz.contains(e.id);
      return Card(margin: const EdgeInsets.only(bottom: 8), child: Padding(padding: const EdgeInsets.fromLTRB(14, 10, 6, 4), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        InkWell(onTap: () => setState(() => offen ? ganz.remove(e.id) : ganz.add(e.id)), child: Text(e.text, maxLines: offen ? null : 4, overflow: offen ? null : TextOverflow.ellipsis, style: theme.textTheme.bodyMedium)),
        Row(children: [
          Expanded(child: Text([typName(e.typ), if (e.quelle == 'manual') 'ausdrücklich gemerkt', if (e.geaendert != null) datum(e.geaendert!), schluesselLesbar(e.schluessel)].join(' · '), maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.labelSmall?.copyWith(color: dim))),
          IconButton(tooltip: 'Korrigieren', onPressed: () => korrigieren(e), icon: const Icon(Icons.edit_outlined, size: 18)),
          IconButton(tooltip: 'Löschen', onPressed: () => loeschen(e), icon: const Icon(Icons.delete_outline, size: 18)),
        ]),
      ])));
    }

    return Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 920), child: Column(children: [
      Padding(padding: const EdgeInsets.fromLTRB(20, 20, 20, 0), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Text('Gedächtnis', style: theme.textTheme.headlineSmall),
          const Spacer(),
          IconButton(tooltip: 'Neu laden', onPressed: laden, icon: const Icon(Icons.refresh)),
        ]),
        Text('Was Alfred über dich weiß. Falsches korrigieren oder löschen — Alfred nutzt ab sofort den neuen Stand.', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
        const SizedBox(height: 10),
        TextField(controller: suche, onChanged: _getippt, onSubmitted: (_) => laden(), decoration: InputDecoration(isDense: true, prefixIcon: const Icon(Icons.search), hintText: 'Im Gedächtnis suchen …', border: const OutlineInputBorder(), suffixIcon: suche.text.isEmpty ? null : IconButton(onPressed: () { suche.clear(); laden(); }, icon: const Icon(Icons.clear)))),
        const SizedBox(height: 8),
        Wrap(spacing: 6, runSpacing: 4, children: [
          ChoiceChip(label: Text('Alles ($sichtbar)'), selected: typ == null, onSelected: (_) { setState(() => typ = null); laden(); }),
          for (final t in reihenfolge) ChoiceChip(label: Text('${typName(t)} (${typen[t]})'), selected: typ == t, onSelected: (_) { setState(() => typ = typ == t ? null : t); laden(); }),
        ]),
        const SizedBox(height: 8),
      ])),
      Expanded(child: fehler != null && l == null
          ? Center(child: Text('Gedächtnis nicht geladen: $fehler', style: TextStyle(color: theme.colorScheme.error)))
          : l == null
              ? const Center(child: CircularProgressIndicator())
              : l.isEmpty
                  ? Center(child: Text(suche.text.isEmpty ? 'Keine Einträge.' : 'Nichts gefunden.', style: theme.textTheme.bodyMedium?.copyWith(color: dim)))
                  : ListView(padding: const EdgeInsets.fromLTRB(20, 4, 20, 20), children: [
                      if (l.length >= 400) Padding(padding: const EdgeInsets.only(bottom: 6), child: Text('Die neuesten 400 — für ältere die Suche nutzen.', style: theme.textTheme.labelSmall?.copyWith(color: dim))),
                      ...l.map(karte),
                    ])),
    ])));
  }
}
