import 'dart:async';

import 'package:flutter/material.dart';

import 'befunde.dart'; // 1.35.0
import 'server.dart';
import 'vorgaenge.dart'; // 1.9.0 A4

/// 1.36.0 — Lage zeilenweise: „Stichwort: Text" (Stichwort fett), ohne die Anweisungszeile fürs Modell („Hinweis: Das ist der belegte Stand …").
List<({String? stichwort, String text})> lageZeilen(String lage) {
  final aus = <({String? stichwort, String text})>[];
  for (final roh in lage.split('\n')) {
    final z = roh.trim();
    if (z.isEmpty || z.startsWith('###') || z.startsWith('Hinweis: Das ist der belegte Stand')) continue;
    final i = z.indexOf(': ');
    if (i > 0 && i <= 40) { aus.add((stichwort: z.substring(0, i), text: z.substring(i + 2))); } else { aus.add((stichwort: null, text: z)); }
  }
  return aus;
}

/// 1.70.0 — Gesamtzustand für „Auf einen Blick“: gestört (Modell gestört oder offene Wächter-Meldung), Befunde, alles ruhig.
enum Ampel { ok, warn, bad }

({Ampel ampel, String text}) gesamtZustand(Map<String, dynamic> l) {
  final puls = ((l['puls'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>().where((p) => p['tier'] != 'embeddings');
  final gestoert = puls.where((p) => p['gestoertSeit'] != null).length;
  final waechter = ((l['offen'] as List<dynamic>?) ?? []).length;
  final befunde = (((l['befunde'] as Map<String, dynamic>?)?['offen'] as List<dynamic>?) ?? []).length;
  if (gestoert > 0 || waechter > 0) return (ampel: Ampel.bad, text: [if (gestoert > 0) '$gestoert Modell${gestoert == 1 ? '' : 'e'} gestört', if (waechter > 0) '$waechter Wächter-Meldung${waechter == 1 ? '' : 'en'}'].join(' · '));
  if (befunde > 0) return (ampel: Ampel.warn, text: '$befunde Befund${befunde == 1 ? '' : 'e'}');
  return (ampel: Ampel.ok, text: 'Alles ruhig');
}

/// 1.70.0 — Ampel eines Modells (wie die Web-Lage): Fehler nach dem letzten Erfolg = rot, ohne Erfolg = gelb.
Ampel pulsAmpel(Map<String, dynamic> p) {
  final f = p['letzterFehler'] as String?, e = p['letzterErfolg'] as String?;
  if (f == null) return e != null ? Ampel.ok : Ampel.warn;
  if (e == null || f.compareTo(e) > 0) return Ampel.bad;
  return Ampel.ok;
}

/// 1.70.0 — „vor 5 min“, „vor 3 h“
String vorZeit(String? iso, {DateTime? jetzt}) {
  final d = iso == null ? null : DateTime.tryParse(iso);
  if (d == null) return '—';
  final min = (jetzt ?? DateTime.now()).difference(d).inMinutes;
  if (min < 1) return 'gerade eben';
  if (min < 60) return 'vor $min min';
  final h = (min / 60).round();
  return h < 48 ? 'vor $h h' : 'vor ${(h / 24).round()} Tagen';
}

const kennzahlNamen = <String, String>{
  'vollpaesse': 'Vollpässe', 'miniPaesse': 'Mini-Pässe', 'rundgaenge': 'Rundgänge', 'insightsGesendet': 'Hinweise gesendet',
  'insightsAufgeschoben': 'aufgeschoben', 'insightsStill': 'still abgelegt', 'aktionenAusgefuehrt': 'Aktionen ausgeführt',
  'aktionenBestaetigung': 'zur Bestätigung', 'aktionenFehlgeschlagen': 'fehlgeschlagen', 'vorgaengeAngelegt': 'Vorgänge angelegt',
};

/// Meilenstein 3 / 1.70.0 (Owner 20.10.: „1–5 wie vorgeschlagen“) — die Lage: oben „Auf einen Blick“, dann was den Owner braucht,
/// die Lage selbst (kurz, mit „mehr“ und „Warum?“), Vorgänge, Befunde (auch erledigte), Geräte, Kennzahlen und eingeklappt die
/// Technik. Jeder Teil lädt für sich; im Hintergrund pausiert die Aktualisierung.
class Kacheln extends StatefulWidget {
  const Kacheln({super.key, required this.server, this.aufHinweis, this.aufMeldung, this.aufNachfragen, this.aufBefunde, this.aufVorgaenge, this.bestaetigungen = 0, this.aufEingang});
  final VoidCallback? aufVorgaenge;
  final void Function(String? quelle)? aufBefunde;
  final Server server;
  final void Function(String)? aufMeldung;
  final void Function(String)? aufNachfragen;
  final void Function(String)? aufHinweis;
  /// 1.70.0 — offene Bestätigungen (aus der Sitzung) und Sprung in den Eingang
  final int bestaetigungen;
  final VoidCallback? aufEingang;

  @override
  State<Kacheln> createState() => _KachelnState();
}

class _KachelnState extends State<Kacheln> with WidgetsBindingObserver {
  Map<String, dynamic>? leben;
  Map<String, dynamic>? vorgaenge;
  String? fehlerLeben, fehlerVorgaenge;
  DateTime? stand;
  Timer? takt;
  bool lageGanz = false;
  final _abschnitte = <String, GlobalKey>{for (final k in ['braucht', 'lage', 'befunde', 'geraete', 'kennzahlen', 'technik']) k: GlobalKey()};

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _laden();
    _taktStarten();
  }

  void _taktStarten() { takt?.cancel(); takt = Timer.periodic(const Duration(seconds: 30), (_) => _laden()); }

  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    // 1.70.0 — im Hintergrund nicht laden (Akku); beim Zurückkommen sofort
    if (s == AppLifecycleState.resumed) { _laden(); _taktStarten(); }
    else if (s == AppLifecycleState.paused || s == AppLifecycleState.hidden) { takt?.cancel(); takt = null; }
  }

  @override
  void dispose() { WidgetsBinding.instance.removeObserver(this); takt?.cancel(); super.dispose(); }

  Future<void> _laden() async {
    // 1.70.0 — getrennt: fällt eine Quelle aus, bleibt die andere sichtbar
    final erste = leben == null;
    await Future.wait([
      widget.server.json('/api/lebenszeichen').then((l) { if (mounted) setState(() { leben = l; fehlerLeben = null; stand = DateTime.now(); }); }, onError: (Object e) { if (mounted) setState(() => fehlerLeben = _kurz(e)); }),
      widget.server.json('/api/vorgaenge?limit=30').then((v) { if (mounted) setState(() { vorgaenge = v; fehlerVorgaenge = null; }); }, onError: (Object e) { if (mounted) setState(() => fehlerVorgaenge = _kurz(e)); }),
    ]);
    if (erste && leben != null) {
      final l = leben!;
      widget.aufHinweis?.call('Lage geladen: ${(((l['befunde'] as Map<String, dynamic>?)?['offen'] as List<dynamic>?) ?? []).length} Befunde, ${((vorgaenge?['offene'] as List<dynamic>?) ?? []).length} Vorgänge, ${((l['geraete'] as List<dynamic>?) ?? []).length} Geräte');
    }
  }

  static String _kurz(Object e) {
    final t = '$e'.replaceFirst('Exception: ', '');
    if (RegExp(r'SocketException|Connection|timed out|HandshakeException', caseSensitive: false).hasMatch(t)) return 'Server nicht erreichbar';
    return t.length > 90 ? '${t.substring(0, 90)}…' : t;
  }

  Future<void> _vorgang(Map<String, dynamic> v) async {
    final entschieden = await zeigeVorgang(context, v: v, schritte: vorgaenge?['schritte'] as List<dynamic>?, json: widget.server.json, aufMeldung: (t) => widget.aufMeldung?.call(t), aufNachfragen: widget.aufNachfragen);
    if (entschieden) await _laden();
  }

  void _zu(String k) { final c = _abschnitte[k]?.currentContext; if (c != null) Scrollable.ensureVisible(c, duration: const Duration(milliseconds: 300), alignment: 0.05); }

  Color _farbe(ThemeData t, Ampel a) => switch (a) { Ampel.ok => Colors.green, Ampel.warn => Colors.amber.shade700, Ampel.bad => t.colorScheme.error };

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    if (leben == null && fehlerLeben == null) return const Center(child: CircularProgressIndicator());
    final l = leben ?? {};
    final breit = MediaQuery.sizeOf(context).width >= 900;
    final links = <Widget>[_brauchtDich(theme), _lage(theme, l), _vorgaenge(theme)];
    final rechts = <Widget>[_befunde(theme, l), _geraete(theme, l), _kennzahlen(theme, l), _technik(theme, l)];
    return RefreshIndicator(
      onRefresh: _laden,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(12, 12, 12, 24),
        children: [
          if (fehlerLeben != null) _hinweis(theme, 'Lage: $fehlerLeben${leben != null ? ' — zeige den Stand von ${_zeit(stand!)}' : ''}'),
          if (leben != null) _aufEinenBlick(theme, l),
          const SizedBox(height: 12),
          if (breit) Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(child: Column(children: links)), const SizedBox(width: 12), Expanded(child: Column(children: rechts)),
          ]) else ...[...links, ...rechts],
        ],
      ),
    );
  }

  Widget _hinweis(ThemeData t, String text) => Padding(padding: const EdgeInsets.only(bottom: 8), child: Row(children: [
    Icon(Icons.cloud_off, size: 16, color: t.colorScheme.error), const SizedBox(width: 6),
    Expanded(child: Text(text, style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.error))),
  ]));

  // ── Auf einen Blick ───────────────────────────────────────────────────────────────────────────────────────────
  Widget _aufEinenBlick(ThemeData t, Map<String, dynamic> l) {
    final z = gesamtZustand(l);
    final geraete = ((l['geraete'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>().where((g) => g['status'] != 'widerrufen').toList();
    final online = geraete.where((g) => g['online'] == true).length;
    final puls = ((l['puls'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>().where((p) => p['tier'] != 'embeddings').toList();
    final gestoert = puls.where((p) => p['gestoertSeit'] != null).length;
    final kosten = l['kosten'] as Map<String, dynamic>?;
    final heute = (kosten?['heuteUsd'] as num?)?.toDouble();
    final budget = (kosten?['budgetUsd'] as num?)?.toDouble();
    final lageStand = (l['lage'] as Map<String, dynamic>?)?['stand'] as String?;
    final alt = lageStand != null && (DateTime.tryParse(lageStand) == null || DateTime.now().difference(DateTime.parse(lageStand)).inMinutes > 20);
    Widget chip(IconData i, String text, Ampel a, String ziel) => ActionChip(
      avatar: Icon(i, size: 16, color: _farbe(t, a)), label: Text(text), onPressed: () => _zu(ziel), visualDensity: VisualDensity.compact,
      side: BorderSide(color: _farbe(t, a).withValues(alpha: 0.4)), backgroundColor: _farbe(t, a).withValues(alpha: 0.08));
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Wrap(spacing: 8, runSpacing: 8, children: [
        chip(z.ampel == Ampel.ok ? Icons.check_circle : z.ampel == Ampel.warn ? Icons.info : Icons.error, z.text, z.ampel, z.ampel == Ampel.bad ? 'technik' : 'befunde'),
        chip(Icons.devices, 'Geräte $online/${geraete.length}', online == geraete.length ? Ampel.ok : Ampel.warn, 'geraete'),
        if (heute != null) chip(Icons.payments_outlined, budget != null ? 'Heute ${heute.toStringAsFixed(2)} \$ von ${budget.toStringAsFixed(0)} \$' : 'Heute ${heute.toStringAsFixed(2)} \$', budget != null && heute > budget ? Ampel.bad : budget != null && heute > budget * 0.8 ? Ampel.warn : Ampel.ok, 'kennzahlen'),
        chip(Icons.memory, gestoert > 0 ? '$gestoert Modell${gestoert == 1 ? '' : 'e'} gestört' : 'Modelle ok', gestoert > 0 ? Ampel.bad : Ampel.ok, 'technik'),
      ]),
      Padding(padding: const EdgeInsets.only(top: 6, left: 2), child: Text('Stand ${stand == null ? '—' : _zeit(stand!)}${lageStand != null ? ' · Lage ${vorZeit(lageStand)}' : ''}${alt ? ' · veraltet' : ''}',
        style: t.textTheme.labelSmall?.copyWith(color: alt ? Colors.amber.shade700 : t.colorScheme.onSurfaceVariant))),
    ]);
  }

  // ── Braucht dich ──────────────────────────────────────────────────────────────────────────────────────────────
  Widget _brauchtDich(ThemeData t) {
    final offene = ((vorgaenge?['offene'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>();
    final wartet = offene.where((v) => v['status'] == 'wartet' || v['besitzer'] == 'user').toList();
    if (wartet.isEmpty && widget.bestaetigungen == 0) return const SizedBox.shrink();
    return _abschnitt(t, 'braucht', 'Braucht dich', Icons.front_hand_outlined, akzent: Colors.amber.shade700, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (widget.bestaetigungen > 0) ListTile(dense: true, contentPadding: EdgeInsets.zero, leading: const Icon(Icons.notifications_active_outlined), title: Text('${widget.bestaetigungen} Bestätigung${widget.bestaetigungen == 1 ? '' : 'en'} offen'), trailing: const Icon(Icons.chevron_right), onTap: widget.aufEingang),
      for (final v in wartet.take(5)) _vorgangZeile(t, v),
    ]));
  }

  // ── Lage ──────────────────────────────────────────────────────────────────────────────────────────────────────
  Widget _lage(ThemeData t, Map<String, dynamic> l) {
    final zeilen = lageZeilen((l['lage'] as Map<String, dynamic>?)?['text'] as String? ?? '');
    final warum = ((l['warum'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>();
    final sicht = lageGanz ? zeilen : zeilen.take(3).toList();
    return _abschnitt(t, 'lage', 'Lage', Icons.radar, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (zeilen.isEmpty) const Text('Keine Lage.'),
      for (final z in sicht) Padding(padding: const EdgeInsets.only(bottom: 8), child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Padding(padding: const EdgeInsets.only(top: 2, right: 8), child: Icon(_lageSymbol(z.stichwort), size: 16, color: t.colorScheme.primary)),
        Expanded(child: Text.rich(TextSpan(children: [if (z.stichwort != null) TextSpan(text: '${z.stichwort}  ', style: const TextStyle(fontWeight: FontWeight.w700)), TextSpan(text: z.text)]), style: t.textTheme.bodySmall?.copyWith(height: 1.35))),
      ])),
      if (zeilen.length > 3) TextButton(onPressed: () => setState(() => lageGanz = !lageGanz), child: Text(lageGanz ? 'weniger' : 'mehr (${zeilen.length - 3})')),
      if (warum.isNotEmpty) Theme(data: t.copyWith(dividerColor: Colors.transparent), child: ExpansionTile(
        tilePadding: EdgeInsets.zero, childrenPadding: EdgeInsets.zero, dense: true,
        title: Text('Warum? — Begründungen der letzten Meldungen', style: t.textTheme.bodySmall?.copyWith(fontWeight: FontWeight.w600)),
        children: [for (final w in warum.take(6)) Padding(padding: const EdgeInsets.only(bottom: 8), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('${vorZeit(w['zeit'] as String?)} · ${w['art'] == 'vollpass' ? 'Vollpass' : w['art'] == 'minipass' ? 'Mini-Pass' : 'Ereignis'} · ${w['zustellung']}', style: t.textTheme.labelSmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
          Text('Auslöser: ${((w['ausloeser'] as List<dynamic>?) ?? []).isEmpty ? 'Vollpass nach Zeitablauf' : (w['ausloeser'] as List<dynamic>).join(' · ')}', style: t.textTheme.bodySmall),
          if (((w['insights'] as List<dynamic>?) ?? []).isNotEmpty) Text((w['insights'] as List<dynamic>).map((x) => '„$x“').join(', '), style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
        ]))],
      )),
    ]));
  }

  IconData _lageSymbol(String? s) {
    final k = (s ?? '').toLowerCase();
    if (k.contains('befund')) return Icons.report_problem_outlined;
    if (k.contains('vorgang') || k.contains('vorgäng')) return Icons.assignment_outlined;
    if (k.contains('regel')) return Icons.rule;
    if (k.contains('zugestellt') || k.contains('hinweis')) return Icons.mark_email_unread_outlined;
    if (k.contains('projekt')) return Icons.folder_outlined;
    if (k.contains('gerät') || k.contains('geraet')) return Icons.devices;
    if (k.contains('erledigt')) return Icons.task_alt;
    return Icons.circle_outlined;
  }

  // ── Vorgänge ──────────────────────────────────────────────────────────────────────────────────────────────────
  Widget _vorgaenge(ThemeData t) {
    final offene = ((vorgaenge?['offene'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>();
    return _abschnitt(t, null, 'Vorgänge (${offene.length})', Icons.assignment_outlined, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (fehlerVorgaenge != null) _hinweis(t, fehlerVorgaenge!),
      if (offene.isEmpty && fehlerVorgaenge == null) const Text('Keine offenen Vorgänge.'),
      for (final v in offene.take(8)) _vorgangZeile(t, v),
      if (offene.isNotEmpty) Align(alignment: Alignment.centerLeft, child: TextButton(onPressed: widget.aufVorgaenge, child: Text(offene.length > 8 ? 'Alle ${offene.length} anzeigen' : 'Alle anzeigen'))),
    ]));
  }

  Widget _vorgangZeile(ThemeData t, Map<String, dynamic> v) => InkWell(borderRadius: BorderRadius.circular(6), onTap: () => _vorgang(v), child: Padding(padding: const EdgeInsets.symmetric(vertical: 5, horizontal: 2), child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
    Expanded(child: Text('${v['titel'] ?? ''}', style: t.textTheme.bodySmall, maxLines: 2, overflow: TextOverflow.ellipsis)),
    const SizedBox(width: 8),
    _zustandChip(t, v),
  ])));

  // ── Befunde ───────────────────────────────────────────────────────────────────────────────────────────────────
  Widget _befunde(ThemeData t, Map<String, dynamic> l) {
    final b = l['befunde'] as Map<String, dynamic>?;
    final alle = ((b?['offen'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>();
    final erledigt = ((b?['erledigt24h'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>();
    final haus = alle.where((x) => x['quelle'] == 'haus-check').length;
    final rest = alle.where((x) => x['quelle'] != 'haus-check').toList();
    return _abschnitt(t, 'befunde', 'Befunde (${alle.length})', Icons.report_problem_outlined, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (alle.isEmpty) const Text('Keine offenen Befunde.'),
      if (haus > 0) InkWell(onTap: widget.aufBefunde == null ? null : () => widget.aufBefunde!('haus-check'), child: Padding(padding: const EdgeInsets.only(bottom: 6), child: Text('Haus-Check: $haus Punkte — öffnen', style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.primary)))),
      for (final x in rest.take(12)) InkWell(
        borderRadius: BorderRadius.circular(6),
        onTap: () async { if (await zeigeBefund(context, b: x, json: widget.server.json, aufMeldung: (m) => widget.aufMeldung?.call(m), aufNachfragen: widget.aufNachfragen, aufVorgaenge: widget.aufVorgaenge)) await _laden(); },
        child: Padding(padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 2), child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Container(margin: const EdgeInsets.only(top: 1, right: 6), padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1), decoration: BoxDecoration(color: t.colorScheme.secondaryContainer, borderRadius: BorderRadius.circular(6)), child: Text(befundQuelle('${x['quelle'] ?? '?'}'), style: t.textTheme.labelSmall?.copyWith(color: t.colorScheme.onSecondaryContainer))),
          Expanded(child: Text('${x['titel'] ?? ''}', style: t.textTheme.bodySmall, maxLines: 2, overflow: TextOverflow.ellipsis)),
          Text(vorZeit(x['zuletztGesehen'] as String?), style: t.textTheme.labelSmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
        ])),
      ),
      if (rest.length > 12) TextButton(onPressed: widget.aufBefunde == null ? null : () => widget.aufBefunde!(null), child: Text('Alle ${rest.length} anzeigen')),
      if (erledigt.isNotEmpty) Theme(data: t.copyWith(dividerColor: Colors.transparent), child: ExpansionTile(
        tilePadding: EdgeInsets.zero, dense: true,
        title: Text('Erledigt (24 h): ${erledigt.length}', style: t.textTheme.bodySmall?.copyWith(color: Colors.green.shade700, fontWeight: FontWeight.w600)),
        children: [for (final x in erledigt.take(15)) Align(alignment: Alignment.centerLeft, child: Padding(padding: const EdgeInsets.only(bottom: 4), child: Text('✓ ${x['titel'] ?? ''}', style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant), maxLines: 2, overflow: TextOverflow.ellipsis)))],
      )),
    ]));
  }

  // ── Geräte ────────────────────────────────────────────────────────────────────────────────────────────────────
  Widget _geraete(ThemeData t, Map<String, dynamic> l) {
    final geraete = ((l['geraete'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>().where((g) => g['status'] != 'widerrufen').toList()
      ..sort((a, b) => (b['online'] == true ? 1 : 0) - (a['online'] == true ? 1 : 0));
    final vorhaben = ((l['vorhaben'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>();
    return _abschnitt(t, 'geraete', 'Geräte (${geraete.where((g) => g['online'] == true).length}/${geraete.length} online)', Icons.devices, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      for (final g in geraete) _geraet(t, g),
      for (final v in vorhaben) Padding(padding: const EdgeInsets.only(top: 4), child: Text('▶ Vorhaben auf ${v['geraet']}: ${v['beschreibung']}', style: t.textTheme.bodySmall?.copyWith(color: Colors.amber.shade800))),
    ]));
  }

  Widget _geraet(ThemeData t, Map<String, dynamic> g) {
    final s = (g['sinne'] as Map<String, dynamic>?) ?? {};
    final online = g['online'] == true;
    final version = (g['manifest'] as Map<String, dynamic>?)?['version'] ?? (g['manifest'] as Map<String, dynamic>?)?['satellitVersion'];
    final plattform = '${g['plattform'] ?? ''}';
    final symbol = switch (plattform) { 'ios' || 'android' => Icons.phone_iphone, 'macos' => Icons.laptop_mac, 'linux' => Icons.terminal, _ => Icons.desktop_windows_outlined };
    final klein = <String>[
      if (s['akkuProzent'] is num) 'Akku ${s['akkuProzent']} %${s['akkuLaedt'] == true ? ' ⚡' : ''}',
      if (online && s['leerlaufSek'] is num) (s['leerlaufSek'] as num) < 300 ? 'aktiv' : 'Leerlauf ${((s['leerlaufSek'] as num) / 60).round()} min',
      if (s['cpuProzent'] is num) 'CPU ${s['cpuProzent']} %',
    ];
    final mehr = <String>[
      if (s['fenster'] is String && (s['fenster'] as String).isNotEmpty) 'Fenster: ${s['fenster']}',
      if (s['ramGesamtMb'] is num && s['ramFreiMb'] is num) 'RAM ${((s['ramFreiMb'] as num) / 1024).round()}/${((s['ramGesamtMb'] as num) / 1024).round()} GB frei',
      for (final lw in ((s['laufwerke'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>()) '${lw['name']}: ${lw['freiGb']}/${lw['gesamtGb']} GB frei',
      if (version != null) 'Version $version',
    ];
    final kopf = Row(children: [
      Icon(symbol, size: 18, color: online ? t.colorScheme.primary : t.colorScheme.outline),
      const SizedBox(width: 8),
      Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('${g['name']}', style: t.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
        Text(online ? (klein.isEmpty ? 'online' : klein.join(' · ')) : 'offline · zuletzt ${vorZeit(g['zuletztGesehen'] as String?)}', style: t.textTheme.labelSmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
      ])),
      Icon(Icons.circle, size: 9, color: online ? Colors.green : t.colorScheme.outline),
    ]);
    if (mehr.isEmpty) return Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: kopf);
    return Theme(data: t.copyWith(dividerColor: Colors.transparent), child: ExpansionTile(
      tilePadding: EdgeInsets.zero, dense: true, showTrailingIcon: false, title: kopf,
      childrenPadding: const EdgeInsets.only(left: 26, bottom: 6),
      children: [for (final m in mehr) Align(alignment: Alignment.centerLeft, child: Text(m, style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)))],
    ));
  }

  // ── Kennzahlen ────────────────────────────────────────────────────────────────────────────────────────────────
  Widget _kennzahlen(ThemeData t, Map<String, dynamic> l) {
    final heute = ((l['kennzahlen'] as Map<String, dynamic>?)?['werte'] as Map<String, dynamic>?) ?? {};
    final gestern = ((l['kennzahlenGestern'] as Map<String, dynamic>?)?['werte'] as Map<String, dynamic>?) ?? {};
    final kosten = l['kosten'] as Map<String, dynamic>?;
    if (heute.isEmpty && kosten == null) return const SizedBox.shrink();
    final groesster = kosten?['groessterPosten'] as Map<String, dynamic>?;
    Widget kachel(String name, num wert, num? vorher) {
      final pfeil = vorher == null || vorher == wert ? '' : wert > vorher ? ' ↑' : ' ↓';
      return Container(width: 150, padding: const EdgeInsets.all(8), decoration: BoxDecoration(color: t.colorScheme.surfaceContainerHighest.withValues(alpha: 0.5), borderRadius: BorderRadius.circular(10)), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('$wert$pfeil', style: t.textTheme.titleMedium),
        Text(name, style: t.textTheme.labelSmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
        if (vorher != null) Text('gestern $vorher', style: t.textTheme.labelSmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
      ]));
    }
    return _abschnitt(t, 'kennzahlen', 'Kennzahlen heute', Icons.insights, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (kosten != null) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text('Kosten heute ${((kosten['heuteUsd'] as num?) ?? 0).toStringAsFixed(2)} \$${kosten['budgetUsd'] is num ? ' von ${(kosten['budgetUsd'] as num).toStringAsFixed(0)} \$ Budget' : ''}${groesster != null ? ' · größter Posten ${groesster['model']} ${((groesster['usd'] as num?) ?? 0).toStringAsFixed(2)} \$' : ''}', style: t.textTheme.bodySmall)),
      Wrap(spacing: 8, runSpacing: 8, children: [
        for (final e in kennzahlNamen.entries) if (heute[e.key] is num) kachel(e.value, heute[e.key] as num, gestern[e.key] as num?),
      ]),
    ]));
  }

  // ── Technik (eingeklappt) ─────────────────────────────────────────────────────────────────────────────────────
  Widget _technik(ThemeData t, Map<String, dynamic> l) {
    final puls = ((l['puls'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>();
    final adapter = ((l['adapter'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>();
    final proben = (((l['proben'] as Map<String, dynamic>?)?['ergebnisse'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>();
    final waechter = ((l['offen'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>();
    final jobs = ((l['jobs'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>();
    final laeufe = ((l['letzteLaeufe'] as List<dynamic>?) ?? []).cast<Map<String, dynamic>>();
    final jobFehler = jobs.where((j) => (j['letzterLauf'] as Map<String, dynamic>?)?['ok'] == false).toList();
    final probenFehler = proben.where((p) => p['ok'] != true).toList();
    Text klein(String s, [Color? c]) => Text(s, style: t.textTheme.bodySmall?.copyWith(color: c));
    Widget titel(String s) => Padding(padding: const EdgeInsets.only(top: 10, bottom: 4), child: Text(s, style: t.textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w700)));
    return _abschnitt(t, 'technik', 'Technik', Icons.settings_suggest_outlined, child: Theme(data: t.copyWith(dividerColor: Colors.transparent), child: ExpansionTile(
      tilePadding: EdgeInsets.zero, dense: true, initiallyExpanded: waechter.isNotEmpty || puls.any((p) => p['gestoertSeit'] != null),
      title: klein('${puls.where((p) => pulsAmpel(p) == Ampel.ok).length}/${puls.length} Modelle ok · ${proben.length - probenFehler.length}/${proben.length} Proben ok · ${jobs.length - jobFehler.length}/${jobs.length} Jobs ok'),
      expandedCrossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (waechter.isNotEmpty) ...[titel('Wächter-Meldungen'), for (final w in waechter) klein('⚠ ${w['text']} (seit ${vorZeit(w['offenSeit'] as String?)})', t.colorScheme.error)],
        titel('Modelle'),
        for (final p in puls) Padding(padding: const EdgeInsets.only(bottom: 3), child: Row(children: [
          Icon(Icons.circle, size: 9, color: _farbe(t, pulsAmpel(p))), const SizedBox(width: 6),
          Expanded(child: klein('${p['tier']} · ${p['model']}${p['gestoertSeit'] != null ? ' · gestört ${vorZeit(p['gestoertSeit'] as String?)}' : ''}')),
          klein('${p['erfolge'] ?? 0}✓ ${p['fehler'] ?? 0}✗', t.colorScheme.onSurfaceVariant),
        ])),
        if (adapter.isNotEmpty) ...[titel('Kanäle'), klein(adapter.map((a) => '${a['platform']}: ${a['status']}').join(' · '))],
        if (proben.isNotEmpty) ...[titel('Proben ${vorZeit((l['proben'] as Map<String, dynamic>?)?['zeit'] as String?)}'), if (probenFehler.isEmpty) klein('alle ${proben.length} ok', Colors.green.shade700) else for (final p in probenFehler) klein('✗ ${p['name']}: ${p['detail']}', t.colorScheme.error)],
        if (jobFehler.isNotEmpty) ...[titel('Jobs mit Fehler'), for (final j in jobFehler) klein('✗ ${j['key']}: ${(j['letzterLauf'] as Map<String, dynamic>?)?['fehler'] ?? ''}', t.colorScheme.error)],
        if (laeufe.isNotEmpty) ...[titel('Letzte Läufe'), for (final r in laeufe.take(8)) klein('${r['ok'] == false ? '✗' : '✓'} ${r['jobKey']} · ${vorZeit(r['startedAt'] as String?)}', r['ok'] == false ? t.colorScheme.error : t.colorScheme.onSurfaceVariant)],
      ],
    )));
  }

  // ── Bausteine ─────────────────────────────────────────────────────────────────────────────────────────────────
  Widget _zustandChip(ThemeData t, Map<String, dynamic> v) {
    final (text, farbe) = v['status'] == 'wartet' ? ('wartet auf dich', Colors.amber.shade700) : v['besitzer'] == 'user' ? ('bei dir', t.colorScheme.primary) : ('bei Alfred', t.colorScheme.tertiary);
    return Container(padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 1), decoration: BoxDecoration(color: farbe.withValues(alpha: 0.14), borderRadius: BorderRadius.circular(10)),
        child: Text(text, style: t.textTheme.labelSmall?.copyWith(color: farbe, fontWeight: FontWeight.w600)));
  }

  Widget _abschnitt(ThemeData t, String? schluessel, String titel, IconData icon, {required Widget child, Color? akzent}) {
    return Card(
      key: schluessel == null ? null : _abschnitte[schluessel],
      margin: const EdgeInsets.only(bottom: 12),
      elevation: 0,
      color: t.colorScheme.surfaceContainerLow,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18), side: BorderSide(color: (akzent ?? t.colorScheme.outlineVariant).withValues(alpha: akzent == null ? 0.6 : 0.5))),
      child: Padding(padding: const EdgeInsets.fromLTRB(14, 12, 14, 10), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [Icon(icon, size: 18, color: akzent ?? t.colorScheme.primary), const SizedBox(width: 8), Expanded(child: Text(titel, style: t.textTheme.titleSmall))]),
        const SizedBox(height: 8),
        child,
      ])),
    );
  }

  static String _zeit(DateTime d) => '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
}
