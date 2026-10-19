/// 1.46.0 (v1505) — eigene Anhänge im Verlauf wie im Vorbild (Owner 19.10.): statt der Upload-Zeilen
/// („Datei „…" (… Bytes, SHA-256 …) liegt in deinem Dateispeicher, Schlüssel: …") eine Reihe Vorschaubilder über der Blase,
/// andere Dateien als Kärtchen mit Name und Größe; „Bestätige kurz den Empfang." wird nicht angezeigt.
/// Die Nachricht an Alfred bleibt unverändert (er braucht die Schlüssel), nur die Anzeige ändert sich.
library;

import 'dart:io';

import 'package:flutter/material.dart';

import 'modell.dart';

class UploadVerweis {
  const UploadVerweis({required this.name, this.key, this.groesse, this.pfad});
  final String name;
  /// Schlüssel im Dateispeicher des Servers (aus dem Verlauf)
  final String? key;
  final int? groesse;
  /// lokale Datei (gerade gesendet, noch vor dem Neuladen des Verlaufs)
  final String? pfad;
  bool get istBild => istBildName(name);
}

bool istBildName(String name) => RegExp(r'\.(png|jpe?g|gif|webp)$', caseSensitive: false).hasMatch(name);

/// App: `„name"` mit Größe und SHA-256; Web: `„name“` nur mit Größe; ältere Zeilen ohne Größe.
final _uploadZeile = RegExp(r'^Datei „(.+?)["“”](?: \((\d+) Bytes(?:, SHA-256 [0-9a-f]+)?\))? liegt in deinem Dateispeicher, Schlüssel: (\S.*)\.$'); // Schlüssel darf Leerzeichen enthalten (FileStore behält sie)
const _bestaetigen = 'Bestätige kurz den Empfang.';

/// Trennt die Upload-Zeilen vom eigentlichen Text. Ohne Upload-Zeilen bleibt der Text unverändert.
({String text, List<UploadVerweis> dateien}) uploadZeilenTrennen(String text) {
  if (!text.contains('liegt in deinem Dateispeicher')) return (text: text, dateien: const []);
  final dateien = <UploadVerweis>[];
  final rest = <String>[];
  for (final z in text.split('\n')) {
    final m = _uploadZeile.firstMatch(z.trim());
    if (m == null) { rest.add(z); continue; }
    dateien.add(UploadVerweis(name: m.group(1)!, groesse: m.group(2) == null ? null : int.tryParse(m.group(2)!), key: m.group(3)));
  }
  if (dateien.isEmpty) return (text: text, dateien: const []);
  return (text: rest.where((z) => z.trim() != _bestaetigen).join('\n').trim(), dateien: dateien);
}

/// Kurzform für Listen (Verlaufsleiste): Text, sonst „📎 Namen".
String uploadKurztext(String text, {List<String> lokaleDateien = const []}) {
  final u = uploadZeilenTrennen(text);
  if (u.text.isNotEmpty) return u.text;
  final namen = [...u.dateien.map((d) => d.name), ...lokaleDateien.map((p) => File(p).uri.pathSegments.last)];
  return namen.isEmpty ? '' : '📎 ${namen.join(', ')}';
}

String _groesse(int b) => b < 1024 ? '$b B' : b < 1024 * 1024 ? '${(b / 1024).toStringAsFixed(0)} KB' : '${(b / 1024 / 1024).toStringAsFixed(1)} MB';

/// Reihe der Vorschaubilder/Kärtchen (rechtsbündig über der eigenen Blase). [laden] holt den Inhalt (Server oder lokal).
class UploadVorschau extends StatelessWidget {
  const UploadVorschau({super.key, required this.dateien, required this.laden, required this.aufOeffnen});
  final List<UploadVerweis> dateien;
  final Future<Anhang?> Function(UploadVerweis d) laden;
  final void Function(Anhang a) aufOeffnen;

  static const kante = 104.0;

  @override
  Widget build(BuildContext context) {
    return Wrap(alignment: WrapAlignment.end, spacing: 8, runSpacing: 8, children: [for (final d in dateien) d.istBild ? _bild(context, d) : _datei(context, d)]);
  }

  Future<void> _oeffne(UploadVerweis d) async { final a = await laden(d); if (a != null) aufOeffnen(a); }

  Widget _bild(BuildContext context, UploadVerweis d) {
    final theme = Theme.of(context);
    final ersatz = Container(width: kante, height: kante, color: theme.colorScheme.surfaceContainerHighest, child: Icon(Icons.image_outlined, color: theme.colorScheme.onSurfaceVariant));
    final Widget bild = d.pfad != null
        ? Image.file(File(d.pfad!), width: kante, height: kante, fit: BoxFit.cover, cacheWidth: 240, errorBuilder: (_, _, _) => ersatz)
        : FutureBuilder<Anhang?>(future: laden(d), builder: (_, s) => s.data == null ? ersatz : Image.memory(s.data!.daten, width: kante, height: kante, fit: BoxFit.cover, cacheWidth: 240, gaplessPlayback: true, errorBuilder: (_, _, _) => ersatz));
    return Tooltip(message: d.name, child: MouseRegion(cursor: SystemMouseCursors.click, child: GestureDetector(
      key: Key('upload-bild-${d.name}'),
      onTap: () => _oeffne(d),
      child: ClipRRect(borderRadius: BorderRadius.circular(10), child: bild),
    )));
  }

  Widget _datei(BuildContext context, UploadVerweis d) {
    final theme = Theme.of(context);
    return Material(key: Key('upload-datei-${d.name}'), color: theme.colorScheme.surfaceContainerHigh, borderRadius: BorderRadius.circular(10), child: InkWell(
      borderRadius: BorderRadius.circular(10), onTap: () => _oeffne(d),
      child: Container(constraints: const BoxConstraints(maxWidth: 260), padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8), child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(Icons.insert_drive_file_outlined, size: 20, color: theme.colorScheme.primary),
        const SizedBox(width: 8),
        Flexible(child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
          Text(d.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall?.copyWith(fontWeight: FontWeight.w600)),
          if (d.groesse != null) Text(_groesse(d.groesse!), style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
        ])),
      ])),
    ));
  }
}
