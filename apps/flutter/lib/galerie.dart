import 'package:flutter/material.dart';

import 'modell.dart';

/// 1.5.0 — Übersicht aller abgelegten Anhänge (Owner-Freigabe 11.10., Punkt 4; Server v1350 `/api/geraete/anhaenge`):
/// Bilder als Kacheln, andere Dateien als Zeilen, neueste zuerst. Inhalte über denselben Weg wie im Verlauf
/// (Arbeitsspeicher → Gerätespeicher → Server), Aufbewahrung wie am Server (Standard 30 Tage).
class Galerie extends StatefulWidget {
  const Galerie({super.key, required this.json, required this.lade, required this.aufOeffnen, required this.aufSpeichern, this.aufGespraech});

  final Future<Map<String, dynamic>> Function(String pfad) json;
  /// Inhalt zu einem Verweis {id, name, mime, groesse}.
  final Future<Anhang?> Function(Map<String, dynamic> verweis) lade;
  final void Function(Anhang) aufOeffnen;
  final void Function(Anhang) aufSpeichern;
  /// Gespräch des Anhangs öffnen (null = Hauptgespräch).
  final void Function(String? faden)? aufGespraech;

  @override
  State<Galerie> createState() => _GalerieState();
}

class _GalerieState extends State<Galerie> {
  List<Map<String, dynamic>>? liste;
  String? fehler;
  final Map<String, Future<Anhang?>> _inhalte = {};

  @override
  void initState() { super.initState(); _laden(); }

  Future<void> _laden() async {
    try {
      final j = await widget.json('/api/geraete/anhaenge?limit=200');
      final l = ((j['anhaenge'] as List<dynamic>?) ?? []).whereType<Map<String, dynamic>>().toList();
      if (mounted) setState(() { liste = l; fehler = null; });
    } catch (e) { if (mounted) setState(() => fehler = 'Anhänge nicht geladen: $e'); }
  }

  /// Ein Future je Kennung — beim Neuzeichnen nicht erneut laden (und kein Flackern).
  Future<Anhang?> _inhalt(Map<String, dynamic> v) => _inhalte.putIfAbsent('${v['id']}', () => widget.lade(v));

  static String _datum(String iso) {
    final d = DateTime.tryParse(iso)?.toLocal();
    if (d == null) return '';
    String zz(int x) => x.toString().padLeft(2, '0');
    return '${zz(d.day)}.${zz(d.month)}.${d.year} ${zz(d.hour)}:${zz(d.minute)}';
  }

  Widget _kachel(Map<String, dynamic> v, ThemeData theme) {
    return FutureBuilder<Anhang?>(
      future: _inhalt(v),
      builder: (context, s) {
        final a = s.data;
        final bild = a == null
            ? Center(child: s.connectionState == ConnectionState.done ? Icon(Icons.broken_image_outlined, color: theme.colorScheme.onSurfaceVariant) : const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)))
            : Image.memory(a.daten, fit: BoxFit.cover, gaplessPlayback: true, errorBuilder: (_, __, ___) => const Icon(Icons.broken_image_outlined));
        return Tooltip(
          message: '${v['name']} · ${_datum('${v['zeit'] ?? ''}')}',
          child: InkWell(
            onTap: a == null ? null : () => widget.aufOeffnen(a),
            child: ClipRRect(borderRadius: BorderRadius.circular(8), child: Container(color: theme.colorScheme.surfaceContainerHigh, child: bild)),
          ),
        );
      },
    );
  }

  Widget _zeile(Map<String, dynamic> v, ThemeData theme) {
    final kb = ((v['groesse'] as num?) ?? 0) / 1024;
    final ton = '${v['mime']}'.startsWith('audio/');
    return ListTile(
      dense: true,
      leading: Icon(ton ? Icons.graphic_eq : Icons.insert_drive_file_outlined),
      title: Text('${v['name']}', maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Text('${_datum('${v['zeit'] ?? ''}')} · ${kb.toStringAsFixed(0)} KB', style: theme.textTheme.labelSmall),
      trailing: Row(mainAxisSize: MainAxisSize.min, children: [
        if (widget.aufGespraech != null) IconButton(tooltip: 'Gespräch öffnen', onPressed: () => widget.aufGespraech!(v['faden'] as String?), icon: const Icon(Icons.forum_outlined, size: 18)),
        IconButton(tooltip: 'Öffnen', onPressed: () async { final a = await _inhalt(v); if (a != null) widget.aufOeffnen(a); }, icon: const Icon(Icons.open_in_new, size: 18)),
        IconButton(tooltip: 'Speichern', onPressed: () async { final a = await _inhalt(v); if (a != null) widget.aufSpeichern(a); }, icon: const Icon(Icons.download, size: 18)),
      ]),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l = liste;
    final bilder = (l ?? []).where((v) => RegExp(r'^image/(jpeg|png|gif|webp)$').hasMatch('${v['mime']}')).toList();
    final dateien = (l ?? []).where((v) => !bilder.contains(v)).toList();
    return Padding(padding: const EdgeInsets.all(20), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        Text('Anhänge', style: theme.textTheme.headlineSmall),
        const Spacer(),
        IconButton(tooltip: 'Neu laden', onPressed: () { setState(() { liste = null; _inhalte.clear(); }); _laden(); }, icon: const Icon(Icons.refresh)),
      ]),
      Text('Fotos, Bildschirmfotos und Dateien aus den Gesprächen — neueste zuerst.', style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
      const SizedBox(height: 12),
      if (fehler != null) Text(fehler!, style: TextStyle(color: theme.colorScheme.error)),
      if (l == null && fehler == null) const LinearProgressIndicator(),
      if (l != null && l.isEmpty) const Text('Noch keine Anhänge abgelegt.'),
      if (l != null && l.isNotEmpty) Expanded(child: CustomScrollView(slivers: [
        if (bilder.isNotEmpty) SliverGrid(
          gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(maxCrossAxisExtent: 180, mainAxisSpacing: 8, crossAxisSpacing: 8),
          delegate: SliverChildBuilderDelegate((context, i) => KeyedSubtree(key: Key('bild-${bilder[i]['id']}'), child: _kachel(bilder[i], theme)), childCount: bilder.length),
        ),
        if (dateien.isNotEmpty) SliverToBoxAdapter(child: Padding(padding: const EdgeInsets.only(top: 16, bottom: 4), child: Text('Dateien', style: theme.textTheme.titleSmall))),
        if (dateien.isNotEmpty) SliverList(delegate: SliverChildBuilderDelegate((context, i) => KeyedSubtree(key: Key('datei-${dateien[i]['id']}'), child: _zeile(dateien[i], theme)), childCount: dateien.length)),
      ])),
    ]));
  }
}
