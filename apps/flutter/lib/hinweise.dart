/// 1.4.0 — Sammlung „Hinweise" (Owner 10.10.2026: Insights verschwinden in der App im Verlauf, man kann nichts damit tun).
/// Liest `/api/geraete/hinweise` (Server v1343, nur Geräte des Owners) und entscheidet je Hinweis: erledigt, später (24 h),
/// verwerfen, ausführen (wenn der Hinweis eine Aktion hat), nachfragen (springt in den Chat mit Bezug). Telegram bleibt
/// unverändert; der Chat der App zeigt Insights nur noch als kurze Zeile mit Verweis hierher.
///
/// 1.14.0 — „Auf Hinweise reagieren" (Server v1364, Owner 12.10.): Ein Hinweis ist Information, kein Auftrag — reagieren
/// ist freiwillig. „Erledigt" wurde als „gelesen" benutzt und ist getrennt in „Nützlich" (Lernsignal) und „Gelesen"
/// (neutral, auch „Alle gelesen"); „Nicht nützlich" mit freiwilligem Grund; „Nachfragen" merkt sich „besprochen".
library;

import 'package:flutter/material.dart';

import 'aufgaben.dart' show JsonAbruf;

class Hinweis {
  Hinweis(Map<String, dynamic> j)
      : id = '${j['id']}', quelle = '${j['quelle'] ?? ''}', titel = '${j['titel'] ?? ''}', text = '${j['text'] ?? ''}',
        status = '${j['status'] ?? 'pending'}', zeit = DateTime.tryParse('${j['zeit']}')?.toLocal() ?? DateTime.now(),
        dringlichkeit = j['dringlichkeit'] as String?, zugestellt = j['zugestellt'] as String?, aktion = j['aktion'] as String?,
        reaktion = j['reaktion'] as String?;
  final String id, quelle, titel, text;
  String status;
  String? reaktion;
  final DateTime zeit;
  final String? dringlichkeit, zugestellt, aktion;
  bool get offen => status == 'pending' || status == 'snoozed';
}

/// 1.5.1 — Zahl offener Hinweise aus der Antwort von `/api/geraete/hinweise`. Owner-Befund 11.10.: der Zähler in der
/// Symbolleiste erschien erst nach dem Öffnen der Ansicht — jetzt fragt die App ihn beim Start und jede Minute selbst ab.
int offeneHinweise(Map<String, dynamic> j) =>
    ((j['hinweise'] as List<dynamic>?) ?? []).whereType<Map<String, dynamic>>().map(Hinweis.new).where((h) => h.offen).length;

/// 1.14.0 — Gründe für „Nicht nützlich" (Schlüssel = Server-Reaktion).
const hinweisGruende = <String, String>{
  'nicht_nuetzlich': 'ohne Grund',
  'bekannt': 'schon bekannt',
  'falsch': 'falsch',
  'kein_interesse': 'interessiert mich nicht',
  'zu_oft': 'zu oft',
};

/// 1.14.0 — Status nach einer Reaktion (null = unverändert, z. B. „besprochen").
String? statusNach(String aktion) => switch (aktion) {
      'nuetzlich' || 'gelesen' || 'ausfuehren' => 'acted',
      'spaeter' => 'snoozed',
      'besprochen' => null,
      _ when hinweisGruende.containsKey(aktion) => 'dismissed',
      _ => null,
    };

