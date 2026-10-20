import AppIntents
import Foundation

/// v1528 (Owner 20.10.: Fokus „Weg B“) — Fokusfilter: In den iOS-Einstellungen → Fokus → <Fokus> → Fokusfilter → Alfred legt der
/// Owner fest, wie Alfred sich in diesem Fokus verhält. iOS ruft den Filter beim Einschalten auf (auch automatisch nach Zeitplan
/// oder Ort) und beim Ausschalten erneut — dann sind alle Felder leer. Darum sind sie optional (Apple ruft den Filter beim
/// Ausschalten sonst nicht auf). Welcher Fokus läuft, verrät iOS nicht; dafür das Feld „Name“.
@available(iOS 16.0, *)
enum AlfredFokusHinweise: String, AppEnum {
  case alle, nurDringend, keine
  static var typeDisplayRepresentation: TypeDisplayRepresentation = "Hinweise"
  static var caseDisplayRepresentations: [AlfredFokusHinweise: DisplayRepresentation] = [
    .alle: "Alle", .nurDringend: "Nur Dringendes", .keine: "Nur Notfälle",
  ]
}

@available(iOS 16.0, *)
struct AlfredFokusFilter: SetFocusFilterIntent {
  static var title: LocalizedStringResource = "Alfred"
  static var description: IntentDescription? = IntentDescription("Wie Alfred sich verhält, solange dieser Fokus aktiv ist: welche Hinweise sofort kommen und ob Antworten vorgelesen werden.")

  @Parameter(title: "Name des Fokus", description: "z. B. Arbeit oder Schlafen — so steht es im Weltmodell") var name: String?
  @Parameter(title: "Hinweise", description: "Nur Dringendes: dringende und wichtige sofort, der Rest später. Nur Notfälle: nur dringende sofort.") var hinweise: AlfredFokusHinweise?
  @Parameter(title: "Antworten vorlesen") var vorlesen: Bool?

  var displayRepresentation: DisplayRepresentation {
    let art = (hinweise ?? .nurDringend).caseDisplay
    return DisplayRepresentation(title: "\(name ?? "Fokus")", subtitle: "Hinweise: \(art)\(vorlesen == true ? " · vorlesen" : "")")
  }

  func perform() async throws -> some IntentResult {
    let aktiv = name != nil || hinweise != nil || vorlesen != nil
    // für die App (Vorlesen im Fokus) und für eine spätere Anzeige
    if aktiv { UserDefaults.standard.set(["name": name ?? "Fokus", "hinweise": (hinweise ?? .nurDringend).rawValue, "vorlesen": vorlesen ?? false], forKey: "alfred.fokus") }
    else { UserDefaults.standard.removeObject(forKey: "alfred.fokus") }
    if let k = try? Kopplung.lade() {
      try? await Netz(k).fokus(aktiv: aktiv, name: name, hinweise: (hinweise ?? .nurDringend).rawValue, vorlesen: vorlesen ?? false)
    }
    return .result()
  }
}

@available(iOS 16.0, *)
private extension AlfredFokusHinweise {
  var caseDisplay: String { switch self { case .alle: return "alle"; case .nurDringend: return "nur Dringendes"; case .keine: return "nur Notfälle" } }
}
