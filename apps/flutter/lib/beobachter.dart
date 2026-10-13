import 'package:flutter/material.dart';
import 'aufgaben.dart' show JsonAbruf;

/// 1.20.0 — Beobachter (v1429 R4a): Regeln am Server, sichtbar mit Schalter je Regel; der Satellit beobachtet Ordner und
/// meldet nur Dateiname/Größe. Am Gerät lassen sich alle Beobachter lokal abschalten (`alfred einstellungen beobachter aus`).
class BeobachterRegel {
  BeobachterRegel(Map<String, dynamic> j)
      : id = '${j['id']}', quelle = '${j['quelle'] ?? 'ordner'}', filter = (j['filter'] as Map<String, dynamic>?) ?? const {}, name = '${j['name'] ?? ''}', geraet = '${j['geraet'] ?? ''}', wirkung = '${j['wirkung'] ?? ''}',
        auftrag = j['auftrag'] as String?, aktiv = j['aktiv'] == true, stand = '${j['stand'] ?? ''}', standGrund = j['standGrund'] as String?,
        treffer = (j['treffer'] as num?)?.toInt() ?? 0, letzterTreffer = DateTime.tryParse('${j['letzterTreffer'] ?? ''}')?.toLocal(),
        pfad = '${(j['filter'] as Map<String, dynamic>?)?['pfad'] ?? ''}', muster = (j['filter'] as Map<String, dynamic>?)?['muster'] as String?,
        ereignisse = (((j['filter'] as Map<String, dynamic>?)?['ereignisse'] as List<dynamic>?) ?? ['neu']).map((e) => '$e').toList();
  final String id, quelle, name, geraet, wirkung, stand, pfad;
  final Map<String, dynamic> filter;
  /// 1.21.0 — Filter je Quelle als eine Zeile
  String get filterText => quelle == 'benachrichtigung' ? 'Benachrichtigungen: ${((filter['apps'] as List<dynamic>?) ?? []).join(', ')}${filter['titel'] != null ? ' · Titel enthält „${filter['titel']}“' : ''}'
      : quelle == 'build' ? 'Build-Wache: ${((filter['befehle'] as List<dynamic>?) ?? []).join(' ; ')} · alle ${filter['intervallMin'] ?? 60} min'
      : quelle == 'outlook' ? 'Outlook-Posteingang${filter['absender'] != null ? ' · von „${filter['absender']}“' : ''}${filter['betreff'] != null ? ' · Betreff „${filter['betreff']}“' : ''}'
      : '$pfad${muster != null ? ' · $muster' : ''} · ${ereignisse.map((e) => artText[e] ?? e).join('/')}';
  final String? auftrag, standGrund, muster;
  final bool aktiv;
  final int treffer;
  final DateTime? letzterTreffer;
  final List<String> ereignisse;
}

const wirkungText = {'hinweis': 'Hinweis', 'vorgang': 'Vorgang', 'aufgabe': 'Aufgabe (Alfred erledigt)', 'projekt': 'Projekt weiterarbeiten (mit Bestätigung)'};
const artText = {'neu': 'neu', 'geaendert': 'geändert', 'geloescht': 'gelöscht'};
const quelleText = {'ordner': 'Ordner', 'benachrichtigung': 'Benachrichtigungen (Windows/macOS)', 'outlook': 'Outlook-Posteingang (Windows)', 'build': 'Build-Wache (Prüfbefehle eines Projekts)'};

class Beobachter extends StatefulWidget {
  const Beobachter({super.key, required this.json, this.aufMeldung});
  final JsonAbruf json;
  final void Function(String text)? aufMeldung;
  @override
  State<Beobachter> createState() => _BeobachterState();
}

class _BeobachterState extends State<Beobachter> {
  List<BeobachterRegel> regeln = [];
  List<Map<String, dynamic>> geraete = [], projekte = [];
  String? fehler;
  bool laedt = true, neuOffen = false, sendet = false;
  // Formular
  String? geraetId, wirkung = 'hinweis', projektId, quelle = 'ordner';
  final pfad = TextEditingController(), muster = TextEditingController(), name = TextEditingController(), auftrag = TextEditingController(),
      apps = TextEditingController(), titel = TextEditingController(), absender = TextEditingController(), betreff = TextEditingController();
  final Set<String> arten = {'neu'};
  bool unterordner = false;
  final intervall = TextEditingController(text: '60'); // 1.22.0 Build-Wache

  @override
  void initState() { super.initState(); laden(); }
  @override
  void dispose() { for (final c in [pfad, muster, name, auftrag, apps, titel, absender, betreff]) { c.dispose(); } super.dispose(); }

  Future<void> laden() async {
    try {
      final j = await widget.json('/api/geraete/beobachter');
      if (!mounted) return;
      setState(() {
        regeln = ((j['regeln'] as List<dynamic>?) ?? []).whereType<Map<String, dynamic>>().map(BeobachterRegel.new).toList();
        geraete = ((j['geraete'] as List<dynamic>?) ?? []).whereType<Map<String, dynamic>>().toList();
        projekte = ((j['projekte'] as List<dynamic>?) ?? []).whereType<Map<String, dynamic>>().toList();
        geraetId ??= geraete.isNotEmpty ? '${geraete.first['id']}' : null;
        fehler = null; laedt = false;
      });
    } catch (e) { if (mounted) setState(() { fehler = '$e'; laedt = false; }); }
  }

