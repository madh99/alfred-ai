import 'package:flutter/material.dart';
import 'aufgaben.dart' show JsonAbruf;

/// 1.24.0 — Deploy eines Geräte-Projekts (v1437/v1439): Ziel anzeigen und setzen, Deployen, Rollback, „automatisch in dev“.
/// Ziel, Deploy und Rollback gehen immer zur Bestätigung an den Owner (Telegram/Freigaben) — die App stellt nur die Anfrage.
const prozessText = {'pm2': 'pm2', 'systemd': 'systemd', 'docker-compose': 'Docker Compose'};
const stufeText = {'dev': 'dev', 'test': 'test', 'prod': 'prod'};
const tokenText = {'projekt': 'Projekt-Token (Projektumgebung)', 'gitlab': 'vorhandenes GitLab-Token', 'github': 'vorhandenes GitHub-Token'};

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
  bool bearbeiten = false, sendet = false;
  String? meldung;
  bool meldungOk = true;
  final host = TextEditingController(), user = TextEditingController(), port = TextEditingController(), branch = TextEditingController(), env = TextEditingController();
  String prozess = 'pm2', stufe = 'dev';
  bool autoDev = false;

  Map<String, dynamic> get ziel => (widget.deploy?['ziel'] as Map<String, dynamic>?) ?? const {};

  @override
  void dispose() { for (final c in [host, user, port, branch, env]) { c.dispose(); } super.dispose(); }

  void formularAusZiel() {
    host.text = '${ziel['host'] ?? ''}'; user.text = '${ziel['user'] ?? ''}'; port.text = ziel['appPort'] != null ? '${ziel['appPort']}' : '';
    branch.text = '${ziel['branch'] ?? ''}'; env.text = '${ziel['envStage'] ?? ''}';
    prozess = '${ziel['prozess'] ?? 'pm2'}'; stufe = '${ziel['stufe'] ?? 'dev'}'; autoDev = ziel['autoDev'] == true;
  }

  Future<void> senden(String aktion, [Map<String, dynamic>? felder]) async {
    setState(() { sendet = true; meldung = null; });
    try {
      final r = await widget.json('/api/geraete/projekte/${widget.id}', methode: 'POST', koerper: {'aktion': aktion, if (felder != null) 'deploy': felder});
      final ok = r['success'] == true;
      if (!mounted) return;
      setState(() { meldungOk = ok; meldung = ok ? '${r['display'] ?? 'Gestellt.'}' : '${r['error'] ?? 'Fehler'}'; if (ok) bearbeiten = false; });
      if (ok) { widget.aufMeldung?.call(aktion == 'deploy' ? '🚀 Deploy zur Bestätigung gestellt' : aktion == 'rollback' ? '⏪ Rollback zur Bestätigung gestellt' : '🎯 Deploy-Ziel zur Bestätigung gestellt'); await widget.neuLaden(); }
    } catch (e) { if (mounted) setState(() { meldungOk = false; meldung = '$e'; }); }
    finally { if (mounted) setState(() => sendet = false); }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dim = theme.colorScheme.onSurfaceVariant;
    final d = widget.deploy;
    if (d == null) return const SizedBox.shrink(); // älterer Server
    final hatZiel = ziel.isNotEmpty;
    final bestaetigt = d['bestaetigt'] == true;
    final repo = d['repoUrl'] as String?;
    final token = d['token'] as String?;
    final letzter = d['letzter'] as Map<String, dynamic>?;
    final zeit = DateTime.tryParse('${letzter?['zeit'] ?? ''}')?.toLocal();
    return Card(key: const Key('projekt-deploy'), margin: const EdgeInsets.only(top: 12), child: Padding(padding: const EdgeInsets.all(12), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        Expanded(child: Text('Deploy', style: theme.textTheme.titleSmall)),
        TextButton(key: const Key('deploy-ziel-bearbeiten'), onPressed: sendet ? null : () => setState(() { bearbeiten = !bearbeiten; if (bearbeiten) formularAusZiel(); }), child: Text(bearbeiten ? 'Abbrechen' : hatZiel ? 'Ziel ändern' : 'Ziel festlegen')),
      ]),
      Text(repo == null ? 'Kein Remote — der Deploy holt den Stand aus dem Repo (Projekt über „von GitLab holen“ anlegen).' : 'Repo: $repo · ${token == null ? 'kein Token gefunden (öffentliches Repo oder GIT_TOKEN in der Projektumgebung)' : 'Token: ${tokenText[token] ?? token}'}', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
      if (hatZiel) Text('Ziel: ${d['zielText'] ?? ''}${bestaetigt ? '' : ' (nicht bestätigt)'}', key: const Key('deploy-ziel-text'), style: theme.textTheme.bodySmall),
      if (!hatZiel && !bearbeiten) Text('Kein Deploy-Ziel — ohne Ziel bleibt alles wie bisher.', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
      if (letzter != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text('${letzter['ok'] == true ? '✅' : '❌'} Letzter Deploy${zeit != null ? ' ${zeit.day}.${zeit.month}. ${zeit.hour.toString().padLeft(2, '0')}:${zeit.minute.toString().padLeft(2, '0')}' : ''}:\n${letzter['text'] ?? ''}', key: const Key('deploy-letzter'), style: theme.textTheme.bodySmall?.copyWith(color: letzter['ok'] == true ? null : theme.colorScheme.error))),
      if (bearbeiten) ...[
        TextField(key: const Key('deploy-host'), controller: host, decoration: const InputDecoration(labelText: 'Zielrechner (IP oder Name)', hintText: '192.168.1.96')),
        TextField(key: const Key('deploy-user'), controller: user, decoration: const InputDecoration(labelText: 'SSH-Benutzer (Standard root)')),
        Row(children: [const Text('Prozess: '), DropdownButton<String>(key: const Key('deploy-prozess'), value: prozess, items: [for (final e in prozessText.entries) DropdownMenuItem(value: e.key, child: Text(e.value))], onChanged: (v) => setState(() => prozess = v ?? 'pm2')),
          const SizedBox(width: 16), const Text('Stufe: '), DropdownButton<String>(key: const Key('deploy-stufe'), value: stufe, items: [for (final e in stufeText.entries) DropdownMenuItem(value: e.key, child: Text(e.value))], onChanged: (v) => setState(() { stufe = v ?? 'dev'; if (stufe != 'dev') autoDev = false; }))]),
        TextField(key: const Key('deploy-port'), controller: port, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Port der App (für die HTTP-Prüfung, optional)')),
        TextField(controller: branch, decoration: const InputDecoration(labelText: 'Zweig (optional)')),
        TextField(controller: env, decoration: const InputDecoration(labelText: 'ENV-Stage als .env (optional, z. B. dev)')),
        SwitchListTile(key: const Key('deploy-autodev'), contentPadding: EdgeInsets.zero, dense: true, value: autoDev, onChanged: stufe == 'dev' ? (v) => setState(() => autoDev = v) : null,
          title: const Text('Automatisch in dev nach grüner Abnahme'), subtitle: Text('Nur Stufe dev; nach einem Lauf, dessen Etappen alle grün abgenommen sind.', style: theme.textTheme.bodySmall?.copyWith(color: dim))),
        Row(children: [
          if (hatZiel) TextButton(onPressed: sendet ? null : () => senden('deploy_ziel_entfernen'), child: const Text('Ziel entfernen')),
          const Spacer(),
          FilledButton(key: const Key('deploy-ziel-speichern'), onPressed: sendet || host.text.trim().isEmpty ? null : () => senden('deploy_ziel', {
            'host': host.text.trim(), 'user': user.text.trim(), 'process_manager': prozess, 'stufe': stufe, 'auto_dev': autoDev,
            if (int.tryParse(port.text.trim()) != null) 'app_port': int.parse(port.text.trim()), 'branch': branch.text.trim(), 'env_stage': env.text.trim(),
          }), child: const Text('Zur Bestätigung')),
        ]),
        Text('Das Ziel wird erst nach deiner Bestätigung gespeichert — dieser Rechner bekommt Code, ggf. .env und beim Holen das Token.', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
      ],
      if (hatZiel && !bearbeiten) Padding(padding: const EdgeInsets.only(top: 8), child: Wrap(spacing: 8, children: [
        FilledButton.tonalIcon(key: const Key('deploy-start'), onPressed: sendet || !bestaetigt || repo == null ? null : () => senden('deploy'), icon: const Icon(Icons.rocket_launch_outlined), label: const Text('Deployen')),
        OutlinedButton.icon(key: const Key('deploy-rollback'), onPressed: sendet || letzter?['vorher'] == null ? null : () => senden('rollback'), icon: const Icon(Icons.undo), label: const Text('Rollback')),
      ])),
      if (hatZiel && !bearbeiten) Text('Deploy und Rollback brauchen deine Bestätigung; danach prüft Alfred Status, HTTP und Logs.', style: theme.textTheme.bodySmall?.copyWith(color: dim)),
      if (meldung != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(meldung!, style: TextStyle(color: meldungOk ? Colors.green : theme.colorScheme.error))),
    ])));
  }
}
