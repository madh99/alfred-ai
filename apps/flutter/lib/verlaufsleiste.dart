/// 1.45.0 (v1504, D4) — Verlaufsleiste am linken Rand des Chats (Owner 19.10., App-Spec §11): ein Strich je eigener Frage.
/// 1.45.2 — nach dem Vorbild (Owner 19.10. 11:40): Striche dicht untereinander in der Mitte, die gerade sichtbare Frage hell
/// und länger; Darüberfahren öffnet eine Karte (Frage fett, Antwortanfang, 🔖 anklickbar), Klick springt hin.
library;

import 'dart:async';
import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';

import 'modell.dart';

class LeistenEintrag {
  const LeistenEintrag({required this.index, required this.frage, required this.antwort, required this.schluessel});
  /// Index im Verlauf (ältester = 0)
  final int index;
  final String frage;
  /// Anfang der folgenden Antwort von Alfred (leer, wenn keine kam)
  final String antwort;
  final String schluessel;
}

/// Lesezeichen-Schlüssel einer Nachricht: Prüfsumme des Texts (gleich auf allen Geräten und nach einem Neustart).
String lesezeichenSchluessel(String text) => sha1.convert(utf8.encode(text.trim())).toString().substring(0, 16);

String _kurz(String t, int n) { final s = t.replaceAll(RegExp(r'\s+'), ' ').trim(); return s.length > n ? '${s.substring(0, n - 1)}…' : s; }

/// Eigene Fragen des Verlaufs mit dem Anfang der jeweils folgenden Antwort.
List<LeistenEintrag> leistenEintraege(List<Eintrag> verlauf) {
  final aus = <LeistenEintrag>[];
  for (var i = 0; i < verlauf.length; i++) {
    final e = verlauf[i];
    if (e.art != Art.du || e.text.trim().isEmpty) continue;
    var antwort = '';
    for (var j = i + 1; j < verlauf.length && verlauf[j].art != Art.du; j++) {
      if (verlauf[j].art == Art.alfred && verlauf[j].text.trim().isNotEmpty) { antwort = _kurz(verlauf[j].text, 220); break; }
    }
    aus.add(LeistenEintrag(index: i, frage: _kurz(e.text, 120), antwort: antwort, schluessel: lesezeichenSchluessel(e.text)));
  }
  return aus;
}

/// Abstand zwischen zwei Strichen: 7 px wie im Vorbild, bei vielen Fragen enger, damit alle in [hoehe] passen (mind. 2 px).
double strichAbstand(int n, double hoehe) => n <= 1 ? 7 : (hoehe / n).clamp(2.0, 7.0);

/// Zu einem Eintrag einer umgekehrten Liste springen (0 = unten/neuester). Die Liste baut nur sichtbare Einträge: erst
/// ungefähr hinscrollen ([anteil] = Lage von unten, 0..1), dann genau mit ensureVisible. true = gefunden.
Future<bool> springeZu(ScrollController scroll, GlobalKey ziel, double anteil) async {
  if (!scroll.hasClients) return false;
  Future<bool> sichtbar() async {
    await WidgetsBinding.instance.endOfFrame;
    final c = ziel.currentContext;
    if (c == null || !c.mounted) return false;
    await Scrollable.ensureVisible(c, alignment: 0.15, duration: const Duration(milliseconds: 250));
    return true;
  }
  if (await sichtbar()) return true;
  // 1.45.2 — Die Gesamthöhe einer Liste, die nur Sichtbares baut, ist eine Schätzung und wächst beim Scrollen. Einmal mit der
  // frühen Schätzung zu rechnen erreichte weit oben liegende Fragen nie (Owner 19.10.: Klick sprang nicht). Daher: nach jedem
  // Sprung mit der neuen Schätzung wiederholen, notfalls die Liste in Schritten von 80 % der Bildschirmhöhe absuchen.
  for (var n = 0; n < 12; n++) {
    final p = scroll.position;
    scroll.jumpTo((anteil.clamp(0.0, 1.0) * p.maxScrollExtent).clamp(0.0, p.maxScrollExtent));
    if (await sichtbar()) return true;
  }
  var stelle = 0.0;
  for (var n = 0; n < 500; n++) {
    final p = scroll.position;
    if (stelle > p.maxScrollExtent + p.viewportDimension) break;
    scroll.jumpTo(stelle.clamp(0.0, p.maxScrollExtent));
    if (await sichtbar()) return true;
    stelle += p.viewportDimension * 0.8;
  }
  return false;
}

