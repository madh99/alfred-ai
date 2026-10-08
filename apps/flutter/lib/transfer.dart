import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

import 'modell.dart';

/// Meilenstein 3 — Datei zum Gehirn, derselbe Weg wie der Satellit (v1241/v1249): Start mit Name, Größe und SHA-256,
/// Blöcke per PUT mit Offset, bei Verbindungsabbruch Stand abfragen und weitermachen, zum Schluss `fertig` → Schlüssel
/// im Dateispeicher des Owners. Die Prüfsumme prüft das Gehirn; stimmt sie nicht, gibt es keinen Schlüssel.
class Transfer {
  Transfer(this.k) {
    _client = HttpClient();
    if (k.insecure) _client.badCertificateCallback = (cert, host, port) => true;
  }
  final Konfig k;
  late final HttpClient _client;

  Future<HttpClientRequest> _anfrage(String methode, String pfad) async {
    final req = await _client.openUrl(methode, Uri.parse('${k.server}$pfad'));
    req.headers.set('Authorization', 'Bearer ${k.token}');
    return req;
  }

  Future<Map<String, dynamic>> _json(HttpClientRequest req, [Object? body]) async {
    if (body != null) { req.headers.set('Content-Type', 'application/json; charset=utf-8'); req.add(utf8.encode(jsonEncode(body))); }
    final res = await req.close();
    final text = await res.transform(utf8.decoder).join();
    if (res.statusCode != 200) throw Exception('HTTP ${res.statusCode}: ${text.length > 160 ? text.substring(0, 160) : text}');
    return jsonDecode(text) as Map<String, dynamic>;
  }

  /// Lädt die Datei hoch; `fortschritt` bekommt gesendete Bytes. Liefert Schlüssel und Prüfsumme.
  Future<({String key, String sha256, int groesse})> hochladen(File datei, {void Function(int gesendet, int gesamt)? fortschritt}) async {
    final name = datei.uri.pathSegments.last;
    final groesse = await datei.length();
    final hash = (await sha256.bind(datei.openRead()).first).toString();
    final start = await _json(await _anfrage('POST', '/api/geraete/dateien'), {'name': name, 'groesse': groesse, 'sha256': hash});
    final id = '${start['id']}';
    final block = (start['blockGroesse'] as num?)?.toInt() ?? 1024 * 1024;
    var offset = 0;
    var fehler = 0;
    final raf = await datei.open();
    try {
      while (offset < groesse) {
        final n = (groesse - offset) < block ? groesse - offset : block;
        await raf.setPosition(offset);
        final daten = await raf.read(n);
        try {
          final req = await _anfrage('PUT', '/api/geraete/dateien/$id?offset=$offset');
          req.headers.set('Content-Type', 'application/octet-stream');
          req.headers.contentLength = daten.length;
          req.add(daten);
          final res = await req.close();
          final text = await res.transform(utf8.decoder).join();
          Map<String, dynamic> r = {};
          try { r = jsonDecode(text.isEmpty ? '{}' : text) as Map<String, dynamic>; } catch (_) {}
          // 409 + empfangen = falscher Offset (z. B. nach Abbruch): dort weitermachen — wie der Satellit (v1249)
          if (res.statusCode == 409 && r['empfangen'] is num) { offset = (r['empfangen'] as num).toInt(); continue; }
          if (res.statusCode != 200) throw Exception('${r['error'] ?? 'Block HTTP ${res.statusCode}'}');
          offset = (r['empfangen'] as num?)?.toInt() ?? (offset + daten.length);
          fehler = 0;
          fortschritt?.call(offset, groesse);
        } catch (e) {
          if (++fehler > 5) rethrow;
          await Future<void>.delayed(Duration(seconds: fehler));
          try { final st = await _json(await _anfrage('GET', '/api/geraete/dateien/$id')); offset = (st['empfangen'] as num?)?.toInt() ?? offset; } catch (_) { /* nächster Versuch */ }
        }
      }
    } finally { await raf.close(); }
    final fertig = await _json(await _anfrage('POST', '/api/geraete/dateien/$id/fertig'));
    return (key: '${fertig['key']}', sha256: hash, groesse: groesse);
  }

  static String sha256Hex(Uint8List daten) => sha256.convert(daten).toString();
}
