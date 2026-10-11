import 'dart:io';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// 1.6.0 — Antworttext mit Markdown-Blöcken (Owner-Freigabe 11.10., Punkt 1): anklickbare Links, Tabellen, Code-Blöcke
/// mit Kopier-Knopf. Vorher (1.0.x) nur **fett**, `code`, Aufzählungen und Überschriften als ein einziger Textblock —
/// Tabellen (z. B. die aWATTar-Zusammenfassung) und Code standen als Rohtext da. Rein, ohne Paket.

/// Ein Block des Antworttexts.
sealed class MdBlock {}
class MdText extends MdBlock { MdText(this.zeilen); final List<String> zeilen; }
class MdCode extends MdBlock { MdCode(this.code, this.sprache); final String code; final String sprache; }
class MdTabelle extends MdBlock { MdTabelle(this.kopf, this.zeilen); final List<String> kopf; final List<List<String>> zeilen; }

final _tabellenTrenner = RegExp(r'^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$');

List<String> _zellen(String zeile) {
  var z = zeile.trim();
  if (z.startsWith('|')) z = z.substring(1);
  if (z.endsWith('|')) z = z.substring(0, z.length - 1);
  return z.split('|').map((c) => c.trim()).toList();
}

/// Text in Blöcke zerlegen: ```-Zäune → Code, Kopfzeile + Trennzeile (|---|) → Tabelle, sonst Text.
List<MdBlock> zerlege(String text) {
  final zeilen = text.replaceAll('\r\n', '\n').split('\n');
  final bloecke = <MdBlock>[];
  var absatz = <String>[];
  void absatzFertig() { if (absatz.isNotEmpty) { bloecke.add(MdText(absatz)); absatz = []; } }
  var i = 0;
  while (i < zeilen.length) {
    final z = zeilen[i];
    final zaun = RegExp(r'^\s*```\s*([\w+-]*)\s*$').firstMatch(z);
    if (zaun != null) {
      absatzFertig();
      final code = <String>[];
      i++;
      while (i < zeilen.length && !RegExp(r'^\s*```\s*$').hasMatch(zeilen[i])) { code.add(zeilen[i]); i++; }
      bloecke.add(MdCode(code.join('\n'), zaun.group(1) ?? ''));
      i++; // schließender Zaun (oder Textende)
      continue;
    }
    if (z.contains('|') && i + 1 < zeilen.length && _tabellenTrenner.hasMatch(zeilen[i + 1]) && zeilen[i + 1].contains('-') && zeilen[i + 1].contains('|')) { // „---" allein = Trennlinie, keine Tabelle
      absatzFertig();
      final kopf = _zellen(z);
      final reihen = <List<String>>[];
      i += 2;
      while (i < zeilen.length && zeilen[i].contains('|') && zeilen[i].trim().isNotEmpty) {
        final r = _zellen(zeilen[i]);
        reihen.add(List.generate(kopf.length, (k) => k < r.length ? r[k] : ''));
        i++;
      }
      bloecke.add(MdTabelle(kopf, reihen));
      continue;
    }
    absatz.add(z);
    i++;
  }
  absatzFertig();
  return bloecke;
}

/// Erlaubte Link-Ziele: nur Web und Mail (nie file:, javascript: o. ä.).
bool linkErlaubt(String url) => RegExp(r'^(https?://|mailto:)', caseSensitive: false).hasMatch(url);

/// Link im Standardprogramm öffnen.
Future<void> oeffneLink(String url) async {
  if (!linkErlaubt(url)) return;
  try {
    if (Platform.isWindows) { await Process.start('rundll32', ['url.dll,FileProtocolHandler', url], mode: ProcessStartMode.detached); }
    else if (Platform.isMacOS) { await Process.start('open', [url], mode: ProcessStartMode.detached); }
    else { await Process.start('xdg-open', [url], mode: ProcessStartMode.detached); }
  } catch (_) {}
}

// **fett**, `code`, [Text](url), nackte URL
final _inline = RegExp(r'(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(((?:https?://|mailto:)[^)\s]+)\)|((?:https?://)[^\s<>()]+[^\s<>().,;:!?]))');

/// Inline-Markdown einer Textzeile; `aufLink` erzeugt den Tipp-Erkenner (der Aufrufer räumt ihn auf).
List<InlineSpan> inlineSpans(String zeile, ThemeData theme, {TextStyle? stil, TapGestureRecognizer Function(String url)? aufLink}) {
  final spans = <InlineSpan>[];
  var i = 0;
  final linkStil = TextStyle(color: theme.colorScheme.primary, decoration: TextDecoration.underline);
  for (final m in _inline.allMatches(zeile)) {
    if (m.start > i) spans.add(TextSpan(text: zeile.substring(i, m.start), style: stil));
    if (m.group(2) != null) { spans.add(TextSpan(text: m.group(2), style: const TextStyle(fontWeight: FontWeight.bold))); }
    else if (m.group(3) != null) { spans.add(TextSpan(text: m.group(3), style: TextStyle(fontFamily: 'Consolas', fontFamilyFallback: const ['Menlo', 'monospace'], color: theme.colorScheme.tertiary))); }
    else {
      final text = m.group(4) ?? m.group(6)!;
      final url = m.group(5) ?? m.group(6)!;
      spans.add(TextSpan(text: text, style: linkStil, recognizer: aufLink?.call(url)));
    }
    i = m.end;
  }
  if (i < zeile.length) spans.add(TextSpan(text: zeile.substring(i), style: stil));
  return spans;
}

