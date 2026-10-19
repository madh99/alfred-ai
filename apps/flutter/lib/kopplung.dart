/// Phase 5 H1 (Spec Geräte §20.4) — Kopplung auf dem Handy: Server + Code (aus der Web-Kachel „Geräte“, auch als QR-Inhalt),
/// Schlüssel-Fingerabdruck des Servers anzeigen bzw. mit dem QR vergleichen, dann mit `/api/geraete/pair` koppeln.
/// Der Schlüssel wird gemerkt (Pinning); danach nimmt die App nur noch Verbindungen mit genau diesem Schlüssel an.
library;

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'handy_verbindung.dart';
import 'plattform.dart';
import 'spki.dart';
import 'tls.dart';

class KopplungsAnsicht extends StatefulWidget {
  const KopplungsAnsicht({super.key, required this.version, required this.aufGekoppelt, this.hinweis,
    this.schluesselHolen = serverSchluessel, this.koppelnMit = koppeln, this.namensVorschlag = 'iPhone', this.automatisch});
  final String version;
  final Future<void> Function(Kopplung k) aufGekoppelt;
  final String? hinweis;
  /// austauschbar für Tests
  final Future<String> Function(String server) schluesselHolen;
  final Future<Kopplung> Function({required String server, required String code, required String name, required String spki, required String version}) koppelnMit;
  final String namensVorschlag;
  /// Beweislauf: QR-Inhalt (JSON {server, code, spki, name?}) → prüfen und koppeln ohne Antippen; der Schlüssel muss zum QR passen
  final String? automatisch;

  @override
  State<KopplungsAnsicht> createState() => _KopplungsAnsichtState();
}

class _KopplungsAnsichtState extends State<KopplungsAnsicht> {
  final _server = TextEditingController(text: 'https://192.168.1.92:3420');
  final _code = TextEditingController();
  late final _name = TextEditingController(text: widget.namensVorschlag);
  final _qr = TextEditingController();
  String? _spki, _qrSpki, _fehler;
  bool _laeuft = false;

  void _qrUebernehmen(String t) {
    final q = qrInhalt(t);
    if (q == null) { if (t.trim().isNotEmpty) setState(() => _fehler = 'Kein gültiger Kopplungs-Inhalt'); return; }
    setState(() { _server.text = q.server; _code.text = q.code; _qrSpki = q.spki; _fehler = null; _spki = null; });
  }

  @override
  void initState() {
    super.initState();
    final a = widget.automatisch;
    if (a != null && a.isNotEmpty) {
      try { final n = (jsonDecode(a) as Map<String, dynamic>)['name']; if (n is String && n.isNotEmpty) _name.text = n; } catch (_) {}
      _qr.text = a; _qrUebernehmen(a);
      WidgetsBinding.instance.addPostFrameCallback((_) async { await _pruefen(); if (_spki != null && _qrSpki != null) await _koppeln(); });
    }
  }

  /// QR der Web-Seite „Geräte“ mit der Kamera lesen; danach wird der Server sofort geprüft (Vergleich mit dem Fingerabdruck im QR).
  Future<void> _scannen() async {
    final text = await Navigator.of(context).push<String>(MaterialPageRoute(fullscreenDialog: true, builder: (_) => const _QrScanner()));
    if (text == null || !mounted) return;
    _qr.text = text; _qrUebernehmen(text);
    if (qrInhalt(text) != null) await _pruefen();
  }

  String get _serverAdresse => _server.text.trim().replaceAll(RegExp(r'/+$'), '');

  Future<void> _pruefen() async {
    setState(() { _laeuft = true; _fehler = null; _spki = null; });
    try {
      if (!_serverAdresse.startsWith('https://')) throw Exception('Adresse muss mit https:// beginnen');
      final fp = await widget.schluesselHolen(_serverAdresse);
      if (_qrSpki != null && fp != _qrSpki) throw Exception('$zertifikatUnbekannt (Schlüssel passt nicht zum QR)');
      setState(() => _spki = fp);
    } catch (e) {
      setState(() => _fehler = '$e'.replaceFirst('Exception: ', ''));
    } finally { if (mounted) setState(() => _laeuft = false); }
  }

