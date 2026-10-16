import 'package:flutter/material.dart';
import 'aufgaben.dart' show JsonAbruf;

/// 1.37.0 — Einrichtung eines Geräte-Projekts (v1486): Repository, Prüfbefehle, Merge Requests, Projektregeln, Protokoll.
/// Der Stand kommt vom Server aus den vorhandenen Einstellungen; „passt so“ hält einen Schritt bewusst, wie er ist. Nichts davon
/// hält einen Lauf auf. Eine Kostengrenze gehört nicht dazu (Owner 16.10.).
class ProjektEinrichtung extends StatefulWidget {
  const ProjektEinrichtung({super.key, required this.id, required this.json, required this.einrichtung, required this.neuLaden, this.aufMeldung});
  final String id;
  final JsonAbruf json;
  final Map<String, dynamic>? einrichtung;
  final Future<void> Function() neuLaden;
  final void Function(String text)? aufMeldung;
  @override
  State<ProjektEinrichtung> createState() => _ProjektEinrichtungState();
}

class _ProjektEinrichtungState extends State<ProjektEinrichtung> {
  bool sendet = false;
  String? meldung;
  bool meldungOk = true;
  List<String>? vorschlag;
  String? vorschlagQuelle;

  Future<Map<String, dynamic>?> senden(Map<String, dynamic> koerper, {bool neuLaden = true}) async {
    setState(() { sendet = true; meldung = null; });
    try {
      final r = await widget.json('/api/geraete/projekte/${widget.id}', methode: 'POST', koerper: koerper);
      final ok = r['success'] == true;
      if (!mounted) return null;
      setState(() { meldungOk = ok; meldung = ok ? (r['display'] != null ? '${r['display']}' : null) : '${r['error'] ?? 'Fehler'}'; });
      if (ok && neuLaden) await widget.neuLaden();
      return ok ? r : null;
    } catch (e) { if (mounted) setState(() { meldungOk = false; meldung = '$e'; }); return null; }
    finally { if (mounted) setState(() => sendet = false); }
  }

  Future<void> passtSo(String schritt) async { await senden({'aktion': 'einrichtung', 'text': 'ok:$schritt'}); }

  Future<void> vorschlagHolen() async {
    final r = await senden({'aktion': 'einrichtung', 'text': 'pruefung_vorschlag'}, neuLaden: false);
    final d = r?['data'] as Map<String, dynamic>?;
    if (!mounted || d == null) return;
    final b = ((d['befehle'] as List<dynamic>?) ?? []).map((e) => '$e').toList();
    setState(() {
      vorschlag = b;
      vorschlagQuelle = d['quelle'] as String?;
      if (b.isEmpty) { meldungOk = false; meldung = 'Kein Vorschlag: ${((d['hinweise'] as List<dynamic>?) ?? []).join('; ')}'; }
    });
  }

  Future<void> uebernehmen() async {
    final b = vorschlag;
    if (b == null || b.isEmpty) return;
    final r = await senden({'aktion': 'einrichtung', 'text': 'pruefung_setzen', 'deploy': {'befehle': b}});
    if (r != null && mounted) setState(() => vorschlag = null);
  }

  List<Widget> knoepfe(String schritt) {
    switch (schritt) {
      case 'repo':
        return [OutlinedButton(key: const Key('einrichtung-repo-keins'), onPressed: sendet ? null : () => passtSo('repo'), child: const Text('Keins (nur lokal)'))];
      case 'pruefung':
        return [
          FilledButton.tonal(key: const Key('einrichtung-pruefung-vorschlag'), onPressed: sendet ? null : vorschlagHolen, child: const Text('Vorschlag holen')),
          OutlinedButton(key: const Key('einrichtung-pruefung-keine'), onPressed: sendet ? null : () => passtSo('pruefung'), child: const Text('Keine')),
        ];
      case 'mr':
        return [
          FilledButton.tonal(key: const Key('einrichtung-mr-an'), onPressed: sendet ? null : () => senden({'aktion': 'merge_requests', 'text': 'an'}), child: const Text('An')),
          OutlinedButton(key: const Key('einrichtung-mr-aus'), onPressed: sendet ? null : () => senden({'aktion': 'merge_requests', 'text': 'aus'}), child: const Text('Aus')),
        ];
      case 'regeln':
        return [OutlinedButton(key: const Key('einrichtung-regeln-keine'), onPressed: sendet ? null : () => passtSo('regeln'), child: const Text('Keine eigenen'))];
      case 'protokoll':
        return [
          FilledButton.tonal(key: const Key('einrichtung-protokoll-an'), onPressed: sendet ? null : () => senden({'aktion': 'protokoll', 'text': 'an'}), child: const Text('An')),
          OutlinedButton(key: const Key('einrichtung-protokoll-aus'), onPressed: sendet ? null : () => senden({'aktion': 'protokoll', 'text': 'aus'}), child: const Text('Aus')),
        ];
    }
    return const [];
  }

  static const _wo = {'repo': 'Neu anlegen oder eintragen: unten bei Deploy → Remote.', 'regeln': 'Einzeln festlegen: unten bei Projektregeln.'};

  @override
  Widget build(BuildContext context) {
    final e = widget.einrichtung;
    final schritte = ((e?['schritte'] as List<dynamic>?) ?? []).whereType<Map<String, dynamic>>().toList();
    if (e == null || schritte.isEmpty) return const SizedBox.shrink();
    final theme = Theme.of(context);
    final dim = theme.colorScheme.onSurfaceVariant;
    final erledigt = e['erledigt'] ?? 0, gesamt = e['gesamt'] ?? schritte.length;
    if (erledigt == gesamt && vorschlag == null) return const SizedBox.shrink();
    return Card(key: const Key('projekt-einrichtung'), child: Padding(padding: const EdgeInsets.all(12), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('Einrichtung $erledigt/$gesamt', style: theme.textTheme.titleSmall),
      Text('Alles ist optional — Läufe starten auch ohne. Was du so lässt, markiert die Wahl als erledigt.', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
      const SizedBox(height: 6),
      for (final s in schritte) Padding(padding: const EdgeInsets.symmetric(vertical: 4), child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Icon(s['erledigt'] == true ? Icons.check_circle : Icons.radio_button_unchecked, size: 18, color: s['erledigt'] == true ? theme.colorScheme.primary : dim),
        const SizedBox(width: 8),
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('${s['titel'] ?? s['schritt']}', style: theme.textTheme.bodyMedium),
          Text('${s['stand'] ?? ''}', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
          if (s['erledigt'] != true && _wo[s['schritt']] != null) Text(_wo[s['schritt']]!, style: theme.textTheme.bodySmall?.copyWith(color: dim)),
          if (s['erledigt'] != true) Padding(padding: const EdgeInsets.only(top: 4), child: Wrap(spacing: 8, runSpacing: 4, children: knoepfe('${s['schritt']}'))),
          if (s['schritt'] == 'pruefung' && vorschlag != null && vorschlag!.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Vorschlag${vorschlagQuelle != null ? ' aus $vorschlagQuelle' : ''}:', style: theme.textTheme.bodySmall),
            for (final b in vorschlag!) SelectableText(b, key: Key('vorschlag-$b'), style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
            const SizedBox(height: 4),
            FilledButton(key: const Key('einrichtung-pruefung-uebernehmen'), onPressed: sendet ? null : uebernehmen, child: const Text('Übernehmen')),
          ])),
        ])),
      ])),
      if (meldung != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(meldung!, style: TextStyle(color: meldungOk ? theme.colorScheme.primary : theme.colorScheme.error))),
    ])));
  }
}
