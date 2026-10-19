/// 1.50.0 (v1510, D6a/D6b) — Aktionen unter einer Antwort und Stufen-Anzeige (App-Spec §11.3, Owner-Freigabe 19.10.).
/// Reine Funktionen (getestet): Klartext aus Markdown, Frage zu einer Antwort, Stufen-Infos vom Server.
library;

import 'modell.dart';
import 'upload_vorschau.dart';

/// Klartext für „Kopieren“: Markdown-Zeichen weg, Links als „Text (Adresse)“, Code-Zäune entfernt, Inhalt bleibt.
String ohneMarkdown(String md) {
  var t = md.replaceAll('\r\n', '\n');
  t = t.replaceAll(RegExp(r'^```[^\n]*\n?', multiLine: true), '');
  t = t.replaceAllMapped(RegExp(r'!\[([^\]]*)\]\(([^)\s]+)\)'), (m) => m[1]!.isEmpty ? m[2]! : '${m[1]} (${m[2]})');
  t = t.replaceAllMapped(RegExp(r'\[([^\]]+)\]\(([^)\s]+)\)'), (m) => m[1] == m[2] ? m[1]! : '${m[1]} (${m[2]})');
  t = t.replaceAll(RegExp(r'^#{1,6}\s+', multiLine: true), '');
  t = t.replaceAll(RegExp(r'^>\s?', multiLine: true), '');
  t = t.replaceAllMapped(RegExp(r'(\*\*|__)(.+?)\1'), (m) => m[2]!);
  t = t.replaceAllMapped(RegExp(r'(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])'), (m) => m[1]!);
  t = t.replaceAllMapped(RegExp(r'`([^`\n]+)`'), (m) => m[1]!);
  // [ \t] statt \s: \s würde den Zeilenumbruch davor mitnehmen
  t = t.replaceAll(RegExp(r'^[ \t]*[-*+][ \t]+', multiLine: true), '• ');
  t = t.replaceAll(RegExp(r'^[ \t]*(-{3,}|\*{3,})[ \t]*$', multiLine: true), '');
  return t.replaceAll(RegExp(r'\n{3,}'), '\n\n').trim();
}

/// Eigene Frage vor der Antwort [i] (Kurzform ohne Upload-Zeilen), leer wenn keine.
String frageVor(List<Eintrag> verlauf, int i) {
  for (var j = i - 1; j >= 0; j--) {
    if (verlauf[j].art == Art.du) return uploadKurztext(verlauf[j].text, lokaleDateien: verlauf[j].lokaleDateien);
  }
  return '';
}

/// Erste Zeile einer Antwort als Aufgabentitel (ohne Markdown, höchstens 120 Zeichen).
String aufgabenTitel(String antwort) {
  final z = ohneMarkdown(antwort).split('\n').map((s) => s.replaceFirst(RegExp(r'^•\s*'), '').trim()).firstWhere((s) => s.isNotEmpty, orElse: () => '');
  return z.length > 120 ? '${z.substring(0, 119)}…' : z;
}

class StufeInfo {
  const StufeInfo({required this.stufe, required this.modell, this.gruendlichkeit, this.verfuegbar = true});
  final String stufe, modell;
  final String? gruendlichkeit;
  final bool verfuegbar;
}

class StufenStand {
  const StufenStand({this.stufen = const {}, this.automatisch = 'default', this.zuletztModell, this.zuletztStufe, this.zuletztZeit});
  final Map<String, StufeInfo> stufen;
  final String automatisch;
  final String? zuletztModell, zuletztStufe;
  final DateTime? zuletztZeit;

  /// Antwort von `/api/geraete/stufen`.
  static StufenStand aus(Map<String, dynamic> j) {
    final z = j['zuletzt'] as Map<String, dynamic>?;
    return StufenStand(
      stufen: {for (final s in (j['stufen'] as List? ?? const [])) '${(s as Map)['stufe']}': StufeInfo(stufe: '${s['stufe']}', modell: '${s['modell']}', gruendlichkeit: s['gruendlichkeit'] as String?, verfuegbar: s['verfuegbar'] != false)},
      automatisch: '${j['automatisch'] ?? 'default'}',
      zuletztModell: z?['modell'] as String?, zuletztStufe: z?['stufe'] as String?,
      zuletztZeit: z?['zeit'] is num ? DateTime.fromMillisecondsSinceEpoch((z!['zeit'] as num).toInt()) : null,
    );
  }

  /// Stufe, die hinter einer Wahl steht (null = Automatisch → [automatisch]).
  StufeInfo? fuer(String? wahl) => stufen[wahl ?? automatisch];
}

const _gruendlichkeit = {'none': 'keine', 'low': 'gering', 'medium': 'mittel', 'high': 'hoch', 'xhigh': 'sehr hoch'};
String gruendlichkeitText(String? g) => g == null ? '' : _gruendlichkeit[g] ?? g;

/// „gpt-6.1-sol · Gründlichkeit mittel“
String stufeZeile(StufeInfo? s) => s == null ? '' : '${s.modell}${s.gruendlichkeit == null ? '' : ' · Gründlichkeit ${gruendlichkeitText(s.gruendlichkeit)}'}${s.verfuegbar ? '' : ' · nicht verfügbar'}';