  Future<void> aendern(BeobachterRegel r, String aktion) async {
    setState(() => sendet = true);
    try {
      final x = await widget.json('/api/geraete/beobachter/${r.id}', methode: 'POST', koerper: {'aktion': aktion});
      widget.aufMeldung?.call(x['success'] == true ? '${x['display'] ?? 'Gespeichert.'}' : 'Fehler: ${x['error'] ?? 'unbekannt'}');
      await laden();
    } catch (e) { widget.aufMeldung?.call('Fehler: $e'); }
    finally { if (mounted) setState(() => sendet = false); }
  }

  Future<void> anlegen() async {
    setState(() => sendet = true);
    try {
      final x = await widget.json('/api/geraete/beobachter', methode: 'POST', koerper: {
        if (quelle != 'build') 'geraet': geraetId, 'quelle': quelle, 'pfad': pfad.text.trim(), 'muster': muster.text.trim(), 'ereignisse': arten.toList(), 'unterordner': unterordner,
        'apps': apps.text.trim(), 'titel': titel.text.trim(), 'absender': absender.text.trim(), 'betreff': betreff.text.trim(), 'intervallMin': int.tryParse(intervall.text.trim()) ?? 60,
        'wirkung': wirkung, 'auftrag': auftrag.text.trim(), 'name': name.text.trim(), if (projektId != null) 'projekt': projektId,
      });
      if (!mounted) return;
      if (x['success'] == true) {
        widget.aufMeldung?.call('${x['display'] ?? 'Angelegt.'}');
        for (final c in [pfad, muster, name, auftrag, apps, titel, absender, betreff]) { c.clear(); }
        setState(() => neuOffen = false);
        await laden();
      } else {
        setState(() => fehler = '${x['error'] ?? 'Fehler'}');
      }
    } catch (e) { if (mounted) setState(() => fehler = '$e'); }
    finally { if (mounted) setState(() => sendet = false); }
  }

