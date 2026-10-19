/// 1.47.0 (v1506, D5) — Kontomenü unten links in der Navigation (Owner 19.10.): ersetzt die Satelliten-Zeile.
/// Kosten heute/Woche/Monat mit Herkunft, teuerstem Modell und Claude Code; Tagesbudget nur als Anzeige (keine Grenze,
/// keine Warnfarbe); kein Guthaben. Dazu Geräte, Einstellungen, Hilfe, Versionen und Update.
library;

import 'package:flutter/material.dart';

class KontoKosten {
  const KontoKosten({required this.heute, required this.woche, required this.monat, required this.claudeCodeMonat, this.tagesbudget, this.herkunftHeute = const [], this.hintergrundMonat = const [], this.teuerstesModell, this.teuerstesModellKosten});
  final double heute, woche, monat, claudeCodeMonat;
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
      claudeCodeMonat: _z((k['claudeCode'] as Map<String, dynamic>?)?['monat']),
      tagesbudget: k['tagesbudgetUsd'] is num ? (k['tagesbudgetUsd'] as num).toDouble() : null,
      herkunftHeute: [for (final h in (k['herkunftHeute'] as List? ?? const [])) ('${(h as Map)['herkunft']}', _z(h['kosten']))],
      hintergrundMonat: [for (final h in (k['hintergrundMonat'] as List? ?? const [])) ('${(h as Map)['job']}', _z(h['kosten']))],
      teuerstesModell: tm?['modell'] as String?, teuerstesModellKosten: tm == null ? null : _z(tm['kosten']),
    );
  }
}

/// „3,12 $“ — zwei Nachkommastellen, unter einem Cent „< 0,01 $“.
String kostenText(double v) => v > 0 && v < 0.005 ? '< 0,01 \$' : '${v.toStringAsFixed(2).replaceAll('.', ',')} \$';

const herkunftNamen = {'chat': 'Chat', 'hintergrund': 'Hintergrund', 'aufgabe': 'Geplante Aufgaben', 'claude-code': 'Claude Code', 'sonstiges': 'Sonstiges'};

class KontoMenue extends StatelessWidget {
  const KontoMenue({super.key, required this.geraet, required this.verbunden, required this.versionen, this.kosten, this.fehler, this.geraete = const [], required this.aufEinstellungen, required this.aufBefehle, required this.aufKuerzel, required this.updateText, required this.aufUpdate});
  final String geraet;
  final bool verbunden;
  /// z. B. „App 1.47.0 · Satellit … · Alfred …“
  final String versionen;
  final KontoKosten? kosten;
  final String? fehler;
  final List<String> geraete;
  final VoidCallback aufEinstellungen, aufBefehle, aufKuerzel, aufUpdate;
  final String updateText;

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
    final k = kosten;
    return Material(key: const Key('konto-menue'), elevation: 8, color: cs.surfaceContainerHigh, borderRadius: BorderRadius.circular(14), child: SizedBox(width: 340, child: SingleChildScrollView(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
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
        if (k.tagesbudget != null) Padding(padding: const EdgeInsets.fromLTRB(16, 10, 16, 0), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Tagesbudget: ${kostenText(k.heute)} von ${kostenText(k.tagesbudget!)}', key: const Key('konto-budget'), style: klein),
          const SizedBox(height: 4),
          // nur Anzeige: gleiche Farbe auch über dem Budget (keine Grenze, keine Warnung)
          ClipRRect(borderRadius: BorderRadius.circular(2), child: LinearProgressIndicator(value: (k.heute / k.tagesbudget!).clamp(0.0, 1.0), minHeight: 4, color: cs.primary, backgroundColor: cs.surfaceContainerHighest)),
        ])),
        if (k.herkunftHeute.isNotEmpty) ...[
          Padding(padding: const EdgeInsets.fromLTRB(16, 12, 16, 2), child: Text('Heute nach Herkunft', style: klein)),
          for (final (h, v) in k.herkunftHeute) Padding(padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 2), child: Row(children: [
            Expanded(child: Text(herkunftNamen[h] ?? h, style: theme.textTheme.bodySmall)),
            Text(kostenText(v), style: theme.textTheme.bodySmall),
          ])),
        ],
        Padding(padding: const EdgeInsets.fromLTRB(16, 10, 16, 0), child: Text([
          if (k.teuerstesModell != null) 'Teuerstes Modell im Monat: ${k.teuerstesModell} (${kostenText(k.teuerstesModellKosten ?? 0)})',
          'Claude Code im Monat: ${kostenText(k.claudeCodeMonat)}',
          if (k.hintergrundMonat.isNotEmpty) 'Teuerste Hintergrund-Jobs: ${k.hintergrundMonat.take(3).map((j) => '${j.$1} ${kostenText(j.$2)}').join(', ')}',
        ].join('\n'), style: klein)),
      ],
      const Divider(height: 20),
      if (geraete.isNotEmpty) ...[
        titel('Verbundene Geräte'),
        for (final g in geraete) Padding(padding: const EdgeInsets.fromLTRB(16, 2, 16, 2), child: Row(children: [const Icon(Icons.circle, size: 7, color: Colors.green), const SizedBox(width: 8), Expanded(child: Text(g, style: theme.textTheme.bodySmall, overflow: TextOverflow.ellipsis))])),
        const Divider(height: 20),
      ],
      punkt(Icons.settings_outlined, 'Einstellungen', aufEinstellungen, kuerzel: 'Strg+,', key: const Key('konto-einstellungen')),
      punkt(Icons.keyboard_command_key, 'Befehle', aufBefehle, kuerzel: 'Strg+K'),
      punkt(Icons.help_outline, 'Hilfe: Tastenkürzel', aufKuerzel),
      punkt(Icons.system_update_alt, updateText, aufUpdate, key: const Key('konto-update')),
      const SizedBox(height: 6),
    ]))));
  }
}
