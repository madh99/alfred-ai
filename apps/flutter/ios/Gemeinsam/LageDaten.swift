import Foundation
#if canImport(ActivityKit)
import ActivityKit
#endif
import WidgetKit

// 1.72.0 (v1540, Owner 21.10. „Widget vollumfänglich alle Größen und live bei rot“) — gemeinsam für App und Widget-Erweiterung.

/// Lage in Kurzform (Server: /api/geraete/lage, packages/core/src/lebenszeichen/lage-kurz.ts).
struct LageKurz: Codable {
  struct Zeile: Codable { let stichwort: String?; let text: String }
  struct Geraete: Codable { let online: Int; let gesamt: Int }
  struct Kosten: Codable { let heute: Double?; let budget: Double? }
  struct Befund: Codable { let id: String; let titel: String; let quelle: String; let seit: String }
  struct Vorgang: Codable { let id: String; let titel: String }
  let ampel: String
  let text: String
  let stand: String
  let lageStand: String?
  let zeilen: [Zeile]
  let braucht: Int
  let bestaetigungen: Int
  let geraete: Geraete
  let kosten: Kosten
  let modelleGestoert: Int
  let waechter: Int
  let befunde: [Befund]
  let befundeGesamt: Int
  let vorgang: Vorgang?

  static let beispiel = LageKurz(
    ampel: "warn", text: "2 Befunde", stand: ISO8601DateFormatter().string(from: Date()), lageStand: nil,
    zeilen: [Zeile(stichwort: "Befunde", text: "2 offen")], braucht: 1, bestaetigungen: 0,
    geraete: Geraete(online: 5, gesamt: 6), kosten: Kosten(heute: 4.2, budget: 20), modelleGestoert: 0, waechter: 0,
    befunde: [Befund(id: "1", titel: "ZFS-Pool meldet Prüfsummenfehler", quelle: "proxmox", seit: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-7200)))],
    befundeGesamt: 2, vorgang: Vorgang(id: "v", titel: "RAM-Auslastung prüfen"))
}

#if canImport(ActivityKit)
/// Live-Aktivität bei roter Lage. Name und Felder genau wie der Server sie schickt (attributes-type „LageAttribute“,
/// content-state in packages/core/src/geraete/live-aktivitaet.ts LiveZustand) — nur Ampel, Zähler, Uhrzeit.
@available(iOS 16.1, *)
struct LageAttribute: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    var ampel: String
    var titel: String
    var zeile: String
    var anzahl: Int
    var stand: String
  }
  var name: String
}
#endif

/// Widget neu laden. Eigene Datei statt AppDelegate: dort verdeckte `import WidgetKit` die PhotosUI-Typen (PHPicker…),
/// Realfall Kompilierprobe 22.10.
enum WidgetAuffrischen {
  static func alle() { WidgetCenter.shared.reloadAllTimelines() }
}

extension Data {
  var hex: String { map { String(format: "%02x", $0) }.joined() }
}
