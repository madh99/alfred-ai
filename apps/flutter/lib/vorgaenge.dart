/// 1.9.0 — A4 (Owner-Freigabe 11.10.): Vorgänge mit Entscheidung. Ein Klick öffnet die Details (Ziel, nächster Schritt,
/// Frist, „Warum?", letzte Schritte).
/// 1.13.0 — Spec „Entscheiden statt Abhaken" E1 (Owner 12.10.: „bei Erledigt muss man doch sagen wie — und ob in Zukunft
/// bei so etwas entschieden werden soll"): statt Erledigt/Verwerfen fragt der Dialog „Was war es?" (behoben — Ursache,
/// Maßnahme · entschieden — was · kein Problem — warum · anders) und bei Vorgängen aus einem Befund „Und künftig?"
/// (wie heute · nicht mehr melden für 7/30/90 Tage · jedes Mal fragen). Ab dem dritten „kein Problem" zum selben Befund
/// ist Alfreds Vorschlag „nicht mehr melden" vorausgewählt. `POST /api/geraete/vorgaenge/:id {ergebnis, kuenftig}` (Server v1362).
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

/// „Was war es?" — Arten und ihre Felder.
const ergebnisArten = {'behoben': 'Behoben', 'entschieden': 'Entschieden', 'kein_problem': 'Kein Problem', 'anders': 'Anders'};

/// „Und künftig?" — Vorauswahl: Alfreds Vorschlag ab dem dritten „kein Problem" (dieses Mal mitgezählt), sonst „wie heute".
String kuenftigVorauswahl({required String? art, required bool befund, required bool nieStumm, required int keinProblemBisher}) =>
    befund && !nieStumm && art == 'kein_problem' && keinProblemBisher >= 2 ? 'stumm' : 'wie_heute';

/// Anfragekörper des Abschlusses.
Map<String, dynamic> abschlussKoerper({required String art, String? ursache, String? massnahme, String? entscheidung, String? text, required String kuenftig, int tage = 30}) => {
      'ergebnis': {
        'art': art,
        if ((ursache ?? '').trim().isNotEmpty) 'ursache': ursache!.trim(),
        if ((massnahme ?? '').trim().isNotEmpty) 'massnahme': massnahme!.trim(),
        if ((entscheidung ?? '').trim().isNotEmpty) 'entscheidung': entscheidung!.trim(),
        if ((text ?? '').trim().isNotEmpty) 'text': text!.trim(),
      },
      'kuenftig': {'art': kuenftig, if (kuenftig == 'stumm') 'tage': tage},
    };

/// 1.34.0 — „Ausführen": die von Alfred vorgeschlagene Aktion (Server v1480) — erst die Aktion zeigen, dann nach Ja ausführen.
/// Liefert true, wenn ausgeführt wurde (Aufrufer lädt neu).
Future<bool> vorgangAusfuehren(BuildContext context, {required Map<String, dynamic> v, required JsonAbruf json, required void Function(String) aufMeldung}) async {
  final vs = v['vorschlag'] as Map<String, dynamic>?;
  if (vs == null || vs['ausfuehrbar'] != true) return false;
  final ja = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(
        title: const Text('Vorschlag ausführen?'),
        content: SizedBox(width: 520, child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('${v['titel'] ?? ''}', style: Theme.of(ctx).textTheme.titleSmall),
          const SizedBox(height: 10),
          Text('Alfred führt genau diese Aktion aus:', style: Theme.of(ctx).textTheme.bodySmall),
          const SizedBox(height: 4),
          Container(width: double.infinity, padding: const EdgeInsets.all(10), decoration: BoxDecoration(color: Theme.of(ctx).colorScheme.surfaceContainerHighest, borderRadius: BorderRadius.circular(8)),
              child: SelectableText('${vs['text'] ?? ''}', style: Theme.of(ctx).textTheme.bodySmall?.copyWith(fontFamily: 'monospace'))),
        ])),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Abbrechen')),
          FilledButton.icon(onPressed: () => Navigator.pop(ctx, true), icon: const Icon(Icons.play_arrow, size: 16), label: const Text('Ausführen')),
        ],
      ));
  if (ja != true) return false;
  try {
    final r = await json('/api/geraete/vorgaenge/${v['id']}', methode: 'POST', koerper: {'aktion': 'ausfuehren'});
    aufMeldung(r['erfolg'] == true ? '▶️ Ausgeführt: ${v['titel'] ?? ''} — ${r['text'] ?? ''}' : '⚠️ Ausführen fehlgeschlagen: ${v['titel'] ?? ''} — ${r['text'] ?? ''}');
    return true;
  } catch (e) {
    aufMeldung('⚠️ Nicht ausgeführt: $e');
    return false;
  }
}

