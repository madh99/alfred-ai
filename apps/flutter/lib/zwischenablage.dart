import 'dart:io';

/// 1.6.0 — Bild aus der Zwischenablage als Anhang (Owner-Freigabe 11.10., Punkt 3): Strg+V (macOS ⌘V) in der Eingabe legt
/// ein kopiertes Bild (Bildschirmfoto, Bild aus dem Browser) als PNG ab und hängt es an — Text wird wie gewohnt eingefügt.
/// Ohne Plugin über die Bordmittel: Windows PowerShell (System.Windows.Forms, STA), macOS AppleScript («class PNGf»),
/// Linux wl-paste (Wayland) bzw. xclip (X11). null = kein Bild in der Zwischenablage.
Future<File?> bildAusZwischenablage({Directory? ziel}) async {
  final dir = ziel ?? Directory.systemTemp;
  final stempel = DateTime.now();
  String zz(int x) => x.toString().padLeft(2, '0');
  final f = File('${dir.path}${Platform.pathSeparator}eingefuegt-${stempel.year}${zz(stempel.month)}${zz(stempel.day)}-${zz(stempel.hour)}${zz(stempel.minute)}${zz(stempel.second)}.png');
  try {
    if (Platform.isWindows) {
      final pfad = f.path.replaceAll("'", "''");
      final r = await Process.run('powershell', ['-NoProfile', '-STA', '-Command',
        "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; \$i = [System.Windows.Forms.Clipboard]::GetImage(); if (\$i) { \$i.Save('$pfad', [System.Drawing.Imaging.ImageFormat]::Png); 'ok' }"]);
      if ('${r.stdout}'.trim() != 'ok') return null;
    } else if (Platform.isMacOS) {
      final pfad = f.path.replaceAll('"', '\\"');
      final r = await Process.run('osascript', ['-e', 'try', '-e', 'set d to the clipboard as «class PNGf»', '-e', 'set h to open for access POSIX file "$pfad" with write permission', '-e', 'write d to h', '-e', 'close access h', '-e', 'return "ok"', '-e', 'on error', '-e', 'return "nein"', '-e', 'end try']);
      if ('${r.stdout}'.trim() != 'ok') return null;
    } else {
      final wayland = Platform.environment['WAYLAND_DISPLAY'] != null;
      final typen = await Process.run(wayland ? 'wl-paste' : 'xclip', wayland ? ['--list-types'] : ['-selection', 'clipboard', '-t', 'TARGETS', '-o']);
      if (!'${typen.stdout}'.contains('image/png')) return null;
      final r = await Process.run(wayland ? 'wl-paste' : 'xclip', wayland ? ['--no-newline', '--type', 'image/png'] : ['-selection', 'clipboard', '-t', 'image/png', '-o'], stdoutEncoding: null);
      final daten = r.stdout is List<int> ? r.stdout as List<int> : const <int>[];
      if (daten.isEmpty) return null;
      await f.writeAsBytes(daten, flush: true);
    }
    return await f.exists() && await f.length() > 0 ? f : null;
  } catch (_) { return null; }
}
