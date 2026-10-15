import 'package:flutter/material.dart';
import 'aufgaben.dart' show JsonAbruf;

/// 1.31.0 — test am Gerät (v1462): eigener Ordner aus dem Hauptzweig, eigener Port, aktualisiert nach dem Zusammenführen.
/// 1.30.0 — dev je Projekt (v1460): „am Gerät“ (die App läuft im Arbeitsordner, Alfred startet sie nach jeder grünen Etappe neu)
/// oder „eigener Host“ (das dev-Ziel im Deploy-Bereich). Die Startangabe erkennt Alfred selbst (Startdatei, package.json …, sonst
/// Claude Code nur lesend) oder man trägt sie ein; ausgeführt wird sie erst nach der Bestätigung des Owners.
String devAngabeText(Map<String, dynamic>? a) {
  if (a == null) return 'noch keine bestätigte Startangabe';
  if (a['dienst'] == false) return 'kein Dienst — dev heißt hier: Build und Tests grün';
  final einr = (a['einrichten'] as List?)?.map((e) => '$e').toList() ?? const <String>[];
  return 'Start „${a['start'] ?? ''}“${a['port'] != null ? ' · Port ${a['port']}' : ''}${a['pruefung'] != null ? ' · Prüfadresse ${a['pruefung']}' : ''}${einr.isNotEmpty ? ' · Einrichtung: ${einr.join('; ')}' : ''}';
}

const quelleText = {'datei': 'aus .alfred-start.json', 'erkannt': 'erkannt', 'claude': 'von Claude Code ermittelt', 'manuell': 'von dir eingetragen'};

class ProjektDev extends StatefulWidget {
  const ProjektDev({super.key, required this.id, required this.json, required this.dev, required this.neuLaden, this.aufMeldung});
  final String id;
  final JsonAbruf json;
  final Map<String, dynamic>? dev;
  final Future<void> Function() neuLaden;
  final void Function(String text)? aufMeldung;
  @override
  State<ProjektDev> createState() => _ProjektDevState();
}

class _ProjektDevState extends State<ProjektDev> {
  bool sendet = false;
  String? meldung;
  bool meldungOk = true;

  Future<void> senden(Map<String, dynamic> felder) async {
    setState(() { sendet = true; meldung = null; });
    try {
      final r = await widget.json('/api/geraete/projekte/${widget.id}', methode: 'POST', koerper: {'aktion': 'dev', 'deploy': felder});
      final ok = r['success'] == true;
      if (!mounted) return;
      setState(() { meldungOk = ok; meldung = ok ? '${r['display'] ?? 'Erledigt.'}' : '${r['error'] ?? 'Fehler'}'; });
      if (ok) await widget.neuLaden();
    } catch (e) { if (mounted) setState(() { meldungOk = false; meldung = '$e'; }); }
    finally { if (mounted) setState(() => sendet = false); }
  }

  Future<void> eintragen() async {
    final felder = await showDialog<Map<String, dynamic>>(context: context, builder: (_) => DevEintragenDialog(angabe: widget.dev?['angabe'] as Map<String, dynamic>?));
    if (felder != null) await senden(felder);
  }

