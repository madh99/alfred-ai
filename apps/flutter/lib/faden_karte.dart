/// 1.44.0 (v1501, D3) — Angeheftete Zusammenfassung oben rechts im Chat (Owner 19.10., App-Spec §11):
/// in Fäden eines Projekts Stand, Änderungen und Schnellaktionen; in anderen Fäden eine Zusammenfassung auf Klick
/// (günstiges Modell, je Faden gespeichert) und die offenen Bestätigungen aus diesem Faden.
library;

import 'dart:io';

import 'package:flutter/material.dart';

import 'aufgaben.dart' show JsonAbruf;
import 'markdown.dart';
import 'projekte.dart' show Lauf, laufStatusMit, laufFortschritt, usd;

/// Neueste Etappe eines Laufs mit Commit (für „Änderungen“): (sha, Titel, Dateien), sonst null.
(String, String, List<String>)? letzterCommit(List<Lauf> laeufe) {
  for (final l in laeufe) {
    final berichte = [for (var i = l.plan.length - 1; i >= 0; i--) l.bericht(i)].whereType<Map<String, dynamic>>();
    for (final b in berichte) {
      final c = b['commit'] as Map<String, dynamic>?;
      if (c != null && '${c['sha'] ?? ''}'.isNotEmpty) return ('${c['sha']}', '${c['titel'] ?? ''}', ((b['dateien'] as List<dynamic>?) ?? []).map((e) => '$e').toList());
    }
  }
  return null;
}

/// Prüfungen der letzten abgeschlossenen Etappe: '✅ grün', '❌ rot', 'ungeprüft' oder null (noch keine Etappe).
String? letztePruefung(List<Lauf> laeufe) {
  for (final l in laeufe) {
    for (var i = l.plan.length - 1; i >= 0; i--) {
      final b = l.bericht(i);
      if (b == null) continue;
      final a = b['abnahme'] as Map<String, dynamic>?;
      return a == null ? 'ungeprüft' : a['ok'] == true ? '✅ grün' : '❌ rot';
    }
  }
  return null;
}

/// Ordner im Dateimanager des Geräts öffnen.
Future<void> oeffneOrdner(String pfad) async {
  try {
    if (Platform.isWindows) { await Process.start('explorer', [pfad], mode: ProcessStartMode.detached); }
    else if (Platform.isMacOS) { await Process.start('open', [pfad], mode: ProcessStartMode.detached); }
    else { await Process.start('xdg-open', [pfad], mode: ProcessStartMode.detached); }
  } catch (_) {}
}

/// Terminal im Ordner öffnen (Windows Terminal, sonst cmd; macOS Terminal; Linux gnome-terminal, sonst x-terminal-emulator).
Future<void> oeffneTerminal(String pfad) async {
  try {
    if (Platform.isWindows) {
      try { await Process.start('wt', ['-d', pfad], mode: ProcessStartMode.detached); }
      catch (_) { await Process.start('cmd', ['/c', 'start', 'cmd', '/K', 'cd /d "$pfad"'], mode: ProcessStartMode.detached); }
    } else if (Platform.isMacOS) { await Process.start('open', ['-a', 'Terminal', pfad], mode: ProcessStartMode.detached); }
    else {
      try { await Process.start('gnome-terminal', ['--working-directory=$pfad'], mode: ProcessStartMode.detached); }
      catch (_) { await Process.start('x-terminal-emulator', [], workingDirectory: pfad, mode: ProcessStartMode.detached); }
    }
  } catch (_) {}
}

class ProjektKarte extends StatefulWidget {
  const ProjektKarte({super.key, required this.json, required this.projektId, required this.dieserRechner, required this.aufProjektansicht, required this.aufMeldung});
  final JsonAbruf json;
  final String projektId;
  /// Name dieses Geräts: Ordner und Terminal nur, wenn das Projekt hier liegt.
  final String dieserRechner;
  final VoidCallback aufProjektansicht;
  final void Function(String) aufMeldung;
  @override
  State<ProjektKarte> createState() => _ProjektKarteState();
}

class _ProjektKarteState extends State<ProjektKarte> {
  Map<String, dynamic>? d;
  String? fehler;
  bool sendet = false;

  @override
  void initState() { super.initState(); laden(); }

  Future<void> laden() async {
    try { final j = await widget.json('/api/geraete/projekte/${widget.projektId}'); if (mounted) setState(() { d = j; fehler = null; }); }
    catch (e) { if (mounted) setState(() => fehler = '$e'); }
  }

