import 'package:flutter/material.dart';
import 'aufgaben.dart' show JsonAbruf;

/// 1.30.0 — dev je Projekt (v1460): „am Gerät“ (die App läuft im Arbeitsordner, Alfred startet sie nach jeder grünen Etappe neu)
/// oder „eigener Host“ (das dev-Ziel im Deploy-Bereich). Die Startangabe erkennt Alfred selbst (Startdatei, package.json …, sonst
/// Claude Code nur lesend) oder man trägt sie ein; ausgeführt wird sie erst nach der Bestätigung des Owners.
String devAngabeText(Map<String, dynamic>? a) {
  if (a == null) return 'noch keine bestätigte Startangabe';
  if (a['dienst'] == false) return 'kein Dienst — dev heißt hier: Build und Tests grün';
  return 'Start „${a['start'] ?? ''}“${a['port'] != null ? ' · Port ${a['port']}' : ''}${a['pruefung'] != null ? ' · Prüfadresse ${a['pruefung']}' : ''}';
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
  late bool keinDienst = widget.angabe?['dienst'] == false;

  @override
  void dispose() { for (final c in [start, port, pruefung]) { c.dispose(); } super.dispose(); }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('Startangabe eintragen'),
    content: Column(mainAxisSize: MainAxisSize.min, children: [
      CheckboxListTile(key: const Key('dev-kein-dienst'), contentPadding: EdgeInsets.zero, value: keinDienst, onChanged: (v) => setState(() => keinDienst = v ?? false), title: const Text('Kein Dienst (Bibliothek, Kommandozeile, Desktop-App)')),
      if (!keinDienst) ...[
        TextField(key: const Key('dev-start'), controller: start, decoration: const InputDecoration(labelText: 'Startbefehl im Projektordner', hintText: 'npm start')),
        TextField(key: const Key('dev-port'), controller: port, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Port', hintText: '3000')),
        TextField(key: const Key('dev-pruefung'), controller: pruefung, decoration: const InputDecoration(labelText: 'Prüfadresse (optional)', hintText: '/api/status')),
      ],
    ]),
    actions: [
      TextButton(onPressed: () => Navigator.pop(context), child: const Text('Abbrechen')),
      FilledButton(key: const Key('dev-eintragen-ok'), onPressed: () => Navigator.pop(context, keinDienst ? {'dev_aktion': 'setzen', 'kein_dienst': true} : {'dev_aktion': 'setzen', 'start': start.text.trim(), if (port.text.trim().isNotEmpty) 'port': int.tryParse(port.text.trim()) ?? port.text.trim(), if (pruefung.text.trim().isNotEmpty) 'pruefung': pruefung.text.trim()}), child: const Text('Zur Bestätigung')),
    ],
  );
}
