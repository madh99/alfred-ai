/// 1.12.0 — Befunde nativ (Owner 12.10.: Haus-Check als Befunde statt Gesprächsfaden). Liest `/api/geraete/befunde`
/// (Server v1359, nur Geräte des Owners): offene Befunde aller Quellen und die der letzten 7 Tage erledigten.
/// Befunde sind Zustände mit Identität (Schicht 3): sie erledigen sich von selbst, wenn die Ursache verschwindet.
/// Der Haus-Check ist eine Quelle davon, gruppiert nach seinen Regeln A1–B3. „Nachfragen" springt mit Bezug in den Chat.
library;

import 'package:flutter/material.dart';

import 'aufgaben.dart' show JsonAbruf;

class Befund {
  Befund(Map<String, dynamic> j)
      : id = '${j['id']}', quelle = '${j['quelle'] ?? ''}', regel = j['regel'] as String?, titel = '${j['titel'] ?? ''}',
        detail = j['detail'] as String?, entstanden = DateTime.tryParse('${j['entstanden'] ?? ''}')?.toLocal(),
        erledigt = DateTime.tryParse('${j['erledigt'] ?? ''}')?.toLocal(), anzahl = (j['anzahl'] as num?)?.toInt() ?? 1,
        vorgang = j['vorgang'] == true, vorgangId = j['vorgangId'] as String?, nieStumm = j['nieStumm'] == true;
  final String id, quelle, titel;
  final String? regel, detail, vorgangId;
  final DateTime? entstanden, erledigt;
  final int anzahl;
  final bool vorgang, nieStumm;
}

/// 1.35.0 — Aktionen am Befund (Server v1481): „nicht mehr melden" für 7/30/90 Tage (Sicherheit nie) und „Vorgang daraus".
const stummTage = <int, String>{7: '7 Tage', 30: '30 Tage', 90: '90 Tage'};

Future<bool> befundStumm(String id, int tage, {required JsonAbruf json, required void Function(String) aufMeldung}) async {
  try {
    final r = await json('/api/geraete/befunde/$id', methode: 'POST', koerper: {'aktion': 'stumm', 'tage': tage});
    aufMeldung('🔕 ${r['regel'] ?? 'Nicht mehr melden'}');
    return true;
  } catch (e) { aufMeldung('🔕 Nicht geändert: $e'); return false; }
}

Future<bool> befundVorgang(String id, {required JsonAbruf json, required void Function(String) aufMeldung}) async {
  try {
    final r = await json('/api/geraete/befunde/$id', methode: 'POST', koerper: {'aktion': 'vorgang'});
    aufMeldung(r['neu'] == true ? '📋 Vorgang angelegt: ${r['titel'] ?? ''}' : '📋 Vorgang gibt es schon: ${r['titel'] ?? ''}');
    return true;
  } catch (e) { aufMeldung('📋 Kein Vorgang: $e'); return false; }
}

