/// 1.70.0 (Owner 20.10.: „1–5 wie vorgeschlagen“) — ein neues Gerät direkt aus der App koppeln: Kopplungscode vom Server
/// (/api/geraete/kopplungscode, nur Owner-Geräte; der Owner bekommt dazu eine Meldung), QR für die Handy-App, fertiger Befehl
/// mit Schlüsselprüfung für PC, Mac und Linux. Der Code gilt 5 Minuten und einmal.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:qr_flutter/qr_flutter.dart';

/// Befehl fürs Desktop-Koppeln, wie die Web-Oberfläche ihn zeigt.
String koppelBefehl({required String server, required String code, String? fingerabdruck}) =>
    'alfred pair --server $server --code $code --insecure${fingerabdruck != null ? ' --schluessel $fingerabdruck' : ''}';

/// Kurzform des Schlüssels zum Vergleichen: „75ed 3a0b c4f2 6c96“.
String schluesselKurz(String hex) => [for (var i = 0; i < 16 && i < hex.length; i += 4) hex.substring(i, i + 4)].join(' ');

Future<void> zeigeNeuesGeraet(BuildContext context, Future<Map<String, dynamic>> Function(String pfad, {String methode, Map<String, dynamic>? koerper}) json) async {
  Map<String, dynamic> r;
  try {
    r = await json('/api/geraete/kopplungscode', methode: 'POST', koerper: const {});
  } catch (e) {
    if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Kopplungscode nicht erhalten: $e')));
    return;
  }
  if (!context.mounted) return;
  await showDialog<void>(context: context, builder: (_) => _KoppelDialog(daten: r));
}

class _KoppelDialog extends StatefulWidget {
  const _KoppelDialog({required this.daten});
  final Map<String, dynamic> daten;
  @override
  State<_KoppelDialog> createState() => _KoppelDialogState();
}

class _KoppelDialogState extends State<_KoppelDialog> {
  Timer? _uhr;
  @override
  void initState() { super.initState(); _uhr = Timer.periodic(const Duration(seconds: 1), (_) { if (mounted) setState(() {}); }); }
  @override
  void dispose() { _uhr?.cancel(); super.dispose(); }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final d = widget.daten;
    final code = '${d['code']}', server = '${d['server']}';
    final fp = d['fingerabdruck'] as String?;
    final qr = d['qr'] as String?;
    final bis = DateTime.tryParse('${d['gueltigBis']}');
    final rest = bis == null ? 0 : bis.difference(DateTime.now()).inSeconds;
    final befehl = koppelBefehl(server: server, code: code, fingerabdruck: fp);
    final dim = t.colorScheme.onSurfaceVariant;
    return AlertDialog(
      title: const Text('Neues Gerät koppeln'),
      content: SizedBox(width: 420, child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (rest <= 0) Text('Der Code ist abgelaufen — bitte neu erzeugen.', style: TextStyle(color: t.colorScheme.error))
        else Text('Gültig noch ${rest ~/ 60}:${(rest % 60).toString().padLeft(2, '0')} min, nur einmal verwendbar.', style: t.textTheme.bodySmall?.copyWith(color: dim)),
        const SizedBox(height: 12),
        Center(child: SelectableText(code, key: const Key('koppel-code'), style: t.textTheme.headlineMedium?.copyWith(fontFamily: 'monospace', letterSpacing: 4))),
        if (qr != null && rest > 0) ...[
          const SizedBox(height: 12),
          Text('iPhone: in der Alfred-App „QR-Code scannen“', style: t.textTheme.titleSmall),
          const SizedBox(height: 6),
          Center(child: Container(color: Colors.white, padding: const EdgeInsets.all(8), child: QrImageView(data: qr, size: 200, backgroundColor: Colors.white))),
        ],
        const SizedBox(height: 14),
        Text('PC, Mac oder Linux: im Terminal ausführen', style: t.textTheme.titleSmall),
        const SizedBox(height: 6),
        Container(width: double.infinity, padding: const EdgeInsets.all(8), decoration: BoxDecoration(color: t.colorScheme.surfaceContainerHighest, borderRadius: BorderRadius.circular(8)),
          child: SelectableText(befehl, style: t.textTheme.bodySmall?.copyWith(fontFamily: 'monospace'))),
        Align(alignment: Alignment.centerRight, child: TextButton.icon(icon: const Icon(Icons.copy, size: 16), label: const Text('Befehl kopieren'), onPressed: () async {
          await Clipboard.setData(ClipboardData(text: befehl));
          if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Befehl kopiert')));
        })),
        if (fp != null) Text('Schlüssel des Servers: ${schluesselKurz(fp)} — der Befehl prüft ihn selbst.', style: t.textTheme.bodySmall?.copyWith(color: dim)),
        const SizedBox(height: 6),
        Text('Server: $server', style: t.textTheme.bodySmall?.copyWith(color: dim)),
      ]))),
      actions: [TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Schließen'))],
    );
  }
}