  /// 1.31.0 — test am Gerät (nur mit bestätigter dev-Startangabe)
  List<Widget> _test(ThemeData theme, Color dim, Map<String, dynamic>? t) {
    final an = t?['aktiv'] == true;
    final z = t?['zuletzt'] as Map<String, dynamic>?;
    return [
      const Divider(height: 20),
      SwitchListTile(key: const Key('test-aktiv'), contentPadding: EdgeInsets.zero, dense: true, value: an, onChanged: sendet ? null : (v) => senden({'dev_aktion': v ? 'test_einschalten' : 'test_ausschalten'}),
        title: const Text('test am Gerät'),
        subtitle: Text(an ? 'Eigener Ordner aus dem Hauptzweig — wird nach jedem Zusammenführen und nach grünen Läufen aktualisiert.' : 'Einschalten schlägt Ordner und Port vor und fragt dich.', style: theme.textTheme.bodySmall?.copyWith(color: dim))),
      if (t != null) Text('Ordner ${t['ordner'] ?? ''}${t['port'] != null ? ' · Port ${t['port']}' : ''}${t['zweig'] != null ? ' · Zweig ${t['zweig']}' : ''}', key: const Key('test-angabe'), style: theme.textTheme.bodySmall),
      if (z != null) Padding(padding: const EdgeInsets.only(top: 4), child: SelectableText('${z['ok'] == true ? '🟢' : '🔴'} ${z['url'] ?? z['text'] ?? ''}${z['sha'] != null ? ' (${z['sha']})' : ''}', style: theme.textTheme.bodySmall)),
      if (t != null) Padding(padding: const EdgeInsets.only(top: 6), child: Wrap(spacing: 8, children: [
        OutlinedButton(key: const Key('test-aktualisieren'), onPressed: sendet ? null : () => senden({'dev_aktion': 'test_aktualisieren'}), child: const Text('test aktualisieren')),
        OutlinedButton(key: const Key('test-stoppen'), onPressed: sendet ? null : () => senden({'dev_aktion': 'test_stoppen'}), child: const Text('test stoppen')),
      ])),
    ];
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dim = theme.colorScheme.onSurfaceVariant;
    final d = widget.dev ?? const {};
    final host = d['art'] == 'host';
    final aktiv = d['aktiv'] == true;
    final angabe = d['angabe'] as Map<String, dynamic>?;
    final zuletzt = d['zuletzt'] as Map<String, dynamic>?;
    final dienst = angabe != null && angabe['dienst'] != false;
    return Card(child: Padding(padding: const EdgeInsets.all(12), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('dev', style: theme.textTheme.titleSmall),
      const SizedBox(height: 6),
      SegmentedButton<String>(key: const Key('dev-art'), segments: const [ButtonSegment(value: 'geraet', label: Text('Am Gerät')), ButtonSegment(value: 'host', label: Text('Eigener Host'))],
        selected: {host ? 'host' : 'geraet'}, onSelectionChanged: sendet ? null : (s) => senden({'dev_aktion': 'art', 'art': s.first})),
      if (host) Padding(padding: const EdgeInsets.only(top: 6), child: Text('dev wird über das dev-Ziel im Deploy-Bereich ausgerollt.', style: theme.textTheme.bodySmall?.copyWith(color: dim)))
      else ...[
        SwitchListTile(key: const Key('dev-aktiv'), contentPadding: EdgeInsets.zero, dense: true, value: aktiv, onChanged: sendet ? null : (v) => senden({'dev_aktion': v ? 'einschalten' : 'ausschalten'}),
          title: const Text('dev am Gerät'),
          subtitle: Text(aktiv ? 'An: Alfred startet die App nach jeder grünen Etappe im Arbeitsordner neu.' : 'Aus: Einschalten erkennt, wie das Projekt startet, und fragt dich.', style: theme.textTheme.bodySmall?.copyWith(color: dim))),
        Text(devAngabeText(angabe) + (d['quelle'] != null ? ' (${quelleText[d['quelle']] ?? d['quelle']})' : ''), key: const Key('dev-angabe'), style: theme.textTheme.bodySmall),
        if (zuletzt != null) Padding(padding: const EdgeInsets.only(top: 4), child: SelectableText('${zuletzt['ok'] == true ? '🟢' : '🔴'} ${zuletzt['url'] ?? zuletzt['text'] ?? ''}', style: theme.textTheme.bodySmall)),
        const SizedBox(height: 6),
        Wrap(spacing: 8, runSpacing: 4, children: [
          OutlinedButton(key: const Key('dev-erkennen'), onPressed: sendet ? null : () => senden({'dev_aktion': 'erkennen'}), child: const Text('Erkennen')),
          OutlinedButton(key: const Key('dev-eintragen'), onPressed: sendet ? null : eintragen, child: const Text('Eintragen')),
          if (dienst) OutlinedButton(key: const Key('dev-neustart'), onPressed: sendet ? null : () => senden({'dev_aktion': 'neustart'}), child: const Text('Neu starten')),
          if (dienst) OutlinedButton(key: const Key('dev-stoppen'), onPressed: sendet ? null : () => senden({'dev_aktion': 'stoppen'}), child: const Text('Stoppen')),
        ]),
        if (dienst) ..._test(theme, dim, d['test'] as Map<String, dynamic>?),
      ],
      if (meldung != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(meldung!, style: theme.textTheme.bodySmall?.copyWith(color: meldungOk ? dim : theme.colorScheme.error))),
    ])));
  }
}

