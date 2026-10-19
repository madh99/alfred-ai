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
    if (Platform.isIOS || Platform.isAndroid) { await const MethodChannel('alfred/system').invokeMethod('oeffnen', {'url': url}); return; } // 1.52.1 — Handy: über das System (Safari, Mail …)
    if (Platform.isWindows) { await Process.start('rundll32', ['url.dll,FileProtocolHandler', url], mode: ProcessStartMode.detached); }
    else if (Platform.isMacOS) { await Process.start('open', [url], mode: ProcessStartMode.detached); }
    else { await Process.start('xdg-open', [url], mode: ProcessStartMode.detached); }
  } catch (_) {}
}

// **fett**, `code`, [Text](url), nackte URL, nackte IPv4-Adresse (1.12.1)
final _inline = RegExp(r'(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(((?:https?://|mailto:)[^)\s]+)\)|((?:https?://)[^\s<>()]+[^\s<>().,;:!?])|(?<![\w.])((?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?)(?!\w|\.\d))');

/// 1.12.1 — IPv4-Adresse (Oktette ≤ 255, optional :Port). Versionsnummern wie „0.19.0" haben nur drei Teile.
bool istIpAdresse(String s) {
  final m = RegExp(r'^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::(\d{1,5}))?$').firstMatch(s.trim());
  if (m == null) return false;
  for (var g = 1; g <= 4; g++) { if (int.parse(m.group(g)!) > 255) return false; }
  final port = m.group(5);
  return port == null || (int.parse(port) > 0 && int.parse(port) <= 65535);
}

