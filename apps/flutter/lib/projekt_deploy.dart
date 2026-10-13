import 'package:flutter/material.dart';
import 'aufgaben.dart' show JsonAbruf;

/// 1.24.0 — Deploy eines Geräte-Projekts (v1437/v1439). 1.25.0 (v1443 B15) — je Stufe dev/test/prod ein eigenes Ziel, Hochstufen
/// (der in der Stufe davor grüne Stand), die Projektumgebung der Stufe geht als .env mit.
/// Ziel, Deploy, Hochstufen und Rollback gehen immer zur Bestätigung an den Owner — die App stellt nur die Anfrage.
const prozessText = {'pm2': 'pm2', 'systemd': 'systemd', 'docker-compose': 'Docker Compose'};
const stufen = ['dev', 'test', 'prod'];
const tokenText = {'projekt': 'Projekt-Token (Projektumgebung)', 'gitlab': 'vorhandenes GitLab-Token', 'github': 'vorhandenes GitHub-Token'};
String? naechste(String s) => s == 'dev' ? 'test' : s == 'test' ? 'prod' : null;

class ProjektDeploy extends StatefulWidget {
  const ProjektDeploy({super.key, required this.id, required this.json, required this.deploy, required this.neuLaden, this.aufMeldung});
  final String id;
  final JsonAbruf json;
  final Map<String, dynamic>? deploy;
  final Future<void> Function() neuLaden;
  final void Function(String text)? aufMeldung;
  @override
  State<ProjektDeploy> createState() => _ProjektDeployState();
}

class _ProjektDeployState extends State<ProjektDeploy> {
  String? bearbeiten; // Stufe, deren Ziel gerade bearbeitet wird
  bool sendet = false;
  String? meldung;
  bool meldungOk = true;
  final host = TextEditingController(), user = TextEditingController(), port = TextEditingController(), branch = TextEditingController(), env = TextEditingController();
  String prozess = 'pm2';
  bool autoDev = false;

  Map<String, dynamic> stufe(String s) => ((widget.deploy?['stufen'] as Map<String, dynamic>?)?[s] as Map<String, dynamic>?) ?? const {};

  @override
  void dispose() { for (final c in [host, user, port, branch, env]) { c.dispose(); } super.dispose(); }

  void oeffnen(String s) {
    final z = (stufe(s)['ziel'] as Map<String, dynamic>?) ?? const {};
    host.text = '${z['host'] ?? ''}'; user.text = '${z['user'] ?? ''}'; port.text = z['appPort'] != null ? '${z['appPort']}' : '';
    branch.text = '${z['branch'] ?? ''}'; env.text = '${z['envStage'] ?? ''}'; prozess = '${z['prozess'] ?? 'pm2'}'; autoDev = z['autoDev'] == true;
    setState(() => bearbeiten = s);
  }

  Future<void> senden(String aktion, Map<String, dynamic> felder) async {
    setState(() { sendet = true; meldung = null; });
    try {
      final r = await widget.json('/api/geraete/projekte/${widget.id}', methode: 'POST', koerper: {'aktion': aktion, 'deploy': felder});
      final ok = r['success'] == true;
      if (!mounted) return;
      setState(() { meldungOk = ok; meldung = ok ? '${r['display'] ?? 'Gestellt.'}' : '${r['error'] ?? 'Fehler'}'; if (ok) bearbeiten = null; });
      if (ok) { widget.aufMeldung?.call(aktion == 'deploy' ? '🚀 Deploy zur Bestätigung gestellt' : aktion == 'hochstufen' ? '⬆️ Hochstufen zur Bestätigung gestellt' : aktion == 'rollback' ? '⏪ Rollback zur Bestätigung gestellt' : '🎯 Deploy-Ziel zur Bestätigung gestellt'); await widget.neuLaden(); }
    } catch (e) { if (mounted) setState(() { meldungOk = false; meldung = '$e'; }); }
    finally { if (mounted) setState(() => sendet = false); }
  }

