/// 1.9.0 — A1 (Owner-Freigabe 11.10.): Aufgaben & Erinnerungen nativ, ohne Umweg über den Chat. Liest
/// `/api/geraete/aufgaben` (Server v1353, nur Geräte des Owners): offene Aufgaben gruppiert nach Fälligkeit, abhaken mit
/// Rückgängig, verschieben (morgen, nächste Woche, Datum), umbenennen, neu anlegen; kommende Erinnerungen mit Löschen.
/// Fällige Erinnerungen meldet die App selbst als Systembenachrichtigung (siehe `faelligeErinnerungen`).
library;

import 'package:flutter/material.dart';

class Aufgabe {
  Aufgabe(Map<String, dynamic> j)
      : id = '${j['id']}', titel = '${j['titel'] ?? ''}', beschreibung = j['beschreibung'] as String?, prioritaet = '${j['prioritaet'] ?? 'normal'}',
        faellig = DateTime.tryParse('${j['faellig'] ?? ''}')?.toLocal(), liste = '${j['liste'] ?? 'default'}', erledigt = j['erledigt'] == true;
  final String id, titel, prioritaet, liste;
  final String? beschreibung;
  final DateTime? faellig;
  final bool erledigt;
  bool get dringend => prioritaet == 'urgent' || prioritaet == 'high';
}

class Erinnerung {
  Erinnerung(Map<String, dynamic> j) : id = '${j['id']}', text = '${j['text'] ?? ''}', zeit = DateTime.tryParse('${j['zeit']}')?.toLocal() ?? DateTime.now();
  final String id, text;
  final DateTime zeit;
}

/// Gruppen in Anzeigereihenfolge.
const aufgabenGruppen = ['Überfällig', 'Heute', 'Morgen', 'Diese Woche', 'Später', 'Ohne Termin'];

DateTime _tag(DateTime d) => DateTime(d.year, d.month, d.day);

/// Gruppe einer Aufgabe relativ zu `jetzt` (lokale Zeit). „Diese Woche" = bis einschließlich Sonntag.
String aufgabenGruppe(Aufgabe a, DateTime jetzt) {
  final f = a.faellig;
  if (f == null) return 'Ohne Termin';
  final heute = _tag(jetzt);
  final tag = _tag(f);
  if (tag.isBefore(heute)) return 'Überfällig';
  if (tag == heute) return 'Heute'; // auch wenn die Uhrzeit vorbei ist — reine Datumsaufgaben stehen auf 00:00
  if (tag == heute.add(const Duration(days: 1))) return 'Morgen';
  final sonntag = heute.add(Duration(days: DateTime.sunday - heute.weekday));
  if (!tag.isAfter(sonntag)) return 'Diese Woche';
  return 'Später';
}

/// Zahl für die Symbolleiste: überfällig oder heute fällig.
int aufgabenFaellig(List<Aufgabe> l, DateTime jetzt) => l.where((a) { final g = aufgabenGruppe(a, jetzt); return g == 'Überfällig' || g == 'Heute'; }).length;

/// Ziel beim Verschieben: „morgen" = morgen 9:00, „woche" = nächster Montag 9:00 (lokale Zeit).
DateTime verschiebeZiel(String wahl, DateTime jetzt) {
  final heute = _tag(jetzt);
  return switch (wahl) {
    'woche' => heute.add(Duration(days: 8 - heute.weekday)).add(const Duration(hours: 9)),
    _ => heute.add(const Duration(days: 1, hours: 9)),
  };
}

/// Bekannte Erinnerungen mit einer neuen Serverliste abgleichen. Der Server streicht eine Erinnerung, sobald sie
/// ausgelöst ist — die App behält sie deshalb, bis sie gemeldet ist (Zeit vorbei). Fehlt eine künftige Erinnerung in der
/// neuen Liste, wurde sie gelöscht: weg. Älter als 30 min: weg (nach App-Start nichts Altes nachmelden).
void erinnerungenAbgleichen(Map<String, Erinnerung> bekannt, List<Erinnerung> neu, DateTime jetzt) {
  final ids = neu.map((e) => e.id).toSet();
  bekannt.removeWhere((id, e) => (e.zeit.isAfter(jetzt) && !ids.contains(id)) || jetzt.difference(e.zeit) >= const Duration(minutes: 30));
  for (final e in neu) { bekannt[e.id] = e; }
}

