import 'dart:async';

import 'package:flutter/material.dart';

import 'server.dart';

/// Meilenstein 3 — Kacheln nativ (Owner-Entscheidung 08.10. „nativ"): Lage, Befunde, Vorgänge und Geräte aus den
/// JSON-Routen, die das Gerätetoken lesen darf (`/api/lebenszeichen`, `/api/vorgaenge`). Kein Webview, kein API-Token.
class Kacheln extends StatefulWidget {
  const Kacheln({super.key, required this.server, this.aufHinweis});
  final Server server;
  /// Erste erfolgreiche Ladung als Verlaufszeile (Beweisläufe, Protokoll).
  final void Function(String)? aufHinweis;

  @override
  State<Kacheln> createState() => _KachelnState();
}

class _KachelnState extends State<Kacheln> {
  Map<String, dynamic>? leben;
  Map<String, dynamic>? vorgaenge;
  String? fehler;
  DateTime? stand;
  Timer? takt;

  @override
  void initState() {
    super.initState();
    _laden();
    takt = Timer.periodic(const Duration(seconds: 30), (_) => _laden());
  }

  @override
  void dispose() { takt?.cancel(); super.dispose(); }

  Future<void> _laden() async {
    try {
      final l = await widget.server.json('/api/lebenszeichen');
      final v = await widget.server.json('/api/vorgaenge?limit=30');
      if (!mounted) return;
      final erste = leben == null;
      setState(() { leben = l; vorgaenge = v; fehler = null; stand = DateTime.now(); });
      if (erste) {
        final nb = ((l['befunde'] as Map<String, dynamic>?)?['offen'] as List<dynamic>?)?.length ?? 0;
        final nv = (v['offene'] as List<dynamic>?)?.length ?? 0;
        final ng = (l['geraete'] as List<dynamic>?)?.length ?? 0;
        widget.aufHinweis?.call('Kacheln geladen: Lage ${((l['lage'] as Map<String, dynamic>?)?['text'] as String?)?.length ?? 0} Zeichen, $nb Befunde, $nv Vorgänge, $ng Geräte');
      }
    } catch (e) {
      if (!mounted) return;
      setState(() => fehler = '$e');
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    if (leben == null && fehler == null) return const Center(child: CircularProgressIndicator());
    final l = leben ?? {};
    final lage = (l['lage'] as Map<String, dynamic>?)?['text'] as String? ?? '(keine Lage)';
    final befunde = ((l['befunde'] as Map<String, dynamic>?)?['offen'] as List<dynamic>? ?? []).cast<Map<String, dynamic>>();
    final geraete = ((l['geraete'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>();
    final puls = ((l['puls'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>();
    final kosten = l['kosten'] as Map<String, dynamic>?;
    final offene = ((vorgaenge?['offene'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>();
    final breit = MediaQuery.of(context).size.width >= 900;
    final kacheln = <Widget>[
      _kachel(theme, 'Lage', Icons.radar, child: SelectableText(lage.replaceFirst(RegExp(r'^###\s*'), ''), style: theme.textTheme.bodyMedium), fuss: stand == null ? null : 'Stand ${_zeit(stand!)}${kosten != null ? ' · heute ${_kosten(kosten)}' : ''}'),
      _kachel(theme, 'Befunde (${befunde.length})', Icons.report_problem_outlined, child: befunde.isEmpty ? const Text('Keine offenen Befunde.') : Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        for (final b in befunde.take(12)) Padding(padding: const EdgeInsets.only(bottom: 6), child: Text('• [${b['quelle'] ?? '?'}] ${b['titel'] ?? ''}', style: theme.textTheme.bodySmall)),
        if (befunde.length > 12) Text('… +${befunde.length - 12} weitere', style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
      ])),
      _kachel(theme, 'Vorgänge (${offene.length})', Icons.assignment_outlined, child: offene.isEmpty ? const Text('Keine offenen Vorgänge.') : Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        for (final v in offene.take(12)) Padding(padding: const EdgeInsets.only(bottom: 8), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('${v['titel'] ?? ''}', style: theme.textTheme.bodySmall, maxLines: 2, overflow: TextOverflow.ellipsis),
          Text('${v['status'] ?? ''} · ${v['naechsterSchritt'] ?? ''}${v['frist'] != null ? ' · bis ${_datum('${v['frist']}')}' : ''}', style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
        ])),
        if (offene.length > 12) Text('… +${offene.length - 12} weitere', style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
      ])),
      _kachel(theme, 'Geräte (${geraete.where((g) => g['online'] == true).length}/${geraete.length} online)', Icons.devices, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        for (final g in geraete) Padding(padding: const EdgeInsets.only(bottom: 6), child: Row(children: [
          Icon(Icons.circle, size: 10, color: g['online'] == true ? Colors.green : theme.colorScheme.outline),
          const SizedBox(width: 6),
          Expanded(child: Text('${g['name']} · ${g['plattform']}${g['version'] != null ? ' · ${g['version']}' : ''}${g['online'] != true && g['zuletztGesehen'] != null ? ' · zuletzt ${_datum('${g['zuletztGesehen']}')}' : ''}', style: theme.textTheme.bodySmall, overflow: TextOverflow.ellipsis)),
        ])),
        if (puls.isNotEmpty) ...[
          const SizedBox(height: 6),
          Text('Modelle', style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
          for (final p in puls.where((p) => p['tier'] != 'embeddings')) Text('${p['tier']}: ${p['model']} ${p['gestoertSeit'] != null ? '○ gestört' : '●'}', style: theme.textTheme.bodySmall),
        ],
      ])),
    ];
    return RefreshIndicator(
      onRefresh: _laden,
      child: ListView(
        padding: const EdgeInsets.all(12),
        children: [
          if (fehler != null) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text('Kacheln: $fehler', style: TextStyle(color: theme.colorScheme.error, fontSize: theme.textTheme.bodySmall?.fontSize))),
          if (breit) Row(crossAxisAlignment: CrossAxisAlignment.start, children: [Expanded(child: kacheln[0]), const SizedBox(width: 12), Expanded(child: kacheln[1])]) else ...[kacheln[0], kacheln[1]],
          if (breit) Row(crossAxisAlignment: CrossAxisAlignment.start, children: [Expanded(child: kacheln[2]), const SizedBox(width: 12), Expanded(child: kacheln[3])]) else ...[kacheln[2], kacheln[3]],
        ],
      ),
    );
  }

  Widget _kachel(ThemeData theme, String titel, IconData icon, {required Widget child, String? fuss}) {
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [Icon(icon, size: 18, color: theme.colorScheme.primary), const SizedBox(width: 8), Text(titel, style: theme.textTheme.titleSmall)]),
          const SizedBox(height: 8),
          child,
          if (fuss != null) ...[const SizedBox(height: 8), Text(fuss, style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.onSurfaceVariant))],
        ]),
      ),
    );
  }

  static String _zeit(DateTime d) => '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  static String _datum(String iso) { final d = DateTime.tryParse(iso)?.toLocal(); return d == null ? iso : '${d.day.toString().padLeft(2, '0')}.${d.month.toString().padLeft(2, '0')}. ${_zeit(d)}'; }
  static String _kosten(Map<String, dynamic> k) {
    final v = k['heuteUsd'] ?? k['heute'] ?? k['usd'];
    return v is num ? '${v.toStringAsFixed(2)} \$' : '';
  }
}
