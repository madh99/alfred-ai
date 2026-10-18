/// 1.41.0 (v1497) — Gesprächsfäden in der Seitenleiste ordnen (Owner 18.10.: nicht alle Fäden sichtbar, anheften
/// und archivieren fehlten). Reine Logik, damit sie ohne Oberfläche testbar ist.
library;

/// So viele normale Fäden stehen ohne „Weitere“ in der Liste (wie bisher).
const int sichtbareFaeden = 12;

class FadenGruppen {
  final List<Map<String, dynamic>> angeheftet;
  final List<Map<String, dynamic>> gespraeche; // bereits auf sichtbare gekürzt, wenn nicht alle gezeigt werden
  final int weitere; // ausgeblendete normale Fäden
  final List<Map<String, dynamic>> archiviert;
  final List<Map<String, dynamic>> sitzungen; // frühere Gerätesitzungen (nur lesen)
  final bool filterSinnvoll; // ab mehr als [sichtbareFaeden] Fäden
  const FadenGruppen(this.angeheftet, this.gespraeche, this.weitere, this.archiviert, this.sitzungen, this.filterSinnvoll);
}

String fadenTitelText(Map<String, dynamic> f) {
  final t = '${f['titel'] ?? ''}'.trim();
  return t.isEmpty ? 'Gespräch' : t;
}

/// Ordnet die Liste vom Server: angeheftete zuerst, dann die übrigen (neueste zuerst, wie geliefert), Archiv getrennt.
/// [ausgeblendet] = Fäden, deren Löschen gerade läuft (Rückgängig noch möglich). [filter] sucht im Titel.
FadenGruppen fadenGruppen(List<Map<String, dynamic>> faeden, {bool alle = false, String filter = '', Set<String> ausgeblendet = const {}}) {
  final f = filter.trim().toLowerCase();
  bool passt(Map<String, dynamic> x) => f.isEmpty || fadenTitelText(x).toLowerCase().contains(f);
  final eigene = faeden.where((x) => x['faden'] != null && x['archiv'] == null && !ausgeblendet.contains('${x['faden']}')).toList();
  final aktiv = eigene.where((x) => x['archiviert'] != true).toList();
  final angeheftet = aktiv.where((x) => x['angeheftet'] == true && passt(x)).toList();
  final normal = aktiv.where((x) => x['angeheftet'] != true && passt(x)).toList();
  final zeigen = (alle || f.isNotEmpty) ? normal : normal.take(sichtbareFaeden).toList();
  return FadenGruppen(
    angeheftet,
    zeigen,
    normal.length - zeigen.length,
    eigene.where((x) => x['archiviert'] == true && passt(x)).toList(),
    faeden.where((x) => x['archiv'] != null).toList(),
    aktiv.length > sichtbareFaeden,
  );
}