/// 1.34.0 — „Später" (Server v1480): zurückstellen, ohne Frist und Status zu ändern. Wahl: 3, morgen, 72, 168, zurueck.
const spaeterWahl = <String, String>{'3': 'In 3 Stunden', 'morgen': 'Morgen früh', '72': 'In 3 Tagen', '168': 'In einer Woche'};
Future<bool> vorgangSpaeter(String id, String wahl, {required JsonAbruf json, required void Function(String) aufMeldung, String titel = ''}) async {
  try {
    final koerper = <String, dynamic>{'aktion': 'spaeter', if (wahl == 'morgen' || wahl == 'zurueck') 'bis': wahl else 'stunden': int.parse(wahl)};
    await json('/api/geraete/vorgaenge/$id', methode: 'POST', koerper: koerper);
    aufMeldung(wahl == 'zurueck' ? '↩️ Wieder aufgenommen: $titel' : '⏰ Zurückgestellt: $titel (${spaeterWahl[wahl] ?? wahl})');
    return true;
  } catch (e) {
    aufMeldung('⏰ Nicht zurückgestellt: $e');
    return false;
  }
}

/// Zurückgestellt bis (lokal) oder null, wenn nicht oder nicht mehr zurückgestellt.
DateTime? zurueckBis(Map<String, dynamic> v, DateTime jetzt) {
  final b = DateTime.tryParse('${v['zurueckBis'] ?? ''}')?.toLocal();
  return b != null && b.isAfter(jetzt) ? b : null;
}