/// 1.14.0 — Anzeige des Ausgangs: Reaktion vor Status (alte Einträge haben nur den Status).
String? ausgangText(String status, String? reaktion) => switch (reaktion) {
      'nuetzlich' => 'nützlich',
      'gelesen' => 'gelesen',
      'nicht_nuetzlich' => 'nicht nützlich',
      'bekannt' || 'falsch' || 'kein_interesse' || 'zu_oft' => 'nicht nützlich: ${hinweisGruende[reaktion]}',
      _ => switch (status) { 'snoozed' => 'später', 'acted' => 'erledigt', 'dismissed' => 'verworfen', _ => null },
    };

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
  const Hinweise({super.key, required this.json, required this.aufNachfragen, required this.aufMeldung, this.aufAnzahl});
  final JsonAbruf json; // 1.14.0 wie Aufgaben/Befunde (testbar)
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
      final j = await widget.json('/api/geraete/hinweise');
      final l = ((j['hinweise'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>().map(Hinweis.new).toList();
      if (!mounted) return;
      setState(() { liste = l; fehler = null; });
      widget.aufAnzahl?.call(l.where((h) => h.offen).length);
    } catch (e) { if (mounted) setState(() => fehler = '$e'); }
  }

  Future<void> entscheide(Hinweis h, String aktion) async {
    try {
      final r = await widget.json('/api/geraete/hinweise/${h.id}', methode: 'POST', koerper: {'aktion': aktion});
      if (r['ok'] == true) {
        setState(() {
          h.status = statusNach(aktion) ?? h.status;
          if (aktion != 'spaeter') h.reaktion = aktion == 'ausfuehren' ? 'nuetzlich' : aktion;
        });
        widget.aufAnzahl?.call(liste!.where((x) => x.offen).length);
        if (aktion == 'ausfuehren') widget.aufMeldung('💡 Ausgeführt: ${h.titel}');
      } else {
        widget.aufMeldung('💡 Nicht möglich: ${r['grund'] ?? 'unbekannt'}');
      }
    } catch (e) { widget.aufMeldung('💡 Fehler: $e'); }
  }

  /// 1.14.0 — Abend-Durchgang wie am 11.10.: alles Offene als gelesen (neutral, kein Lernsignal).
  Future<void> alleGelesen() async {
    for (final h in liste!.where((x) => x.offen).toList()) {
      await entscheide(h, 'gelesen');
    }
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
      final statusText = ausgangText(h.status, h.reaktion);
      return Card(margin: const EdgeInsets.only(bottom: 10), child: Padding(padding: const EdgeInsets.fromLTRB(14, 12, 14, 6), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          if (h.dringlichkeit == 'high' || h.dringlichkeit == 'urgent') Padding(padding: const EdgeInsets.only(right: 6), child: Icon(Icons.priority_high, size: 16, color: theme.colorScheme.error)),
          Expanded(child: Text(h.titel, style: theme.textTheme.titleSmall)),
          Text('${quellenName(h.quelle)} · ${zeit(h.zeit)}${statusText != null ? ' · $statusText' : ''}', style: theme.textTheme.labelSmall?.copyWith(color: dim)),
        ]),
        const SizedBox(height: 6),
        InkWell(onTap: () => setState(() => ganz ? offenText.remove(h.id) : offenText.add(h.id)), child: Text(h.text.replaceAll('**', ''), maxLines: ganz ? null : 3, overflow: ganz ? null : TextOverflow.ellipsis, style: theme.textTheme.bodyMedium)),
        Wrap(spacing: 2, children: [
          if (h.offen) TextButton.icon(onPressed: () => entscheide(h, 'nuetzlich'), icon: const Icon(Icons.thumb_up_outlined, size: 16), label: const Text('Nützlich')),
          if (h.offen) TextButton.icon(onPressed: () => entscheide(h, 'gelesen'), icon: const Icon(Icons.done, size: 16), label: const Text('Gelesen')),
          if (h.offen) PopupMenuButton<String>(
            tooltip: 'Nicht nützlich — Grund freiwillig',
            onSelected: (g) => entscheide(h, g),
            itemBuilder: (_) => [for (final e in hinweisGruende.entries) PopupMenuItem(value: e.key, child: Text(e.value))],
            child: Padding(padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10), child: Row(mainAxisSize: MainAxisSize.min, children: [
              Icon(Icons.thumb_down_outlined, size: 16, color: theme.colorScheme.primary), const SizedBox(width: 8),
              Text('Nicht nützlich', style: theme.textTheme.labelLarge?.copyWith(color: theme.colorScheme.primary)), Icon(Icons.arrow_drop_down, size: 18, color: theme.colorScheme.primary),
            ])),
          ),
          if (h.offen && h.aktion != null) TextButton.icon(onPressed: () => entscheide(h, 'ausfuehren'), icon: const Icon(Icons.bolt, size: 16), label: Text(h.aktion!)),
          if (h.offen && h.status != 'snoozed') TextButton.icon(onPressed: () => entscheide(h, 'spaeter'), icon: const Icon(Icons.schedule, size: 16), label: const Text('Später')),
          TextButton.icon(onPressed: () { if (h.reaktion == null) entscheide(h, 'besprochen'); widget.aufNachfragen('${h.titel}\n\n${h.text}'); }, icon: const Icon(Icons.reply_outlined, size: 16), label: const Text('Nachfragen')),
        ]),
      ])));
    }
    return Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 920), child: RefreshIndicator(onRefresh: laden, child: ListView(padding: const EdgeInsets.all(20), children: [
      Row(children: [
        Text('Hinweise', style: theme.textTheme.headlineSmall),
        const Spacer(),
        if (offen.isNotEmpty) TextButton.icon(onPressed: alleGelesen, icon: const Icon(Icons.done_all, size: 18), label: const Text('Alle gelesen')),
        IconButton(tooltip: 'Neu laden', onPressed: laden, icon: const Icon(Icons.refresh)),
      ]),
      Text('Was Alfred bemerkt hat, gesammelt. Reagieren ist freiwillig — „Nützlich" und „Nicht nützlich" helfen Alfred zu lernen, „Gelesen" räumt nur auf.', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
      const SizedBox(height: 14),
      if (offen.isEmpty) Padding(padding: const EdgeInsets.symmetric(vertical: 24), child: Text('Keine offenen Hinweise.', style: theme.textTheme.bodyMedium?.copyWith(color: dim))),
      ...offen.map(karte),
      if (entschieden.isNotEmpty) TextButton(onPressed: () => setState(() => entschiedeneZeigen = !entschiedeneZeigen), child: Text('${entschiedeneZeigen ? 'Entschiedene ausblenden' : 'Entschiedene der letzten 7 Tage zeigen'} (${entschieden.length})')),
      if (entschiedeneZeigen) ...entschieden.map(karte),
    ]))));
  }
}
