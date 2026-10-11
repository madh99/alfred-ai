/// 1.9.0 — A4 (Owner-Freigabe 11.10.): Vorgänge mit Entscheidung. Bisher zeigten Kachel und Seitenleiste Vorgänge nur
/// an; jetzt öffnet ein Klick die Details (Ziel, nächster Schritt, Frist, „Warum?", letzte Schritte) und der Owner
/// entscheidet: erledigt oder verworfen, mit optionaler Notiz (`POST /api/geraete/vorgaenge/:id`, Server v1353 —
/// dieselbe Entscheidung wie in der Web-Kachel, zählt für die Erledigungsquote in Schicht 4).
library;

import 'package:flutter/material.dart';

import 'aufgaben.dart' show JsonAbruf;

String vorgangStatusName(String s) => switch (s) {
      'offen' => 'offen',
      'wartet' => 'wartet',
      'erledigt' => 'erledigt',
      'verworfen' => 'verworfen',
      _ => s,
    };

/// Schritte dieses Vorgangs aus der Übersicht (`schritte` von /api/vorgaenge), neueste zuerst.
List<Map<String, dynamic>> schritteVon(String id, List<dynamic>? alle) =>
    (alle ?? []).whereType<Map<String, dynamic>>().where((s) => s['vorgangId'] == id).toList()..sort((a, b) => '${b['zeit']}'.compareTo('${a['zeit']}'));

String _zeit(String iso) {
  final d = DateTime.tryParse(iso)?.toLocal();
  if (d == null) return '';
  return '${d.day}.${d.month}. ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
}

/// Dialog öffnen. Liefert true, wenn entschieden wurde (Aufrufer lädt neu).
Future<bool> zeigeVorgang(BuildContext context, {required Map<String, dynamic> v, required List<dynamic>? schritte, required JsonAbruf json, required void Function(String) aufMeldung, void Function(String text)? aufNachfragen}) async {
  final r = await showDialog<bool>(context: context, builder: (ctx) => _VorgangDialog(v: v, schritte: schritteVon('${v['id']}', schritte), json: json, aufMeldung: aufMeldung, aufNachfragen: aufNachfragen));
  return r == true;
}

class _VorgangDialog extends StatefulWidget {
  const _VorgangDialog({required this.v, required this.schritte, required this.json, required this.aufMeldung, this.aufNachfragen});
  final Map<String, dynamic> v;
  final List<Map<String, dynamic>> schritte;
  final JsonAbruf json;
  final void Function(String) aufMeldung;
  final void Function(String text)? aufNachfragen;
  @override
  State<_VorgangDialog> createState() => _VorgangDialogState();
}

class _VorgangDialogState extends State<_VorgangDialog> {
  final notiz = TextEditingController();
  bool sendet = false;

  @override
  void dispose() { notiz.dispose(); super.dispose(); }

  Future<void> entscheide(String status) async {
    setState(() => sendet = true);
    try {
      await widget.json('/api/geraete/vorgaenge/${widget.v['id']}', methode: 'POST', koerper: {'status': status, if (notiz.text.trim().isNotEmpty) 'notiz': notiz.text.trim()});
      widget.aufMeldung('📋 Vorgang ${status == 'erledigt' ? 'erledigt' : 'verworfen'}: ${widget.v['titel'] ?? ''}');
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      widget.aufMeldung('📋 Nicht entschieden: $e');
      if (mounted) setState(() => sendet = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dim = theme.colorScheme.onSurfaceVariant;
    final v = widget.v;
    final offen = v['status'] != 'erledigt' && v['status'] != 'verworfen';
    Widget feld(String name, Object? wert) => (wert == null || '$wert'.trim().isEmpty) ? const SizedBox.shrink() : Padding(padding: const EdgeInsets.only(bottom: 8), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(name, style: theme.textTheme.labelSmall?.copyWith(color: dim)),
          SelectableText('$wert', style: theme.textTheme.bodyMedium),
        ]));
    return AlertDialog(
      title: Text('${v['titel'] ?? 'Vorgang'}'),
      content: SizedBox(width: 620, child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text([vorgangStatusName('${v['status'] ?? ''}'), if (v['besitzer'] == 'user') 'bei dir' else 'bei Alfred', if (v['quelle'] != null) '${v['quelle']}', if (v['erstellt'] != null) 'seit ${_zeit('${v['erstellt']}')}'].join(' · '), style: theme.textTheme.labelMedium?.copyWith(color: dim)),
        const SizedBox(height: 10),
        feld('Ziel', v['ziel']),
        feld('Nächster Schritt', v['naechsterSchritt']),
        feld('Frist', v['frist'] == null ? null : _zeit('${v['frist']}')),
        feld('Warum?', v['begruendung']),
        feld('Ergebnis', v['ergebnis']),
        if (widget.schritte.isNotEmpty) ...[
          Text('Letzte Schritte', style: theme.textTheme.labelSmall?.copyWith(color: dim)),
          for (final s in widget.schritte.take(8)) Padding(padding: const EdgeInsets.only(top: 4), child: Text('${_zeit('${s['zeit']}')} · ${s['art'] ?? ''} — ${s['beschreibung'] ?? ''}${s['ergebnis'] != null ? ' → ${s['ergebnis']}' : ''}', style: theme.textTheme.bodySmall, maxLines: 3, overflow: TextOverflow.ellipsis)),
          const SizedBox(height: 10),
        ],
        if (offen) TextField(controller: notiz, enabled: !sendet, maxLength: 500, decoration: const InputDecoration(isDense: true, labelText: 'Notiz (optional)', border: OutlineInputBorder())),
      ]))),
      actions: [
        if (widget.aufNachfragen != null) TextButton.icon(onPressed: sendet ? null : () { Navigator.pop(context, false); widget.aufNachfragen!('Wie steht es um „${v['titel'] ?? ''}“?'); }, icon: const Icon(Icons.reply_outlined, size: 16), label: const Text('Nachfragen')),
        if (offen) TextButton.icon(onPressed: sendet ? null : () => entscheide('verworfen'), icon: const Icon(Icons.close, size: 16), label: const Text('Verwerfen')),
        if (offen) FilledButton.icon(onPressed: sendet ? null : () => entscheide('erledigt'), icon: const Icon(Icons.check, size: 16), label: const Text('Erledigt')),
        if (!offen) TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Schließen')),
      ],
    );
  }
}
