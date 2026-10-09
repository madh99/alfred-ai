import 'dart:async';
import 'dart:io';

/// 1.0.3 — Tastenkürzel unter Linux/Wayland. hotkey_manager bindet über keybinder (X11) und scheitert unter Wayland
/// („Binding '<Primary><Alt>KP_Space' failed!", Ubuntu-VM 09.10.). Weg über die Oberfläche: ein eigenes GNOME-Tastenkürzel
/// (gsettings, media-keys) startet `alfred_app --sprechen`; dieser zweite Prozess schickt der laufenden App SIGUSR1
/// (PID-Datei im Laufzeitordner) und beendet sich. Die App schaltet darauf das Mikrofon um.
class LinuxHotkey {
  static const _schema = 'org.gnome.settings-daemon.plugins.media-keys';
  static const _pfad = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/alfred-sprechen/';

  static bool get wayland => (Platform.environment['WAYLAND_DISPLAY'] ?? '').isNotEmpty || Platform.environment['XDG_SESSION_TYPE'] == 'wayland';

  static String get pidDatei {
    final dir = Platform.environment['XDG_RUNTIME_DIR'] ?? Directory.systemTemp.path;
    return '$dir/alfred-app.pid';
  }

  /// Laufende Instanz: PID merken und auf SIGUSR1 hören.
  static StreamSubscription<ProcessSignal> hoere(void Function() beiSignal) {
    try { File(pidDatei).writeAsStringSync('$pid'); } catch (_) { /* dann kein Kürzel */ }
    return ProcessSignal.sigusr1.watch().listen((_) => beiSignal());
  }

  /// Zweiter Prozess (`--sprechen`): Signal an die laufende Instanz. true = zugestellt.
  static Future<bool> signal() async {
    try {
      final p = int.tryParse((await File(pidDatei).readAsString()).trim());
      if (p == null) return false;
      return Process.killPid(p, ProcessSignal.sigusr1);
    } catch (_) { return false; }
  }

  /// GNOME-Tastenkürzel Strg+Alt+Leertaste anlegen oder nachziehen (idempotent). Liefert eine Meldung für den Verlauf.
  static Future<String?> einrichten() async {
    final exe = Platform.resolvedExecutable;
    try {
      final hat = await Process.run('sh', ['-c', 'command -v gsettings']);
      if (hat.exitCode != 0) return 'Kein gsettings — Tastenkürzel unter Wayland nicht eingerichtet.';
      final liste = await Process.run('gsettings', ['get', _schema, 'custom-keybindings']);
      if (liste.exitCode != 0) return 'GNOME-Tastenkürzel nicht verfügbar (${liste.stderr.toString().trim()}).';
      final pfade = RegExp(r"'([^']+)'").allMatches(liste.stdout.toString()).map((m) => m.group(1)!).toList();
      if (!pfade.contains(_pfad)) {
        pfade.add(_pfad);
        final r = await Process.run('gsettings', ['set', _schema, 'custom-keybindings', '[${pfade.map((p) => "'$p'").join(', ')}]']);
        if (r.exitCode != 0) return 'Tastenkürzel nicht angelegt: ${r.stderr.toString().trim()}';
      }
      final s = '$_schema.custom-keybinding:$_pfad';
      // Werte als GVariant-Zeichenkette ('…'), sonst „expected end of input" bei Leerzeichen/Anführungszeichen (VM 09.10.)
      String gv(String v) => "'${v.replaceAll("'", r"\'")}'";
      for (final (k, v) in [('name', 'Alfred: sprechen'), ('command', '"$exe" --sprechen'), ('binding', '<Control><Alt>space')]) {
        final r = await Process.run('gsettings', ['set', s, k, gv(v)]);
        if (r.exitCode != 0) return 'Tastenkürzel unvollständig ($k): ${r.stderr.toString().trim()}';
      }
      return null;
    } catch (e) { return 'Tastenkürzel nicht eingerichtet: $e'; }
  }
}
