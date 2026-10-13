/// 1.15.0 — Projekte auf Geräten (Spec „Projekte sichtbar und fortsetzbar", Owner 12.10.: „in der App oder im Web sieht man außer
/// beim Bauen nichts vom Projekt"). Liest `/api/geraete/projekte` (Server v1401, nur Geräte des Owners): Liste mit Zustand,
/// Detail mit Läufen und Etappen, „Stand laden" (Commits vom Gerät) und „Weiterarbeiten" — nur der Wunsch; Alfred plant mit dem
/// Bestand und fragt vor dem Start zur Bestätigung.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import 'aufgaben.dart' show JsonAbruf;
import 'projekt_deploy.dart'; // 1.24.0
import 'projekt_umgebungen.dart'; // 1.25.0

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

/// 1.17.3 — Owner 13.10.: „läuft 1/3“ las sich wie Etappe 1, war aber die Zahl der abgenommenen Etappen.
String laufFortschritt(Lauf l) => l.status == 'laeuft' && l.nr > 0
    ? 'Etappe ${l.nr}/${l.plan.length}${l.ok > 0 ? ' · ${l.ok} abgenommen' : ''}'
    : '${l.ok}/${l.plan.length} abgenommen';

/// 1.18.0 — Schalter „Protokoll im Projekt“ (v1425): Detail liefert protokoll; fehlt das Feld (alter Server), gilt an.
bool protokollAn(Map<String, dynamic>? d) => d?['protokoll'] != false;

/// 1.19.0 — Projektregeln (v1426, Projekt-Konventionen): Schalter mit Optionen und eigene Regeln; jede Änderung geht sofort an den Server.
class ProjektRegeln extends StatefulWidget {
  const ProjektRegeln({super.key, required this.konventionen, required this.aendern, this.gesperrt = false});
  final Map<String, dynamic> konventionen;
  final Future<void> Function(Map<String, dynamic> aenderung) aendern;
  final bool gesperrt;
  @override
  State<ProjektRegeln> createState() => _ProjektRegelnState();
}

class _ProjektRegelnState extends State<ProjektRegeln> {
  final neu = TextEditingController();
  @override
  void dispose() { neu.dispose(); super.dispose(); }

  Map<String, dynamic> teil(String k) => (widget.konventionen[k] as Map<String, dynamic>?) ?? const {};

  Widget auswahl(String wert, Map<String, String> optionen, void Function(String) neuWert, Key key) => DropdownButton<String>(key: key, isDense: true, value: optionen.containsKey(wert) ? wert : optionen.keys.first,
    items: [for (final e in optionen.entries) DropdownMenuItem(value: e.key, child: Text(e.value))], onChanged: widget.gesperrt ? null : (v) { if (v != null) neuWert(v); });