  Color standFarbe(ThemeData t, String s) => s == 'läuft' ? Colors.green : s == 'gestört' || s == 'Satellit zu alt' ? t.colorScheme.error : t.colorScheme.onSurfaceVariant;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dim = theme.colorScheme.onSurfaceVariant;
    return RefreshIndicator(onRefresh: laden, child: ListView(padding: const EdgeInsets.all(16), children: [
      Row(children: [
        Expanded(child: Text('Beobachter', style: theme.textTheme.titleLarge)),
        FilledButton.tonalIcon(key: const Key('beobachter-neu'), onPressed: () => setState(() => neuOffen = !neuOffen), icon: Icon(neuOffen ? Icons.close : Icons.add), label: Text(neuOffen ? 'Schließen' : 'Neue Regel')),
        IconButton(tooltip: 'Aktualisieren', onPressed: laden, icon: const Icon(Icons.refresh)),
      ]),
      Text('Alfred bemerkt, was auf deinen Geräten passiert (Ordner, Benachrichtigungen, Outlook), und reagiert nach diesen Regeln. Gemeldet werden nur Kopfdaten, nie Inhalte.', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
      if (fehler != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(fehler!, style: TextStyle(color: theme.colorScheme.error))),
      if (neuOffen) Card(margin: const EdgeInsets.only(top: 12), child: Padding(padding: const EdgeInsets.all(12), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (quelle != 'build') Row(children: [const Text('Gerät: '), DropdownButton<String>(key: const Key('beobachter-geraet'), value: geraetId, items: [for (final g in geraete) DropdownMenuItem(value: '${g['id']}', child: Text('${g['name']}${g['online'] == true ? '' : ' (offline)'}'))], onChanged: (v) => setState(() => geraetId = v))]),
        Row(children: [const Text('Was: '), DropdownButton<String>(key: const Key('beobachter-quelle'), value: quelle, items: [for (final e in quelleText.entries) DropdownMenuItem(value: e.key, child: Text(e.value))], onChanged: (v) => setState(() => quelle = v))]),
        if (quelle == 'ordner') ...[
          TextField(key: const Key('beobachter-pfad'), controller: pfad, decoration: const InputDecoration(labelText: 'Ordner auf dem Gerät (absolut, freigegeben)', hintText: r'C:\Users\madh\Downloads')),
          TextField(key: const Key('beobachter-muster'), controller: muster, decoration: const InputDecoration(labelText: 'Dateimuster (optional)', hintText: '*.pdf, Rechnung*')),
          Wrap(spacing: 8, children: [for (final a in artText.keys) FilterChip(key: Key('beobachter-art-$a'), label: Text(artText[a]!), selected: arten.contains(a), onSelected: (s) => setState(() { if (s) { arten.add(a); } else if (arten.length > 1) { arten.remove(a); } }))]),
          SwitchListTile(contentPadding: EdgeInsets.zero, dense: true, value: unterordner, onChanged: (v) => setState(() => unterordner = v), title: const Text('Unterordner einbeziehen')),
        ],
        if (quelle == 'benachrichtigung') ...[
          TextField(key: const Key('beobachter-apps'), controller: apps, decoration: const InputDecoration(labelText: 'Apps (Pflicht, durch Komma)', hintText: 'WhatsApp, Teams')),
          TextField(controller: titel, decoration: const InputDecoration(labelText: 'Titel enthält (optional)')),
          Text('Nur App und Titel verlassen das Gerät; andere Apps verwirft der Satellit.', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
        ],
        if (quelle == 'build') ...[
          Row(children: [const Text('Projekt: '), DropdownButton<String>(key: const Key('beobachter-projekt'), value: projektId, hint: const Text('wählen'), items: [for (final p in projekte) DropdownMenuItem(value: '${p['id']}', child: Text('${p['name']}'))], onChanged: (v) => setState(() => projektId = v))]),
          TextField(key: const Key('beobachter-intervall'), controller: intervall, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Alle wie viele Minuten (15–1440)')),
          Text('Führt nur die freigegebenen Prüfbefehle des Projekts auf dessen Gerät aus und meldet, wenn sie rot werden oder wieder grün. Pausiert, solange ein Lauf im Projekt arbeitet.', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
        ],
        if (quelle == 'outlook') ...[
          TextField(key: const Key('beobachter-absender'), controller: absender, decoration: const InputDecoration(labelText: 'Absender enthält (optional)')),
          TextField(controller: betreff, decoration: const InputDecoration(labelText: 'Betreff enthält (optional)')),
          Text('Nur für Konten, die Alfred nicht schon am Server liest — sonst kommt jede Mail doppelt.', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
        ],
        Row(children: [const Text('Dann: '), DropdownButton<String>(key: const Key('beobachter-wirkung'), value: wirkung, items: [for (final e in wirkungText.entries) DropdownMenuItem(value: e.key, child: Text(e.value))], onChanged: (v) => setState(() => wirkung = v))]),
        if (wirkung == 'projekt' && quelle != 'build') Row(children: [const Text('Projekt: '), DropdownButton<String>(value: projektId, hint: const Text('wählen'), items: [for (final p in projekte) DropdownMenuItem(value: '${p['id']}', child: Text('${p['name']}'))], onChanged: (v) => setState(() => projektId = v))]),
        TextField(key: const Key('beobachter-auftrag'), controller: auftrag, maxLines: 2, decoration: InputDecoration(labelText: wirkung == 'hinweis' ? 'Notiz (optional)' : wirkung == 'vorgang' ? 'Nächster Schritt (optional)' : 'Was soll Alfred tun? (Pflicht)')),
        TextField(key: const Key('beobachter-name'), controller: name, decoration: const InputDecoration(labelText: 'Name (optional)', hintText: 'z. B. Rechnungen')),
        const SizedBox(height: 8),
        Align(alignment: Alignment.centerRight, child: FilledButton(key: const Key('beobachter-anlegen'), onPressed: sendet || (quelle == 'build' ? projektId == null : geraetId == null) ? null : anlegen, child: const Text('Anlegen'))),
      ]))),
      const SizedBox(height: 12),
      if (laedt) const Center(child: Padding(padding: EdgeInsets.all(24), child: CircularProgressIndicator())),
      if (!laedt && regeln.isEmpty) Padding(padding: const EdgeInsets.all(12), child: Text('Noch keine Beobachter. Beispiel im Chat: „Sag mir, wenn in Downloads eine PDF-Rechnung landet."', style: TextStyle(color: dim))),
      for (final r in regeln) Card(key: Key('beobachter-${r.id}'), margin: const EdgeInsets.only(bottom: 8), child: Padding(padding: const EdgeInsets.fromLTRB(12, 8, 4, 8), child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(r.name, style: theme.textTheme.titleSmall),
          Text('${r.geraet}: ${r.filterText}', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
          Text('→ ${wirkungText[r.wirkung] ?? r.wirkung}${r.auftrag != null && r.auftrag!.isNotEmpty ? ': ${r.auftrag}' : ''}', style: theme.textTheme.bodySmall),
          Text('${r.stand}${r.standGrund != null ? ' — ${r.standGrund}' : ''} · ${r.treffer} Treffer${r.letzterTreffer != null ? ', zuletzt ${r.letzterTreffer!.day}.${r.letzterTreffer!.month}. ${r.letzterTreffer!.hour.toString().padLeft(2, '0')}:${r.letzterTreffer!.minute.toString().padLeft(2, '0')}' : ''}', style: theme.textTheme.labelSmall?.copyWith(color: standFarbe(theme, r.stand))),
        ])),
        Switch(key: Key('beobachter-schalter-${r.id}'), value: r.aktiv, onChanged: sendet ? null : (v) => aendern(r, v ? 'an' : 'aus')),
        IconButton(tooltip: 'Löschen', onPressed: sendet ? null : () => aendern(r, 'loeschen'), icon: const Icon(Icons.delete_outline)),
      ]))),
    ]));
  }
}
