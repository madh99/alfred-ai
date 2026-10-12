/// 1.15.0 — Projekte auf Geräten (Spec „Projekte sichtbar und fortsetzbar", Owner 12.10.: „in der App oder im Web sieht man außer
/// beim Bauen nichts vom Projekt"). Liest `/api/geraete/projekte` (Server v1401, nur Geräte des Owners): Liste mit Zustand,
/// Detail mit Läufen und Etappen, „Stand laden" (Commits vom Gerät) und „Weiterarbeiten" — nur der Wunsch; Alfred plant mit dem
/// Bestand und fragt vor dem Start zur Bestätigung.
library;

import 'package:flutter/material.dart';

import 'aufgaben.dart' show JsonAbruf;

class ProjektKurz {
  ProjektKurz(Map<String, dynamic> j)
      : id = '${j['id']}', name = '${j['name'] ?? ''}', geraet = '${j['geraet'] ?? ''}', pfad = '${j['pfad'] ?? ''}',
        zustand = '${j['zustand'] ?? 'ruht'}', laeufe = (j['laeufe'] as num?)?.toInt() ?? 0, kostenUsd = (j['kostenUsd'] as num?)?.toDouble() ?? 0,
        letzteAktivitaet = DateTime.tryParse('${j['letzteAktivitaet'] ?? ''}')?.toLocal();
  final String id, name, geraet, pfad, zustand;
  final int laeufe;
  final double kostenUsd;
  final DateTime? letzteAktivitaet;
}

class Lauf {
  Lauf(Map<String, dynamic> j)
      : id = '${j['id']}', status = '${j['status'] ?? ''}', grund = j['grund'] as String?, ziel = '${j['ziel'] ?? ''}',
        plan = ((j['plan'] as List<dynamic>?) ?? []).map((e) => '$e').toList(),
        erledigt = ((j['erledigt'] as List<dynamic>?) ?? []).whereType<Map<String, dynamic>>().toList(),
        nr = (j['nr'] as num?)?.toInt() ?? 0, kostenUsd = (j['kostenUsd'] as num?)?.toDouble() ?? 0,
        start = DateTime.tryParse('${j['start'] ?? ''}')?.toLocal(), frage = j['frage'] as String?, frageArt = j['frageArt'] as String?;
  final String id, status, ziel;
  final String? grund;
  /// 1.15.1 — offene Frage (Plan, Weiter, Planänderung): direkt hier freigeben statt in den Bestätigungen
  final String? frage, frageArt;
  final List<String> plan;
  final List<Map<String, dynamic>> erledigt;
  final int nr;
  final double kostenUsd;
  final DateTime? start;
  int get ok => erledigt.where((e) => e['ok'] == true).length;
  /// Zeichen je Etappe: ✅ abgenommen, ▶ läuft, ❌ nicht abgenommen, · offen.
  String zeichen(int i) {
    final e = erledigt.where((x) => (x['nr'] as num?)?.toInt() == i + 1).firstOrNull;
    if (e?['ok'] == true) return '✅';
    if (status == 'laeuft' && i + 1 == nr) return '▶';
    return e != null ? '❌' : '·';
  }
}

String usd(double n) => '${n.toStringAsFixed(2).replaceAll('.', ',')} USD';

String laufStatus(String s) => switch (s) {
      'laeuft' => '▶ läuft',
      'wartet_owner' => '⏳ wartet auf dich',
      'fertig' => '✅ fertig',
      'angehalten' => '⏸ angehalten',
      _ => '⏹ abgebrochen',
    };

String zustandText(String z) => switch (z) { 'laeuft' => '▶ läuft', 'wartet' => '⏳ wartet auf dich', _ => 'ruht' };

class Projekte extends StatefulWidget {
  const Projekte({super.key, required this.json, this.aufMeldung});
  final JsonAbruf json;
  final void Function(String text)? aufMeldung;
  @override
  State<Projekte> createState() => _ProjekteState();
}

class _ProjekteState extends State<Projekte> {
  List<ProjektKurz>? liste;
  String? fehler;
  String? gewaehlt;

  @override
  void initState() { super.initState(); laden(); }