/// Erinnerungen, die seit dem letzten Blick fällig wurden und noch nicht gemeldet sind.
List<Erinnerung> faelligeErinnerungen(List<Erinnerung> l, DateTime jetzt, Set<String> gemeldet) =>
    l.where((e) => !e.zeit.isAfter(jetzt) && jetzt.difference(e.zeit) < const Duration(minutes: 30) && !gemeldet.contains(e.id)).toList();

String zeitText(DateTime t, DateTime jetzt) {
  final hm = '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
  final d = _tag(t).difference(_tag(jetzt)).inDays;
  if (d == 0) return 'heute $hm';
  if (d == 1) return 'morgen $hm';
  if (d == -1) return 'gestern $hm';
  const wt = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  return '${wt[t.weekday - 1]} ${t.day}.${t.month}. $hm';
}

typedef JsonAbruf = Future<Map<String, dynamic>> Function(String pfad, {String methode, Map<String, dynamic>? koerper});

class Aufgaben extends StatefulWidget {
  const Aufgaben({super.key, required this.json, required this.aufMeldung, this.aufStand, this.jetzt});
  final JsonAbruf json;
  final void Function(String text) aufMeldung;
  /// Nach jedem Laden: Aufgaben und Erinnerungen für Zähler und Benachrichtigungen der Sitzung.
  final void Function(List<Aufgabe> aufgaben, List<Erinnerung> erinnerungen)? aufStand;
  final DateTime Function()? jetzt;
  @override
  State<Aufgaben> createState() => _AufgabenState();
}

class _AufgabenState extends State<Aufgaben> {
  List<Aufgabe>? aufgaben;
  List<Erinnerung> erinnerungen = [];
  String? fehler;
  final neu = TextEditingController();
  DateTime? neuFaellig;
  bool sendet = false;

  DateTime get jetzt => widget.jetzt?.call() ?? DateTime.now();

  @override
  void initState() { super.initState(); laden(); }

  @override
  void dispose() { neu.dispose(); super.dispose(); }

  Future<void> laden() async {
    try {
      final j = await widget.json('/api/geraete/aufgaben');
      final a = ((j['aufgaben'] as List<dynamic>?) ?? []).whereType<Map<String, dynamic>>().map(Aufgabe.new).toList();
      final e = ((j['erinnerungen'] as List<dynamic>?) ?? []).whereType<Map<String, dynamic>>().map(Erinnerung.new).toList();
      if (!mounted) return;
      setState(() { aufgaben = a; erinnerungen = e; fehler = null; });
      widget.aufStand?.call(a, e);
    } catch (e) { if (mounted) setState(() => fehler = '$e'); }
  }

  Future<bool> _aendern(Aufgabe a, Map<String, dynamic> k) async {
    try {
      await widget.json('/api/geraete/aufgaben/${a.id}', methode: 'POST', koerper: k);
      await laden();
      return true;
    } catch (e) { widget.aufMeldung('✅ Aufgabe nicht geändert: $e'); return false; }
  }