/// Dialog öffnen. Liefert true, wenn abgeschlossen wurde (Aufrufer lädt neu).
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
  final ursache = TextEditingController(), massnahme = TextEditingController(), entscheidung = TextEditingController(), text = TextEditingController();
  String? art;
  String kuenftig = 'wie_heute';
  int tage = 30;
  bool sendet = false;

  bool get befund => widget.v['befund'] != null;
  bool get nieStumm => widget.v['nieStumm'] == true;
  int get keinProblemBisher => (widget.v['keinProblemBisher'] as num?)?.toInt() ?? 0;

  @override
  void dispose() { for (final c in [ursache, massnahme, entscheidung, text]) { c.dispose(); } super.dispose(); }

  void waehleArt(String a) => setState(() { art = a; kuenftig = kuenftigVorauswahl(art: a, befund: befund, nieStumm: nieStumm, keinProblemBisher: keinProblemBisher); });

  Future<void> abschliessen() async {
    if (art == null) return;
    setState(() => sendet = true);
    try {
      final r = await widget.json('/api/geraete/vorgaenge/${widget.v['id']}', methode: 'POST', koerper: abschlussKoerper(art: art!, ursache: ursache.text, massnahme: massnahme.text, entscheidung: entscheidung.text, text: text.text, kuenftig: kuenftig, tage: tage));
      final zusatz = [if (r['regel'] != null) 'Regel: ${r['regel']}', if (r['vorschlag'] != null) 'Alfred schlägt vor: ${r['vorschlag']} (Befunde › Regeln)'].join(' · ');
      widget.aufMeldung('📋 Abgeschlossen: ${widget.v['titel'] ?? ''} — ${ergebnisArten[art] ?? art}${zusatz.isEmpty ? '' : ' · $zusatz'}');
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      widget.aufMeldung('📋 Nicht abgeschlossen: $e');
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
    Widget eingabe(TextEditingController c, String label) => Padding(padding: const EdgeInsets.only(top: 8), child: TextField(controller: c, enabled: !sendet, maxLength: 500, decoration: InputDecoration(isDense: true, labelText: label, border: const OutlineInputBorder())));
    final vorschlagAktiv = kuenftig == 'stumm' && art == 'kein_problem' && keinProblemBisher >= 2;

    return AlertDialog(
      title: Text('${v['titel'] ?? 'Vorgang'}'),
      content: SizedBox(width: 640, child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text([vorgangStatusName('${v['status'] ?? ''}'), if (v['besitzer'] == 'user') 'bei dir' else 'bei Alfred', if (v['quelle'] != null) '${v['quelle']}', if (v['erstellt'] != null) 'seit ${_zeit('${v['erstellt']}')}'].join(' · '), style: theme.textTheme.labelMedium?.copyWith(color: dim)),
        const SizedBox(height: 10),
        feld('Ziel', v['ziel']),
        feld('Nächster Schritt', v['naechsterSchritt']),
        feld('Frist', v['frist'] == null ? null : _zeit('${v['frist']}')),
        feld('Warum?', v['begruendung']),
        feld('Ergebnis', v['ergebnis']),
        // 1.34.0 — vorgeschlagene Aktion (ausführbar oder mit Grund, warum nicht)
        feld((v['vorschlag'] as Map<String, dynamic>?)?['ausfuehrbar'] == false ? 'Vorgeschlagene Aktion (nicht ausführbar)' : 'Vorgeschlagene Aktion', (v['vorschlag'] as Map<String, dynamic>?)?['text']),
        if (widget.schritte.isNotEmpty) ...[
          Text('Letzte Schritte', style: theme.textTheme.labelSmall?.copyWith(color: dim)),
          for (final s in widget.schritte.take(8)) Padding(padding: const EdgeInsets.only(top: 4), child: Text('${_zeit('${s['zeit']}')} · ${s['art'] ?? ''} — ${s['beschreibung'] ?? ''}${s['ergebnis'] != null ? ' → ${s['ergebnis']}' : ''}', style: theme.textTheme.bodySmall, maxLines: 3, overflow: TextOverflow.ellipsis)),
          const SizedBox(height: 10),
        ],
        if (offen) ...[
          const Divider(),
          Text('Was war es?', style: theme.textTheme.titleSmall),
          const SizedBox(height: 6),
          Wrap(spacing: 6, runSpacing: 6, children: [for (final e in ergebnisArten.entries) ChoiceChip(label: Text(e.value), selected: art == e.key, onSelected: sendet ? null : (_) => waehleArt(e.key))]),
          if (art == 'behoben') ...[eingabe(ursache, 'Ursache'), eingabe(massnahme, 'Maßnahme — was wurde getan?')],
          if (art == 'entschieden') eingabe(entscheidung, 'Was wurde entschieden?'),
          if (art == 'kein_problem') eingabe(text, 'Warum ist es kein Problem?'),
          if (art == 'anders') eingabe(text, 'Was war es?'),
          if (art != null && befund) ...[
            const SizedBox(height: 12),
            Text('Und künftig, wenn dieser Befund wieder auftritt?', style: theme.textTheme.titleSmall),
            const SizedBox(height: 6),
            Wrap(spacing: 6, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
              ChoiceChip(label: const Text('Wie heute'), selected: kuenftig == 'wie_heute', onSelected: sendet ? null : (_) => setState(() => kuenftig = 'wie_heute')),
              Tooltip(message: nieStumm ? 'Sicherheitsbefunde und Alfreds eigener Zustand lassen sich nicht stummschalten' : 'Kein neuer Vorgang zu diesem Befund — der Befund bleibt unter „Befunde" sichtbar',
                  child: ChoiceChip(label: const Text('Nicht mehr melden'), selected: kuenftig == 'stumm', onSelected: sendet || nieStumm ? null : (_) => setState(() => kuenftig = 'stumm'))),
              if (kuenftig == 'stumm') DropdownButton<int>(value: tage, isDense: true, items: const [DropdownMenuItem(value: 7, child: Text('7 Tage')), DropdownMenuItem(value: 30, child: Text('30 Tage')), DropdownMenuItem(value: 90, child: Text('90 Tage'))], onChanged: sendet ? null : (t) => setState(() => tage = t ?? 30)),
              ChoiceChip(label: const Text('Jedes Mal fragen'), selected: kuenftig == 'immer_fragen', onSelected: sendet ? null : (_) => setState(() => kuenftig = 'immer_fragen')),
            ]),
            if (vorschlagAktiv) Padding(padding: const EdgeInsets.only(top: 6), child: Text('Alfreds Vorschlag: Dieser Befund war schon $keinProblemBisher× „kein Problem".', style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.primary))),
          ],
        ],
      ]))),
      actions: [
        if (widget.aufNachfragen != null) TextButton.icon(onPressed: sendet ? null : () { Navigator.pop(context, false); widget.aufNachfragen!('Wie steht es um „${v['titel'] ?? ''}“?'); }, icon: const Icon(Icons.reply_outlined, size: 16), label: const Text('Nachfragen')),
        // 1.34.0 — Später und Ausführen (Server v1480)
        if (offen) PopupMenuButton<String>(
          tooltip: 'Später: zurückstellen', enabled: !sendet,
          onSelected: (w) async { if (await vorgangSpaeter('${v['id']}', w, json: widget.json, aufMeldung: widget.aufMeldung, titel: '${v['titel'] ?? ''}') && context.mounted) Navigator.pop(context, true); },
          itemBuilder: (_) => [for (final e in spaeterWahl.entries) PopupMenuItem(value: e.key, child: Text(e.value))],
          child: const Padding(padding: EdgeInsets.symmetric(horizontal: 12, vertical: 8), child: Row(mainAxisSize: MainAxisSize.min, children: [Icon(Icons.schedule, size: 16), SizedBox(width: 6), Text('Später')])),
        ),
        if (offen && (v['vorschlag'] as Map<String, dynamic>?)?['ausfuehrbar'] == true) FilledButton.tonalIcon(onPressed: sendet ? null : () async { if (await vorgangAusfuehren(context, v: v, json: widget.json, aufMeldung: widget.aufMeldung) && context.mounted) Navigator.pop(context, true); }, icon: const Icon(Icons.play_arrow, size: 16), label: const Text('Ausführen…')),
        TextButton(onPressed: sendet ? null : () => Navigator.pop(context, false), child: Text(offen ? 'Abbrechen' : 'Schließen')),
        if (offen) FilledButton.icon(onPressed: sendet || art == null ? null : abschliessen, icon: const Icon(Icons.check, size: 16), label: const Text('Abschließen')),
      ],
    );
  }
}