  Widget _stufe(ThemeData theme, String s, String? repo) {
    final dim = theme.colorScheme.onSurfaceVariant;
    final e = stufe(s);
    final hatZiel = e.isNotEmpty;
    final bestaetigt = e['bestaetigt'] == true;
    final letzter = e['letzter'] as Map<String, dynamic>?;
    final zeit = DateTime.tryParse('${letzter?['zeit'] ?? ''}')?.toLocal();
    final n = naechste(s);
    final nZiel = n != null ? stufe(n) : const <String, dynamic>{};
    final kannHoch = n != null && letzter?['ok'] == true && letzter?['nachher'] != null && nZiel['bestaetigt'] == true;
    return Padding(key: Key('deploy-stufe-$s'), padding: const EdgeInsets.only(top: 10), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        Text(s, style: theme.textTheme.labelLarge),
        const SizedBox(width: 8),
        Expanded(child: Text(hatZiel ? '${e['zielText'] ?? ''}${bestaetigt ? '' : ' (nicht bestätigt)'}' : 'kein Ziel', style: theme.textTheme.bodySmall?.copyWith(color: hatZiel ? null : dim))),
        TextButton(key: Key('deploy-ziel-$s'), onPressed: sendet ? null : () => bearbeiten == s ? setState(() => bearbeiten = null) : oeffnen(s), child: Text(bearbeiten == s ? 'Abbrechen' : hatZiel ? 'Ändern' : 'Festlegen')),
      ]),
      if (letzter != null) Text('${letzter['ok'] == true ? '✅' : '❌'} ${zeit != null ? '${zeit.day}.${zeit.month}. ${zeit.hour.toString().padLeft(2, '0')}:${zeit.minute.toString().padLeft(2, '0')} ' : ''}${letzter['nachher'] != null ? '${'${letzter['nachher']}'.substring(0, 7)} · ' : ''}${'${letzter['text'] ?? ''}'.split('\n').first}', key: Key('deploy-letzter-$s'), style: theme.textTheme.bodySmall?.copyWith(color: letzter['ok'] == true ? null : theme.colorScheme.error)),
      if (bearbeiten == s) ...[
        TextField(key: const Key('deploy-host'), controller: host, onChanged: (_) => setState(() {}), decoration: const InputDecoration(labelText: 'Zielrechner (IP oder Name)', hintText: '192.168.1.96')),
        TextField(key: const Key('deploy-user'), controller: user, decoration: const InputDecoration(labelText: 'SSH-Benutzer (Standard root)')),
        Row(children: [const Text('Prozess: '), DropdownButton<String>(key: const Key('deploy-prozess'), value: prozess, items: [for (final e in prozessText.entries) DropdownMenuItem(value: e.key, child: Text(e.value))], onChanged: (v) => setState(() => prozess = v ?? 'pm2'))]),
        TextField(key: const Key('deploy-port'), controller: port, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Port der App (für die HTTP-Prüfung, optional)')),
        TextField(controller: branch, decoration: const InputDecoration(labelText: 'Zweig (optional)')),
        TextField(controller: env, decoration: InputDecoration(labelText: 'Umgebung als .env (Standard: $s)')),
        if (s == 'dev') SwitchListTile(key: const Key('deploy-autodev'), contentPadding: EdgeInsets.zero, dense: true, value: autoDev, onChanged: (v) => setState(() => autoDev = v), title: const Text('Automatisch nach grüner Abnahme aller Etappen')),
        Row(children: [
          if (hatZiel) TextButton(onPressed: sendet ? null : () => senden('deploy_ziel_entfernen', {'stufe': s}), child: const Text('Ziel entfernen')),
          const Spacer(),
          FilledButton(key: const Key('deploy-ziel-speichern'), onPressed: sendet || host.text.trim().isEmpty ? null : () => senden('deploy_ziel', {
            'stufe': s, 'host': host.text.trim(), 'user': user.text.trim(), 'process_manager': prozess, if (s == 'dev') 'auto_dev': autoDev,
            if (int.tryParse(port.text.trim()) != null) 'app_port': int.parse(port.text.trim()), 'branch': branch.text.trim(), 'env_stage': env.text.trim(),
          }), child: const Text('Zur Bestätigung')),
        ]),
      ],
      if (hatZiel && bearbeiten != s) Wrap(spacing: 8, children: [
        FilledButton.tonalIcon(key: Key('deploy-start-$s'), onPressed: sendet || !bestaetigt || repo == null ? null : () => senden('deploy', {'stufe': s}), icon: const Icon(Icons.rocket_launch_outlined), label: const Text('Deployen')),
        if (n != null) OutlinedButton.icon(key: Key('deploy-hoch-$s'), onPressed: sendet || !kannHoch ? null : () => senden('hochstufen', {'von': s, 'nach': n}), icon: const Icon(Icons.arrow_upward), label: Text('nach $n')),
        OutlinedButton.icon(key: Key('deploy-rollback-$s'), onPressed: sendet || letzter?['vorher'] == null ? null : () => senden('rollback', {'stufe': s}), icon: const Icon(Icons.undo), label: const Text('Rollback')),
      ]),
    ]));
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dim = theme.colorScheme.onSurfaceVariant;
    final d = widget.deploy;
    if (d == null) return const SizedBox.shrink(); // älterer Server
    final repo = d['repoUrl'] as String?;
    final token = d['token'] as String?;
    return Card(key: const Key('projekt-deploy'), margin: const EdgeInsets.only(top: 12), child: Padding(padding: const EdgeInsets.all(12), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('Deploy', style: theme.textTheme.titleSmall),
      Text(repo == null ? 'Kein Remote — der Deploy holt den Stand aus dem Repo.' : 'Repo: $repo · ${token == null ? 'kein Token gefunden' : 'Token: ${tokenText[token] ?? token}'}', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
      for (final s in stufen) _stufe(theme, s, repo),
      const SizedBox(height: 6),
      Text('Ziel, Deploy, Hochstufen und Rollback brauchen deine Bestätigung. Die Umgebung der Stufe geht als .env aufs Ziel; danach prüft Alfred Status, HTTP und Logs.', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
      if (meldung != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(meldung!, style: TextStyle(color: meldungOk ? Colors.green : theme.colorScheme.error))),
    ])));
  }
}