class Verlaufsleiste extends StatefulWidget {
  const Verlaufsleiste({super.key, required this.eintraege, required this.markiert, required this.aufSprung, this.aktuell, this.aufLesezeichen});
  final List<LeistenEintrag> eintraege;
  final Set<String> markiert;
  final void Function(int index) aufSprung;
  /// Verlaufs-Index der gerade sichtbaren Frage (heller, längerer Strich)
  final int? aktuell;
  final void Function(LeistenEintrag e)? aufLesezeichen;
  @override
  State<Verlaufsleiste> createState() => _VerlaufsleisteState();
}

class _VerlaufsleisteState extends State<Verlaufsleiste> {
  final _portal = OverlayPortalController();
  final List<LayerLink> _links = [];
  int? _hover;
  Timer? _zu;

  @override
  void dispose() { _zu?.cancel(); super.dispose(); }

  void _zeige(int k) { _zu?.cancel(); setState(() => _hover = k); _portal.show(); }
  void _verzoegertZu() { _zu?.cancel(); _zu = Timer(const Duration(milliseconds: 250), () { if (mounted) { _portal.hide(); setState(() => _hover = null); } }); }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dim = theme.colorScheme.onSurfaceVariant.withValues(alpha: 0.5);
    final n = widget.eintraege.length;
    while (_links.length < n) { _links.add(LayerLink()); }
    return OverlayPortal(controller: _portal, overlayChildBuilder: (_) => _karte(theme), child: LayoutBuilder(builder: (context, c) {
      final abstand = strichAbstand(n, c.maxHeight - 40);
      return Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
        for (var k = 0; k < n; k++) CompositedTransformTarget(link: _links[k], child: MouseRegion(
          key: Key('leiste-${widget.eintraege[k].index}'),
          cursor: SystemMouseCursors.click,
          onEnter: (_) => _zeige(k), onExit: (_) => _verzoegertZu(),
          child: GestureDetector(behavior: HitTestBehavior.opaque, onTap: () => widget.aufSprung(widget.eintraege[k].index), child: SizedBox(width: 28, height: abstand, child: Align(alignment: Alignment.centerLeft, child: _strich(theme, dim, k)))),
        )),
      ]));
    }));
  }

  Widget _strich(ThemeData theme, Color dim, int k) {
    final e = widget.eintraege[k];
    final aktuell = widget.aktuell == e.index;
    final markiert = widget.markiert.contains(e.schluessel);
    final breite = aktuell ? 20.0 : _hover == k ? 16.0 : markiert ? 14.0 : 9.0;
    final farbe = aktuell ? theme.colorScheme.onSurface : markiert ? theme.colorScheme.primary : _hover == k ? theme.colorScheme.onSurfaceVariant : dim;
    return Padding(padding: const EdgeInsets.only(left: 6), child: AnimatedContainer(duration: const Duration(milliseconds: 120), width: breite, height: markiert || aktuell ? 2.5 : 1.5, decoration: BoxDecoration(color: farbe, borderRadius: BorderRadius.circular(1))));
  }

  Widget _karte(ThemeData theme) {
    final k = _hover;
    if (k == null || k >= widget.eintraege.length) return const SizedBox.shrink();
    final e = widget.eintraege[k];
    final markiert = widget.markiert.contains(e.schluessel);
    return CompositedTransformFollower(link: _links[k], showWhenUnlinked: false, offset: const Offset(30, -22), child: Align(alignment: Alignment.topLeft, child: MouseRegion(
      onEnter: (_) => _zu?.cancel(), onExit: (_) => _verzoegertZu(),
      child: GestureDetector(onTap: () => widget.aufSprung(e.index), child: Material(key: const Key('leiste-karte'), elevation: 6, color: theme.colorScheme.surfaceContainerHigh, borderRadius: BorderRadius.circular(10), child: Container(
        width: 330, padding: const EdgeInsets.fromLTRB(12, 8, 4, 10),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(child: Padding(padding: const EdgeInsets.only(top: 4), child: Text(e.frage, maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall?.copyWith(fontWeight: FontWeight.w600)))),
            if (widget.aufLesezeichen != null) IconButton(key: const Key('leiste-lesezeichen'), tooltip: markiert ? 'Lesezeichen entfernen' : 'Lesezeichen setzen', iconSize: 16, visualDensity: VisualDensity.compact, onPressed: () { widget.aufLesezeichen!(e); setState(() {}); },
              icon: Icon(markiert ? Icons.bookmark : Icons.bookmark_border, color: markiert ? theme.colorScheme.primary : null)),
          ]),
          if (e.antwort.isNotEmpty) Padding(padding: const EdgeInsets.only(right: 8), child: Text(e.antwort, maxLines: 3, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant))),
        ]),
      ))),
    )));
  }
}