/// Befund im Dialog: Quelle, seit, wie oft, Einzelheiten — und die Aktionen. Liefert true, wenn sich etwas geändert hat.
Future<bool> zeigeBefund(BuildContext context, {required Map<String, dynamic> b, required JsonAbruf json, required void Function(String) aufMeldung, void Function(String text)? aufNachfragen, VoidCallback? aufVorgaenge}) async {
  final r = await showDialog<bool>(context: context, builder: (ctx) {
    final t = Theme.of(ctx);
    final dim = t.colorScheme.onSurfaceVariant;
    final entstanden = DateTime.tryParse('${b['entstanden'] ?? ''}')?.toLocal();
    final anzahl = b['anzahl'] ?? b['gesehenAnzahl'];
    final hatVorgang = b['vorgang'] == true || b['vorgangId'] != null;
    final nieStumm = b['nieStumm'] == true;
    return AlertDialog(
      title: Text('${b['titel'] ?? 'Befund'}'),
      content: SizedBox(width: 600, child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text([befundQuelle('${b['quelle'] ?? ''}'), if (entstanden != null) 'seit ${entstanden.day}.${entstanden.month}.', if (anzahl != null) '$anzahl× gesehen', if (hatVorgang) 'mit Vorgang'].join(' · '), style: t.textTheme.labelMedium?.copyWith(color: dim)),
        const SizedBox(height: 10),
        if ((b['detail'] ?? '').toString().trim().isNotEmpty && b['detail'] != b['titel']) SelectableText('${b['detail']}', style: t.textTheme.bodyMedium)
        else Text('Keine weiteren Einzelheiten.', style: t.textTheme.bodySmall?.copyWith(color: dim)),
        const SizedBox(height: 10),
        Text('Befunde erledigen sich von selbst, sobald die Ursache weg ist.', style: t.textTheme.bodySmall?.copyWith(color: dim)),
      ]))),
      actions: [
        if (aufNachfragen != null) TextButton.icon(onPressed: () { Navigator.pop(ctx, false); aufNachfragen('Zum Befund „${b['titel']}"${b['detail'] != null && b['detail'] != b['titel'] ? ' (${b['detail']})' : ''}: '); }, icon: const Icon(Icons.question_answer_outlined, size: 16), label: const Text('Nachfragen')),
        Tooltip(message: nieStumm ? 'Sicherheitsbefunde und Alfreds eigener Zustand lassen sich nicht stummschalten' : 'Beim nächsten Auftreten kein Vorgang und keine Meldung', child: PopupMenuButton<int>(
          enabled: !nieStumm,
          onSelected: (tage) async { if (await befundStumm('${b['id']}', tage, json: json, aufMeldung: aufMeldung) && ctx.mounted) Navigator.pop(ctx, true); },
          itemBuilder: (_) => [for (final e in stummTage.entries) PopupMenuItem(value: e.key, child: Text('Nicht mehr melden: ${e.value}'))],
          child: Padding(padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8), child: Row(mainAxisSize: MainAxisSize.min, children: [Icon(Icons.notifications_off_outlined, size: 16, color: nieStumm ? dim : t.colorScheme.primary), const SizedBox(width: 6), Text('Nicht mehr melden', style: t.textTheme.labelLarge?.copyWith(color: nieStumm ? dim : t.colorScheme.primary))])),
        )),
        if (hatVorgang && aufVorgaenge != null) TextButton.icon(onPressed: () { Navigator.pop(ctx, false); aufVorgaenge(); }, icon: const Icon(Icons.assignment_outlined, size: 16), label: const Text('Vorgang öffnen'))
        else if (!hatVorgang) FilledButton.tonalIcon(onPressed: () async { if (await befundVorgang('${b['id']}', json: json, aufMeldung: aufMeldung) && ctx.mounted) Navigator.pop(ctx, true); }, icon: const Icon(Icons.add_task, size: 16), label: const Text('Vorgang daraus')),
        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Schließen')),
      ],
    );
  });
  return r == true;
}

/// Anzeigename je Quelle (befunde.quelle).
String befundQuelle(String q) => switch (q) {
      'haus-check' => 'Haus-Check',
      'infra' => 'Infrastruktur',
      'energie' => 'Energie',
      'sensorbatterien' => 'Sensorbatterien',
      'haus' => 'Haus',
      'bmw' => 'Auto',
      'geraete' => 'Geräte',
      'mikrotik' => 'Netzwerk',
      'lebenszeichen' => 'Alfred selbst',
      _ => q,
    };

/// Regeln des Haus-Checks (Server ha-pruefung.ts REGEL_TEXT, Kurzform).
String regelName(String r) => switch (r) {
      'A1' => 'Automation verweist auf Fehlendes',
      'A2' => 'Automation lange nicht ausgelöst',
      'A3' => 'Automation lange deaktiviert',
      'B1' => 'Gerät lange nicht verfügbar',
      'B2' => 'Melder oder Messwert stumm',
      'B3' => 'Verbindung instabil',
      _ => r,
    };