  void regelDazu() { final t = neu.text.trim(); if (t.isEmpty) return; neu.clear(); widget.aendern({'regel': t}); }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dim = theme.colorScheme.onSurfaceVariant;
    final cl = teil('changelog'), rm = teil('readme'), cm = teil('commits');
    final clAn = cl['autoUpdate'] == true, rmAn = rm['autoUpdate'] == true, cmAn = cm['convention'] == 'conventional';
    final regeln = ((widget.konventionen['regeln'] as List<dynamic>?) ?? []).map((e) => '$e').toList();
    final aktiv = [if (clAn) 'CHANGELOG', if (rmAn) 'README', if (cmAn) 'Conventional Commits', if (regeln.isNotEmpty) '${regeln.length} eigene'];
    return Card(child: ExpansionTile(key: const Key('projekt-regeln'), title: const Text('Projektregeln'), subtitle: Text(aktiv.isEmpty ? 'keine — gelten für jede Etappe' : aktiv.join(' · '), style: theme.textTheme.bodySmall?.copyWith(color: dim)),
      childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 12), expandedCrossAxisAlignment: CrossAxisAlignment.start, children: [
        SwitchListTile(key: const Key('regel-changelog'), contentPadding: EdgeInsets.zero, dense: true, value: clAn, onChanged: widget.gesperrt ? null : (v) => widget.aendern({'changelog': v}),
          title: const Text('CHANGELOG pflegen'), subtitle: Text('Fehlt der Eintrag nach einer Etappe, lässt Alfred ihn vor der Abnahme nachtragen.', style: theme.textTheme.bodySmall?.copyWith(color: dim))),
        if (clAn) Padding(padding: const EdgeInsets.only(bottom: 6), child: Row(children: [const Text('Format: '), auswahl('${cl['format'] ?? 'keepachangelog'}', const {'keepachangelog': 'Keep a Changelog', 'free': 'frei'}, (v) => widget.aendern({'changelog': {'format': v}}), const Key('regel-changelog-format'))])),
        SwitchListTile(key: const Key('regel-readme'), contentPadding: EdgeInsets.zero, dense: true, value: rmAn, onChanged: widget.gesperrt ? null : (v) => widget.aendern({'readme': v}), title: const Text('README pflegen')),
        if (rmAn) Padding(padding: const EdgeInsets.only(bottom: 6), child: Row(children: [const Text('Vorlage: '), auswahl('${rm['template'] ?? 'default'}', const {'default': 'Features/Setup/Usage', 'minimal': 'nur Titel + Beschreibung', 'custom': 'eigene (Alfred greift nicht ein)'}, (v) => widget.aendern({'readme': {'template': v}}), const Key('regel-readme-vorlage'))])),
        SwitchListTile(key: const Key('regel-commits'), contentPadding: EdgeInsets.zero, dense: true, value: cmAn, onChanged: widget.gesperrt ? null : (v) => widget.aendern({'conventionalCommits': v}), title: const Text('Conventional Commits (feat:/fix:/…)')),
        if (cmAn) Padding(padding: const EdgeInsets.only(bottom: 6), child: Row(children: [const Text('Scope: '), auswahl('${cm['scopePolicy'] ?? 'optional'}', const {'optional': 'optional', 'required': 'Pflicht', 'forbidden': 'ohne'}, (v) => widget.aendern({'commits': {'scopePolicy': v}}), const Key('regel-commits-scope'))])),
        const SizedBox(height: 6),
        Text('Eigene Regeln', style: theme.textTheme.labelLarge),
        for (var i = 0; i < regeln.length; i++) Row(children: [
          Expanded(child: Text('${i + 1}. ${regeln[i]}', style: theme.textTheme.bodySmall)),
          IconButton(key: Key('regel-weg-$i'), tooltip: 'Regel entfernen', iconSize: 18, onPressed: widget.gesperrt ? null : () => widget.aendern({'regelEntfernen': '${i + 1}'}), icon: const Icon(Icons.delete_outline)),
        ]),
        if (regeln.length < 12) Row(children: [
          Expanded(child: TextField(key: const Key('regel-neu'), controller: neu, maxLength: 200, decoration: const InputDecoration(isDense: true, hintText: 'z. B. Commits auf Deutsch', counterText: ''), onSubmitted: (_) => regelDazu())),
          IconButton(key: const Key('regel-dazu'), tooltip: 'Regel hinzufügen', onPressed: widget.gesperrt ? null : regelDazu, icon: const Icon(Icons.add)),
        ]),
      ]));
  }
}

