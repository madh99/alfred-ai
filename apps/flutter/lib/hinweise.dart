/// 1.4.0 — Sammlung „Hinweise" (Owner 10.10.2026: Insights verschwinden in der App im Verlauf, man kann nichts damit tun).
/// Liest `/api/geraete/hinweise` (Server v1343, nur Geräte des Owners) und entscheidet je Hinweis: erledigt, später (24 h),
/// verwerfen, ausführen (wenn der Hinweis eine Aktion hat), nachfragen (springt in den Chat mit Bezug). Telegram bleibt
/// unverändert; der Chat der App zeigt Insights nur noch als kurze Zeile mit Verweis hierher.
library;

import 'package:flutter/material.dart';

import 'server.dart';

class Hinweis {
  Hinweis(Map<String, dynamic> j)
      : id = '${j['id']}', quelle = '${j['quelle'] ?? ''}', titel = '${j['titel'] ?? ''}', text = '${j['text'] ?? ''}',
        status = '${j['status'] ?? 'pending'}', zeit = DateTime.tryParse('${j['zeit']}')?.toLocal() ?? DateTime.now(),
        dringlichkeit = j['dringlichkeit'] as String?, zugestellt = j['zugestellt'] as String?, aktion = j['aktion'] as String?;
  final String id, quelle, titel, text;
  String status;
  final DateTime zeit;
  final String? dringlichkeit, zugestellt, aktion;
  bool get offen => status == 'pending' || status == 'snoozed';
}

/// Anzeigename je Quelle (Kategorie in alfred_insights).
String quellenName(String q) => switch (q) {
      'reasoning' => 'Alfred',
      'interests' => 'Interessen',
      'interest-suggestion' => 'Interessen-Vorschlag',
      'vorausschau' => 'Vorausschau',
      'itsm-reflection' => 'IT-Betrieb',
      'automation' => 'Automatik',
      _ => q,
    };

/// Kurzzeile für den Chat: „💡 Hinweis: <erster Punkt> (+n)" statt der ganzen Insight-Meldung.
String hinweisKurzzeile(String text) {
  final zeilen = text.split('\n').map((z) => z.replaceAll('**', '').replaceAll('_', '').trim()).where((z) => z.isNotEmpty && !z.startsWith('💡')).toList();
  if (zeilen.isEmpty) return '💡 Hinweis von Alfred';
  final punkte = zeilen.where((z) => RegExp(r'^(\d+[.)]|[-•])\s').hasMatch(z)).length;
  var erste = zeilen.first.replaceFirst(RegExp(r'^(\d+[.)]|[-•])\s*'), '');
  if (erste.length > 90) erste = '${erste.substring(0, 90)}…';
  return '💡 Hinweis: $erste${punkte > 1 ? ' (+${punkte - 1})' : ''} — unter „Hinweise"';
}

class Hinweise extends StatefulWidget {
  const Hinweise({super.key, required this.server, required this.aufNachfragen, required this.aufMeldung, this.aufAnzahl});
  final Server server;
  final void Function(String text) aufNachfragen;
  final void Function(String text) aufMeldung;
  final void Function(int offen)? aufAnzahl;
  @override
  State<Hinweise> createState() => _HinweiseState();
}

class _HinweiseState extends State<Hinweise> {
  List<Hinweis>? liste;
  String? fehler;
  final offenText = <String>{};
  bool entschiedeneZeigen = false;

  @override
  void initState() { super.initState(); laden(); }

