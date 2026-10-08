import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'modell.dart';

/// HTTP zum Gehirn mit dem Gerätetoken — dieselben Routen wie die Terminal-Sitzung (v1232): Chat mit Streaming (SSE),
/// offene Bestätigungen, Entscheidung. `insecure` = selbst signiertes Zertifikat des Servers akzeptieren (wie beim Satelliten).
class Server {
  Server(this.k) {
    _client = HttpClient();
    if (k.insecure) _client.badCertificateCallback = (cert, host, port) => true;
  }

  final Konfig k;
  late final HttpClient _client;

  String get chatId => 'sitzung:${k.geraetId}';

  Future<HttpClientRequest> _anfrage(String methode, String pfad) async {
    final req = await _client.openUrl(methode, Uri.parse('${k.server}$pfad'));
    req.headers.set('Authorization', 'Bearer ${k.token}');
    req.headers.set('Content-Type', 'application/json; charset=utf-8');
    return req;
  }

  /// Meilenstein 3 — JSON einer erlaubten Route (Kacheln).
  Future<Map<String, dynamic>> json(String pfad) async {
    final req = await _anfrage('GET', pfad);
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
  Future<String> sende(String text, {required void Function(String) aufDelta, required void Function(String) aufStatus, String? tier}) async {
    final req = await _anfrage('POST', '/api/message');
    final body = jsonEncode({'text': text, 'chatId': chatId, 'stream': true, 'tier': ?tier});
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
        else if (typ == 'error') { throw Exception('${e['text'] ?? 'unbekannt'}'); }
      }
    }
    return antwort;
  }
}