/// Inline-Markdown einer Textzeile; `aufLink` erzeugt den Tipp-Erkenner (der Aufrufer räumt ihn auf).
List<InlineSpan> inlineSpans(String zeile, ThemeData theme, {TextStyle? stil, TapGestureRecognizer Function(String url)? aufLink, TapGestureRecognizer Function(String code)? aufCode}) {
  final spans = <InlineSpan>[];
  var i = 0;
  final linkStil = TextStyle(color: theme.colorScheme.primary, decoration: TextDecoration.underline);
  for (final m in _inline.allMatches(zeile)) {
    if (m.start > i) spans.add(TextSpan(text: zeile.substring(i, m.start), style: stil));
    if (m.group(2) != null) { spans.add(TextSpan(text: m.group(2), style: const TextStyle(fontWeight: FontWeight.bold))); }
    else if (m.group(3) != null || (m.group(7) != null && istIpAdresse(m.group(7)!))) {
      // 1.12.1 — Code-Stellen und IPs anklickbar (kopieren bzw. Menü mit „Im Browser öffnen")
      final code = m.group(3) ?? m.group(7)!;
      spans.add(TextSpan(text: code, style: TextStyle(fontFamily: 'Consolas', fontFamilyFallback: const ['Menlo', 'monospace'], color: theme.colorScheme.tertiary), recognizer: aufCode?.call(code), mouseCursor: aufCode == null ? null : SystemMouseCursors.click));
    }
    else if (m.group(7) != null) { spans.add(TextSpan(text: m.group(7), style: stil)); } // vier Zahlen, aber keine gültige IP
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
TextSpan textSpan(List<String> zeilen, ThemeData theme, {TapGestureRecognizer Function(String url)? aufLink, TapGestureRecognizer Function(String code)? aufCode}) {
  final spans = <InlineSpan>[];
  for (var z = 0; z < zeilen.length; z++) {
    var zeile = zeilen[z];
    TextStyle? stil;
    final u = RegExp(r'^#{1,6}\s+(.*)$').firstMatch(zeile);
    if (u != null) { zeile = u.group(1)!; stil = const TextStyle(fontWeight: FontWeight.bold); }
    final p = RegExp(r'^(\s*)([-*•]|\d+[.)])\s+(.*)$').firstMatch(zeile);
    if (u == null && p != null) zeile = '${p.group(1)}${RegExp(r'\d').hasMatch(p.group(2)!) ? p.group(2) : '•'} ${p.group(3)}';
    if (RegExp(r'^\s*-{3,}\s*$').hasMatch(zeile)) zeile = '────────';
    spans.addAll(inlineSpans(zeile, theme, stil: stil, aufLink: aufLink, aufCode: aufCode));
    if (z < zeilen.length - 1) spans.add(const TextSpan(text: '\n'));
  }
  return TextSpan(children: spans, style: theme.textTheme.bodyMedium);
}

/// Antwort von Alfred als Blöcke. `aufLink` ist für Tests ersetzbar (Standard: im Browser öffnen).
/// 1.12.1 (Owner 12.10.: Tabellenwerte und IPs ließen sich weder markieren noch anklicken): die ganze Antwort liegt in
/// einer SelectionArea — markieren über Absätze, Tabellen und Code hinweg, Strg+C, Rechtsklick „Kopieren". Ein Klick auf
/// eine Code-Stelle kopiert sie; ein Klick auf eine IP-Adresse öffnet ein Menü „Kopieren · Im Browser öffnen".
class AlfredText extends StatefulWidget {
  const AlfredText(this.text, {super.key, this.aufLink = oeffneLink, this.aufKopiert});
  final String text;
  final Future<void> Function(String url) aufLink;
  /// Nach dem Kopieren (Code-Block-Knopf oder Klick auf eine Code-Stelle), mit dem kopierten Text.
  final void Function(String was)? aufKopiert;

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

  void _kopiere(String text) { Clipboard.setData(ClipboardData(text: text)); widget.aufKopiert?.call(text); }

  /// 1.12.1 — Klick auf Code: kopieren; auf eine IP: Menü an der Klickstelle.
  TapGestureRecognizer _code(String code) {
    final e = TapGestureRecognizer()..onTapUp = (d) async {
      if (!istIpAdresse(code)) { _kopiere(code); return; }
      final o = d.globalPosition;
      final wahl = await showMenu<String>(context: context, position: RelativeRect.fromLTRB(o.dx, o.dy, o.dx + 1, o.dy + 1), items: [
        const PopupMenuItem(value: 'kopieren', child: ListTile(dense: true, leading: Icon(Icons.copy_outlined, size: 18), title: Text('Kopieren'))),
        PopupMenuItem(value: 'browser', child: ListTile(dense: true, leading: const Icon(Icons.open_in_browser, size: 18), title: Text('Im Browser öffnen (http://$code)'))),
      ]);
      if (wahl == 'kopieren') _kopiere(code);
      if (wahl == 'browser') await widget.aufLink('http://$code');
    };
    _erkenner.add(e);
    return e;
  }

  Widget _codeBlock(MdCode c, ThemeData theme) => Container(
    margin: const EdgeInsets.symmetric(vertical: 6),
    decoration: BoxDecoration(color: theme.colorScheme.surfaceContainerHighest, borderRadius: BorderRadius.circular(8)),
    child: Stack(children: [
      SingleChildScrollView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.fromLTRB(12, 10, 44, 10), child: Text(c.code, style: TextStyle(fontFamily: 'Consolas', fontFamilyFallback: const ['Menlo', 'monospace'], fontSize: 13, color: theme.colorScheme.onSurface))),
      Positioned(top: 2, right: 2, child: IconButton(tooltip: 'Code kopieren', iconSize: 16, visualDensity: VisualDensity.compact, onPressed: () => _kopiere(c.code), icon: const Icon(Icons.copy_outlined))),
    ]),
  );

  Widget _tabelle(MdTabelle t, ThemeData theme) {
    Widget zelle(String s, {bool kopf = false}) => Padding(padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6), child: Text.rich(TextSpan(children: inlineSpans(s, theme, aufLink: _link, aufCode: _code), style: kopf ? theme.textTheme.bodySmall?.copyWith(fontWeight: FontWeight.bold) : theme.textTheme.bodySmall)));
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
    return SelectionArea(child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
      for (final b in bloecke) switch (b) {
        MdText() => Text.rich(textSpan(b.zeilen, theme, aufLink: _link, aufCode: _code)),
        MdCode() => _codeBlock(b, theme),
        MdTabelle() => _tabelle(b, theme),
      },
    ]));
  }
}
