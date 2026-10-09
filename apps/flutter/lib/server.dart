import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'modell.dart';

/// 1.0.5 — MIME-Typ aus der Dateiendung (für Anhänge aus dem SSE-Strom).
String _mimeAusName(String name) {
  final e = name.contains('.') ? name.split('.').last.toLowerCase() : '';
  const m = {'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png', 'gif': 'image/gif', 'webp': 'image/webp', 'pdf': 'application/pdf', 'txt': 'text/plain', 'md': 'text/markdown', 'csv': 'text/csv', 'json': 'application/json', 'zip': 'application/zip', 'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'mp4': 'video/mp4'};
  return m[e] ?? 'application/octet-stream';
}

/// HTTP zum Gehirn mit dem Gerätetoken — dieselben Routen wie die Terminal-Sitzung (v1232): Chat mit Streaming (SSE),
/// offene Bestätigungen, Entscheidung. `insecure` = selbst signiertes Zertifikat des Servers akzeptieren (wie beim Satelliten).
class Server {
  Server(this.k) {
    _client = HttpClient();
    if (k.insecure) _client.badCertificateCallback = (cert, host, port) => true;
  }

  final Konfig k;
  late final HttpClient _client;
  /// 1.2.0 — aktueller Gesprächsfaden (null = Hauptgespräch); Chat-ID `sitzung:<geraetId>[:<faden>]` (v1328).
  String? faden;

  String get chatId => faden == null ? 'sitzung:${k.geraetId}' : 'sitzung:${k.geraetId}:$faden'; // 1.2.0 Fäden

  Future<HttpClientRequest> _anfrage(String methode, String pfad) async {
    final req = await _client.openUrl(methode, Uri.parse('${k.server}$pfad'));
    req.headers.set('Authorization', 'Bearer ${k.token}');
    req.headers.set('Content-Type', 'application/json; charset=utf-8');
    return req;
  }

  /// M6 — rohe Antwort (Download des Installers).
  Future<HttpClientResponse> hole(String pfad) async {
    final req = await _anfrage('GET', pfad);
    return req.close();
  }

  /// Meilenstein 3 — JSON einer erlaubten Route (Kacheln).
  Future<Map<String, dynamic>> json(String pfad, {String methode = 'GET'}) async {
    final req = await _anfrage(methode, pfad);
    final res = await req.close();
    final body = await res.transform(utf8.decoder).join();
    if (res.statusCode != 200) throw Exception('HTTP ${res.statusCode}: ${body.length > 120 ? body.substring(0, 120) : body}');
    return jsonDecode(body) as Map<String, dynamic>;
  }

  Future<List<Bestaetigung>> offeneBestaetigungen() async {
    final req = await _anfrage('GET', '/api/confirmations/pending');
    final res = await req.close();
    if (res.statusCode != 200) return [];
    final body = await res.transform(utf8.decoder).join();
    final liste = (jsonDecode(body) as Map<String, dynamic>)['confirmations'] as List<dynamic>? ?? [];
    return liste.map((b) {
      final m = b as Map<String, dynamic>;
      return Bestaetigung(id: '${m['id']}', text: '${m['description'] ?? m['skillName'] ?? ''}', quelle: m['source'] as String?, seit: DateTime.tryParse('${m['createdAt'] ?? ''}'));
    }).toList();
  }

  Future<String> entscheide(String id, bool ja) async {
    final req = await _anfrage('POST', '/api/confirmations/${Uri.encodeComponent(id)}/${ja ? 'approve' : 'reject'}');
    final res = await req.close();
    final body = await res.transform(utf8.decoder).join();
    return res.statusCode == 200 ? (ja ? 'freigegeben' : 'abgelehnt') : 'HTTP ${res.statusCode}: ${body.length > 120 ? body.substring(0, 120) : body}';
  }

  /// Meilenstein 2 — Audio zum Gehirn (Transkription) und Text vom Gehirn als Sprache (mp3).
  Future<String> transkribiere(List<int> audio, String mime) async {
    final req = await _anfrage('POST', '/api/transcribe');
    req.headers.set('Content-Type', mime);
    req.headers.contentLength = audio.length;
    req.add(audio);
    final res = await req.close();
    final body = await res.transform(utf8.decoder).join();
    if (res.statusCode != 200) throw Exception('Transkription HTTP ${res.statusCode}: ${body.length > 120 ? body.substring(0, 120) : body}');
    return '${(jsonDecode(body) as Map<String, dynamic>)['text'] ?? ''}'.trim();
  }

  Future<(List<int>, String)> sprich(String text) async {
    final req = await _anfrage('POST', '/api/sprich');
    req.add(utf8.encode(jsonEncode({'text': text, 'knapp': false}))); // UTF-8: req.write kodiert Latin-1 — „–" und „„" warfen „Contains invalid characters" (Owner 14:26)
    final res = await req.close();
    final teile = <int>[];
    await for (final c in res) { teile.addAll(c); }
    if (res.statusCode != 200) throw Exception('Sprache HTTP ${res.statusCode}');
    return (teile, res.headers.contentType?.mimeType ?? 'audio/mpeg');
  }

  /// Nachricht senden; `aufDelta` bekommt Textstücke, `aufStatus` Zwischenstände (Werkzeuge, Denken). Liefert den Endtext.
  Future<String> sende(String text, {required void Function(String) aufDelta, required void Function(String) aufStatus, void Function(Anhang)? aufAnhang, String? tier, String? bezug}) async {
    final req = await _anfrage('POST', '/api/message');
    // 1.2.2 — Bezug auf eine frühere Alfred-Nachricht (wie Antworten in Telegram): replyToText/replyToFrom wie in der Web-Oberfläche
    final body = jsonEncode({'text': text, 'chatId': chatId, 'stream': true, 'tier': ?tier, if (bezug != null && bezug.trim().isNotEmpty) ...{'replyToText': bezug, 'replyToFrom': 'Alfred'}});
    req.add(utf8.encode(body)); // UTF-8 statt Latin-1
    final res = await req.close();
    if (res.statusCode != 200) {
      final t = await res.transform(utf8.decoder).join();
      throw Exception('HTTP ${res.statusCode}: ${t.length > 200 ? t.substring(0, 200) : t}');
    }
    var antwort = '';
    var puffer = '';
    await for (final stueck in res.transform(utf8.decoder)) {
      puffer += stueck;
      while (true) {
        final i = puffer.indexOf('\n\n');
        if (i < 0) break;
        final block = puffer.substring(0, i);
        puffer = puffer.substring(i + 2);
        final zeile = block.split('\n').firstWhere((l) => l.startsWith('data: '), orElse: () => '');
        if (zeile.isEmpty) continue;
        Map<String, dynamic> e;
        try { e = jsonDecode(zeile.substring(6)) as Map<String, dynamic>; } catch (_) { continue; }
        final typ = e['type'];
        if (typ == 'progress' && e['kind'] == 'delta') { aufDelta('${e['text'] ?? ''}'); }
        else if (typ == 'progress' || typ == 'status') { aufStatus('${e['text'] ?? ''}'); }
        else if (typ == 'response') { antwort = '${e['text'] ?? ''}'; }
        else if (typ == 'attachment' && e['data'] is String) { // 1.0.5 — Bild/Datei aus der Antwort (bisher verworfen)
          try {
            final bild = e['attachmentType'] == 'image';
            final name = '${e['fileName'] ?? (bild ? 'bild-${DateTime.now().millisecondsSinceEpoch}.jpg' : 'datei')}';
            aufAnhang?.call(Anhang(name: name, mime: bild ? 'image/jpeg' : _mimeAusName(name), bytes: base64Decode(e['data'] as String)));
          } catch (_) { /* Anhang optional */ }
        }
        else if (typ == 'error') { throw Exception('${e['text'] ?? 'unbekannt'}'); }
      }
    }
    return antwort;
  }
}
