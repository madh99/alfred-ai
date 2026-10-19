/// 1.41.0 (v1497) — Gesprächsfäden in der Seitenleiste ordnen (Owner 18.10.: nicht alle Fäden sichtbar, anheften
/// und archivieren fehlten). 1.42.0 (v1499, D1) — Projekte mit ihren Fäden getrennt von den Gesprächen (Owner 19.10.).
/// Reine Logik, damit sie ohne Oberfläche testbar ist.
library;

/// So viele normale Fäden stehen ohne „Weitere“ in der Liste (wie bisher).
const int sichtbareFaeden = 12;

/// So viele Fäden stehen je Projekt ohne „Weitere“ (App-Spec §11 D1).
const int sichtbareProjektFaeden = 5;

class ProjektGruppe {
  final String id;
  final String name;
  final List<Map<String, dynamic>> faeden; // bereits gekürzt, wenn das Projekt nicht aufgeklappt ist
  final int weitere;
  const ProjektGruppe(this.id, this.name, this.faeden, this.weitere);
}

class FadenGruppen {
  final List<ProjektGruppe> projekte;
  final List<Map<String, dynamic>> angeheftet;
  final List<Map<String, dynamic>> gespraeche; // bereits auf sichtbare gekürzt, wenn nicht alle gezeigt werden
  final int weitere; // ausgeblendete normale Fäden
  final List<Map<String, dynamic>> archiviert;
  final List<Map<String, dynamic>> sitzungen; // frühere Gerätesitzungen (nur lesen)
  final bool filterSinnvoll; // ab mehr als [sichtbareFaeden] Fäden
  const FadenGruppen(this.angeheftet, this.gespraeche, this.weitere, this.archiviert, this.sitzungen, this.filterSinnvoll, {this.projekte = const []});
}

String fadenTitelText(Map<String, dynamic> f) {
  final t = '${f['titel'] ?? ''}'.trim();
  return t.isEmpty ? 'Gespräch' : t;
}

/// Projekt-ID eines Fadens (vom Server: `projekt: {id, name}`), sonst null.
String? fadenProjektId(Map<String, dynamic> f) {
  final p = f['projekt'];
  return p is Map && p['id'] != null ? '${p['id']}' : null;
}

/// Projektfaden `projekt-<id8>` (gehört immer zu seinem Projekt, lässt sich nicht lösen).
bool istProjektFaden(Map<String, dynamic> f) => '${f['faden'] ?? ''}'.startsWith('projekt-');

/// Ordnet die Liste vom Server: Projekte mit ihren Fäden, dann angeheftete und übrige Gespräche, Archiv getrennt.
/// [projekte] = aktive Projekte vom Server (`projekte: [{id, name, aktualisiert}]`), zuletzt aktive zuerst.
/// [ausgeblendet] = Fäden, deren Löschen gerade läuft (Rückgängig noch möglich). [filter] sucht in Titel und Projektname.
/// [offeneProjekte] = Projekte, deren „Weitere“ aufgeklappt ist.
FadenGruppen fadenGruppen(List<Map<String, dynamic>> faeden,
    {bool alle = false, String filter = '', Set<String> ausgeblendet = const {}, List<Map<String, dynamic>> projekte = const [], Set<String> offeneProjekte = const {}}) {
  final f = filter.trim().toLowerCase();
  bool passt(Map<String, dynamic> x) => f.isEmpty || fadenTitelText(x).toLowerCase().contains(f);
  final eigene = faeden.where((x) => x['faden'] != null && x['archiv'] == null && !ausgeblendet.contains('${x['faden']}')).toList();
  final aktiv = eigene.where((x) => x['archiviert'] != true).toList();

  // Projekte: alle aktiven vom Server, dazu solche, die nur über einen Faden bekannt sind
  final namen = <String, String>{};
  final reihenfolge = <String>[];
  for (final p in projekte) { final id = '${p['id']}'; if (!namen.containsKey(id)) { namen[id] = '${p['name'] ?? ''}'; reihenfolge.add(id); } }
  for (final x in aktiv) {
    final id = fadenProjektId(x);
    if (id != null && !namen.containsKey(id)) { namen[id] = '${(x['projekt'] as Map)['name'] ?? ''}'; reihenfolge.add(id); }
  }
  final gruppen = <ProjektGruppe>[];
  for (final id in reihenfolge) {
    final name = namen[id]!;
    final namePasst = f.isNotEmpty && name.toLowerCase().contains(f);
    final alleFaeden = aktiv.where((x) => fadenProjektId(x) == id && (namePasst || passt(x))).toList();
    if (f.isNotEmpty && !namePasst && alleFaeden.isEmpty) continue;
    // Projektfaden zuerst, danach neueste zuerst (wie vom Server geliefert)
    alleFaeden.sort((a, b) => (istProjektFaden(b) ? 1 : 0) - (istProjektFaden(a) ? 1 : 0));
    final zeigen = (offeneProjekte.contains(id) || f.isNotEmpty) ? alleFaeden : alleFaeden.take(sichtbareProjektFaeden).toList();
    gruppen.add(ProjektGruppe(id, name, zeigen, alleFaeden.length - zeigen.length));
  }

  final ohneProjekt = aktiv.where((x) => fadenProjektId(x) == null).toList();
  final angeheftet = ohneProjekt.where((x) => x['angeheftet'] == true && passt(x)).toList();
  final normal = ohneProjekt.where((x) => x['angeheftet'] != true && passt(x)).toList();
  final zeigen = (alle || f.isNotEmpty) ? normal : normal.take(sichtbareFaeden).toList();
  return FadenGruppen(
    angeheftet,
    zeigen,
    normal.length - zeigen.length,
    eigene.where((x) => x['archiviert'] == true && passt(x)).toList(),
    faeden.where((x) => x['archiv'] != null).toList(),
    ohneProjekt.length > sichtbareFaeden,
    projekte: gruppen,
  );
}
