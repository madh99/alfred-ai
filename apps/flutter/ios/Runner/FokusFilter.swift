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
    // 1.61.0 — jeder Aufruf wird festgehalten (lief der Filter, ging das Senden?); die App meldet das beim nächsten Öffnen
    await FokusAbgleich.uebernimm(self, quelle: "filter", immer: true)
    return .result()
  }
}

/// 1.62.0 — Realfall 20.10. 13:38: Einschalten rief den Filter auf, Ausschalten NICHT (am Server blieb der Fokus aktiv, Hinweise
/// wurden aufgeschoben). Darum fragt die App den aktuellen Filter selbst ab (`current`): beim Öffnen und bei jedem Zonenwechsel,
/// der die App im Hintergrund weckt. Gemeldet wird nur bei Änderung gegenüber dem gespeicherten Stand.
@available(iOS 16.0, *)
enum FokusAbgleich {
  static func jetzt() async {
    guard let f = try? await AlfredFokusFilter.current else { return }
    await uebernimm(f, quelle: "abgleich", immer: false)
  }

  static func uebernimm(_ f: AlfredFokusFilter, quelle: String, immer: Bool) async {
    let aktiv = f.name != nil || f.hinweise != nil || f.vorlesen != nil
    let neu: [String: Any]? = aktiv ? ["name": f.name ?? "Fokus", "hinweise": (f.hinweise ?? .nurDringend).rawValue, "vorlesen": f.vorlesen ?? false] : nil
    let alt = UserDefaults.standard.dictionary(forKey: "alfred.fokus")
    let gleich = (alt == nil && neu == nil) || (alt != nil && neu != nil && NSDictionary(dictionary: alt!).isEqual(to: neu!))
    if gleich && !immer { return }
    if let n = neu { UserDefaults.standard.set(n, forKey: "alfred.fokus") } else { UserDefaults.standard.removeObject(forKey: "alfred.fokus") }
    // 1.63.0 — Verlauf der letzten 10 Aufrufe; der Eintrag steht VOR dem Senden („läuft“), damit auch ein abgebrochener Aufruf
    // sichtbar bleibt (vorher überschrieb der Abgleich beim Öffnen den Eintrag des Filters)
    let zeit = ISO8601DateFormatter().string(from: Date())
    protokolliere(["zeit": zeit, "aktiv": aktiv, "ergebnis": "läuft", "quelle": quelle])
    var ergebnis = "gesendet"
    do {
      let k = try Kopplung.lade()
      try await Netz(k).fokus(aktiv: aktiv, name: f.name, hinweise: (f.hinweise ?? .nurDringend).rawValue, vorlesen: f.vorlesen ?? false)
    } catch { ergebnis = "Fehler: \(error.localizedDescription)" }
    protokolliere(["zeit": zeit, "aktiv": aktiv, "ergebnis": ergebnis, "quelle": quelle])
  }

  /// Eintrag mit gleicher Zeit ersetzen, sonst anhängen; höchstens 10.
  private static func protokolliere(_ e: [String: Any]) {
    var l = (UserDefaults.standard.array(forKey: "alfred.fokus.meldungen") as? [[String: Any]]) ?? []
    if let i = l.lastIndex(where: { ($0["zeit"] as? String) == (e["zeit"] as? String) && ($0["quelle"] as? String) == (e["quelle"] as? String) }) { l[i] = e } else { l.append(e) }
    UserDefaults.standard.set(Array(l.suffix(10)), forKey: "alfred.fokus.meldungen")
  }
}

@available(iOS 16.0, *)
private extension AlfredFokusHinweise {
  var caseDisplay: String { switch self { case .alle: return "alle"; case .nurDringend: return "nur Dringendes"; case .keine: return "nur Notfälle" } }
}