/// Quellen-Reihenfolge: die übrigen (meist wenige, wichtige) zuerst, der Haus-Check zuletzt.
List<String> quellenReihenfolge(Iterable<Befund> l) {
  final z = <String, int>{};
  for (final b in l) { z[b.quelle] = (z[b.quelle] ?? 0) + 1; }
  return z.keys.toList()..sort((a, b) => a == 'haus-check' ? 1 : b == 'haus-check' ? -1 : befundQuelle(a).compareTo(befundQuelle(b)));
}

/// Gruppen einer Quelle: Haus-Check nach Regel (A1 … B3), sonst eine Gruppe.
List<MapEntry<String?, List<Befund>>> befundGruppen(List<Befund> l) {
  final m = <String?, List<Befund>>{};
  for (final b in l) { (m[b.regel] ??= []).add(b); }
  final k = m.keys.toList()..sort((a, b) => (a ?? '').compareTo(b ?? ''));
  return [for (final x in k) MapEntry(x, m[x]!)];
}

/// „neu" = in den letzten 7 Tagen entstanden.
bool befundNeu(Befund b, DateTime jetzt) => b.entstanden != null && jetzt.difference(b.entstanden!).inDays < 7;

/// 1.13.0 — Regel des Owners (Spec „Entscheiden statt Abhaken"): Vorschlag von Alfred oder aktive Regel.
class Regel {
  Regel(Map<String, dynamic> j)
      : id = '${j['id']}', text = '${j['text'] ?? ''}', begruendung = j['begruendung'] as String?, herkunft = '${j['herkunft'] ?? ''}',
        status = '${j['status'] ?? ''}', abgelaufen = j['abgelaufen'] == true;
  final String id, text, herkunft, status;
  final String? begruendung;
  final bool abgelaufen;
}

class Befunde extends StatefulWidget {
  const Befunde({super.key, required this.json, this.aufNachfragen, this.anfang, this.aufMeldung});
  final JsonAbruf json;
  /// 1.13.0 — Rückmeldung nach Übernehmen/Ablehnen/Widerrufen einer Regel
  final void Function(String text)? aufMeldung;
  final void Function(String text)? aufNachfragen;
  /// Startfilter (z. B. 'haus-check' aus dem Telegram-Satz)
  final String? anfang;
  @override
  State<Befunde> createState() => _BefundeState();
}

class _BefundeState extends State<Befunde> {
  List<Befund>? offen;
  List<Regel> vorschlaege = [], regeln = [];
  List<Befund> erledigt = [];
  String? quelle;
  String? fehler;
  bool erledigteZeigen = false;
  final ganz = <String>{};

  @override
  void initState() { super.initState(); quelle = widget.anfang; laden(); }

  Future<void> _regelnLaden() async {
    try {
      final j = await widget.json('/api/geraete/regeln');
      List<Regel> liste(String k) => ((j[k] as List<dynamic>?) ?? []).whereType<Map<String, dynamic>>().map(Regel.new).toList();
      if (mounted) setState(() { vorschlaege = liste('vorschlaege'); regeln = liste('aktiv'); });
    } catch (_) { /* älterer Server ohne Regeln — Abschnitt bleibt leer */ }
  }

  Future<void> _regelAendern(Regel r, String aktion) async {
    try {
      await widget.json('/api/geraete/regeln/${r.id}', methode: 'POST', koerper: {'aktion': aktion});
      widget.aufMeldung?.call(switch (aktion) { 'uebernehmen' => '📏 Regel übernommen: ${r.text}', 'ablehnen' => '📏 Vorschlag abgelehnt', _ => '📏 Regel widerrufen: ${r.text}' });
      await _regelnLaden();
    } catch (e) { widget.aufMeldung?.call('📏 Nicht geändert: $e'); }
  }

