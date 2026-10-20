/// 1.71.0 (Owner 20.10.: „1–5 wie vorgeschlagen“) — Wissen, Interessen und Ziele in den Apps, nur lesend:
/// was Alfred über Personen, Orte und Dinge weiß (Wissensgraph, persönliche Ebene), welche Themen er beobachtet und welche Ziele
/// verfolgt werden. Ändern bleibt im Chat bzw. im Web.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import 'markdown.dart' show oeffneLink;

import 'aufgaben.dart' show JsonAbruf;

const typNamen = <String, String>{'person': 'Person', 'location': 'Ort', 'organization': 'Organisation', 'vehicle': 'Fahrzeug', 'device': 'Gerät', 'network_device': 'Netzwerkgerät', 'pet': 'Haustier', 'event': 'Ereignis', 'project': 'Projekt', 'topic': 'Thema', 'product': 'Produkt'};

class WissenAnsicht extends StatelessWidget {
  const WissenAnsicht({super.key, required this.json});
  final JsonAbruf json;
  @override
  Widget build(BuildContext context) => DefaultTabController(length: 3, child: Column(children: [
    const TabBar(tabs: [Tab(text: 'Wissen'), Tab(text: 'Interessen'), Tab(text: 'Ziele')]),
    Expanded(child: TabBarView(children: [_Wissen(json: json), _Interessen(json: json), _Ziele(json: json)])),
  ]));
}

// ── Wissen ─────────────────────────────────────────────────────────────────────────────────────────────────────
class _Wissen extends StatefulWidget {
  const _Wissen({required this.json});
  final JsonAbruf json;
  @override
  State<_Wissen> createState() => _WissenState();
}

class _WissenState extends State<_Wissen> with AutomaticKeepAliveClientMixin {
  final _suche = TextEditingController();
  Map<String, dynamic>? daten;
  String? fehler;
  Timer? _verz;
  @override
  bool get wantKeepAlive => true;
  @override
  void initState() { super.initState(); _laden(); }
  @override
  void dispose() { _verz?.cancel(); _suche.dispose(); super.dispose(); }

  Future<void> _laden() async {
    final q = _suche.text.trim();
    try {
      final r = await widget.json('/api/geraete/wissen${q.isEmpty ? '' : '?q=${Uri.encodeQueryComponent(q)}'}');
      if (mounted) setState(() { daten = r; fehler = null; });
    } catch (e) { if (mounted) setState(() => fehler = '$e'); }
  }

