import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';

import 'ipc.dart';
import 'modell.dart';
import 'server.dart';

/// Alfred — Desktop-App, Phase 4 Meilenstein 1 (Spec docs/specs/2026-10-07-flutter-app-phase4.md):
/// hängt sich an den Satelliten (IPC), spricht per HTTP mit dem Gehirn, zeigt Verlauf, streamt Antworten,
/// stellt Bestätigungen mit Buttons dar. Dieselbe Oberfläche wie die Terminal-Sitzung, nur als Fenster.
/// Startargumente: `--protokoll <datei>` schreibt jede Verlaufszeile in die Datei (Beweise, Fehlersuche),
/// `--sende "<text>"` schickt nach dem Anhängen eine Nachricht (Beweislauf ohne Tippen).
late final Map<String, String> startArgs;

void main(List<String> args) {
  final m = <String, String>{};
  for (var i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length) { m[args[i].substring(2)] = args[i + 1]; i++; }
  }
  startArgs = m;
  runApp(const AlfredApp());
}

class AlfredApp extends StatelessWidget {
  const AlfredApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Alfred',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(brightness: Brightness.dark, colorSchemeSeed: const Color(0xFF4FC3F7), useMaterial3: true),
      home: const Sitzung(),
    );
  }
}

class Sitzung extends StatefulWidget {
  const Sitzung({super.key});

  @override
  State<Sitzung> createState() => _SitzungState();
}

class _SitzungState extends State<Sitzung> {
  final List<Eintrag> verlauf = [];
  final List<Bestaetigung> offen = [];
  final Set<String> gemeldet = {};
  final TextEditingController eingabe = TextEditingController();
  final ScrollController scroll = ScrollController();
  final FocusNode fokus = FocusNode();

  SatellitStatus? satellit;
  String ipcZustand = 'verbinde …';
  Konfig? konfig;
  Server? server;
  Eintrag? laufend;
  String fluechtig = '';
  bool antwortet = false;
  Timer? abfrage;
  late final IpcVerbindung ipc;

  @override
  void initState() {
    super.initState();
    ipc = IpcVerbindung(
      aufStatus: (s) => setState(() => satellit = s),
      aufEreignis: (art, text, zeit) => _zeile(Eintrag(Art.satellit, text, zeit: zeit)),
      aufBestaetigung: _meldeNeu,
      aufKonfig: (k) {
        final erste = server == null;
        setState(() { konfig = k; server = Server(k); });
        _holeBestaetigungen();
        abfrage ??= Timer.periodic(const Duration(seconds: 4), (_) => _holeBestaetigungen());
        final auto = startArgs['sende'];
        if (erste && auto != null && auto.isNotEmpty) { eingabe.text = auto; Future.delayed(const Duration(milliseconds: 800), _senden); }
      },
      aufZustand: (z) => setState(() => ipcZustand = z),
    );
    ipc.start();
    _zeile(Eintrag(Art.hinweis, 'Alfred-App — Verlauf, Chat und Bestätigungen laufen über den Satelliten dieses Geräts.'));
  }

  @override
  void dispose() {
    abfrage?.cancel();
    ipc.stop();
    super.dispose();
  }

  void _zeile(Eintrag e) {
    setState(() => verlauf.add(e));
    _protokolliere(e);
    _nachUnten();
  }

  void _protokolliere(Eintrag e) {
    final p = startArgs['protokoll'];
    if (p == null) return;
    try { File(p).writeAsStringSync('${e.zeit.toIso8601String()} ${e.art.name} ${e.text.replaceAll('\n', ' ')}\n', mode: FileMode.append, flush: true); } catch (_) {}
  }