  Future<void> _koppeln() async {
    final fp = _spki; if (fp == null) return;
    setState(() { _laeuft = true; _fehler = null; });
    try {
      final k = await widget.koppelnMit(server: _serverAdresse, code: _code.text.trim(), name: _name.text.trim().isEmpty ? widget.namensVorschlag : _name.text.trim(), spki: fp, version: widget.version);
      await widget.aufGekoppelt(k);
    } catch (e) {
      setState(() => _fehler = '$e'.replaceFirst('Exception: ', ''));
    } finally { if (mounted) setState(() => _laeuft = false); }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dim = theme.colorScheme.onSurfaceVariant;
    return Scaffold(body: SafeArea(child: ListView(padding: const EdgeInsets.fromLTRB(20, 24, 20, 24), children: [
      Row(children: [
        ClipRRect(borderRadius: BorderRadius.circular(10), child: Image.asset('assets/alfred.png', width: 44, height: 44)),
        const SizedBox(width: 12),
        Expanded(child: Text('Alfred koppeln', style: theme.textTheme.headlineSmall)),
      ]),
      const SizedBox(height: 8),
      Text('Im Web unter Geräte einen Kopplungscode erzeugen. Den QR-Inhalt hier einfügen oder Server und Code eintippen.', style: theme.textTheme.bodyMedium?.copyWith(color: dim)),
      if (widget.hinweis != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(widget.hinweis!, style: TextStyle(color: theme.colorScheme.error))),
      const SizedBox(height: 16),
      if (istHandy) ...[
        OutlinedButton.icon(key: const Key('kopplung-scannen'), onPressed: _laeuft ? null : _scannen, icon: const Icon(Icons.qr_code_scanner), label: const Text('QR-Code scannen')),
        const SizedBox(height: 12),
      ],
      TextField(key: const Key('kopplung-qr'), controller: _qr, decoration: const InputDecoration(labelText: 'QR-Inhalt (optional)', border: OutlineInputBorder()), onChanged: _qrUebernehmen, maxLines: 2),
      const SizedBox(height: 12),
      TextField(key: const Key('kopplung-server'), controller: _server, keyboardType: TextInputType.url, autocorrect: false, decoration: const InputDecoration(labelText: 'Server', border: OutlineInputBorder()), onChanged: (_) => setState(() => _spki = null)),
      const SizedBox(height: 12),
      TextField(key: const Key('kopplung-code'), controller: _code, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Kopplungscode', border: OutlineInputBorder())),
      const SizedBox(height: 12),
      TextField(key: const Key('kopplung-name'), controller: _name, decoration: const InputDecoration(labelText: 'Name dieses Geräts', border: OutlineInputBorder())),
      const SizedBox(height: 16),
      if (_spki == null) FilledButton.icon(key: const Key('kopplung-pruefen'), onPressed: _laeuft ? null : _pruefen, icon: const Icon(Icons.verified_user_outlined), label: const Text('Server prüfen'))
      else ...[
        Card(child: Padding(padding: const EdgeInsets.all(12), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Schlüssel des Servers', style: theme.textTheme.labelMedium?.copyWith(color: dim)),
          Text(fingerabdruckKurz(_spki!), key: const Key('kopplung-fingerabdruck'), style: theme.textTheme.titleLarge?.copyWith(fontFamily: 'monospace', letterSpacing: 1)),
          const SizedBox(height: 4),
          Text(_qrSpki != null ? '✓ stimmt mit dem QR überein' : 'Vergleiche mit der Anzeige im Web (Geräte → Kopplung).', key: const Key('kopplung-vergleich'), style: theme.textTheme.bodySmall?.copyWith(color: _qrSpki != null ? Colors.green : dim)),
        ]))),
        const SizedBox(height: 12),
        FilledButton.icon(key: const Key('kopplung-koppeln'), onPressed: _laeuft || _code.text.trim().isEmpty ? null : _koppeln, icon: const Icon(Icons.link), label: const Text('Koppeln')),
      ],
      if (_laeuft) const Padding(padding: EdgeInsets.only(top: 12), child: Center(child: CircularProgressIndicator())),
      if (_fehler != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_fehler!, key: const Key('kopplung-fehler'), style: TextStyle(color: theme.colorScheme.error))),
    ])));
  }
}

/// Kamera-Ansicht: der erste lesbare QR-Code geht an die Kopplung zurück.
class _QrScanner extends StatefulWidget {
  const _QrScanner();
  @override
  State<_QrScanner> createState() => _QrScannerState();
}

class _QrScannerState extends State<_QrScanner> {
  bool _fertig = false;
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('QR-Code der Seite „Geräte“')),
    body: MobileScanner(onDetect: (c) {
      final v = c.barcodes.map((b) => b.rawValue).whereType<String>().firstOrNull;
      if (v == null || _fertig) return;
      _fertig = true;
      Navigator.of(context).pop(v);
    }),
  );
}
