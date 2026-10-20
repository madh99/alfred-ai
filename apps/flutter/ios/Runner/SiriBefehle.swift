import AppIntents
import Foundation

/// 1.67.0 (Owner 20.10.: „Siri-Kurzbefehle wie empfohlen“) — „Hey Siri, frag Alfred“ und „Hey Siri, Unterhaltung mit Alfred“.
/// Frage: Siri fragt nach, was du wissen willst, Alfred antwortet (schnelle Stufe), Siri liest die Antwort vor; Frage und
/// Antwort stehen danach im Hauptgespräch. Unterhaltung: öffnet die App direkt im Unterhaltungsmodus.

extension Notification.Name { static let alfredUnterhaltung = Notification.Name("at.alfred.unterhaltung") }

@available(iOS 16.0, *)
struct FragAlfred: AppIntent {
  static var title: LocalizedStringResource = "Alfred fragen"
  static var description = IntentDescription("Stellt Alfred eine Frage; Siri liest die Antwort vor. Frage und Antwort stehen danach im Hauptgespräch.")
  static var openAppWhenRun = false
  /// Alfred kann Haus, Kalender und Geräte bedienen: am gesperrten iPhone erst nach Face ID / Code (Sicherheitsprüfung 20.10.)
  static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

  @Parameter(title: "Frage", requestValueDialog: IntentDialog("Was möchtest du Alfred fragen?")) var frage: String

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let k = try Kopplung.lade()
    let antwort = try await Netz(k).frage(frage, chatId: "sitzung:\(k.geraetId):haupt")
    return .result(dialog: IntentDialog(stringLiteral: SiriText.sprechbar(antwort)))
  }
}

@available(iOS 16.0, *)
struct UnterhaltungMitAlfred: AppIntent {
  static var title: LocalizedStringResource = "Unterhaltung mit Alfred"
  static var description = IntentDescription("Öffnet Alfred direkt im Unterhaltungsmodus.")
  static var openAppWhenRun = true
  static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

  @MainActor
  func perform() async throws -> some IntentResult {
    // die App liest den Wunsch beim Öffnen (kalter Start) oder sofort über die Benachrichtigung (läuft schon)
    UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: "alfred.unterhaltung.start")
    NotificationCenter.default.post(name: .alfredUnterhaltung, object: nil)
    return .result()
  }
}

@available(iOS 16.0, *)
struct AlfredKurzbefehle: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(intent: FragAlfred(), phrases: ["Frag \(.applicationName)", "\(.applicationName) fragen", "Frage an \(.applicationName)"])
    AppShortcut(intent: UnterhaltungMitAlfred(), phrases: ["Unterhaltung mit \(.applicationName)", "Mit \(.applicationName) sprechen", "\(.applicationName) Unterhaltung"])
  }
}

enum SiriText {
  /// Markdown weg, höchstens etwa 700 Zeichen (Siri liest sonst minutenlang; der Rest steht im Chat).
  static func sprechbar(_ t: String) -> String {
    var s = t.replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "`", with: "")
    s = s.replacingOccurrences(of: "(?m)^\\s*[-*•]\\s+", with: "", options: .regularExpression)
    s = s.replacingOccurrences(of: "(?m)^#{1,6}\\s+", with: "", options: .regularExpression)
    s = s.replacingOccurrences(of: "\\[([^\\]]+)\\]\\([^)]+\\)", with: "$1", options: .regularExpression)
    s = s.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.isEmpty { return "Alfred hat keine Antwort geliefert." }
    guard s.count > 700 else { return s }
    let kurz = String(s.prefix(700))
    let ende = kurz.lastIndex(where: { ".!?".contains($0) }).map { kurz[...$0] } ?? Substring(kurz)
    return ende + " Den Rest findest du im Chat."
  }
}