  Future<void> abhaken(Aufgabe a) async {
    if (!await _aendern(a, {'erledigt': true})) return;
    if (!mounted) return;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(
      content: Text('Erledigt: ${a.titel}'),
      action: SnackBarAction(label: 'Rückgängig', onPressed: () => _aendern(a, {'erledigt': false})),
      // 1.12.1 — seit Flutter 3.47 bleibt eine Meldung mit Knopf stehen (persist = action != null); Owner 12.10.: sie verschwand nie
      persist: false,
      duration: const Duration(seconds: 8),
    ));
  }

  Future<DateTime?> _datumWaehlen(DateTime? start) async {
    final basis = start ?? verschiebeZiel('morgen', jetzt);
    final d = await showDatePicker(context: context, initialDate: basis, firstDate: _tag(jetzt).subtract(const Duration(days: 1)), lastDate: _tag(jetzt).add(const Duration(days: 730)));
    if (d == null || !mounted) return null;
    final t = await showTimePicker(context: context, initialTime: TimeOfDay.fromDateTime(basis));
    return DateTime(d.year, d.month, d.day, t?.hour ?? 9, t?.minute ?? 0);
  }

  Future<void> menue(Aufgabe a, String wahl) async {
    switch (wahl) {
      case 'morgen' || 'woche':
        await _aendern(a, {'faellig': verschiebeZiel(wahl, jetzt).toUtc().toIso8601String()});
      case 'datum':
        final d = await _datumWaehlen(a.faellig);
        if (d != null) await _aendern(a, {'faellig': d.toUtc().toIso8601String()});
      case 'ohne':
        await _aendern(a, {'faellig': ''});
      case 'umbenennen':
        final c = TextEditingController(text: a.titel);
        final t = await showDialog<String>(context: context, builder: (ctx) => AlertDialog(
          title: const Text('Aufgabe umbenennen'),
          content: TextField(controller: c, autofocus: true, onSubmitted: (v) => Navigator.pop(ctx, v)),
          actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Abbrechen')), FilledButton(onPressed: () => Navigator.pop(ctx, c.text), child: const Text('Speichern'))],
        ));
        if (t != null && t.trim().isNotEmpty && t.trim() != a.titel) await _aendern(a, {'titel': t.trim()});
      case 'dringend':
        await _aendern(a, {'prioritaet': a.dringend ? 'normal' : 'high'});
    }
  }

  Future<void> anlegen() async {
    final t = neu.text.trim();
    if (t.isEmpty || sendet) return;
    setState(() => sendet = true);
    try {
      await widget.json('/api/geraete/aufgaben', methode: 'POST', koerper: {'titel': t, if (neuFaellig != null) 'faellig': neuFaellig!.toUtc().toIso8601String()});
      neu.clear();
      setState(() => neuFaellig = null);
      await laden();
    } catch (e) { widget.aufMeldung('✅ Aufgabe nicht angelegt: $e'); }
    finally { if (mounted) setState(() => sendet = false); }
  }

  Future<void> erinnerungLoeschen(Erinnerung e) async {
    final ok = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(
      title: const Text('Erinnerung löschen?'),
      content: Text('„${e.text}“ — ${zeitText(e.zeit, jetzt)}'),
      actions: [TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Abbrechen')), FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Löschen'))],
    ));
    if (ok != true) return;
    try { await widget.json('/api/geraete/erinnerungen/${e.id}', methode: 'DELETE'); await laden(); }
    catch (err) { widget.aufMeldung('⏰ Erinnerung nicht gelöscht: $err'); }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dim = theme.colorScheme.onSurfaceVariant;
    if (fehler != null && aufgaben == null) return Center(child: Text('Aufgaben nicht geladen: $fehler', style: TextStyle(color: theme.colorScheme.error)));
    final l = aufgaben;
    if (l == null) return const Center(child: CircularProgressIndicator());
    final j = jetzt;
    final gruppen = {for (final g in aufgabenGruppen) g: l.where((a) => aufgabenGruppe(a, j) == g).toList()};

    Widget zeile(Aufgabe a) => ListTile(
      dense: true,
      contentPadding: const EdgeInsets.only(left: 4, right: 0),
      leading: Checkbox(value: false, onChanged: (_) => abhaken(a)),
      title: Row(children: [
        if (a.dringend) Padding(padding: const EdgeInsets.only(right: 4), child: Icon(Icons.priority_high, size: 16, color: theme.colorScheme.error)),
        Expanded(child: Text(a.titel, style: theme.textTheme.bodyMedium)),
      ]),
      subtitle: (a.faellig != null || (a.beschreibung ?? '').isNotEmpty || a.liste != 'default')
          ? Text([if (a.faellig != null) zeitText(a.faellig!, j), if (a.liste != 'default') a.liste, if ((a.beschreibung ?? '').isNotEmpty) a.beschreibung!].join(' · '), maxLines: 2, overflow: TextOverflow.ellipsis, style: theme.textTheme.labelSmall?.copyWith(color: aufgabenGruppe(a, j) == 'Überfällig' ? theme.colorScheme.error : dim))
          : null,
      trailing: PopupMenuButton<String>(
        tooltip: 'Verschieben, umbenennen',
        onSelected: (w) => menue(a, w),
        itemBuilder: (_) => [
          const PopupMenuItem(value: 'morgen', child: Text('Auf morgen')),
          const PopupMenuItem(value: 'woche', child: Text('Auf nächste Woche')),
          const PopupMenuItem(value: 'datum', child: Text('Datum wählen …')),
          if (a.faellig != null) const PopupMenuItem(value: 'ohne', child: Text('Termin entfernen')),
          const PopupMenuDivider(),
          const PopupMenuItem(value: 'umbenennen', child: Text('Umbenennen …')),
          PopupMenuItem(value: 'dringend', child: Text(a.dringend ? 'Nicht mehr dringend' : 'Als dringend markieren')),
        ],
      ),
    );

    return Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 920), child: RefreshIndicator(onRefresh: laden, child: ListView(padding: const EdgeInsets.all(20), children: [
      Row(children: [
        Text('Aufgaben', style: theme.textTheme.headlineSmall),
        const Spacer(),
        IconButton(tooltip: 'Neu laden', onPressed: laden, icon: const Icon(Icons.refresh)),
      ]),
      Text('Dieselben Aufgaben wie im Web und in Telegram. Abhaken und Verschieben gilt überall.', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
      const SizedBox(height: 12),
      Card(child: Padding(padding: const EdgeInsets.fromLTRB(12, 4, 6, 4), child: Row(children: [
        Expanded(child: TextField(controller: neu, enabled: !sendet, decoration: const InputDecoration(hintText: 'Neue Aufgabe …', border: InputBorder.none), onSubmitted: (_) => anlegen())),
        if (neuFaellig != null) InputChip(label: Text(zeitText(neuFaellig!, j)), onDeleted: () => setState(() => neuFaellig = null)),
        IconButton(tooltip: 'Fällig am …', onPressed: () async { final d = await _datumWaehlen(neuFaellig); if (d != null) setState(() => neuFaellig = d); }, icon: const Icon(Icons.event_outlined)),
        IconButton(tooltip: 'Anlegen', onPressed: sendet ? null : anlegen, icon: const Icon(Icons.add_task)),
      ]))),
      const SizedBox(height: 8),
      if (l.isEmpty) Padding(padding: const EdgeInsets.symmetric(vertical: 20), child: Text('Keine offenen Aufgaben.', style: theme.textTheme.bodyMedium?.copyWith(color: dim))),
      for (final g in aufgabenGruppen)
        if (gruppen[g]!.isNotEmpty) ...[
          Padding(padding: const EdgeInsets.fromLTRB(4, 14, 4, 2), child: Text('$g (${gruppen[g]!.length})', style: theme.textTheme.titleSmall?.copyWith(color: g == 'Überfällig' ? theme.colorScheme.error : null))),
          ...gruppen[g]!.map(zeile),
        ],
      const SizedBox(height: 20),
      Text('Erinnerungen (${erinnerungen.length})', style: theme.textTheme.titleMedium),
      Text('Neue Erinnerungen legst du im Chat an („Erinnere mich morgen um 9 an …“).', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
      const SizedBox(height: 6),
      if (erinnerungen.isEmpty) Text('Keine kommenden Erinnerungen.', style: theme.textTheme.bodyMedium?.copyWith(color: dim)),
      for (final e in erinnerungen) ListTile(
        dense: true,
        leading: const Icon(Icons.alarm, size: 20),
        title: Text(e.text, style: theme.textTheme.bodyMedium),
        subtitle: Text(zeitText(e.zeit, j), style: theme.textTheme.labelSmall?.copyWith(color: dim)),
        trailing: IconButton(tooltip: 'Löschen', onPressed: () => erinnerungLoeschen(e), icon: const Icon(Icons.delete_outline, size: 20)),
      ),
    ]))));
  }
}
