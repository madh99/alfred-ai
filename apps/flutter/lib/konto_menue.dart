/// 1.47.0 (v1506, D5) — Kontomenü unten links in der Navigation (Owner 19.10.): ersetzt die Satelliten-Zeile.
/// Kosten heute/Woche/Monat mit Herkunft, teuerstem Modell und Code-Agenten; Tagesbudget nur als Anzeige (keine Grenze,
/// keine Warnfarbe); kein Guthaben. Dazu Geräte, Einstellungen, Hilfe, Versionen und Update.
/// 1.48.0 (v1508) — Code-Agenten getrennt (Claude Code, Codex, Mistral Vibe); Geräte je Eintrag aufklappbar mit Details.
/// 1.49.0 (v1509) — „Läuft gerade“ je Gerät: Projekt mit Etappe, Beginn und Kosten bisher; einzelne Claude-Code-Aufträge.
/// 1.49.1 — Owner 19.10.: Code-Agenten laufen über ihre CLIs, nicht über die API. Sie zählen zu Heute/Woche/Monat, aber
/// nicht zum Tagesbudget; „Heute nach Herkunft“ zeigt nur API-Kosten, die Agenten stehen in ihrem eigenen Block.
library;

import 'package:flutter/material.dart';

class KontoKosten {
  const KontoKosten({required this.heute, required this.woche, required this.monat, this.apiHeute, this.agenten = const [], this.tagesbudget, this.herkunftHeute = const [], this.hintergrundMonat = const [], this.teuerstesModell, this.teuerstesModellKosten});
  final double heute, woche, monat;
  /// API-Kosten heute (ohne Code-Agenten) — Grundlage des Tagesbudgets; null bei älterem Server
  final double? apiHeute;
  /// (Agent, heute, Monat)
  final List<(String, double, double)> agenten;
  final double? tagesbudget;
  final List<(String, double)> herkunftHeute;
  final List<(String, double)> hintergrundMonat;
  final String? teuerstesModell;
  final double? teuerstesModellKosten;

  static double _z(Object? v) => v is num ? v.toDouble() : 0;

  /// Antwort von `/api/geraete/konto` (Feld `kosten`).
  static KontoKosten aus(Map<String, dynamic> k) {
    final tm = k['teuerstesModell'] as Map<String, dynamic>?;
    return KontoKosten(
      heute: _z(k['heute']), woche: _z(k['woche']), monat: _z(k['monat']),
      apiHeute: (k['llm'] as Map<String, dynamic>?)?['heute'] is num ? ((k['llm'] as Map<String, dynamic>)['heute'] as num).toDouble() : null,
      agenten: [for (final a in (k['agenten'] as List? ?? const [])) ('${(a as Map)['agent']}', _z(a['heute']), _z(a['monat']))],
      tagesbudget: k['tagesbudgetUsd'] is num ? (k['tagesbudgetUsd'] as num).toDouble() : null,
      herkunftHeute: [for (final h in (k['herkunftHeute'] as List? ?? const [])) ('${(h as Map)['herkunft']}', _z(h['kosten']))],
      hintergrundMonat: [for (final h in (k['hintergrundMonat'] as List? ?? const [])) ('${(h as Map)['job']}', _z(h['kosten']))],
      teuerstesModell: tm?['modell'] as String?, teuerstesModellKosten: tm == null ? null : _z(tm['kosten']),
    );
  }
}

/// v1509 — ein laufender Claude-Code-Lauf auf einem Gerät (Projekt-Etappe, Auftrag oder Frage zum Projekt).
class KontoLauf {
  const KontoLauf({required this.art, required this.titel, this.akteId, this.etappe, this.etappen, this.fix, this.seit, this.kostenBisher, this.schritt});
  final String art, titel;
  final String? akteId, schritt;
  final int? etappe, etappen, fix;
  final DateTime? seit;
  final double? kostenBisher;

  static KontoLauf aus(Map<String, dynamic> l) => KontoLauf(
    art: '${l['art'] ?? 'auftrag'}', titel: '${l['titel'] ?? 'Claude-Code-Auftrag'}', akteId: l['akteId'] as String?,
    etappe: (l['etappe'] as num?)?.toInt(), etappen: (l['etappen'] as num?)?.toInt(), fix: (l['fix'] as num?)?.toInt(),
    seit: l['seit'] is String ? DateTime.tryParse(l['seit'] as String)?.toLocal() : null,
    kostenBisher: l['kostenBisher'] is num ? (l['kostenBisher'] as num).toDouble() : null, schritt: l['schritt'] as String?,
  );

