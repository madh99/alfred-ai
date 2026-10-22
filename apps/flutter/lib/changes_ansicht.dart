/// 1.75.0 (Owner 22.10.: „eigene Changes-Ansicht in der App“ — vorher nur der Chat und die Web-Seite Vorhaben im Browser).
/// Alle Infrastruktur-Changes mit Laufstand, gruppiert: läuft gerade · braucht dich (angehalten) · wartet auf Freigabe ·
/// freigegeben · in Planung · abgeschlossen (7 Tage). Daten: /api/geraete/changes (dieselbe Liste wie die Web-Seite Vorhaben).
/// Die Knöpfe füllen nur die Chat-Eingabe vor („Change … Schritt wiederholen“) — gesendet wird erst vom Owner.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import 'aufgaben.dart' show JsonAbruf;

const _erledigt = {'completed', 'rolled_back', 'failed', 'cancelled'};

/// Alle Changes flach, je Change mit dem Titel seines Vorhabens.
List<Map<String, dynamic>> changesFlach(Map<String, dynamic> j) => [
  for (final v in ((j['vorhaben'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>())
    for (final c in ((v['changes'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>()) {...c, 'vorhabenTitel': v['titel']},
  for (final c in ((j['ohneVorhaben'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>()) c,
];

DateTime? _zeit(Map<String, dynamic> c) => DateTime.tryParse('${(c['lauf'] as Map?)?['ende'] ?? (c['lauf'] as Map?)?['start'] ?? c['erstellt'] ?? ''}');

typedef ChangeGruppen = ({List<Map<String, dynamic>> laeuft, List<Map<String, dynamic>> brauchtDich, List<Map<String, dynamic>> freigabe, List<Map<String, dynamic>> freigegeben, List<Map<String, dynamic>> planung, List<Map<String, dynamic>> erledigt});

/// Gruppen nach Status und Laufphase; Abgeschlossene nur der letzten 7 Tage, neueste zuerst.
ChangeGruppen changeGruppen(List<Map<String, dynamic>> alle, DateTime jetzt) {
  final g = (laeuft: <Map<String, dynamic>>[], brauchtDich: <Map<String, dynamic>>[], freigabe: <Map<String, dynamic>>[], freigegeben: <Map<String, dynamic>>[], planung: <Map<String, dynamic>>[], erledigt: <Map<String, dynamic>>[]);
  for (final c in alle) {
    final status = '${c['status']}', phase = '${c['phase'] ?? ''}';
    if (_erledigt.contains(status)) {
      final z = _zeit(c);
      if (z == null || jetzt.difference(z).inDays < 7) g.erledigt.add(c);
    } else if (phase == 'angehalten' || phase == 'wartet_owner') {
      g.brauchtDich.add(c);
    } else if (phase == 'laeuft' || phase == 'rueckweg' || status == 'in_progress') {
      g.laeuft.add(c);
    } else if (status == 'submitted') {
      g.freigabe.add(c);
    } else if (status == 'approved' || status == 'scheduled') {
      g.freigegeben.add(c);
    } else {
      g.planung.add(c);
    }
  }
  g.erledigt.sort((a, b) => (_zeit(b) ?? DateTime(0)).compareTo(_zeit(a) ?? DateTime(0)));
  return g;
}

/// Zähler in der Navigation: was gerade läuft, angehalten ist oder auf die Freigabe wartet.
int changesZahl(Map<String, dynamic> j, DateTime jetzt) {
  final g = changeGruppen(changesFlach(j), jetzt);
  return g.laeuft.length + g.brauchtDich.length + g.freigabe.length;
}

/// Kurztext zum Status (deutsch), mit Phase für laufende/angehaltene Changes.
String changeStatusText(Map<String, dynamic> c) {
  final phase = '${c['phase'] ?? ''}';
  if (phase == 'rueckweg') return 'Rückweg läuft';
  if (phase == 'angehalten') return 'angehalten';
  if (phase == 'wartet_owner') return 'wartet auf dich';
  return switch ('${c['status']}') {
    'draft' => 'in Planung',
    'submitted' => 'wartet auf Freigabe',
    'approved' || 'scheduled' => 'freigegeben',
    'in_progress' => 'läuft',
    'completed' => 'abgeschlossen',
    'rolled_back' => 'zurückgenommen',
    'failed' => 'fehlgeschlagen',
    'cancelled' => 'abgebrochen',
    final s => s,
  };
}

class ChangesAnsicht extends StatefulWidget {
  const ChangesAnsicht({super.key, required this.json, required this.aufNachfragen, this.aufBestaetigungen, this.aufAnzahl, this.jetzt});
  final JsonAbruf json;
  /// füllt die Chat-Eingabe vor (nicht senden)
  final void Function(String text) aufNachfragen;
  /// öffnet die offenen Bestätigungen (dort steht die Freigabe-Frage)
  final VoidCallback? aufBestaetigungen;
  final void Function(int)? aufAnzahl;
  final DateTime Function()? jetzt;
  @override
  State<ChangesAnsicht> createState() => _ChangesAnsichtState();
}

class _ChangesAnsichtState extends State<ChangesAnsicht> {
  Map<String, dynamic>? daten;
  String? fehler;
  Timer? takt;
  final offen = <String>{};

  DateTime get _jetzt => widget.jetzt?.call() ?? DateTime.now();

  @override
  void initState() { super.initState(); _laden(); }

  @override
  void dispose() { takt?.cancel(); super.dispose(); }

  Future<void> _laden() async {
    try {
      final j = await widget.json('/api/geraete/changes');
      if (!mounted) return;
      setState(() { daten = j; fehler = null; });
      widget.aufAnzahl?.call(changesZahl(j, _jetzt));
      // läuft etwas, alle 5 s nachlesen — sonst alle 30 s
      final g = changeGruppen(changesFlach(j), _jetzt);
      takt?.cancel();
      takt = Timer(Duration(seconds: g.laeuft.isNotEmpty ? 5 : 30), _laden);
    } catch (e) {
      if (mounted) setState(() => fehler = '$e');
      takt?.cancel();
      takt = Timer(const Duration(seconds: 30), _laden);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    if (daten == null && fehler == null) return const Center(child: CircularProgressIndicator());
    final g = changeGruppen(changesFlach(daten ?? const {}), _jetzt);
    Widget gruppe(String titel, List<Map<String, dynamic>> l, {String? leer}) => l.isEmpty && leer == null ? const SizedBox.shrink() : Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Padding(padding: const EdgeInsets.fromLTRB(4, 14, 4, 6), child: Text('$titel${l.isEmpty ? '' : ' (${l.length})'}', style: t.textTheme.titleSmall)),
      if (l.isEmpty) Padding(padding: const EdgeInsets.fromLTRB(4, 0, 4, 4), child: Text(leer!, style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant))),
      for (final c in l) _karte(t, c),
    ]);
    return RefreshIndicator(onRefresh: _laden, child: ListView(padding: const EdgeInsets.fromLTRB(12, 4, 12, 24), children: [
      if (fehler != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text('Changes: $fehler', style: TextStyle(color: t.colorScheme.error))),
      gruppe('Läuft gerade', g.laeuft, leer: 'Gerade läuft kein Change.'),
      gruppe('Braucht dich', g.brauchtDich),
      gruppe('Wartet auf Freigabe', g.freigabe),
      gruppe('Freigegeben, startet bald', g.freigegeben),
      gruppe('In Planung', g.planung),
      gruppe('Abgeschlossen (7 Tage)', g.erledigt.take(20).toList()),
    ]));
  }

  Color _farbe(ThemeData t, Map<String, dynamic> c) {
    final s = '${c['status']}', p = '${c['phase'] ?? ''}';
    if (p == 'angehalten' || p == 'wartet_owner' || s == 'failed') return t.colorScheme.error;
    if (s == 'completed') return Colors.green.shade600;
    if (p == 'laeuft' || p == 'rueckweg' || s == 'in_progress') return t.colorScheme.primary;
    return t.colorScheme.onSurfaceVariant;
  }

  Widget _karte(ThemeData t, Map<String, dynamic> c) {
    final id = '${c['id']}', kurz = id.length > 8 ? id.substring(0, 8) : id;
    final lauf = (c['lauf'] as Map?)?.cast<String, dynamic>();
    final schritte = ((lauf?['schrittListe'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>();
    final anzahl = (c['schritte'] as num?)?.toInt() ?? schritte.length;
    final fertig = (lauf?['fertig'] as num?)?.toInt() ?? 0;
    final status = '${c['status']}', phase = '${c['phase'] ?? ''}';
    final laeuft = phase == 'laeuft' || phase == 'rueckweg' || status == 'in_progress';
    final halt = phase == 'angehalten' || phase == 'wartet_owner';
    final dim = t.colorScheme.onSurfaceVariant;
    final farbe = _farbe(t, c);
    final aufgeklappt = offen.contains(id);
    final unter = [if (c['vorhabenTitel'] != null) '${c['vorhabenTitel']}', kurz, if (c['risiko'] != null) 'Risiko ${c['risiko']}', if ((c['ausfallMinuten'] as num?) != null && (c['ausfallMinuten'] as num) > 0) 'Ausfall ${c['ausfallMinuten']} min'].join(' · ');
    return Card(elevation: 0, color: t.colorScheme.surfaceContainerLow, margin: const EdgeInsets.only(bottom: 10),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16), side: BorderSide(color: halt ? t.colorScheme.error.withValues(alpha: 0.6) : t.colorScheme.outlineVariant.withValues(alpha: 0.6))),
      child: InkWell(borderRadius: BorderRadius.circular(16), onTap: schritte.isEmpty ? null : () => setState(() => aufgeklappt ? offen.remove(id) : offen.add(id)),
        child: Padding(padding: const EdgeInsets.all(12), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(child: Text('${c['titel']}', style: t.textTheme.titleSmall)),
            const SizedBox(width: 8),
            Container(padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2), decoration: BoxDecoration(color: farbe.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(10)),
              child: Text(changeStatusText(c), style: t.textTheme.labelSmall?.copyWith(color: farbe))),
          ]),
          const SizedBox(height: 2),
          Text(unter, style: t.textTheme.bodySmall?.copyWith(color: dim)),
          if (lauf != null && anzahl > 0) ...[
            const SizedBox(height: 8),
            ClipRRect(borderRadius: BorderRadius.circular(3), child: LinearProgressIndicator(value: anzahl == 0 ? 0 : fertig / anzahl, minHeight: 5, color: farbe)),
            const SizedBox(height: 4),
            Text(laeuft || halt ? 'Schritt ${lauf['schritt'] ?? fertig + 1} von $anzahl${lauf['schrittTitel'] != null ? ': ${lauf['schrittTitel']}' : ''}' : '$fertig von $anzahl Schritten erfolgreich', style: t.textTheme.bodySmall),
          ],
          if (halt && lauf?['grund'] != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text('${lauf!['grund']}', style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.error))),
          if (aufgeklappt) Padding(padding: const EdgeInsets.only(top: 8), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            for (final s in schritte) Padding(padding: const EdgeInsets.only(bottom: 3), child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Icon(s['ok'] == true ? Icons.check_circle : s['ok'] == false ? Icons.cancel : (laeuft && s['nr'] == lauf?['schritt'] ? Icons.play_circle : Icons.radio_button_unchecked), size: 16,
                color: s['ok'] == true ? Colors.green.shade600 : s['ok'] == false ? t.colorScheme.error : dim),
              const SizedBox(width: 6),
              Expanded(child: Text('${s['nr']}. ${s['titel']}', style: t.textTheme.bodySmall)),
            ])),
          ])),
          const SizedBox(height: 6),
          Wrap(spacing: 6, runSpacing: 4, children: [
            if (schritte.isNotEmpty) TextButton.icon(onPressed: () => setState(() => aufgeklappt ? offen.remove(id) : offen.add(id)), icon: Icon(aufgeklappt ? Icons.expand_less : Icons.expand_more, size: 18), label: Text(aufgeklappt ? 'Schritte ausblenden' : 'Schritte')),
            if (status == 'submitted' && widget.aufBestaetigungen != null) FilledButton.tonalIcon(onPressed: widget.aufBestaetigungen, icon: const Icon(Icons.verified_outlined, size: 18), label: const Text('Zur Freigabe')),
            if (halt) ...[
              FilledButton.tonalIcon(onPressed: () => widget.aufNachfragen('Change $kurz Schritt wiederholen'), icon: const Icon(Icons.replay, size: 18), label: const Text('Wiederholen …')),
              TextButton(onPressed: () => widget.aufNachfragen('Change $kurz Rückweg ausführen'), child: const Text('Rückweg …')),
              TextButton(onPressed: () => widget.aufNachfragen('Change $kurz abbrechen'), child: const Text('Abbrechen …')),
            ],
            TextButton.icon(onPressed: () => widget.aufNachfragen('Change $kurz: '), icon: const Icon(Icons.chat_bubble_outline, size: 18), label: const Text('Nachfragen')),
          ]),
        ]))));
  }
}