  Future<void> laden() async {
    try {
      final j = await widget.json('/api/geraete/projekte');
      final l = ((j['projekte'] as List<dynamic>?) ?? []).whereType<Map<String, dynamic>>().map(ProjektKurz.new).toList();
      if (mounted) setState(() { liste = l; fehler = null; });
    } catch (e) { if (mounted) setState(() => fehler = '$e'); }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    if (gewaehlt != null) {
      return ProjektDetail(key: ValueKey(gewaehlt), id: gewaehlt!, json: widget.json, aufMeldung: widget.aufMeldung, zurueck: () { setState(() => gewaehlt = null); laden(); });
    }
    final l = liste;
    return RefreshIndicator(onRefresh: laden, child: ListView(padding: const EdgeInsets.all(16), children: [
      Row(children: [
        Expanded(child: Text('Projekte auf Geräten', style: theme.textTheme.titleLarge)),
        IconButton(tooltip: 'Aktualisieren', onPressed: laden, icon: const Icon(Icons.refresh)),
      ]),
      const SizedBox(height: 8),
      if (fehler != null) Text('Nicht geladen: $fehler', style: TextStyle(color: theme.colorScheme.error)),
      if (l == null && fehler == null) const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator())),
      if (l != null && l.isEmpty) Text('Noch keine Projekte. Sag Alfred z. B. „Bau mir auf der Ubuntu-VM …".', style: theme.textTheme.bodyMedium),
      for (final p in l ?? <ProjektKurz>[])
        Card(margin: const EdgeInsets.only(bottom: 8), child: ListTile(
          onTap: () => setState(() => gewaehlt = p.id),
          title: Text(p.name),
          subtitle: Text('📟 ${p.geraet} · ${p.pfad}\n${p.laeufe} ${p.laeufe == 1 ? 'Lauf' : 'Läufe'} · ${usd(p.kostenUsd)}', style: theme.textTheme.bodySmall),
          isThreeLine: true,
          trailing: Text(zustandText(p.zustand), style: theme.textTheme.labelMedium),
        )),
    ]));
  }
}

class ProjektDetail extends StatefulWidget {
  const ProjektDetail({super.key, required this.id, required this.json, required this.zurueck, this.aufMeldung});
  final String id;
  final JsonAbruf json;
  final VoidCallback zurueck;
  final void Function(String text)? aufMeldung;
  @override
  State<ProjektDetail> createState() => _ProjektDetailState();
}

class _ProjektDetailState extends State<ProjektDetail> {
  Map<String, dynamic>? d;
  String? fehler, stand, meldung;
  bool standLaedt = false, plant = false, meldungOk = true;
  final wunsch = TextEditingController();
  final frage = TextEditingController(); // 1.15.2
  final offen = <String>{};

  @override
  void initState() { super.initState(); laden(); }
  @override
  void dispose() { wunsch.dispose(); frage.dispose(); super.dispose(); }

  Future<void> laden() async {
    try {
      final j = await widget.json('/api/geraete/projekte/${widget.id}');
      if (!mounted) return;
      setState(() { d = j; fehler = null; });
      final l = ((j['laeufe'] as List<dynamic>?) ?? []);
      if (offen.isEmpty && l.isNotEmpty) offen.add('${(l.first as Map<String, dynamic>)['id']}');
    } catch (e) { if (mounted) setState(() => fehler = '$e'); }
  }

  Future<void> standLaden() async {
    setState(() => standLaedt = true);
    try {
      final r = await widget.json('/api/geraete/projekte/${widget.id}', methode: 'POST', koerper: {'aktion': 'stand'});
      if (mounted) setState(() => stand = r['success'] == true ? '${r['display'] ?? ''}' : 'Fehler: ${r['error'] ?? 'unbekannt'}');
    } catch (e) { if (mounted) setState(() => stand = 'Fehler: $e'); }
    finally { if (mounted) setState(() => standLaedt = false); }
  }

  Future<void> entscheiden(Lauf l, String aktion) async {
    setState(() { plant = true; meldung = null; });
    try {
      final r = await widget.json('/api/geraete/projekte/${widget.id}', methode: 'POST', koerper: {'aktion': aktion, 'lauf': l.id});
      final ok = r['success'] == true;
      if (!mounted) return;
      setState(() { meldungOk = ok; meldung = ok ? '${r['display'] ?? 'Entschieden.'}' : '${r['error'] ?? 'Fehler'}'; });
      if (ok) { widget.aufMeldung?.call(aktion == 'freigeben' ? '🧭 Projekt freigegeben' : '🧭 Projekt abgelehnt'); await laden(); }
    } catch (e) { if (mounted) setState(() { meldungOk = false; meldung = '$e'; }); }
    finally { if (mounted) setState(() => plant = false); }
  }