  /// „Projekt Finanz-Backend · Etappe 6/8 seit 12:51“
  String get zeile {
    final uhr = seit == null ? '' : ' seit ${seit!.hour.toString().padLeft(2, '0')}:${seit!.minute.toString().padLeft(2, '0')}';
    return switch (art) {
      'projekt' => 'Projekt $titel · Etappe ${etappe ?? '?'}/${etappen ?? '?'}${fix != null ? ' (Fix $fix)' : ''}$uhr',
      'frage' => 'Frage zum Projekt $titel$uhr',
      _ => '$titel$uhr',
    };
  }
}

/// Gekoppeltes Gerät mit Details (v1508, `geraete` aus `/api/geraete/konto`).
class KontoGeraet {
  const KontoGeraet({required this.name, required this.plattform, required this.online, this.hostname, this.satellitVersion, this.verbundenSeit, this.zuletztGesehen, this.gekoppelt, this.rechte = const [], this.aktionen = 0, this.sinne = const [], this.claudeCodeMonat = 0, this.laeuft = const []});
  final String name, plattform;
  final bool online;
  final String? hostname, satellitVersion;
  final DateTime? verbundenSeit, zuletztGesehen, gekoppelt;
  final List<String> rechte, sinne;
  final int aktionen;
  final double claudeCodeMonat;
  final List<KontoLauf> laeuft;

  static KontoGeraet aus(Map<String, dynamic> g) {
    DateTime? zeit(Object? v) => v is String ? DateTime.tryParse(v)?.toLocal() : null;
    return KontoGeraet(
      name: '${g['name'] ?? '?'}', plattform: '${g['plattform'] ?? ''}', online: g['online'] == true,
      hostname: g['hostname'] as String?, satellitVersion: g['satellitVersion'] as String?,
      verbundenSeit: zeit(g['verbundenSeit']), zuletztGesehen: zeit(g['zuletztGesehen']), gekoppelt: zeit(g['gekoppelt']),
      rechte: [for (final r in (g['rechte'] as List? ?? const [])) '$r'], sinne: [for (final s in (g['sinne'] as List? ?? const [])) '$s'],
      aktionen: (g['aktionen'] as num?)?.toInt() ?? 0, claudeCodeMonat: KontoKosten._z(g['claudeCodeMonat']),
      laeuft: [for (final l in (g['laeuft'] as List? ?? const [])) KontoLauf.aus(l as Map<String, dynamic>)],
    );
  }
}

/// „3,12 $“ — zwei Nachkommastellen, unter einem Cent „< 0,01 $“.
String kostenText(double v) => v > 0 && v < 0.005 ? '< 0,01 \$' : '${v.toStringAsFixed(2).replaceAll('.', ',')} \$';

const agentNamen = {'claude-code': 'Claude Code', 'codex': 'Codex', 'mistral-vibe': 'Mistral Vibe'};
String agentName(String a) => agentNamen[a] ?? a;
String herkunftName(String h) => h.startsWith('agent:') ? agentName(h.substring(6))
    : const {'chat': 'Chat', 'hintergrund': 'Hintergrund', 'aufgabe': 'Geplante Aufgaben', 'claude-code': 'Claude Code', 'sonstiges': 'Sonstiges'}[h] ?? h;

String _zeitText(DateTime? t) {
  if (t == null) return '–';
  final z = '${t.day}.${t.month}.${t.year}, ${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
  return z;
}

const _plattformNamen = {'windows': 'Windows', 'macos': 'macOS', 'linux': 'Linux'};

