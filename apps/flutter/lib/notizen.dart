/// 1.71.0 (Owner 20.10.: „1–5 wie vorgeschlagen“) — Notizen in den Apps: lesen, suchen, neu anlegen (/api/geraete/notizen).
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'aufgaben.dart' show JsonAbruf;

class NotizenAnsicht extends StatefulWidget {
  const NotizenAnsicht({super.key, required this.json});
  final JsonAbruf json;
  @override
  State<NotizenAnsicht> createState() => _NotizenAnsichtState();
}

class _NotizenAnsichtState extends State<NotizenAnsicht> {
  final _suche = TextEditingController();
  List<Map<String, dynamic>>? notizen;
  String? fehler;
  Timer? _verzoegert;

  @override
  void initState() { super.initState(); _laden(); }
  @override
  void dispose() { _verzoegert?.cancel(); _suche.dispose(); super.dispose(); }

  Future<void> _laden() async {
    final q = _suche.text.trim();
    try {
      final r = await widget.json('/api/geraete/notizen${q.isEmpty ? '' : '?q=${Uri.encodeQueryComponent(q)}'}');
      if (mounted) setState(() { notizen = ((r['notes'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>(); fehler = null; });
    } catch (e) { if (mounted) setState(() => fehler = '$e'); }
  }

  Future<void> _neu() async {
    final titel = TextEditingController(), inhalt = TextEditingController();
    final ok = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(
      title: const Text('Neue Notiz'),
      content: SizedBox(width: 420, child: Column(mainAxisSize: MainAxisSize.min, children: [
        TextField(controller: titel, autofocus: true, decoration: const InputDecoration(labelText: 'Titel')),
        const SizedBox(height: 8),
        TextField(controller: inhalt, minLines: 4, maxLines: 10, decoration: const InputDecoration(labelText: 'Inhalt', alignLabelWithHint: true)),
      ])),
      actions: [TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Abbrechen')), FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Speichern'))],
    ));
    if (ok != true || (titel.text.trim().isEmpty && inhalt.text.trim().isEmpty)) return;
    try {
      await widget.json('/api/geraete/notizen', methode: 'POST', koerper: {'title': titel.text.trim(), 'content': inhalt.text.trim()});
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Notiz gespeichert')));
      await _laden();
    } catch (e) { if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Nicht gespeichert: $e'))); }
  }

  void _zeigen(Map<String, dynamic> n) {
    showModalBottomSheet<void>(context: context, isScrollControlled: true, showDragHandle: true, builder: (ctx) => DraggableScrollableSheet(expand: false, initialChildSize: 0.6, maxChildSize: 0.95, builder: (ctx, sc) => ListView(controller: sc, padding: const EdgeInsets.fromLTRB(20, 0, 20, 24), children: [
      Text('${n['title'] ?? ''}', style: Theme.of(ctx).textTheme.titleLarge),
      const SizedBox(height: 4),
      Text(_datum(n['updatedAt'] as String?), style: Theme.of(ctx).textTheme.labelSmall),
      const SizedBox(height: 12),
      SelectableText('${n['content'] ?? ''}'),
      Align(alignment: Alignment.centerRight, child: TextButton.icon(icon: const Icon(Icons.copy, size: 16), label: const Text('Kopieren'), onPressed: () => Clipboard.setData(ClipboardData(text: '${n['content'] ?? ''}')))),
    ])));
  }

  static String _datum(String? iso) { final d = iso == null ? null : DateTime.tryParse(iso)?.toLocal(); return d == null ? '' : '${d.day.toString().padLeft(2, '0')}.${d.month.toString().padLeft(2, '0')}.${d.year} ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}'; }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Column(children: [
      Padding(padding: const EdgeInsets.fromLTRB(12, 12, 12, 4), child: Row(children: [
        Expanded(child: TextField(controller: _suche, decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Notizen durchsuchen', isDense: true, border: OutlineInputBorder()),
          onChanged: (_) { _verzoegert?.cancel(); _verzoegert = Timer(const Duration(milliseconds: 350), _laden); })),
        const SizedBox(width: 8),
        FilledButton.icon(key: const Key('notiz-neu'), onPressed: _neu, icon: const Icon(Icons.add, size: 18), label: const Text('Neu')),
      ])),
      if (fehler != null) Padding(padding: const EdgeInsets.all(12), child: Text('Notizen: $fehler', style: TextStyle(color: t.colorScheme.error))),
      Expanded(child: notizen == null && fehler == null ? const Center(child: CircularProgressIndicator()) : RefreshIndicator(onRefresh: _laden, child: ListView.separated(
        padding: const EdgeInsets.fromLTRB(4, 4, 4, 24),
        itemCount: notizen?.length ?? 0,
        separatorBuilder: (_, __) => const Divider(height: 1),
        itemBuilder: (_, i) {
          final n = notizen![i];
          return ListTile(title: Text('${n['title'] ?? ''}', maxLines: 1, overflow: TextOverflow.ellipsis), subtitle: Text('${n['content'] ?? ''}'.replaceAll('\n', ' '), maxLines: 2, overflow: TextOverflow.ellipsis),
            trailing: Text(_datum(n['updatedAt'] as String?).split(' ').first, style: t.textTheme.labelSmall), onTap: () => _zeigen(n));
        },
      ))),
    ]);
  }
}
