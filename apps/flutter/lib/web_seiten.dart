/// 1.71.0 (Owner 20.10.: „1–5 wie vorgeschlagen“) — Verwaltungsseiten, die es nur im Web gibt, aus der App heraus öffnen.
/// Bewusst kein Nachbau: Einstellungen, Sandboxes, Runbooks usw. bleiben im Web; Social ist pausiert und fehlt hier.
library;

import 'package:flutter/material.dart';

import 'markdown.dart' show oeffneLink;

const webSeiten = <({String pfad, String titel, String text, IconData icon})>[
  (pfad: 'settings', titel: 'Einstellungen', text: 'Modelle, Dienste, Konfiguration', icon: Icons.tune),
  (pfad: 'background-tasks', titel: 'Hintergrundaufgaben', text: 'Geplante und laufende Jobs', icon: Icons.schedule),
  (pfad: 'runbooks', titel: 'Runbooks', text: 'Abläufe und Anleitungen', icon: Icons.menu_book_outlined),
  (pfad: 'sandboxes', titel: 'Sandboxes', text: 'Testumgebungen', icon: Icons.science_outlined),
  (pfad: 'project-agents', titel: 'Projekt-Agenten', text: 'Agenten je Projekt', icon: Icons.smart_toy_outlined),
  (pfad: 'itsm', titel: 'ITSM', text: 'Störungen, Changes, Probleme', icon: Icons.support_agent),
  (pfad: 'cmdb', titel: 'CMDB', text: 'Geräte und Dienste im Bestand', icon: Icons.inventory_2_outlined),
  (pfad: 'services', titel: 'Services', text: 'Dienste und Abhängigkeiten', icon: Icons.miscellaneous_services_outlined),
  (pfad: 'docs', titel: 'Dokumentation', text: 'Erzeugte Dokumente', icon: Icons.description_outlined),
  (pfad: 'logs', titel: 'Logs', text: 'Protokolle des Servers', icon: Icons.receipt_long_outlined),
  (pfad: 'cluster', titel: 'Cluster', text: 'Knoten und Zustand', icon: Icons.lan_outlined),
];

/// Adresse einer Webseite des Servers (basePath /alfred, abschließender Schrägstrich wie beim Chat-Link).
String webAdresse(String server, String pfad) => '${server.replaceAll(RegExp(r'/+$'), '')}/alfred/$pfad/';

Future<void> zeigeWebSeiten(BuildContext context, String server) => showModalBottomSheet<void>(context: context, showDragHandle: true, isScrollControlled: true,
  builder: (ctx) => DraggableScrollableSheet(expand: false, initialChildSize: 0.6, maxChildSize: 0.9, builder: (ctx, sc) => ListView(controller: sc, children: [
    const Padding(padding: EdgeInsets.fromLTRB(20, 0, 20, 8), child: Text('Im Web öffnen', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600))),
    for (final s in webSeiten) ListTile(leading: Icon(s.icon), title: Text(s.titel), subtitle: Text(s.text), trailing: const Icon(Icons.open_in_new, size: 16),
      onTap: () { Navigator.of(ctx).pop(); oeffneLink(webAdresse(server, s.pfad)); }),
  ])));