  Future<void> dev(String aktion) async {
    setState(() => sendet = true);
    try {
      final r = await widget.json('/api/geraete/projekte/${widget.projektId}', methode: 'POST', koerper: {'aktion': 'dev', 'deploy': {'dev_aktion': aktion}});
      widget.aufMeldung(r['success'] == true ? '${r['display'] ?? 'Erledigt.'}' : 'dev: ${r['error'] ?? 'Fehler'}');
      await laden();
    } catch (e) { widget.aufMeldung('dev: $e'); }
    finally { if (mounted) setState(() => sendet = false); }
  }

  Future<void> aenderungen(String sha, List<String> dateien) async {
    String text;
    try {
      final r = await widget.json('/api/geraete/projekte/${widget.projektId}', methode: 'POST', koerper: {'aktion': 'diff', 'lauf': sha});
      text = r['success'] == true ? '${r['display'] ?? ''}' : 'Fehler: ${r['error'] ?? 'unbekannt'}';
    } catch (e) { text = 'Fehler: $e'; }
    if (!mounted) return;
    await showDialog<void>(context: context, builder: (ctx) => AlertDialog(
      title: Text('Änderungen ${sha.substring(0, sha.length.clamp(0, 7))}'),
      content: SizedBox(width: 720, child: SingleChildScrollView(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (dateien.isNotEmpty) Text('Dateien: ${dateien.take(20).join(', ')}${dateien.length > 20 ? ' …' : ''}', style: Theme.of(ctx).textTheme.bodySmall),
        const SizedBox(height: 8),
        SelectableText(text, style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
      ]))),
      actions: [TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('Schließen'))],
    ));
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dim = theme.colorScheme.onSurfaceVariant;
    final j = d;
    if (j == null) return Padding(padding: const EdgeInsets.all(12), child: Text(fehler == null ? 'Lade Projekt …' : 'Projekt nicht geladen: $fehler', style: theme.textTheme.bodySmall));
    final laeufe = ((j['laeufe'] as List<dynamic>?) ?? []).whereType<Map<String, dynamic>>().map(Lauf.new).toList();
    final l = laeufe.firstOrNull;
    final commit = letzterCommit(laeufe);
    final pruefung = letztePruefung(laeufe);
    final devD = j['dev'] as Map<String, dynamic>?;
    final devUrl = (devD?['zuletzt'] as Map<String, dynamic>?)?['url'] as String?;
    final devAn = devD?['aktiv'] == true;
    final pfad = '${j['pfad'] ?? ''}';
    final hier = '${j['geraet'] ?? ''}' == widget.dieserRechner && pfad.isNotEmpty;
    return Padding(padding: const EdgeInsets.fromLTRB(12, 10, 8, 10), child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
      Row(children: [
        Expanded(child: InkWell(onTap: widget.aufProjektansicht, child: Text('${j['name']}', key: const Key('karte-projekt-name'), style: theme.textTheme.titleSmall))),
        IconButton(tooltip: 'Neu laden', iconSize: 16, visualDensity: VisualDensity.compact, onPressed: laden, icon: const Icon(Icons.refresh)),
      ]),
      Text('${j['geraet'] ?? ''} · $pfad', maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.labelSmall?.copyWith(color: dim)),
      const SizedBox(height: 8),
      if (l == null) Text('Noch kein Lauf.', style: theme.textTheme.bodySmall)
      else ...[
        Text('${laufStatusMit(l)} · ${laufFortschritt(l)}', key: const Key('karte-stand'), style: theme.textTheme.bodySmall),
        if (pruefung != null) Text('Prüfungen: $pruefung', style: theme.textTheme.bodySmall),
        Text('Kosten des Laufs: ${usd(l.kostenUsd)}', style: theme.textTheme.labelSmall?.copyWith(color: dim)),
      ],
      if (commit != null) ListTile(key: const Key('karte-aenderungen'), dense: true, contentPadding: EdgeInsets.zero, leading: const Icon(Icons.difference_outlined, size: 18),
        title: const Text('Änderungen'), subtitle: Text('${commit.$1.substring(0, commit.$1.length.clamp(0, 7))} · ${commit.$2}', maxLines: 1, overflow: TextOverflow.ellipsis),
        onTap: () => aenderungen(commit.$1, commit.$3)),
      const Divider(height: 12),
      Wrap(spacing: 6, runSpacing: 4, children: [
        if (devUrl != null) ActionChip(avatar: const Icon(Icons.open_in_browser, size: 16), label: const Text('dev öffnen'), onPressed: () => oeffneLink(devUrl)),
        if (devAn) ActionChip(avatar: const Icon(Icons.restart_alt, size: 16), label: const Text('dev neu starten'), onPressed: sendet ? null : () => dev('neustart'))
        else ActionChip(avatar: const Icon(Icons.play_arrow, size: 16), label: const Text('dev starten'), onPressed: sendet ? null : () => dev('einschalten')),
        if (hier) ActionChip(avatar: const Icon(Icons.folder_open_outlined, size: 16), label: const Text('Ordner'), onPressed: () => oeffneOrdner(pfad)),
        if (hier) ActionChip(avatar: const Icon(Icons.terminal, size: 16), label: const Text('Terminal'), onPressed: () => oeffneTerminal(pfad)),
        ActionChip(avatar: const Icon(Icons.construction_outlined, size: 16), label: const Text('Projektansicht'), onPressed: widget.aufProjektansicht),
      ]),
    ]));
  }
}