  Future<void> laden() async {
    try {
      final j = await widget.json('/api/geraete/befunde');
      List<Befund> liste(String k) => ((j[k] as List<dynamic>?) ?? []).whereType<Map<String, dynamic>>().map(Befund.new).toList();
      if (!mounted) return;
      setState(() { offen = liste('offen'); erledigt = liste('erledigt'); fehler = null; });
      await _regelnLaden();
    } catch (e) { if (mounted) setState(() => fehler = '$e'); }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dim = theme.colorScheme.onSurfaceVariant;
    final jetzt = DateTime.now();
    final o = offen;
    String datum(DateTime d) => '${d.day}.${d.month}.';

    Widget karte(Befund b, {bool istErledigt = false}) {
      final auf = ganz.contains(b.id);
      final neu = !istErledigt && befundNeu(b, jetzt);
      return Card(margin: const EdgeInsets.only(bottom: 8), child: Padding(padding: const EdgeInsets.fromLTRB(14, 10, 6, 4), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        InkWell(onTap: b.detail == null ? null : () => setState(() => auf ? ganz.remove(b.id) : ganz.add(b.id)), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            if (neu) Padding(padding: const EdgeInsets.only(right: 8, top: 2), child: Container(padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1), decoration: BoxDecoration(color: theme.colorScheme.primaryContainer, borderRadius: BorderRadius.circular(6)), child: Text('neu', style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.onPrimaryContainer)))),
            Expanded(child: Text(b.titel, style: theme.textTheme.bodyMedium?.copyWith(decoration: istErledigt ? TextDecoration.lineThrough : null))),
          ]),
          if (b.detail != null && auf) Padding(padding: const EdgeInsets.only(top: 6), child: SelectableText(b.detail!, style: theme.textTheme.bodySmall)),
        ])),
        Row(children: [
          Expanded(child: Text([
            if (b.entstanden != null) 'seit ${datum(b.entstanden!)}',
            if (istErledigt && b.erledigt != null) 'erledigt ${datum(b.erledigt!)}',
            '${b.anzahl}× gesehen',
            if (b.vorgang) 'mit Vorgang',
            if (b.detail != null && !auf) 'Klick: Einzelheiten',
          ].join(' · '), maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.labelSmall?.copyWith(color: dim))),
          // 1.35.0 — Aktionen direkt an der Karte (Server v1481)
          if (!istErledigt && !b.nieStumm) PopupMenuButton<int>(
            tooltip: 'Nicht mehr melden', icon: const Icon(Icons.notifications_off_outlined, size: 18),
            onSelected: (tage) async { if (await befundStumm(b.id, tage, json: widget.json, aufMeldung: (t) => widget.aufMeldung?.call(t))) await laden(); },
            itemBuilder: (_) => [for (final e in stummTage.entries) PopupMenuItem(value: e.key, child: Text('Nicht mehr melden: ${e.value}'))],
          ),
          if (!istErledigt && !b.vorgang) IconButton(tooltip: 'Vorgang daraus', icon: const Icon(Icons.add_task, size: 18),
              onPressed: () async { if (await befundVorgang(b.id, json: widget.json, aufMeldung: (t) => widget.aufMeldung?.call(t))) await laden(); }),
          if (widget.aufNachfragen != null && !istErledigt)
            IconButton(tooltip: 'Nachfragen: im Chat mit Bezug weiterfragen', icon: const Icon(Icons.question_answer_outlined, size: 18),
                onPressed: () => widget.aufNachfragen!('Zum Befund „${b.titel}"${b.detail != null ? ' (${b.detail})' : ''}: ')),
        ]),
      ])));
    }

    final sichtbar = (o ?? []).where((b) => quelle == null || b.quelle == quelle).toList();
    final sichtbarErledigt = erledigt.where((b) => quelle == null || b.quelle == quelle).toList();
    final quellen = quellenReihenfolge([...(o ?? []), ...erledigt]);

    return Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 920), child: Column(children: [
      Padding(padding: const EdgeInsets.fromLTRB(20, 20, 20, 0), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Text('Befunde', style: theme.textTheme.headlineSmall),
          const SizedBox(width: 12),
          if (o != null) Text('${o.length} offen', style: theme.textTheme.bodyMedium?.copyWith(color: dim)),
          const Spacer(),
          IconButton(tooltip: 'Neu laden', onPressed: laden, icon: const Icon(Icons.refresh)),
        ]),
        Text('Was Alfred als auffällig führt. Befunde erledigen sich von selbst, sobald die Ursache weg ist.', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
        const SizedBox(height: 10),
        Wrap(spacing: 6, runSpacing: 6, children: [
          ChoiceChip(label: Text('Alle (${o?.length ?? 0})'), selected: quelle == null, onSelected: (_) => setState(() => quelle = null)),
          for (final q in quellen) ChoiceChip(label: Text('${befundQuelle(q)} (${(o ?? []).where((b) => b.quelle == q).length})'), selected: quelle == q, onSelected: (_) => setState(() => quelle = q)),
        ]),
        const SizedBox(height: 8),
      ])),
      Expanded(child: fehler != null
          ? Center(child: Text('Befunde nicht geladen: $fehler'))
          : o == null
              ? const Center(child: CircularProgressIndicator())
              : ListView(padding: const EdgeInsets.fromLTRB(20, 4, 20, 20), children: [
                  // 1.13.0 — Regeln: Vorschläge von Alfred zuerst (übernehmen/ablehnen), dann aktive (widerrufen)
                  if (vorschlaege.isNotEmpty || regeln.isNotEmpty) Card(margin: const EdgeInsets.only(bottom: 12), child: Padding(padding: const EdgeInsets.fromLTRB(14, 10, 8, 6), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('Regeln', style: theme.textTheme.titleMedium),
                    for (final r in vorschlaege) Row(children: [
                      Icon(Icons.lightbulb_outline, size: 16, color: theme.colorScheme.primary),
                      const SizedBox(width: 6),
                      Expanded(child: Text('Vorschlag von Alfred: ${r.text}${r.begruendung != null ? ' — ${r.begruendung}' : ''}', style: theme.textTheme.bodySmall)),
                      TextButton(onPressed: () => _regelAendern(r, 'uebernehmen'), child: const Text('Übernehmen')),
                      TextButton(onPressed: () => _regelAendern(r, 'ablehnen'), child: const Text('Ablehnen')),
                    ]),
                    for (final r in regeln) Row(children: [
                      Icon(r.abgelaufen ? Icons.history : Icons.rule, size: 16, color: dim),
                      const SizedBox(width: 6),
                      Expanded(child: Text('${r.text}${r.herkunft == 'alfred' ? ' · von Alfred vorgeschlagen' : ''}${r.begruendung != null ? ' — ${r.begruendung}' : ''}', style: theme.textTheme.bodySmall?.copyWith(color: r.abgelaufen ? dim : null))),
                      if (!r.abgelaufen) TextButton(onPressed: () => _regelAendern(r, 'widerrufen'), child: const Text('Widerrufen')),
                    ]),
                  ]))),
                  if (sichtbar.isEmpty) Padding(padding: const EdgeInsets.symmetric(vertical: 24), child: Text('Keine offenen Befunde${quelle == null ? '' : ' für ${befundQuelle(quelle!)}'}.', style: theme.textTheme.bodyMedium?.copyWith(color: dim))),
                  for (final q in quellenReihenfolge(sichtbar)) ...[
                    if (quelle == null) Padding(padding: const EdgeInsets.fromLTRB(0, 12, 0, 6), child: Text(befundQuelle(q), style: theme.textTheme.titleMedium)),
                    for (final g in befundGruppen(sichtbar.where((b) => b.quelle == q).toList())) ...[
                      if (g.key != null) Padding(padding: const EdgeInsets.fromLTRB(0, 6, 0, 6), child: Text('${g.key} — ${regelName(g.key!)} (${g.value.length})', style: theme.textTheme.labelLarge?.copyWith(color: theme.colorScheme.primary))),
                      for (final b in g.value) karte(b),
                    ],
                  ],
                  if (sichtbarErledigt.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    TextButton.icon(onPressed: () => setState(() => erledigteZeigen = !erledigteZeigen), icon: Icon(erledigteZeigen ? Icons.expand_less : Icons.expand_more),
                        label: Text('In den letzten 7 Tagen erledigt (${sichtbarErledigt.length})')),
                    if (erledigteZeigen) for (final b in sichtbarErledigt) karte(b, istErledigt: true),
                  ],
                ])),
    ])));
  }
}
