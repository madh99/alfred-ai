import Flutter
import Network
import Security
import UIKit
import UserNotifications

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  /// Phase 5 H2 — Kanal zu lib/handy_push.dart; Ziel einer angetippten Mitteilung, bis Dart es abholt
  private var pushKanal: FlutterMethodChannel?
  private var pushZiel: [String: Any]?
  /// 1.54.0 H3 — Netzwechsel (WLAN ↔ Mobilfunk, VPN an/aus) an Dart: sofort neu verbinden statt auf den toten Kanal zu warten
  private let netzWaechter = NWPathMonitor()
  private var netzKanal: FlutterMethodChannel?
  private var netzZuletzt: String?

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    UNUserNotificationCenter.current().delegate = self
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // Phase 5 H2 — APNs-Token an Dart (Server: /api/geraete/push); Debug-Builds laufen gegen die Sandbox, TestFlight gegen production
  override func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
    #if DEBUG
    let umgebung = "sandbox"
    #else
    let umgebung = "production"
    #endif
    pushKanal?.invokeMethod("token", arguments: ["token": hex, "umgebung": umgebung])
    super.application(application, didRegisterForRemoteNotificationsWithDeviceToken: deviceToken)
  }

  // App vorne: der Server schickt dann ohnehin keinen Push; kommt einer im Übergang, wird er trotzdem angezeigt
  override func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                       withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
    completionHandler([.banner, .sound, .list])
  }

  // Antippen: eigener Schlüssel `alfred` {art, id, faden} → Dart öffnet die Stelle (auch nach Kaltstart über „startZiel“)
  override func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                       withCompletionHandler completionHandler: @escaping () -> Void) {
    if let ziel = response.notification.request.content.userInfo["alfred"] as? [String: Any] {
      pushZiel = ziel
      pushKanal?.invokeMethod("geoeffnet", arguments: ziel)
    }
    completionHandler()
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    // Phase 5 H1 — Kopplung im Schlüsselbund (lib/schluesselbund.dart); eigener Kanal statt Plugin, damit die Desktop-Builds unberührt bleiben
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "AlfredSchluesselbund") {
      let kanal = FlutterMethodChannel(name: "alfred/schluesselbund", binaryMessenger: registrar.messenger())
      kanal.setMethodCallHandler { aufruf, ergebnis in
        let args = aufruf.arguments as? [String: Any] ?? [:]
        guard let schluessel = args["schluessel"] as? String else { ergebnis(FlutterError(code: "args", message: "schluessel fehlt", details: nil)); return }
        switch aufruf.method {
        case "lesen": ergebnis(Schluesselbund.lesen(schluessel))
        case "schreiben": ergebnis(Schluesselbund.schreiben(schluessel, args["wert"] as? String ?? ""))
        case "loeschen": ergebnis(Schluesselbund.loeschen(schluessel))
        default: ergebnis(FlutterMethodNotImplemented)
        }
      }
    }
    // Phase 5 H2 — Mitteilungen: Erlaubnis + Anmeldung, Ziel nach Kaltstart
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "AlfredPush") {
      let kanal = FlutterMethodChannel(name: "alfred/push", binaryMessenger: registrar.messenger())
      pushKanal = kanal
      kanal.setMethodCallHandler { [weak self] aufruf, ergebnis in
        switch aufruf.method {
        case "anmelden":
          UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { erlaubt, _ in
            DispatchQueue.main.async {
              if erlaubt { UIApplication.shared.registerForRemoteNotifications() }
              ergebnis(erlaubt)
            }
          }
        case "startZiel":
          ergebnis(self?.pushZiel)
          self?.pushZiel = nil
        default: ergebnis(FlutterMethodNotImplemented)
        }
      }
    }
    // 1.54.0 H3 — Netzwächter; meldet nur echte Wechsel (erster Stand wird nur gemerkt)
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "AlfredNetz") {
      netzKanal = FlutterMethodChannel(name: "alfred/netz", binaryMessenger: registrar.messenger())
      netzWaechter.pathUpdateHandler = { [weak self] pfad in
        var teile: [String] = []
        if pfad.status != .satisfied { teile.append("keins") }
        if pfad.usesInterfaceType(.wifi) { teile.append("wlan") }
        if pfad.usesInterfaceType(.cellular) { teile.append("mobil") }
        if pfad.usesInterfaceType(.other) { teile.append("vpn") }
        let art = teile.joined(separator: "+")
        DispatchQueue.main.async {
          guard let self = self else { return }
          let vorher = self.netzZuletzt
          self.netzZuletzt = art
          if vorher != nil && vorher != art { self.netzKanal?.invokeMethod("geaendert", arguments: ["art": art]) }
        }
      }
      netzWaechter.start(queue: DispatchQueue(label: "at.alfred.netz"))
    }
    // 1.52.1 — Links aus Antworten über das System öffnen (Safari, Mail …); die Desktop-Wege (open, xdg-open) gibt es auf iOS nicht
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "AlfredSystem") {
      let kanal = FlutterMethodChannel(name: "alfred/system", binaryMessenger: registrar.messenger())
      kanal.setMethodCallHandler { aufruf, ergebnis in
        guard aufruf.method == "oeffnen", let text = (aufruf.arguments as? [String: Any])?["url"] as? String,
              let url = URL(string: text), ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") else {
          ergebnis(false); return
        }
        UIApplication.shared.open(url) { ok in ergebnis(ok) }
      }
    }
  }
}

/// Generisches Passwort im Schlüsselbund der App; nur auf diesem Gerät, lesbar ab dem ersten Entsperren (kein iCloud-Abgleich).
enum Schluesselbund {
  static let dienst = "at.alfred.app"

  static func basis(_ schluessel: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: dienst, kSecAttrAccount as String: schluessel]
  }

  static func lesen(_ schluessel: String) -> String? {
    var q = basis(schluessel)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var daten: AnyObject?
    guard SecItemCopyMatching(q as CFDictionary, &daten) == errSecSuccess, let d = daten as? Data else { return nil }
    return String(data: d, encoding: .utf8)
  }

  static func schreiben(_ schluessel: String, _ wert: String) -> Bool {
    SecItemDelete(basis(schluessel) as CFDictionary)
    var q = basis(schluessel)
    q[kSecValueData as String] = Data(wert.utf8)
    q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
  }

  static func loeschen(_ schluessel: String) -> Bool {
    let s = SecItemDelete(basis(schluessel) as CFDictionary)
    return s == errSecSuccess || s == errSecItemNotFound
  }
}