/// Eigener Dialog mit eigenen Controllern (werden erst nach dem Schließen entsorgt — sonst nutzt die Schließ-Animation entsorgte Controller).
class DevEintragenDialog extends StatefulWidget {
  const DevEintragenDialog({super.key, this.angabe});
  final Map<String, dynamic>? angabe;
  @override
  State<DevEintragenDialog> createState() => _DevEintragenDialogState();
}

class _DevEintragenDialogState extends State<DevEintragenDialog> {
  late final start = TextEditingController(text: '${widget.angabe?['start'] ?? ''}');
  late final port = TextEditingController(text: widget.angabe?['port'] != null ? '${widget.angabe!['port']}' : '');
  late final pruefung = TextEditingController(text: '${widget.angabe?['pruefung'] ?? ''}');
  late final einrichten = TextEditingController(text: ((widget.angabe?['einrichten'] as List?) ?? const []).join('\n')); // 1.32.0
  late bool keinDienst = widget.angabe?['dienst'] == false;

  @override
  void dispose() { for (final c in [start, port, pruefung, einrichten]) { c.dispose(); } super.dispose(); }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('Startangabe eintragen'),
    content: Column(mainAxisSize: MainAxisSize.min, children: [
      CheckboxListTile(key: const Key('dev-kein-dienst'), contentPadding: EdgeInsets.zero, value: keinDienst, onChanged: (v) => setState(() => keinDienst = v ?? false), title: const Text('Kein Dienst (Bibliothek, Kommandozeile, Desktop-App)')),
      if (!keinDienst) ...[
        TextField(key: const Key('dev-start'), controller: start, decoration: const InputDecoration(labelText: 'Startbefehl im Projektordner', hintText: 'npm start')),
        TextField(key: const Key('dev-port'), controller: port, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Port', hintText: '3000')),
        TextField(key: const Key('dev-pruefung'), controller: pruefung, decoration: const InputDecoration(labelText: 'Prüfadresse (optional)', hintText: '/api/status')),
        TextField(key: const Key('dev-einrichten'), controller: einrichten, minLines: 1, maxLines: 4, decoration: const InputDecoration(labelText: 'Einrichtung für test (optional, je Zeile ein Befehl)', hintText: 'npm run browser:einrichten')),
      ],
    ]),
    actions: [
      TextButton(onPressed: () => Navigator.pop(context), child: const Text('Abbrechen')),
      FilledButton(key: const Key('dev-eintragen-ok'), onPressed: () => Navigator.pop(context, keinDienst ? {'dev_aktion': 'setzen', 'kein_dienst': true} : {'dev_aktion': 'setzen', 'start': start.text.trim(), if (port.text.trim().isNotEmpty) 'port': int.tryParse(port.text.trim()) ?? port.text.trim(), if (pruefung.text.trim().isNotEmpty) 'pruefung': pruefung.text.trim(), if (einrichten.text.trim().isNotEmpty) 'einrichten': einrichten.text.split('\n').map((z) => z.trim()).where((z) => z.isNotEmpty).toList()}), child: const Text('Zur Bestätigung')),
    ],
  );
}