class FadenKarte extends StatefulWidget {
  const FadenKarte({super.key, required this.json, required this.faden, required this.aufBestaetigungen});
  final JsonAbruf json;
  /// null = Hauptgespräch
  final String? faden;
  final VoidCallback aufBestaetigungen;
  @override
  State<FadenKarte> createState() => _FadenKarteState();
}

class _FadenKarteState extends State<FadenKarte> {
  Map<String, dynamic>? d;
  bool laedt = false;
  String? fehler;

  String get _pfad => '/api/geraete/faeden/${widget.faden ?? 'haupt'}/zusammenfassung';

  @override
  void initState() { super.initState(); laden(neu: false); }

  Future<void> laden({required bool neu}) async {
    setState(() { laedt = neu; fehler = null; });
    try { final j = await widget.json(_pfad, methode: neu ? 'POST' : 'GET'); if (mounted) setState(() => d = j); }
    catch (e) { if (mounted) setState(() => fehler = '$e'); }
    finally { if (mounted) setState(() => laedt = false); }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dim = theme.colorScheme.onSurfaceVariant;
    final text = d?['text'] as String?;
    final stand = DateTime.tryParse('${d?['stand'] ?? ''}')?.toLocal();
    final neue = ((d?['anzahl'] as num?)?.toInt() ?? 0) - ((d?['standAnzahl'] as num?)?.toInt() ?? 0);
    final best = ((d?['bestaetigungen'] as List<dynamic>?) ?? []).whereType<Map<String, dynamic>>().toList();
    return Padding(padding: const EdgeInsets.fromLTRB(12, 10, 8, 10), child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
      Row(children: [
        Expanded(child: Text('Zusammenfassung', style: theme.textTheme.titleSmall)),
        if (laedt) const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
        else IconButton(key: const Key('karte-zusammenfassen'), tooltip: text == null ? 'Zusammenfassen' : 'Neu zusammenfassen', iconSize: 16, visualDensity: VisualDensity.compact, onPressed: () => laden(neu: true), icon: Icon(text == null ? Icons.auto_awesome : Icons.refresh)),
      ]),
      if (fehler != null) Text('Nicht geladen: $fehler', style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.error))
      else if (text == null) Text(laedt ? 'Alfred fasst zusammen …' : 'Noch keine Zusammenfassung — ✨ fasst das Gespräch in ein paar Zeilen zusammen.', style: theme.textTheme.bodySmall?.copyWith(color: dim))
      else ...[
        AlfredText(text, key: const Key('karte-text')),
        if (stand != null) Text('Stand ${stand.day}.${stand.month}. ${stand.hour.toString().padLeft(2, '0')}:${stand.minute.toString().padLeft(2, '0')}${neue > 0 ? ' · $neue neue Nachrichten seither' : ''}', style: theme.textTheme.labelSmall?.copyWith(color: dim)),
      ],
      if (best.isNotEmpty) ...[
        const Divider(height: 14),
        Text('Offene Bestätigungen aus diesem Gespräch', style: theme.textTheme.labelMedium),
        for (final b in best.take(5)) Padding(padding: const EdgeInsets.only(top: 3), child: InkWell(onTap: widget.aufBestaetigungen, child: Text('🔔 ${b['text']}', maxLines: 2, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall))),
      ],
    ]));
  }
}