class Lauf {
  Lauf(Map<String, dynamic> j)
      : id = '${j['id']}', status = '${j['status'] ?? ''}', grund = j['grund'] as String?, ziel = '${j['ziel'] ?? ''}',
        plan = ((j['plan'] as List<dynamic>?) ?? []).map((e) => '$e').toList(),
        erledigt = ((j['erledigt'] as List<dynamic>?) ?? []).whereType<Map<String, dynamic>>().toList(),
        nr = (j['nr'] as num?)?.toInt() ?? 0, kostenUsd = (j['kostenUsd'] as num?)?.toDouble() ?? 0,
        start = DateTime.tryParse('${j['start'] ?? ''}')?.toLocal(), frage = j['frage'] as String?, frageArt = j['frageArt'] as String?, wartetAufGeraet = j['wartetAufGeraet'] != null,
        live = ((j['live'] as Map<String, dynamic>?)?['schritte'] as List<dynamic>? ?? []).map((e) => '$e').toList(), liveWerkzeuge = ((j['live'] as Map<String, dynamic>?)?['werkzeuge'] as num?)?.toInt();
  final String id, status, ziel;
  final String? grund;
  /// 1.15.1 — offene Frage (Plan, Weiter, Planänderung): direkt hier freigeben statt in den Bestätigungen
  final String? frage, frageArt;
  /// 1.15.3 — Etappe wartet, bis das Gerät wieder verbunden ist
  final bool wartetAufGeraet;
  /// 1.16.1 G2 — letzte Schritte von Claude Code, solange die Etappe läuft
  final List<String> live;
  final int? liveWerkzeuge;
  final List<String> plan;
  final List<Map<String, dynamic>> erledigt;
  final int nr;
  final double kostenUsd;
  final DateTime? start;
  int get ok => erledigt.where((e) => e['ok'] == true).length;
  /// 1.16.0 G1 — Etappenbericht (Zusammenfassung, Dateien, Commit, Abnahme) der Etappe i (0-basiert)
  Map<String, dynamic>? bericht(int i) => erledigt.where((x) => (x['nr'] as num?)?.toInt() == i + 1).firstOrNull?['bericht'] as Map<String, dynamic>?;
  /// Zeichen je Etappe: ✅ abgenommen, ▶ läuft, ❌ nicht abgenommen, · offen.
  String zeichen(int i) {
    final e = erledigt.where((x) => (x['nr'] as num?)?.toInt() == i + 1).firstOrNull;
    if (e?['ok'] == true) return '✅';
    if (status == 'laeuft' && i + 1 == nr) return '▶';
    return e != null ? '❌' : '·';
  }
}

String usd(double n) => '${n.toStringAsFixed(2).replaceAll('.', ',')} USD';

String laufStatusMit(Lauf l) => l.status == 'laeuft' && l.wartetAufGeraet ? '⏳ wartet auf Gerät' : laufStatus(l.status);

String laufStatus(String s) => switch (s) {
      'laeuft' => '▶ läuft',
      'wartet_owner' => '⏳ wartet auf dich',
      'fertig' => '✅ fertig',
      'angehalten' => '⏸ angehalten',
      _ => '⏹ abgebrochen',
    };

String zustandText(String z) => switch (z) { 'laeuft' => '▶ läuft', 'wartet' => '⏳ wartet auf dich', _ => 'ruht' };

class Projekte extends StatefulWidget {
  const Projekte({super.key, required this.json, this.aufMeldung, this.anfang, this.aufGespraech});
  final JsonAbruf json;
  /// 1.17.0 G3 — Projektfaden öffnen (Owner-Faden projekt-<id8>)
  final void Function(String faden)? aufGespraech;
  /// 1.16.1 — gleich dieses Projekt öffnen (Live-Leiste)
  final String? anfang;
  final void Function(String text)? aufMeldung;
  @override
  State<Projekte> createState() => _ProjekteState();
}

class _ProjekteState extends State<Projekte> {
  List<ProjektKurz>? liste;
  String? fehler;
  String? gewaehlt;

  @override
  void initState() { super.initState(); gewaehlt = widget.anfang; laden(); }

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
      return ProjektDetail(key: ValueKey(gewaehlt), id: gewaehlt!, json: widget.json, aufMeldung: widget.aufMeldung, aufGespraech: widget.aufGespraech, zurueck: () { setState(() => gewaehlt = null); laden(); });
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
  const ProjektDetail({super.key, required this.id, required this.json, required this.zurueck, this.aufMeldung, this.aufGespraech});
  final void Function(String faden)? aufGespraech;
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
  final berichtOffen = <String>{}; // 1.16.0 G1 — aufgeklappte Etappen (lauf:nr)
  Timer? liveTakt; // 1.16.1 G2 — läuft eine Etappe, alle 5 s neu laden
  final offen = <String>{};