  Future<void> laden() async {
    try {
      final j = await widget.server.json('/api/geraete/hinweise');
      final l = ((j['hinweise'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>().map(Hinweis.new).toList();
      if (!mounted) return;
      setState(() { liste = l; fehler = null; });
      widget.aufAnzahl?.call(l.where((h) => h.offen).length);
    } catch (e) { if (mounted) setState(() => fehler = '$e'); }
  }

  Future<void> entscheide(Hinweis h, String aktion) async {
    try {
      final r = await widget.server.json('/api/geraete/hinweise/${h.id}', methode: 'POST', koerper: {'aktion': aktion});
      if (r['ok'] == true) {
        setState(() => h.status = switch (aktion) { 'erledigt' || 'ausfuehren' => 'acted', 'verwerfen' => 'dismissed', _ => 'snoozed' });
        widget.aufAnzahl?.call(liste!.where((x) => x.offen).length);
        if (aktion == 'ausfuehren') widget.aufMeldung('💡 Ausgeführt: ${h.titel}');
      } else {
        widget.aufMeldung('💡 Nicht möglich: ${r['grund'] ?? 'unbekannt'}');
      }
    } catch (e) { widget.aufMeldung('💡 Fehler: $e'); }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dim = theme.colorScheme.onSurfaceVariant;
    if (fehler != null) return Center(child: Text('Hinweise nicht geladen: $fehler', style: TextStyle(color: theme.colorScheme.error)));
    final l = liste;
    if (l == null) return const Center(child: CircularProgressIndicator());
    final offen = l.where((h) => h.offen).toList();
    final entschieden = l.where((h) => !h.offen).toList();
    String zeit(DateTime t) => '${t.day}.${t.month}. ${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
    Widget karte(Hinweis h) {
      final ganz = offenText.contains(h.id);
      final statusText = switch (h.status) { 'snoozed' => 'später', 'acted' => 'erledigt', 'dismissed' => 'verworfen', _ => null };
      return Card(margin: const EdgeInsets.only(bottom: 10), child: Padding(padding: const EdgeInsets.fromLTRB(14, 12, 14, 6), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          if (h.dringlichkeit == 'high' || h.dringlichkeit == 'urgent') Padding(padding: const EdgeInsets.only(right: 6), child: Icon(Icons.priority_high, size: 16, color: theme.colorScheme.error)),
          Expanded(child: Text(h.titel, style: theme.textTheme.titleSmall)),
          Text('${quellenName(h.quelle)} · ${zeit(h.zeit)}${statusText != null ? ' · $statusText' : ''}', style: theme.textTheme.labelSmall?.copyWith(color: dim)),
        ]),
        const SizedBox(height: 6),
        InkWell(onTap: () => setState(() => ganz ? offenText.remove(h.id) : offenText.add(h.id)), child: Text(h.text.replaceAll('**', ''), maxLines: ganz ? null : 3, overflow: ganz ? null : TextOverflow.ellipsis, style: theme.textTheme.bodyMedium)),
        Wrap(spacing: 2, children: [
          if (h.offen) TextButton.icon(onPressed: () => entscheide(h, 'erledigt'), icon: const Icon(Icons.check, size: 16), label: const Text('Erledigt')),
          if (h.offen && h.aktion != null) TextButton.icon(onPressed: () => entscheide(h, 'ausfuehren'), icon: const Icon(Icons.bolt, size: 16), label: Text(h.aktion!)),
          if (h.offen && h.status != 'snoozed') TextButton.icon(onPressed: () => entscheide(h, 'spaeter'), icon: const Icon(Icons.schedule, size: 16), label: const Text('Später')),
          if (h.offen) TextButton.icon(onPressed: () => entscheide(h, 'verwerfen'), icon: const Icon(Icons.close, size: 16), label: const Text('Verwerfen')),
          TextButton.icon(onPressed: () => widget.aufNachfragen('${h.titel}\n\n${h.text}'), icon: const Icon(Icons.reply_outlined, size: 16), label: const Text('Nachfragen')),
        ]),
      ])));
    }
    return Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 920), child: RefreshIndicator(onRefresh: laden, child: ListView(padding: const EdgeInsets.all(20), children: [
      Row(children: [
        Text('Hinweise', style: theme.textTheme.headlineSmall),
        const Spacer(),
        IconButton(tooltip: 'Neu laden', onPressed: laden, icon: const Icon(Icons.refresh)),
      ]),
      Text('Was Alfred bemerkt hat, gesammelt. Entscheidungen hier zählen auch in Telegram.', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
      const SizedBox(height: 14),
      if (offen.isEmpty) Padding(padding: const EdgeInsets.symmetric(vertical: 24), child: Text('Keine offenen Hinweise.', style: theme.textTheme.bodyMedium?.copyWith(color: dim))),
      ...offen.map(karte),
      if (entschieden.isNotEmpty) TextButton(onPressed: () => setState(() => entschiedeneZeigen = !entschiedeneZeigen), child: Text('${entschiedeneZeigen ? 'Entschiedene ausblenden' : 'Entschiedene der letzten 7 Tage zeigen'} (${entschieden.length})')),
      if (entschiedeneZeigen) ...entschieden.map(karte),
    ]))));
  }
}