  void _nachUnten() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (scroll.hasClients) scroll.animateTo(scroll.position.maxScrollExtent, duration: const Duration(milliseconds: 150), curve: Curves.easeOut);
    });
  }

  void _meldeNeu(Bestaetigung b) {
    if (gemeldet.contains(b.id)) return;
    gemeldet.add(b.id);
    setState(() => offen.add(b));
    _zeile(Eintrag(Art.bestaetigung, '${b.quelle == 'geraet' ? '(Gerät) ' : ''}${b.text}'));
  }

  Future<void> _holeBestaetigungen() async {
    final s = server;
    if (s == null) return;
    try {
      final liste = await s.offeneBestaetigungen();
      final ids = liste.map((b) => b.id).toSet();
      for (final b in offen.where((b) => !ids.contains(b.id)).toList()) {
        setState(() => offen.remove(b));
        _zeile(Eintrag(Art.hinweis, '✓ Bestätigung erledigt: ${b.text.length > 80 ? b.text.substring(0, 80) : b.text}'));
      }
      for (final b in liste) { _meldeNeu(b); }
    } catch (_) { /* nächste Runde */ }
  }

  Future<void> _entscheide(Bestaetigung b, bool ja) async {
    final s = server;
    if (s == null) return;
    final r = await s.entscheide(b.id, ja);
    if (r == 'freigegeben' || r == 'abgelehnt') {
      setState(() => offen.remove(b));
      _zeile(Eintrag(Art.hinweis, '${ja ? '✅ Freigegeben' : '❌ Abgelehnt'}: ${b.text.length > 100 ? b.text.substring(0, 100) : b.text}'));
    } else {
      _zeile(Eintrag(Art.fehler, 'Entscheidung nicht angenommen ($r)'));
    }
  }

  Future<void> _senden() async {
    final text = eingabe.text.trim();
    final s = server;
    if (text.isEmpty || antwortet) return;
    if (s == null) { _zeile(Eintrag(Art.fehler, 'Noch nicht mit dem Satelliten verbunden — $ipcZustand')); return; }
    eingabe.clear();
    _zeile(Eintrag(Art.du, text));
    setState(() { antwortet = true; fluechtig = '… denkt'; });
    final e = Eintrag(Art.alfred, '');
    var gezeigt = '';
    try {
      final ende = await s.sende(text,
        aufDelta: (t) {
          if (laufend == null) { laufend = e; setState(() { verlauf.add(e); fluechtig = ''; }); }
          gezeigt += t;
          setState(() => e.text = gezeigt);
          _nachUnten();
        },
        aufStatus: (t) => setState(() => fluechtig = t.isEmpty ? '' : '… ${t.length > 100 ? t.substring(0, 100) : t}'),
      );
      if (laufend == null) { _zeile(Eintrag(Art.alfred, ende.isEmpty ? '(keine Antwort)' : ende)); }
      else { if (ende.trim().isNotEmpty && ende.trim() != gezeigt.trim()) setState(() => e.text = ende); _protokolliere(e); }
    } catch (err) {
      _zeile(Eintrag(Art.fehler, 'Fehler: $err'));
    } finally {
      setState(() { antwortet = false; fluechtig = ''; laufend = null; });
      fokus.requestFocus();
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final geraet = konfig?.name ?? satellit?.name ?? '…';
    return Scaffold(
      appBar: AppBar(
        title: Text('Alfred — $geraet'),
        actions: [
          if (offen.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(right: 12),
              child: Chip(avatar: const Icon(Icons.notifications_active, size: 18), label: Text('${offen.length} ${offen.length == 1 ? 'Bestätigung' : 'Bestätigungen'}'), backgroundColor: Colors.amber.shade900),
            ),
        ],
      ),
      body: Column(
        children: [
          Expanded(
            child: ListView.builder(
              controller: scroll,
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
              itemCount: verlauf.length,
              itemBuilder: (context, i) => _eintrag(verlauf[i], theme),
            ),
          ),
          if (offen.isNotEmpty) _bestaetigungen(theme),
          if (fluechtig.isNotEmpty) Padding(padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4), child: Align(alignment: Alignment.centerLeft, child: Text(fluechtig, style: theme.textTheme.bodySmall?.copyWith(color: Colors.white54)))),
          const Divider(height: 1),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: eingabe,
                    focusNode: fokus,
                    autofocus: true,
                    enabled: !antwortet,
                    minLines: 1,
                    maxLines: 5,
                    decoration: const InputDecoration(hintText: 'Nachricht an Alfred … (Enter sendet)', border: OutlineInputBorder(), isDense: true),
                    onSubmitted: (_) => _senden(),
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton.icon(onPressed: antwortet ? null : _senden, icon: antwortet ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.send), label: const Text('Senden')),
              ],
            ),
          ),
          Container(
            color: theme.colorScheme.surfaceContainerHighest,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
            child: Row(
              children: [
                Icon(Icons.circle, size: 10, color: satellit?.verbunden == true ? Colors.greenAccent : Colors.redAccent),
                const SizedBox(width: 6),
                Expanded(child: Text(satellit == null ? ipcZustand : 'Satellit ${satellit!.version} · ${satellit!.verbunden ? 'verbunden mit Alfred ${satellit!.serverVersion ?? ''}' : 'nicht verbunden'}${satellit!.aktionenLaufend > 0 ? ' · ${satellit!.aktionenLaufend} Aktion(en)' : ''}', style: theme.textTheme.bodySmall, overflow: TextOverflow.ellipsis)),
                Text(konfig?.server ?? '', style: theme.textTheme.bodySmall?.copyWith(color: Colors.white38)),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _bestaetigungen(ThemeData theme) {
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 0, 12, 8),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(border: Border.all(color: Colors.amber.shade700), borderRadius: BorderRadius.circular(8)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Offene Bestätigungen (${offen.length})', style: theme.textTheme.titleSmall?.copyWith(color: Colors.amber.shade300)),
          for (final b in offen)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Row(
                children: [
                  Expanded(child: Text('${b.quelle == 'geraet' ? '(Gerät) ' : ''}${b.text}', maxLines: 3, overflow: TextOverflow.ellipsis)),
                  const SizedBox(width: 8),
                  FilledButton(onPressed: () => _entscheide(b, true), child: const Text('Ja')),
                  const SizedBox(width: 6),
                  OutlinedButton(onPressed: () => _entscheide(b, false), child: const Text('Nein')),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _eintrag(Eintrag e, ThemeData theme) {
    final zeit = '${e.zeit.hour.toString().padLeft(2, '0')}:${e.zeit.minute.toString().padLeft(2, '0')}';
    switch (e.art) {
      case Art.du:
        return Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: Align(alignment: Alignment.centerRight, child: Container(constraints: const BoxConstraints(maxWidth: 720), padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8), decoration: BoxDecoration(color: theme.colorScheme.primaryContainer, borderRadius: BorderRadius.circular(12)), child: SelectableText(e.text))));
      case Art.alfred:
        return Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: Align(alignment: Alignment.centerLeft, child: Container(constraints: const BoxConstraints(maxWidth: 820), padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8), decoration: BoxDecoration(color: theme.colorScheme.surfaceContainerHigh, borderRadius: BorderRadius.circular(12)), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text('Alfred · $zeit', style: theme.textTheme.labelSmall?.copyWith(color: Colors.cyanAccent)), const SizedBox(height: 4), SelectableText(e.text.isEmpty ? '…' : e.text)]))));
      case Art.satellit:
        return Text('$zeit  ⚙ ${e.text}', style: theme.textTheme.bodySmall?.copyWith(color: Colors.white54));
      case Art.bestaetigung:
        return Text('$zeit  🔔 ${e.text}', style: theme.textTheme.bodySmall?.copyWith(color: Colors.amber.shade200));
      case Art.hinweis:
        return Text('$zeit  ${e.text}', style: theme.textTheme.bodySmall?.copyWith(color: Colors.white70));
      case Art.fehler:
        return Text('$zeit  ${e.text}', style: theme.textTheme.bodySmall?.copyWith(color: Colors.redAccent));
    }
  }
}