  @override
  void initState() { super.initState(); laden(); }
  @override
  void dispose() { liveTakt?.cancel(); wunsch.dispose(); frage.dispose(); super.dispose(); }

  Future<void> laden() async {
    try {
      final j = await widget.json('/api/geraete/projekte/${widget.id}');
      if (!mounted) return;
      setState(() { d = j; fehler = null; });
      final laeuft = ((j['laeufe'] as List<dynamic>?) ?? []).any((x) => (x as Map<String, dynamic>)['status'] == 'laeuft');
      if (laeuft && liveTakt == null) { liveTakt = Timer.periodic(const Duration(seconds: 5), (_) { if (mounted) laden(); }); }
      if (!laeuft) { liveTakt?.cancel(); liveTakt = null; }
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

  /// 1.15.3 — angehaltenen Lauf fortsetzen (aktuelle Etappe neu, gleiche Freigabe)
  /// 1.16.0 G1 — eine Etappe: Zeile, aufklappbar mit Bericht
  Widget _etappe(ThemeData theme, Lauf l, int i) {
    final b = l.bericht(i);
    final key = '${l.id}:$i';
    final auf = berichtOffen.contains(key);
    final dim = theme.colorScheme.onSurfaceVariant;
    final dateien = ((b?['dateien'] as List<dynamic>?) ?? []).map((e) => '$e').toList();
    final anzahl = (b?['dateienAnzahl'] as num?)?.toInt() ?? dateien.length;
    final commit = b?['commit'] as Map<String, dynamic>?;
    final abnahme = b?['abnahme'] as Map<String, dynamic>?;
    final dauer = (b?['dauerS'] as num?)?.toInt();
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      InkWell(key: Key('etappe-$key'), onTap: b == null ? null : () => setState(() => auf ? berichtOffen.remove(key) : berichtOffen.add(key)), child: Padding(padding: const EdgeInsets.symmetric(vertical: 3), child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(child: Text('${l.zeichen(i)} ${l.plan[i]}', style: theme.textTheme.bodySmall)),
        if (b != null) Icon(auf ? Icons.expand_less : Icons.expand_more, size: 16, color: dim),
      ]))),
      if (auf && b != null) Container(
        margin: const EdgeInsets.only(left: 18, bottom: 8), padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(color: theme.colorScheme.surfaceContainerHighest.withValues(alpha: 0.5), borderRadius: BorderRadius.circular(8)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text([if (abnahme != null) (abnahme['ok'] == true ? 'Abnahme ✅' : 'Abnahme ❌') else 'ohne Abnahme', if ((b['fixVersuche'] as num? ?? 0) > 0) '${b['fixVersuche']} Fix-Versuch(e)', if (dauer != null) '${(dauer / 60).round()} min'].join(' · '), style: theme.textTheme.labelSmall?.copyWith(color: dim)),
          if ('${b['zusammenfassung'] ?? ''}'.trim().isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: SelectableText('${b['zusammenfassung']}'.trim(), style: theme.textTheme.bodySmall)),
          if (anzahl > 0) Padding(padding: const EdgeInsets.only(top: 6), child: Text('Geänderte Dateien ($anzahl): ${dateien.take(12).join(', ')}${anzahl > 12 ? ' …' : ''}', style: theme.textTheme.bodySmall?.copyWith(color: dim))),
          if (commit != null) Padding(padding: const EdgeInsets.only(top: 6), child: Row(children: [
            Expanded(child: Text('Commit ${'${commit['sha']}'.substring(0, '${commit['sha']}'.length.clamp(0, 7))} · ${commit['titel'] ?? ''}', style: theme.textTheme.bodySmall)),
            TextButton(key: Key('diff-$key'), onPressed: () => _diffZeigen('${commit['sha']}', dateien), child: const Text('Änderungen ansehen')),
          ])),
          if (abnahme != null && abnahme['ok'] != true && '${abnahme['protokoll'] ?? ''}'.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: SelectableText('${abnahme['protokoll']}', style: theme.textTheme.bodySmall?.copyWith(fontFamily: 'monospace', color: theme.colorScheme.error))),
        ]),
      ),
    ]);
  }

  /// 1.16.0 G1 — Änderungen eines Commits: Statistik; Antippen einer Datei zeigt ihren Diff (nur lesend)
  Future<void> _diffZeigen(String sha, List<String> dateien) async {
    var text = '';
    Future<String> hole([String? datei]) async {
      try { final r = await widget.json('/api/geraete/projekte/${widget.id}', methode: 'POST', koerper: {'aktion': 'diff', 'lauf': sha, if (datei != null) 'text': datei}); return r['success'] == true ? '${r['display'] ?? ''}' : 'Fehler: ${r['error'] ?? ''}'; } catch (e) { return 'Fehler: $e'; }
    }
    text = await hole();
    if (!mounted) return;
    await showDialog<void>(context: context, builder: (ctx) => StatefulBuilder(builder: (ctx, setD) {
      return AlertDialog(
        title: Text('Änderungen ${sha.substring(0, sha.length.clamp(0, 7))}'),
        content: SizedBox(width: 720, child: SingleChildScrollView(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          if (dateien.isNotEmpty) Wrap(spacing: 6, runSpacing: 4, children: [for (final d in dateien.take(20)) ActionChip(label: Text(d, style: const TextStyle(fontSize: 11)), onPressed: () async { setD(() => text = 'Lade …'); final t = await hole(d); setD(() => text = t); })]),
          const SizedBox(height: 8),
          SelectableText(text, style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
        ]))),
        actions: [TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('Schließen'))],
      );
    }));
  }

  /// 1.19.0 — Projektregeln ändern (v1426)
  Future<void> konventionenSetzen(Map<String, dynamic> aenderung) async {
    setState(() { plant = true; meldung = null; });
    try {
      final r = await widget.json('/api/geraete/projekte/${widget.id}', methode: 'POST', koerper: {'aktion': 'konventionen', 'konventionen': aenderung});
      final ok = r['success'] == true;
      if (!mounted) return;
      if (!ok) setState(() { meldungOk = false; meldung = '${r['error'] ?? 'Fehler'}'; });
      if (ok) await laden();
    } catch (e) { if (mounted) setState(() { meldungOk = false; meldung = '$e'; }); }
    finally { if (mounted) setState(() => plant = false); }
  }

  /// 1.18.0 — Schalter „Protokoll im Projekt“ (v1425)
  Future<void> protokollSetzen(bool an) async {
    setState(() { plant = true; meldung = null; });
    try {
      final r = await widget.json('/api/geraete/projekte/${widget.id}', methode: 'POST', koerper: {'aktion': 'protokoll', 'text': an ? 'an' : 'aus'});
      final ok = r['success'] == true;
      if (!mounted) return;
      setState(() { meldungOk = ok; meldung = ok ? '${r['display'] ?? 'Gespeichert.'}' : '${r['error'] ?? 'Fehler'}'; });
      if (ok) await laden();
    } catch (e) { if (mounted) setState(() { meldungOk = false; meldung = '$e'; }); }
    finally { if (mounted) setState(() => plant = false); }
  }

  Future<void> fortsetzen(Lauf l) async {
    setState(() { plant = true; meldung = null; });
    try {
      final r = await widget.json('/api/geraete/projekte/${widget.id}', methode: 'POST', koerper: {'aktion': 'fortsetzen', 'lauf': l.id});
      final ok = r['success'] == true;
      if (!mounted) return;
      setState(() { meldungOk = ok; meldung = ok ? '${r['display'] ?? 'Fortgesetzt.'}' : '${r['error'] ?? 'Fehler'}'; });
      if (ok) await laden();
    } catch (e) { if (mounted) setState(() { meldungOk = false; meldung = '$e'; }); }
    finally { if (mounted) setState(() => plant = false); }
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
      setState(() { meldungOk = ok; meldung = ok ? '${r['display'] ?? 'Gefragt.'}\nDie Antwort kommt ins Gespräch zum Projekt.' : '${r['error'] ?? 'Fehler'}'; });
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
        if (widget.aufGespraech != null && RegExp(r'^[0-9a-f]{8}').hasMatch(widget.id)) TextButton.icon(key: const Key('projekt-gespraech'), onPressed: () => widget.aufGespraech!('projekt-${widget.id.substring(0, 8)}'), icon: const Icon(Icons.forum_outlined, size: 18), label: const Text('Gespräch zum Projekt')), // 1.17.0 G3
        IconButton(tooltip: 'Aktualisieren', onPressed: laden, icon: const Icon(Icons.refresh)),
      ]),
      if (fehler != null) Text('Nicht geladen: $fehler', style: TextStyle(color: theme.colorScheme.error)),
      if (j == null && fehler == null) const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator())),
      if (j != null) ...[
        Text('📟 ${j['geraet'] ?? ''} · ${j['pfad'] ?? ''}', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
        Text('Abnahme: ${befehle.isEmpty ? 'keine — Alfred fragt nach jeder Etappe' : befehle.join(' ; ')}', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
        Text('${laeufe.length} ${laeufe.length == 1 ? 'Lauf' : 'Läufe'} · ${usd(kosten)}', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
        // 1.18.0 — Schalter je Projekt: Auftrag und Bericht jeder Etappe mit committen (v1425)
        SwitchListTile(key: const Key('projekt-protokoll'), contentPadding: EdgeInsets.zero, dense: true, value: protokollAn(j), onChanged: plant ? null : protokollSetzen,
          title: const Text('Protokoll im Projekt'),
          subtitle: Text(protokollAn(j) ? 'An: Auftrag und Bericht jeder Etappe werden unter .alfred/laeufe/ mit committet.' : 'Aus: Auftrag und Bericht bleiben nur lokal unter .alfred/laeufe/ (nicht in git).', style: theme.textTheme.bodySmall?.copyWith(color: dim))),
        ProjektRegeln(konventionen: (j['konventionen'] as Map<String, dynamic>?) ?? const {}, aendern: konventionenSetzen, gesperrt: plant), // 1.19.0
        ProjektDeploy(id: widget.id, json: widget.json, deploy: j['deploy'] as Map<String, dynamic>?, neuLaden: laden, aufMeldung: widget.aufMeldung), // 1.24.0 v1439
        ProjektUmgebungen(id: widget.id, json: widget.json), // 1.25.0 v1443 B15
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
          Text('Claude Code liest im Projekt und antwortet, ändert aber nichts. Die Antwort kommt nach etwa einer Minute ins Gespräch zum Projekt.', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
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
                Text(laufStatusMit(l), style: theme.textTheme.labelMedium),
                const SizedBox(width: 8),
                Expanded(child: Text('${laufFortschritt(l)} · ${usd(l.kostenUsd)}${l.start != null ? ' · ${datum(l.start!)}' : ''}', style: theme.textTheme.bodySmall?.copyWith(color: dim))),
              ]),
              if (l.status == 'laeuft' && l.live.isNotEmpty) Container( // 1.16.1 G2 — Live-Aktivität
                key: Key('live-${l.id}'), margin: const EdgeInsets.only(top: 8), padding: const EdgeInsets.all(8), width: double.infinity,
                decoration: BoxDecoration(color: Colors.black.withValues(alpha: 0.25), borderRadius: BorderRadius.circular(6)),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('🔨 Claude Code arbeitet${l.liveWerkzeuge != null ? ' · ${l.liveWerkzeuge} Schritte' : ''}', style: theme.textTheme.labelSmall),
                  for (final z in l.live) Text(z, maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall?.copyWith(fontFamily: 'monospace')),
                ]),
              ),
              if (l.status == 'angehalten') Padding(padding: const EdgeInsets.only(top: 8), child: OutlinedButton.icon(key: Key('fortsetzen-${l.id}'), onPressed: plant ? null : () => fortsetzen(l), icon: const Icon(Icons.play_arrow, size: 18), label: const Text('Fortsetzen'))),
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
                for (var i = 0; i < l.plan.length; i++) _etappe(theme, l, i),
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