  void _zeigen(Map<String, dynamic> e, Map<String, Map<String, dynamic>> nachId, List<Map<String, dynamic>> rel) {
    final eigene = rel.where((r) => r['sourceEntityId'] == e['id'] || r['targetEntityId'] == e['id']).toList();
    final attr = (e['attributes'] as Map<String, dynamic>?) ?? {};
    showModalBottomSheet<void>(context: context, isScrollControlled: true, showDragHandle: true, builder: (ctx) {
      final t = Theme.of(ctx);
      return DraggableScrollableSheet(expand: false, initialChildSize: 0.6, maxChildSize: 0.95, builder: (ctx, sc) => ListView(controller: sc, padding: const EdgeInsets.fromLTRB(20, 0, 20, 24), children: [
        Text('${e['name']}', style: t.textTheme.titleLarge),
        Text('${typNamen[e['entityType']] ?? e['entityType']} · ${e['mentionCount'] ?? 0}× erwähnt', style: t.textTheme.labelMedium?.copyWith(color: t.colorScheme.onSurfaceVariant)),
        if (attr.isNotEmpty) ...[const SizedBox(height: 12), for (final a in attr.entries.where((a) => a.value != null && '${a.value}'.isNotEmpty)) Padding(padding: const EdgeInsets.only(bottom: 4), child: Text.rich(TextSpan(children: [TextSpan(text: '${a.key}: ', style: const TextStyle(fontWeight: FontWeight.w600)), TextSpan(text: '${a.value}')]), style: t.textTheme.bodySmall))],
        if (eigene.isNotEmpty) ...[const SizedBox(height: 12), Text('Beziehungen', style: t.textTheme.titleSmall), const SizedBox(height: 4),
          for (final r in eigene) Padding(padding: const EdgeInsets.only(bottom: 4), child: Text(
            r['sourceEntityId'] == e['id'] ? '→ ${r['relationType']} ${nachId[r['targetEntityId']]?['name'] ?? '?'}' : '← ${nachId[r['sourceEntityId']]?['name'] ?? '?'} ${r['relationType']}',
            style: t.textTheme.bodySmall))],
      ]));
    });
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final t = Theme.of(context);
    final ents = ((daten?['entities'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>();
    final rel = ((daten?['relations'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>();
    final nachId = {for (final e in ents) '${e['id']}': e};
    final nachTyp = <String, List<Map<String, dynamic>>>{};
    for (final e in ents) { nachTyp.putIfAbsent('${e['entityType']}', () => []).add(e); }
    return Column(children: [
      Padding(padding: const EdgeInsets.fromLTRB(12, 10, 12, 4), child: TextField(controller: _suche, decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'z. B. Linz, Alexandra, BMW', isDense: true, border: OutlineInputBorder()),
        onChanged: (_) { _verz?.cancel(); _verz = Timer(const Duration(milliseconds: 400), _laden); })),
      if (daten?['gesamt'] != null) Padding(padding: const EdgeInsets.only(bottom: 4), child: Text('${ents.length} von ${daten!['gesamt']} Einträgen${_suche.text.trim().isEmpty ? ' (die meistgenannten)' : ''}', style: t.textTheme.labelSmall?.copyWith(color: t.colorScheme.onSurfaceVariant))),
      if (fehler != null) Text('Wissen: $fehler', style: TextStyle(color: t.colorScheme.error)),
      Expanded(child: daten == null && fehler == null ? const Center(child: CircularProgressIndicator()) : RefreshIndicator(onRefresh: _laden, child: ListView(padding: const EdgeInsets.fromLTRB(12, 0, 12, 24), children: [
        for (final g in nachTyp.entries) ...[
          Padding(padding: const EdgeInsets.only(top: 10, bottom: 4), child: Text('${typNamen[g.key] ?? g.key} (${g.value.length})', style: t.textTheme.titleSmall)),
          Wrap(spacing: 6, runSpacing: 6, children: [for (final e in g.value) ActionChip(label: Text('${e['name']}'), onPressed: () => _zeigen(e, nachId, rel))]),
        ],
      ]))),
    ]);
  }
}

// ── Interessen ─────────────────────────────────────────────────────────────────────────────────────────────────
class _Interessen extends StatefulWidget {
  const _Interessen({required this.json});
  final JsonAbruf json;
  @override
  State<_Interessen> createState() => _InteressenState();
}

class _InteressenState extends State<_Interessen> with AutomaticKeepAliveClientMixin {
  List<Map<String, dynamic>>? themen;
  String? fehler;
  @override
  bool get wantKeepAlive => true;
  @override
  void initState() { super.initState(); _laden(); }
  Future<void> _laden() async {
    try { final r = await widget.json('/api/geraete/interessen'); if (mounted) setState(() { themen = ((r['topics'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>(); fehler = null; }); }
    catch (e) { if (mounted) setState(() => fehler = '$e'); }
  }

  Future<void> _eintraege(Map<String, dynamic> th) async {
    List<Map<String, dynamic>> items = [];
    try { items = (((await widget.json('/api/geraete/interessen/${th['id']}?limit=40'))['items'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>(); } catch (_) {}
    if (!mounted) return;
    showModalBottomSheet<void>(context: context, isScrollControlled: true, showDragHandle: true, builder: (ctx) => DraggableScrollableSheet(expand: false, initialChildSize: 0.7, maxChildSize: 0.95, builder: (ctx, sc) => ListView(controller: sc, padding: const EdgeInsets.fromLTRB(16, 0, 16, 24), children: [
      Text('${th['name']}', style: Theme.of(ctx).textTheme.titleLarge),
      if (items.isEmpty) const Padding(padding: EdgeInsets.only(top: 12), child: Text('Noch keine Einträge.')),
      for (final it in items) ListTile(contentPadding: EdgeInsets.zero, title: Text('${it['title']}', maxLines: 2, overflow: TextOverflow.ellipsis), subtitle: it['summary'] == null ? null : Text('${it['summary']}', maxLines: 3, overflow: TextOverflow.ellipsis),
        trailing: it['url'] == null ? null : const Icon(Icons.open_in_new, size: 16), onTap: it['url'] == null ? null : () => oeffneLink('${it['url']}')),
    ])));
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final t = Theme.of(context);
    if (themen == null && fehler == null) return const Center(child: CircularProgressIndicator());
    return RefreshIndicator(onRefresh: _laden, child: ListView(padding: const EdgeInsets.fromLTRB(12, 10, 12, 24), children: [
      if (fehler != null) Text('Interessen: $fehler', style: TextStyle(color: t.colorScheme.error)),
      if (themen?.isEmpty == true) const Text('Keine beobachteten Themen.'),
      for (final th in themen ?? const <Map<String, dynamic>>[]) Card(elevation: 0, color: t.colorScheme.surfaceContainerLow, child: ListTile(
        title: Text('${th['name']}'),
        subtitle: Text([
          if (((th['keywords'] as List<dynamic>?) ?? []).isNotEmpty) (th['keywords'] as List<dynamic>).take(5).join(', '),
          '${th['itemsLast7d'] ?? 0} neu in 7 Tagen',
          if ((th['digest'] as Map<String, dynamic>?)?['summary'] != null) '${(th['digest'] as Map<String, dynamic>)['summary']}',
        ].join(' · '), maxLines: 3, overflow: TextOverflow.ellipsis),
        trailing: Text(th['status'] == 'active' ? '' : '${th['status']}', style: t.textTheme.labelSmall),
        onTap: () => _eintraege(th),
      )),
    ]));
  }
}

// ── Ziele ──────────────────────────────────────────────────────────────────────────────────────────────────────
class _Ziele extends StatefulWidget {
  const _Ziele({required this.json});
  final JsonAbruf json;
  @override
  State<_Ziele> createState() => _ZieleState();
}

class _ZieleState extends State<_Ziele> with AutomaticKeepAliveClientMixin {
  List<Map<String, dynamic>>? ziele;
  String? fehler;
  @override
  bool get wantKeepAlive => true;
  @override
  void initState() { super.initState(); _laden(); }
  Future<void> _laden() async {
    try { final r = await widget.json('/api/geraete/ziele'); if (mounted) setState(() { ziele = ((r['goals'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>(); fehler = null; }); }
    catch (e) { if (mounted) setState(() => fehler = '$e'); }
  }

  Future<void> _zeigen(Map<String, dynamic> z) async {
    Map<String, dynamic>? d;
    try { d = await widget.json('/api/geraete/ziele/${z['id']}'); } catch (_) {}
    if (!mounted) return;
    final cps = ((d?['checkpoints'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>();
    showModalBottomSheet<void>(context: context, isScrollControlled: true, showDragHandle: true, builder: (ctx) => DraggableScrollableSheet(expand: false, initialChildSize: 0.6, maxChildSize: 0.95, builder: (ctx, sc) => ListView(controller: sc, padding: const EdgeInsets.fromLTRB(20, 0, 20, 24), children: [
      Text('${z['title']}', style: Theme.of(ctx).textTheme.titleLarge),
      if (z['description'] != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text('${z['description']}')),
      const SizedBox(height: 10),
      Text('Prüfungen', style: Theme.of(ctx).textTheme.titleSmall),
      if (cps.isEmpty) const Text('Noch keine.'),
      for (final c in cps) Padding(padding: const EdgeInsets.only(top: 6), child: Text('${'${c['createdAt'] ?? c['checkedAt'] ?? ''}'.split('T').first} · ${c['status'] ?? ''} ${c['note'] ?? c['notiz'] ?? c['summary'] ?? ''}', style: Theme.of(ctx).textTheme.bodySmall)),
    ])));
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final t = Theme.of(context);
    if (ziele == null && fehler == null) return const Center(child: CircularProgressIndicator());
    return RefreshIndicator(onRefresh: _laden, child: ListView(padding: const EdgeInsets.fromLTRB(12, 10, 12, 24), children: [
      if (fehler != null) Text('Ziele: $fehler', style: TextStyle(color: t.colorScheme.error)),
      if (ziele?.isEmpty == true) const Text('Keine Ziele.'),
      for (final z in ziele ?? const <Map<String, dynamic>>[]) Card(elevation: 0, color: t.colorScheme.surfaceContainerLow, child: ListTile(
        leading: Icon(z['status'] == 'active' ? Icons.flag_outlined : Icons.flag, color: z['lastStatus'] == 'on_track' ? Colors.green : z['lastStatus'] == 'off_track' ? t.colorScheme.error : null),
        title: Text('${z['title']}'),
        subtitle: Text([if (z['category'] != null) '${z['category']}', '${z['status']}', if (z['lastStatus'] != null) 'zuletzt: ${z['lastStatus']}', if (z['lastCheckedAt'] != null) 'geprüft ${'${z['lastCheckedAt']}'.split('T').first}'].join(' · ')),
        onTap: () => _zeigen(z),
      )),
    ]));
  }
}
