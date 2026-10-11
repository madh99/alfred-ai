import 'package:flutter/material.dart';

/// 1.5.0 — Suche im Verlauf (Owner-Freigabe 11.10., Punkt 4; Server v1350 `/api/geraete/suche`).
/// Owner-Geräte durchsuchen Hauptgespräch und alle Fäden, andere Geräte ihre eigenen Gespräche. Ein Treffer öffnet die
/// Fundstelle im Chat (Nachrichten rund um den Treffer).

/// Suchwörter wie am Server: an Leerraum getrennt, mindestens 2 Zeichen.
List<String> suchWoerter(String q) => q.split(RegExp(r'\s+')).map((w) => w.trim()).where((w) => w.length >= 2).toList();

/// Ausschnitt um den ersten Treffer: höchstens [vor] Zeichen davor und [laenge] insgesamt, Zeilenumbrüche als Leerzeichen.
String ausschnitt(String text, List<String> woerter, {int vor = 60, int laenge = 220}) {
  final t = text.replaceAll(RegExp(r'\s+'), ' ').trim();
  final klein = t.toLowerCase();
  var pos = -1;
  for (final w in woerter) { final i = klein.indexOf(w.toLowerCase()); if (i >= 0 && (pos < 0 || i < pos)) pos = i; }
  final start = pos <= vor ? 0 : pos - vor;
  final ende = (start + laenge) > t.length ? t.length : start + laenge;
  return '${start > 0 ? '…' : ''}${t.substring(start, ende)}${ende < t.length ? '…' : ''}';
}

/// Text in Stücke zerlegen, Treffer fett/markiert.
TextSpan markiert(String text, List<String> woerter, TextStyle? basis, TextStyle treffer) {
  if (woerter.isEmpty) return TextSpan(text: text, style: basis);
  final re = RegExp(woerter.map(RegExp.escape).join('|'), caseSensitive: false);
  final teile = <InlineSpan>[];
  var i = 0;
  for (final m in re.allMatches(text)) {
    if (m.start > i) teile.add(TextSpan(text: text.substring(i, m.start)));
    teile.add(TextSpan(text: m.group(0), style: treffer));
    i = m.end;
  }
  if (i < text.length) teile.add(TextSpan(text: text.substring(i)));
  return TextSpan(children: teile, style: basis);
}

class Suche extends StatefulWidget {
  const Suche({super.key, required this.json, required this.aufOeffnen, this.anfang = '', this.aufAnfrage});

  /// Letzte Anfrage (Rückkehr von einer Fundstelle): wird sofort wieder gesucht.
  final String anfang;
  final void Function(String q)? aufAnfrage;

  /// GET einer erlaubten Route (Server.json).
  final Future<Map<String, dynamic>> Function(String pfad) json;
  /// Treffer gewählt: {rolle, text, zeit, faden, gespraech}.
  final void Function(Map<String, dynamic> treffer) aufOeffnen;

  @override
  State<Suche> createState() => _SucheState();
}

class _SucheState extends State<Suche> {
  final eingabe = TextEditingController();
  List<Map<String, dynamic>>? treffer;
  List<String> woerter = [];
  bool laeuft = false;
  String? fehler;

  @override
  void initState() {
    super.initState();
    if (widget.anfang.trim().isNotEmpty) { eingabe.text = widget.anfang; WidgetsBinding.instance.addPostFrameCallback((_) { if (mounted) _suchen(); }); }
  }

  @override
  void dispose() { eingabe.dispose(); super.dispose(); }

  Future<void> _suchen() async {
    final q = eingabe.text.trim();
    final w = suchWoerter(q);
    if (w.isEmpty) { setState(() { fehler = 'Mindestens 2 Zeichen eingeben.'; treffer = null; }); return; }
    widget.aufAnfrage?.call(q);
    setState(() { laeuft = true; fehler = null; });
    try {
      final j = await widget.json('/api/geraete/suche?q=${Uri.encodeQueryComponent(q)}&limit=60');
      final l = ((j['treffer'] as List<dynamic>?) ?? []).whereType<Map<String, dynamic>>().toList();
      if (mounted) setState(() { treffer = l; woerter = w; });
    } catch (e) {
      if (mounted) setState(() { fehler = 'Suche fehlgeschlagen: $e'; treffer = null; });
    } finally { if (mounted) setState(() => laeuft = false); }
  }

  static String _datum(String iso) {
    final d = DateTime.tryParse(iso)?.toLocal();
    if (d == null) return '';
    String zz(int x) => x.toString().padLeft(2, '0');
    return '${zz(d.day)}.${zz(d.month)}.${d.year}, ${zz(d.hour)}:${zz(d.minute)}';
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dim = theme.colorScheme.onSurfaceVariant;
    final l = treffer;
    return Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 920), child: Padding(padding: const EdgeInsets.all(20), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('Suche im Verlauf', style: theme.textTheme.headlineSmall),
      const SizedBox(height: 12),
      TextField(
        key: const Key('suche-eingabe'),
        controller: eingabe,
        autofocus: true,
        textInputAction: TextInputAction.search,
        onSubmitted: (_) => _suchen(),
        decoration: InputDecoration(
          hintText: 'Wörter aus Fragen oder Antworten, z. B. „Rechnung aWATTar"',
          prefixIcon: const Icon(Icons.search),
          suffixIcon: laeuft ? const Padding(padding: EdgeInsets.all(12), child: SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))) : IconButton(tooltip: 'Suchen', onPressed: _suchen, icon: const Icon(Icons.arrow_forward)),
          border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
        ),
      ),
      const SizedBox(height: 10),
      if (fehler != null) Text(fehler!, style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.error)),
      if (l != null) Text(l.isEmpty ? 'Keine Treffer.' : '${l.length} Treffer${l.length >= 60 ? ' (die neuesten)' : ''}', style: theme.textTheme.labelMedium?.copyWith(color: dim)),
      const SizedBox(height: 6),
      Expanded(child: l == null || l.isEmpty ? const SizedBox.shrink() : ListView.separated(
        itemCount: l.length,
        separatorBuilder: (_, __) => const Divider(height: 1),
        itemBuilder: (context, i) {
          final t = l[i];
          final du = t['rolle'] == 'user';
          return ListTile(
            key: Key('treffer-$i'),
            leading: Icon(du ? Icons.person_outline : Icons.auto_awesome, size: 20, color: du ? dim : theme.colorScheme.primary),
            title: Text.rich(markiert(ausschnitt('${t['text'] ?? ''}', woerter), woerter, theme.textTheme.bodyMedium, TextStyle(fontWeight: FontWeight.bold, backgroundColor: theme.colorScheme.primaryContainer)), maxLines: 3, overflow: TextOverflow.ellipsis),
            subtitle: Text('${du ? 'Du' : 'Alfred'} · ${t['gespraech'] ?? 'Gespräch'} · ${_datum('${t['zeit'] ?? ''}')}', style: theme.textTheme.labelSmall?.copyWith(color: dim)),
            onTap: () => widget.aufOeffnen(t),
          );
        },
      )),
    ]))));
  }
}
