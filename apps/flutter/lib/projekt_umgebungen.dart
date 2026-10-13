import 'package:flutter/material.dart';
import 'aufgaben.dart' show JsonAbruf;

/// 1.25.0 (v1443 B15) — Umgebungen eines Projekts: ENV-Werte je Stufe (wie beim Projekt-Agenten), verschlüsselt am Server.
/// Die App sieht Werte nur maskiert; sie gehen beim Deploy als .env aufs Ziel — nie aufs Entwicklungsgerät (Owner 13.10.).
class ProjektUmgebungen extends StatefulWidget {
  const ProjektUmgebungen({super.key, required this.id, required this.json});
  final String id;
  final JsonAbruf json;
  @override
  State<ProjektUmgebungen> createState() => _ProjektUmgebungenState();
}

class _ProjektUmgebungenState extends State<ProjektUmgebungen> {
  List<Map<String, dynamic>> stufen = [];
  List<String> erkannt = [];
  bool offen = false, sendet = false;
  String? meldung;
  bool meldungOk = true;
  String stage = 'dev';
  final key = TextEditingController(), wert = TextEditingController();

  @override
  void dispose() { key.dispose(); wert.dispose(); super.dispose(); }

  Future<Map<String, dynamic>> aktion(String a, [Map<String, dynamic> f = const {}]) => widget.json('/api/geraete/projekte/${widget.id}', methode: 'POST', koerper: {'aktion': 'env_$a', 'deploy': f});

  Future<void> laden() async {
    try {
      final r = await aktion('liste');
      if (!mounted) return;
      setState(() => stufen = (((r['data'] as Map<String, dynamic>?)?['stufen'] as List<dynamic>?) ?? []).whereType<Map<String, dynamic>>().toList());
    } catch (e) { if (mounted) setState(() { meldungOk = false; meldung = '$e'; }); }
  }

  Future<void> tun(String a, Map<String, dynamic> f) async {
    setState(() { sendet = true; meldung = null; });
    try {
      final r = await aktion(a, f);
      final ok = r['success'] == true;
      if (!mounted) return;
      setState(() {
        meldungOk = ok; meldung = ok ? '${r['display'] ?? 'Gespeichert.'}' : '${r['error'] ?? 'Fehler'}';
        if (ok && a == 'erkennen') erkannt = (((r['data'] as Map<String, dynamic>?)?['keys'] as List<dynamic>?) ?? []).map((k) => '${(k as Map<String, dynamic>)['key']}').toList();
        if (ok && a == 'setzen') { key.clear(); wert.clear(); }
      });
      if (ok && a != 'erkennen') await laden();
    } catch (e) { if (mounted) setState(() { meldungOk = false; meldung = '$e'; }); }
    finally { if (mounted) setState(() => sendet = false); }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dim = theme.colorScheme.onSurfaceVariant;
    final namen = {'dev', 'test', 'prod', ...stufen.map((s) => '${s['stage']}')}.toList();
    return Card(key: const Key('projekt-umgebungen'), margin: const EdgeInsets.only(top: 12), child: Padding(padding: const EdgeInsets.all(12), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        Expanded(child: Text('Umgebungen', style: theme.textTheme.titleSmall)),
        TextButton(key: const Key('umgebungen-oeffnen'), onPressed: () { setState(() => offen = !offen); if (offen) laden(); }, child: Text(offen ? 'Schließen' : 'Anzeigen')),
      ]),
      Text('ENV-Werte je Stufe, verschlüsselt am Server. Beim Deploy geht die Umgebung der Stufe als .env aufs Ziel — nie aufs Entwicklungsgerät.', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
      if (offen) ...[
        if (stufen.isEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: Text('Noch keine Umgebung.', style: theme.textTheme.bodySmall?.copyWith(color: dim))),
        for (final s in stufen) Padding(padding: const EdgeInsets.only(top: 8), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Text('${s['stage']}', style: theme.textTheme.labelLarge),
            const SizedBox(width: 8),
            Text('${((s['werte'] as Map<String, dynamic>?) ?? {}).length} Schlüssel${s['lesbar'] == false ? ' · nicht lesbar' : ''}', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
            const Spacer(),
            for (final n in namen.where((n) => n != '${s['stage']}').take(2)) TextButton(onPressed: sendet ? null : () => tun('kopieren', {'von': '${s['stage']}', 'nach': n}), child: Text('→ $n')),
          ]),
          for (final e in ((s['werte'] as Map<String, dynamic>?) ?? {}).entries) Row(children: [
            Expanded(child: Text('${e.key} = ${e.value}', style: theme.textTheme.bodySmall?.copyWith(fontFamily: 'monospace'))),
            IconButton(tooltip: 'Löschen', visualDensity: VisualDensity.compact, onPressed: sendet ? null : () => tun('loeschen', {'stage': '${s['stage']}', 'key': e.key}), icon: const Icon(Icons.close, size: 16)),
          ]),
        ])),
        const Divider(),
        Row(children: [
          DropdownButton<String>(key: const Key('umgebung-stage'), value: namen.contains(stage) ? stage : 'dev', items: [for (final n in namen) DropdownMenuItem(value: n, child: Text(n))], onChanged: (v) => setState(() => stage = v ?? 'dev')),
          const SizedBox(width: 8),
          Expanded(child: TextField(key: const Key('umgebung-key'), controller: key, decoration: const InputDecoration(labelText: 'Schlüssel', hintText: 'DATABASE_URL'))),
        ]),
        TextField(key: const Key('umgebung-wert'), controller: wert, obscureText: true, decoration: const InputDecoration(labelText: 'Wert')),
        if (erkannt.isNotEmpty) Wrap(spacing: 6, children: [for (final k in erkannt) ActionChip(label: Text(k), onPressed: () => setState(() => key.text = k))]),
        Row(children: [
          TextButton(key: const Key('umgebung-erkennen'), onPressed: sendet ? null : () => tun('erkennen', {}), child: const Text('Schlüssel am Gerät erkennen')),
          const Spacer(),
          FilledButton(key: const Key('umgebung-setzen'), onPressed: sendet ? null : () => tun('setzen', {'stage': stage, 'key': key.text.trim(), 'value': wert.text}), child: const Text('Speichern')),
        ]),
      ],
      if (meldung != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(meldung!, style: TextStyle(color: meldungOk ? Colors.green : theme.colorScheme.error))),
    ])));
  }
}