  /// 1.15.2 — Frage zum Projekt: Claude Code liest nur; die Antwort kommt als Meldung in den Chat (≈1 min)
  Future<void> fragen() async {
    final t = frage.text.trim();
    if (t.isEmpty) return;
    setState(() { plant = true; meldung = null; });
    try {
      final r = await widget.json('/api/geraete/projekte/${widget.id}', methode: 'POST', koerper: {'aktion': 'frage', 'text': t});
      final ok = r['success'] == true;
      if (!mounted) return;
      setState(() { meldungOk = ok; meldung = ok ? '${r['display'] ?? 'Gefragt.'}\nDie Antwort kommt als Meldung in den Chat.' : '${r['error'] ?? 'Fehler'}'; });
      if (ok) frage.clear();
    } catch (e) { if (mounted) setState(() { meldungOk = false; meldung = '$e'; }); }
    finally { if (mounted) setState(() => plant = false); }
  }

  Future<void> weiter() async {
    final t = wunsch.text.trim();
    if (t.isEmpty) return;
    setState(() { plant = true; meldung = null; });
    try {
      final r = await widget.json('/api/geraete/projekte/${widget.id}', methode: 'POST', koerper: {'aktion': 'weiter', 'text': t});
      final ok = r['success'] == true;
      if (!mounted) return;
      setState(() { meldungOk = ok; meldung = ok ? '${r['display'] ?? 'Geplant.'}\nDie Planfrage kommt zur Bestätigung.' : '${r['error'] ?? 'Fehler'}'; });
      if (ok) { wunsch.clear(); widget.aufMeldung?.call('🧭 Projekt geplant — Planfrage kommt zur Bestätigung'); await laden(); }
    } catch (e) { if (mounted) setState(() { meldungOk = false; meldung = '$e'; }); }
    finally { if (mounted) setState(() => plant = false); }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dim = theme.colorScheme.onSurfaceVariant;
    final j = d;
    final laeufe = ((j?['laeufe'] as List<dynamic>?) ?? []).whereType<Map<String, dynamic>>().map(Lauf.new).toList()
      ..sort((a, b) => (b.start ?? DateTime(0)).compareTo(a.start ?? DateTime(0)));
    final laeuftGerade = laeufe.any((l) => l.status == 'laeuft' || l.status == 'wartet_owner');
    final befehle = ((j?['pruefBefehle'] as List<dynamic>?) ?? []).map((e) => '$e').toList();
    final punkte = ((j?['offenePunkte'] as List<dynamic>?) ?? []).whereType<Map<String, dynamic>>().toList();
    final kosten = laeufe.fold<double>(0, (s, l) => s + l.kostenUsd);
    String datum(DateTime x) => '${x.day}.${x.month}. ${x.hour.toString().padLeft(2, '0')}:${x.minute.toString().padLeft(2, '0')}';

    return RefreshIndicator(onRefresh: laden, child: ListView(padding: const EdgeInsets.all(16), children: [
      Row(children: [
        IconButton(tooltip: 'Zurück zur Liste', onPressed: widget.zurueck, icon: const Icon(Icons.arrow_back)),
        Expanded(child: Text('${j?['name'] ?? 'Projekt'}', style: theme.textTheme.titleLarge)),
        IconButton(tooltip: 'Aktualisieren', onPressed: laden, icon: const Icon(Icons.refresh)),
      ]),
      if (fehler != null) Text('Nicht geladen: $fehler', style: TextStyle(color: theme.colorScheme.error)),
      if (j == null && fehler == null) const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator())),
      if (j != null) ...[
        Text('📟 ${j['geraet'] ?? ''} · ${j['pfad'] ?? ''}', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
        Text('Abnahme: ${befehle.isEmpty ? 'keine — Alfred fragt nach jeder Etappe' : befehle.join(' ; ')}', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
        Text('${laeufe.length} ${laeufe.length == 1 ? 'Lauf' : 'Läufe'} · ${usd(kosten)}', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
        const SizedBox(height: 12),
        Card(child: Padding(padding: const EdgeInsets.all(12), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Weiterarbeiten', style: theme.textTheme.titleSmall),
          Text('Nur, was als Nächstes passieren soll. Gerät, Verzeichnis, Abnahme und den Bestand kennt Alfred. Er plant und fragt dich vor dem Start.', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
          const SizedBox(height: 8),
          TextField(key: const Key('wunsch-feld'), controller: wunsch, minLines: 2, maxLines: 5, enabled: !plant && !laeuftGerade, decoration: const InputDecoration(border: OutlineInputBorder(), hintText: 'z. B. Die Merkliste soll man per Link teilen können.')),
          const SizedBox(height: 8),
          Row(children: [
            FilledButton.tonal(onPressed: plant || laeuftGerade ? null : weiter, child: Text(plant ? 'Plane …' : 'Planen lassen')),
            if (laeuftGerade) Expanded(child: Padding(padding: const EdgeInsets.only(left: 12), child: Text('Ein Lauf läuft oder wartet gerade.', style: theme.textTheme.bodySmall))),
          ]),
          if (meldung != null) Padding(padding: const EdgeInsets.only(top: 8), child: SelectableText(meldung!, style: theme.textTheme.bodySmall?.copyWith(color: meldungOk ? null : theme.colorScheme.error))),
        ]))),
        const SizedBox(height: 8),
        Card(child: Padding(padding: const EdgeInsets.all(12), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Frage zum Projekt', style: theme.textTheme.titleSmall),
          Text('Claude Code liest im Projekt und antwortet, ändert aber nichts. Die Antwort kommt nach etwa einer Minute als Meldung in den Chat.', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
          const SizedBox(height: 8),
          TextField(key: const Key('frage-feld'), controller: frage, minLines: 1, maxLines: 4, enabled: !plant, decoration: const InputDecoration(border: OutlineInputBorder(), hintText: 'z. B. Woher holt die App die Hofer-Angebote?')),
          const SizedBox(height: 8),
          OutlinedButton(key: const Key('fragen'), onPressed: plant ? null : fragen, child: const Text('Fragen')),
        ]))),
        const SizedBox(height: 12),
        Text('Läufe', style: theme.textTheme.titleSmall),
        if (laeufe.isEmpty) Text('Noch keine Läufe.', style: theme.textTheme.bodySmall),
        for (final l in laeufe)
          Card(margin: const EdgeInsets.only(top: 6), child: InkWell(
            onTap: () => setState(() => offen.contains(l.id) ? offen.remove(l.id) : offen.add(l.id)),
            child: Padding(padding: const EdgeInsets.all(12), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Text(laufStatus(l.status), style: theme.textTheme.labelMedium),
                const SizedBox(width: 8),
                Expanded(child: Text('${l.ok}/${l.plan.length} · ${usd(l.kostenUsd)}${l.start != null ? ' · ${datum(l.start!)}' : ''}', style: theme.textTheme.bodySmall?.copyWith(color: dim))),
              ]),
              if (l.status == 'wartet_owner' && l.frage != null) Container(
                margin: const EdgeInsets.only(top: 8), padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(color: theme.colorScheme.tertiaryContainer, borderRadius: BorderRadius.circular(8)),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  SelectableText(l.frage!, style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onTertiaryContainer)),
                  const SizedBox(height: 8),
                  Row(children: [
                    FilledButton(key: Key('freigeben-${l.id}'), onPressed: plant ? null : () => entscheiden(l, 'freigeben'), child: const Text('Freigeben')),
                    const SizedBox(width: 8),
                    OutlinedButton(key: Key('ablehnen-${l.id}'), onPressed: plant ? null : () => entscheiden(l, 'ablehnen'), child: const Text('Ablehnen')),
                  ]),
                ]),
              ),
              const SizedBox(height: 4),
              Text(l.ziel, maxLines: offen.contains(l.id) ? null : 2, overflow: offen.contains(l.id) ? null : TextOverflow.ellipsis, style: theme.textTheme.bodyMedium),
              if (offen.contains(l.id)) ...[
                if (l.grund != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text(l.grund!, style: theme.textTheme.bodySmall?.copyWith(color: dim))),
                const SizedBox(height: 6),
                for (var i = 0; i < l.plan.length; i++) Padding(padding: const EdgeInsets.only(bottom: 3), child: Text('${l.zeichen(i)} ${l.plan[i]}', style: theme.textTheme.bodySmall)),
              ],
            ])),
          )),
        const SizedBox(height: 12),
        Row(children: [
          Expanded(child: Text('Stand auf dem Gerät', style: theme.textTheme.titleSmall)),
          TextButton(onPressed: standLaedt ? null : standLaden, child: Text(standLaedt ? 'Lese …' : 'Commits und Stand laden')),
        ]),
        if (stand != null) Card(child: Padding(padding: const EdgeInsets.all(12), child: SelectableText(stand!, style: theme.textTheme.bodySmall?.copyWith(fontFamily: 'monospace')))),
        if (punkte.isNotEmpty) ...[
          const SizedBox(height: 12),
          Text('Offene Punkte (${punkte.length})', style: theme.textTheme.titleSmall),
          for (final p in punkte.take(20)) Text('• ${p['titel'] ?? ''}', style: theme.textTheme.bodySmall),
        ],
      ],
    ]));
  }
}