class KontoMenue extends StatelessWidget {
  const KontoMenue({super.key, required this.geraet, required this.verbunden, required this.versionen, this.kosten, this.fehler, this.geraete = const [], required this.aufEinstellungen, required this.aufBefehle, required this.aufKuerzel, required this.updateText, required this.aufUpdate, this.aufProjekt});
  final String geraet;
  final bool verbunden;
  /// z. B. „App 1.48.0 · Satellit … · Alfred …“
  final String versionen;
  final KontoKosten? kosten;
  final String? fehler;
  final List<KontoGeraet> geraete;
  final VoidCallback aufEinstellungen, aufBefehle, aufKuerzel, aufUpdate;
  final String updateText;
  /// v1509 — Klick auf ein laufendes Projekt: Projektansicht (Kennung der Akte, falls bekannt)
  final void Function(String? akteId)? aufProjekt;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final dim = cs.onSurfaceVariant;
    final klein = theme.textTheme.bodySmall?.copyWith(color: dim);
    Widget titel(String t) => Padding(padding: const EdgeInsets.fromLTRB(16, 12, 16, 6), child: Text(t.toUpperCase(), style: theme.textTheme.labelSmall?.copyWith(color: dim, letterSpacing: 0.8, fontWeight: FontWeight.w600)));
    Widget punkt(IconData i, String t, VoidCallback auf, {String? kuerzel, Key? key}) => InkWell(key: key, onTap: auf, child: Padding(padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9), child: Row(children: [
      Icon(i, size: 18, color: dim), const SizedBox(width: 12), Expanded(child: Text(t)), if (kuerzel != null) Text(kuerzel, style: klein),
    ])));
    Widget zeile(String l, String r, {TextStyle? stil}) => Padding(padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 2), child: Row(children: [
      Expanded(child: Text(l, style: stil ?? theme.textTheme.bodySmall)), Text(r, style: stil ?? theme.textTheme.bodySmall),
    ]));
    final k = kosten;
    return Material(key: const Key('konto-menue'), elevation: 8, color: cs.surfaceContainerHigh, borderRadius: BorderRadius.circular(14), clipBehavior: Clip.antiAlias, child: SizedBox(width: 360, child: SingleChildScrollView(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
      Padding(padding: const EdgeInsets.fromLTRB(16, 14, 16, 4), child: Row(children: [
        Icon(Icons.circle, size: 10, color: verbunden ? Colors.green : cs.error),
        const SizedBox(width: 8),
        Expanded(child: Text(geraet, style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600), overflow: TextOverflow.ellipsis)),
      ])),
      Padding(padding: const EdgeInsets.fromLTRB(34, 0, 16, 4), child: Text(versionen, style: klein)),
      const Divider(height: 16),
      titel('Kosten'),
      if (k == null) Padding(padding: const EdgeInsets.fromLTRB(16, 0, 16, 8), child: Text(fehler ?? 'wird geladen …', style: klein))
      else ...[
        Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: Row(children: [
          for (final (n, v) in [('Heute', k.heute), ('Woche', k.woche), ('Monat', k.monat)]) Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(n, style: klein),
            Text(kostenText(v), key: Key('konto-$n'), style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
          ])),
        ])),
        if (k.apiHeute != null) Padding(padding: const EdgeInsets.fromLTRB(16, 4, 16, 0), child: Text('Heute: API ${kostenText(k.apiHeute!)} · Code-Agenten ${kostenText((k.heute - k.apiHeute!).clamp(0, double.infinity).toDouble())}', key: const Key('konto-aufteilung'), style: klein)),
        // nur API-Kosten zählen zum Tagesbudget (Code-Agenten laufen über ihre CLIs)
        if (k.tagesbudget != null) Padding(padding: const EdgeInsets.fromLTRB(16, 10, 16, 0), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('API-Tagesbudget: ${kostenText(k.apiHeute ?? k.heute)} von ${kostenText(k.tagesbudget!)}', key: const Key('konto-budget'), style: klein),
          const SizedBox(height: 4),
          // nur Anzeige: gleiche Farbe auch über dem Budget (keine Grenze, keine Warnung)
          ClipRRect(borderRadius: BorderRadius.circular(2), child: LinearProgressIndicator(value: ((k.apiHeute ?? k.heute) / k.tagesbudget!).clamp(0.0, 1.0), minHeight: 4, color: cs.primary, backgroundColor: cs.surfaceContainerHighest)),
        ])),
        if (k.herkunftHeute.any((h) => !h.$1.startsWith('agent:'))) ...[
          Padding(padding: const EdgeInsets.fromLTRB(16, 12, 16, 2), child: Text('API heute nach Herkunft', style: klein)),
          for (final (h, v) in k.herkunftHeute.where((h) => !h.$1.startsWith('agent:'))) zeile(herkunftName(h), kostenText(v)),
        ],
        if (k.agenten.isNotEmpty) ...[
          Padding(padding: const EdgeInsets.fromLTRB(16, 12, 16, 2), child: Row(children: [
            Expanded(child: Text('Code-Agenten (CLI, nicht im API-Budget)', style: klein)), SizedBox(width: 70, child: Text('heute', textAlign: TextAlign.right, style: klein)), SizedBox(width: 70, child: Text('Monat', textAlign: TextAlign.right, style: klein)),
          ])),
          for (final (a, h, m) in k.agenten) Padding(key: Key('konto-agent-$a'), padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 2), child: Row(children: [
            Expanded(child: Text(agentName(a), style: theme.textTheme.bodySmall)),
            SizedBox(width: 70, child: Text(kostenText(h), textAlign: TextAlign.right, style: theme.textTheme.bodySmall)),
            SizedBox(width: 70, child: Text(kostenText(m), textAlign: TextAlign.right, style: theme.textTheme.bodySmall)),
          ])),
        ],
        Padding(padding: const EdgeInsets.fromLTRB(16, 10, 16, 0), child: Text([
          if (k.teuerstesModell != null) 'Teuerstes Modell im Monat: ${k.teuerstesModell} (${kostenText(k.teuerstesModellKosten ?? 0)})',
          if (k.hintergrundMonat.isNotEmpty) 'Teuerste Hintergrund-Jobs: ${k.hintergrundMonat.take(3).map((j) => '${j.$1} ${kostenText(j.$2)}').join(', ')}',
        ].join('\n'), style: klein)),
      ],
      const Divider(height: 20),
      if (geraete.isNotEmpty) ...[
        titel('Geräte'),
        for (final g in geraete) _geraet(theme, g),
        const Divider(height: 20),
      ],
      punkt(Icons.settings_outlined, 'Einstellungen', aufEinstellungen, kuerzel: 'Strg+,', key: const Key('konto-einstellungen')),
      punkt(Icons.keyboard_command_key, 'Befehle', aufBefehle, kuerzel: 'Strg+K'),
      punkt(Icons.help_outline, 'Hilfe: Tastenkürzel', aufKuerzel),
      punkt(Icons.system_update_alt, updateText, aufUpdate, key: const Key('konto-update')),
      const SizedBox(height: 6),
    ]))));
  }

  /// 1.48.0 — ein Gerät, aufklappbar: Status, Hostname, Satellit, Zeiten, Fähigkeiten, Rechte, Claude Code im Monat.
  Widget _geraet(ThemeData theme, KontoGeraet g) {
    final cs = theme.colorScheme;
    final klein = theme.textTheme.bodySmall?.copyWith(color: cs.onSurfaceVariant);
    Widget detail(String l, String r) => Padding(padding: const EdgeInsets.symmetric(vertical: 1.5), child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
      SizedBox(width: 110, child: Text(l, style: klein)), Expanded(child: Text(r, style: theme.textTheme.bodySmall)),
    ]));
    return Theme(data: theme.copyWith(dividerColor: Colors.transparent), child: ExpansionTile(
      key: Key('konto-geraet-${g.name}'),
      dense: true, visualDensity: VisualDensity.compact,
      tilePadding: const EdgeInsets.symmetric(horizontal: 16), childrenPadding: const EdgeInsets.fromLTRB(34, 0, 16, 8),
      leading: Icon(Icons.circle, size: 9, color: g.online ? Colors.green : cs.outline),
      title: Text(g.name, style: theme.textTheme.bodyMedium, overflow: TextOverflow.ellipsis),
      subtitle: Text('${_plattformNamen[g.plattform] ?? g.plattform} · ${g.online ? 'verbunden' : 'offline'}${g.laeuft.isEmpty ? '' : ' · ${g.laeuft.length == 1 ? 'Claude Code läuft' : '${g.laeuft.length} Läufe'}'}', style: klein),
      expandedCrossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // v1509 — laufende Claude-Code-Läufe zuerst (Kosten eines Laufs kommen erst mit seinem Ende)
        for (final l in g.laeuft) Padding(padding: const EdgeInsets.only(bottom: 6), child: Material(color: cs.secondaryContainer.withValues(alpha: 0.5), borderRadius: BorderRadius.circular(8), child: InkWell(
          key: Key('konto-lauf-${g.name}-${l.titel}'), borderRadius: BorderRadius.circular(8),
          onTap: l.art == 'auftrag' || aufProjekt == null ? null : () => aufProjekt!(l.akteId),
          child: Padding(padding: const EdgeInsets.fromLTRB(8, 6, 8, 6), child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Padding(padding: const EdgeInsets.only(top: 2), child: SizedBox(width: 12, height: 12, child: CircularProgressIndicator(strokeWidth: 1.6, color: cs.primary))),
            const SizedBox(width: 8),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(l.zeile, style: theme.textTheme.bodySmall?.copyWith(fontWeight: FontWeight.w600)),
              if (l.schritt != null) Text(l.schritt!, maxLines: 1, overflow: TextOverflow.ellipsis, style: klein),
              if (l.kostenBisher != null) Text('Projekt bisher ${kostenText(l.kostenBisher!)} · laufende Etappe wird am Ende verbucht', style: klein),
            ])),
          ])),
        ))),
        if (g.hostname != null) detail('Hostname', g.hostname!),
        if (g.satellitVersion != null) detail('Satellit', g.satellitVersion!),
        g.online ? detail('Verbunden seit', _zeitText(g.verbundenSeit)) : detail('Zuletzt gesehen', _zeitText(g.zuletztGesehen)),
        detail('Gekoppelt', _zeitText(g.gekoppelt)),
        detail('Fähigkeiten', '${g.aktionen} Aktionen${g.sinne.isEmpty ? '' : ' · Sinne: ${g.sinne.join(', ')}'}'),
        if (g.rechte.isNotEmpty) detail('Rechte', g.rechte.join(', ')),
        detail('Claude Code (Monat)', kostenText(g.claudeCodeMonat)),
      ],
    ));
  }
}
