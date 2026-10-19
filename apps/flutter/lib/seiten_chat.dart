/// 1.43.0 (v1500, D2) — Seiten-Chat (Owner 19.10., App-Spec §11): ein schmaler zweiter Chat rechts für eine Zwischenfrage,
/// ohne den Hauptfaden zu verlassen. Eigener Owner-Faden mit eigener Server-Verbindung (der Hauptchat bleibt unberührt);
/// er erscheint in der Seitenleiste wie jeder Faden und lässt sich dort weiterführen.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'markdown.dart';
import 'modell.dart';
import 'server.dart';

class SeitenChat extends StatefulWidget {
  const SeitenChat({super.key, required this.konfig, required this.faden, required this.titel, required this.aufSchliessen, this.aufAlsHauptchat, this.aufGeaendert});
  final Konfig konfig;
  final String faden;
  final String titel;
  final VoidCallback aufSchliessen;
  /// Im Hauptbereich öffnen (dann weiter mit allen Funktionen des Chats).
  final VoidCallback? aufAlsHauptchat;
  /// Nach jeder Antwort (Seitenleiste neu laden: Titel, Zeit).
  final VoidCallback? aufGeaendert;
  @override
  State<SeitenChat> createState() => _SeitenChatState();
}

class _SeitenChatState extends State<SeitenChat> {
  late final Server _server = Server(widget.konfig)..faden = widget.faden;
  final List<(bool du, String text)> _nachrichten = [];
  final _eingabe = TextEditingController();
  final _fokus = FocusNode();
  String _laufend = '';
  String? _status;
  bool _sendet = false;

  @override
  void initState() { super.initState(); _laden(); }

  @override
  void dispose() { _eingabe.dispose(); _fokus.dispose(); super.dispose(); }

  Future<void> _laden() async {
    try {
      final j = await _server.json('/api/geraete/verlauf?limit=50&faden=${Uri.encodeQueryComponent(widget.faden)}');
      final n = (j['nachrichten'] as List<dynamic>? ?? []).cast<Map<String, dynamic>>();
      if (mounted) setState(() { _nachrichten..clear()..addAll(n.where((m) => m['rolle'] == 'user' || m['rolle'] == 'assistant').map((m) => (m['rolle'] == 'user', '${m['text']}'))); });
    } catch (_) { /* neuer Faden ohne Verlauf */ }
    if (mounted) _fokus.requestFocus();
  }

  Future<void> _senden() async {
    final text = _eingabe.text.trim();
    if (text.isEmpty || _sendet) return;
    _eingabe.clear();
    setState(() { _nachrichten.add((true, text)); _sendet = true; _laufend = ''; _status = null; });
    try {
      final antwort = await _server.sende(text, aufDelta: (d) { if (mounted) setState(() => _laufend += d); }, aufStatus: (s) { if (mounted) setState(() => _status = s); });
      if (mounted) setState(() => _nachrichten.add((false, antwort.trim().isEmpty ? _laufend : antwort)));
      widget.aufGeaendert?.call();
    } catch (e) {
      if (mounted) setState(() => _nachrichten.add((false, '⚠️ $e')));
    } finally {
      if (mounted) setState(() { _sendet = false; _laufend = ''; _status = null; });
      _fokus.requestFocus();
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dim = theme.colorScheme.onSurfaceVariant;
    final eintraege = [..._nachrichten, if (_sendet) (false, _laufend.isEmpty ? '… ${_status ?? 'denkt nach'}' : _laufend)];
    return Material(color: theme.colorScheme.surfaceContainerLow, child: Column(children: [
      SizedBox(height: 48, child: Row(children: [
        const SizedBox(width: 12),
        Icon(Icons.vertical_split_outlined, size: 18, color: dim),
        const SizedBox(width: 8),
        Expanded(child: Text(widget.titel, key: const Key('seiten-chat-titel'), maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.titleSmall)),
        if (widget.aufAlsHauptchat != null) IconButton(tooltip: 'Im Hauptbereich öffnen', iconSize: 18, onPressed: widget.aufAlsHauptchat, icon: const Icon(Icons.open_in_full)),
        IconButton(tooltip: 'Seiten-Chat schließen (Strg+Alt+S)', iconSize: 18, onPressed: widget.aufSchliessen, icon: const Icon(Icons.close)),
      ])),
      const Divider(height: 1),
      Expanded(child: eintraege.isEmpty
          ? Center(child: Padding(padding: const EdgeInsets.all(24), child: Text('Zwischenfrage stellen — der Hauptchat bleibt, wie er ist.', textAlign: TextAlign.center, style: theme.textTheme.bodySmall?.copyWith(color: dim))))
          : ListView.builder(reverse: true, padding: const EdgeInsets.all(12), itemCount: eintraege.length, itemBuilder: (_, i) {
              final (du, text) = eintraege[eintraege.length - 1 - i];
              return Align(alignment: du ? Alignment.centerRight : Alignment.centerLeft, child: Container(
                margin: const EdgeInsets.symmetric(vertical: 4),
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                constraints: const BoxConstraints(maxWidth: 320),
                decoration: BoxDecoration(color: du ? theme.colorScheme.primaryContainer : theme.colorScheme.surface, borderRadius: BorderRadius.circular(10)),
                child: du ? SelectableText(text, style: theme.textTheme.bodySmall) : AlfredText(text),
              ));
            })),
      Padding(padding: const EdgeInsets.all(8), child: Focus(
        onKeyEvent: (_, ev) {
          if (ev is KeyDownEvent && (ev.logicalKey == LogicalKeyboardKey.enter || ev.logicalKey == LogicalKeyboardKey.numpadEnter) && !HardwareKeyboard.instance.isShiftPressed) { _senden(); return KeyEventResult.handled; }
          return KeyEventResult.ignored;
        },
        child: TextField(key: const Key('seiten-chat-eingabe'), controller: _eingabe, focusNode: _fokus, minLines: 1, maxLines: 5, enabled: !_sendet,
          decoration: InputDecoration(isDense: true, hintText: 'Zwischenfrage …', border: const OutlineInputBorder(), suffixIcon: IconButton(tooltip: 'Senden', onPressed: _sendet ? null : _senden, icon: const Icon(Icons.send, size: 18)))),
      )),
    ]));
  }
}