/// Textblock wie bisher: Überschriften fett, Aufzählungen mit •, dazu Inline-Markdown.
TextSpan textSpan(List<String> zeilen, ThemeData theme, {TapGestureRecognizer Function(String url)? aufLink}) {
  final spans = <InlineSpan>[];
  for (var z = 0; z < zeilen.length; z++) {
    var zeile = zeilen[z];
    TextStyle? stil;
    final u = RegExp(r'^#{1,6}\s+(.*)$').firstMatch(zeile);
    if (u != null) { zeile = u.group(1)!; stil = const TextStyle(fontWeight: FontWeight.bold); }
    final p = RegExp(r'^(\s*)([-*•]|\d+[.)])\s+(.*)$').firstMatch(zeile);
    if (u == null && p != null) zeile = '${p.group(1)}${RegExp(r'\d').hasMatch(p.group(2)!) ? p.group(2) : '•'} ${p.group(3)}';
    if (RegExp(r'^\s*-{3,}\s*$').hasMatch(zeile)) zeile = '────────';
    spans.addAll(inlineSpans(zeile, theme, stil: stil, aufLink: aufLink));
    if (z < zeilen.length - 1) spans.add(const TextSpan(text: '\n'));
  }
  return TextSpan(children: spans, style: theme.textTheme.bodyMedium);
}

/// Antwort von Alfred als Blöcke. `aufLink` ist für Tests ersetzbar (Standard: im Browser öffnen).
class AlfredText extends StatefulWidget {
  const AlfredText(this.text, {super.key, this.aufLink = oeffneLink, this.aufKopiert});
  final String text;
  final Future<void> Function(String url) aufLink;
  final VoidCallback? aufKopiert;

  @override
  State<AlfredText> createState() => _AlfredTextState();
}

class _AlfredTextState extends State<AlfredText> {
  final List<TapGestureRecognizer> _erkenner = [];

  void _aufraeumen() { for (final e in _erkenner) { e.dispose(); } _erkenner.clear(); }

  @override
  void dispose() { _aufraeumen(); super.dispose(); }

  TapGestureRecognizer _link(String url) {
    final e = TapGestureRecognizer()..onTap = () => widget.aufLink(url);
    _erkenner.add(e);
    return e;
  }

  Widget _code(MdCode c, ThemeData theme) => Container(
    margin: const EdgeInsets.symmetric(vertical: 6),
    decoration: BoxDecoration(color: theme.colorScheme.surfaceContainerHighest, borderRadius: BorderRadius.circular(8)),
    child: Stack(children: [
      SingleChildScrollView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.fromLTRB(12, 10, 44, 10), child: SelectableText(c.code, style: TextStyle(fontFamily: 'Consolas', fontFamilyFallback: const ['Menlo', 'monospace'], fontSize: 13, color: theme.colorScheme.onSurface))),
      Positioned(top: 2, right: 2, child: IconButton(tooltip: 'Code kopieren', iconSize: 16, visualDensity: VisualDensity.compact, onPressed: () { Clipboard.setData(ClipboardData(text: c.code)); widget.aufKopiert?.call(); }, icon: const Icon(Icons.copy_outlined))),
    ]),
  );

  Widget _tabelle(MdTabelle t, ThemeData theme) {
    Widget zelle(String s, {bool kopf = false}) => Padding(padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6), child: Text.rich(TextSpan(children: inlineSpans(s, theme, aufLink: _link), style: kopf ? theme.textTheme.bodySmall?.copyWith(fontWeight: FontWeight.bold) : theme.textTheme.bodySmall)));
    return Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: SingleChildScrollView(scrollDirection: Axis.horizontal, child: Table(
      defaultColumnWidth: const IntrinsicColumnWidth(),
      border: TableBorder.all(color: theme.colorScheme.outlineVariant, borderRadius: BorderRadius.circular(6)),
      children: [
        TableRow(decoration: BoxDecoration(color: theme.colorScheme.surfaceContainerHigh), children: [for (final k in t.kopf) zelle(k, kopf: true)]),
        for (final r in t.zeilen) TableRow(children: [for (final c in r) zelle(c)]),
      ],
    )));
  }

  @override
  Widget build(BuildContext context) {
    _aufraeumen();
    final theme = Theme.of(context);
    final bloecke = zerlege(widget.text.isEmpty ? '…' : widget.text);
    return Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
      for (final b in bloecke) switch (b) {
        MdText() => SelectableText.rich(textSpan(b.zeilen, theme, aufLink: _link)),
        MdCode() => _code(b, theme),
        MdTabelle() => _tabelle(b, theme),
      },
    ]);
  }
}
