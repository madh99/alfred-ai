import AVFoundation
import Flutter
import Network
import UniformTypeIdentifiers
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
  /// 1.54.1 — offene Ordnerwahl (hält den Delegaten, bis der Owner gewählt oder abgebrochen hat)
  private var ordnerWahl: OrdnerWahl?

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
      kanal.setMethodCallHandler { [weak self] aufruf, ergebnis in
        let args = aufruf.arguments as? [String: Any] ?? [:]
        switch aufruf.method {
        case "oeffnen":
          guard let text = args["url"] as? String, let url = URL(string: text), ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") else { ergebnis(false); return }
          UIApplication.shared.open(url) { ok in ergebnis(ok) }
        case "kopieren":
          // 1.54.0 — vertraulich: nicht über die universelle Zwischenablage teilen, nach 2 min weg
          guard let text = args["text"] as? String else { ergebnis(false); return }
          let optionen: [UIPasteboard.OptionsKey: Any] = (args["vertraulich"] as? Bool ?? false) ? [.localOnly: true, .expirationDate: Date().addingTimeInterval(120)] : [:]
          UIPasteboard.general.setItems([["public.utf8-plain-text": text]], options: optionen)
          ergebnis(true)
        case "zustand":
          ergebnis(self?.systemZustand())
        case "ordnerWaehlen":
          // 1.54.1 — Owner gibt einen Ordner frei (Downloads, iCloud Drive …); iOS liefert eine dauerhafte Freigabe (Bookmark)
          DispatchQueue.main.async {
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.folder])
            let wahl = OrdnerWahl { url in
              self?.ordnerWahl = nil
              guard let url = url else { ergebnis(nil); return }
              let zugriff = url.startAccessingSecurityScopedResource()
              defer { if zugriff { url.stopAccessingSecurityScopedResource() } }
              do {
                let b = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
                ergebnis(["name": url.lastPathComponent, "bookmark": FlutterStandardTypedData(bytes: b)])
              } catch { ergebnis(FlutterError(code: "bookmark", message: error.localizedDescription, details: nil)) }
            }
            self?.ordnerWahl = wahl
            picker.delegate = wahl
            picker.allowsMultipleSelection = false
            self?.obersteAnsicht()?.present(picker, animated: true)
          }
        case "ordnerSchreiben":
          // 1.54.1 — Datei in einen freigegebenen Ordner; nie überschreiben („Name (1).pdf“)
          guard let b = args["bookmark"] as? FlutterStandardTypedData, let name = args["name"] as? String, let daten = args["daten"] as? FlutterStandardTypedData else { ergebnis(FlutterError(code: "args", message: "bookmark, name, daten", details: nil)); return }
          do { ergebnis(try Ordner.schreibe(bookmark: b.data, name: name, daten: daten.data)) }
          catch { ergebnis(FlutterError(code: "schreiben", message: error.localizedDescription, details: nil)) }
        default: ergebnis(FlutterMethodNotImplemented)
        }
      }
    }
  }
}

extension AppDelegate {
  /// 1.54.0 — Zustand für die Sinne (nur solange die App offen ist): Akku, Netzweg, Audio-Ausgang, Modell, System, Speicher.
  /// Den Fokus-Status lässt Apple nur Kommunikations-Apps lesen; iOS filtert im Fokus selbst, Dringendes kommt zeitkritisch durch.
  func systemZustand() -> [String: Any] {
    var z: [String: Any] = [:]
    let geraet = UIDevice.current
    geraet.isBatteryMonitoringEnabled = true
    if geraet.batteryLevel >= 0 { z["akkuProzent"] = Int((geraet.batteryLevel * 100).rounded()) }
    z["akkuLaedt"] = geraet.batteryState == .charging || geraet.batteryState == .full
    if let netz = netzZuletzt { z["netz"] = netz }
    let ausgang = AVAudioSession.sharedInstance().currentRoute.outputs.first?.portType
    switch ausgang {
    case .some(.headphones): z["audio"] = "kopfhoerer"
    case .some(.bluetoothA2DP), .some(.bluetoothLE), .some(.bluetoothHFP): z["audio"] = "bluetooth"
    case .some(.carAudio): z["audio"] = "auto"
    case .some(.airPlay): z["audio"] = "airplay"
    default: z["audio"] = "lautsprecher"
    }
    var info = utsname(); uname(&info)
    let kennung = withUnsafePointer(to: &info.machine) { $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) } }
    let modell = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] ?? kennung
    z["modell"] = "\(geraet.model) (\(modell))"
    z["system"] = "\(geraet.systemName) \(geraet.systemVersion)"
    if let werte = try? URL(fileURLWithPath: NSHomeDirectory()).resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey, .volumeTotalCapacityKey]) {
      if let frei = werte.volumeAvailableCapacityForImportantUsage { z["speicherFreiGb"] = Double(frei) / 1_000_000_000 }
      if let gesamt = werte.volumeTotalCapacity { z["speicherGesamtGb"] = Double(gesamt) / 1_000_000_000 }
    }
    return z
  }
}

/// 1.54.1 — Ordnerwahl über das Dateien-Fenster von iOS
final class OrdnerWahl: NSObject, UIDocumentPickerDelegate {
  let fertig: (URL?) -> Void
  init(fertig: @escaping (URL?) -> Void) { self.fertig = fertig }
  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { fertig(urls.first) }
  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { fertig(nil) }
}

/// 1.54.1 — Schreiben in einen freigegebenen Ordner (Sicherheits-Bookmark), koordiniert (iCloud Drive), nie überschreiben
enum Ordner {
  static func eindeutig(_ ordner: URL, _ name: String) -> URL {
    let fm = FileManager.default
    var ziel = ordner.appendingPathComponent(name)
    if !fm.fileExists(atPath: ziel.path) { return ziel }
    let basis = (name as NSString).deletingPathExtension, endung = (name as NSString).pathExtension
    var n = 1
    repeat { ziel = ordner.appendingPathComponent(endung.isEmpty ? "\(basis) (\(n))" : "\(basis) (\(n)).\(endung)"); n += 1 } while fm.fileExists(atPath: ziel.path) && n < 1000
    return ziel
  }

  static func schreibe(bookmark: Data, name: String, daten: Data) throws -> [String: Any] {
    var veraltet = false
    let ordner = try URL(resolvingBookmarkData: bookmark, options: [], relativeTo: nil, bookmarkDataIsStale: &veraltet)
    let zugriff = ordner.startAccessingSecurityScopedResource()
    defer { if zugriff { ordner.stopAccessingSecurityScopedResource() } }
    let ziel = eindeutig(ordner, name)
    var koordFehler: NSError?
    var schreibFehler: Error?
    NSFileCoordinator().coordinate(writingItemAt: ziel, options: [], error: &koordFehler) { z in
      do { try daten.write(to: z, options: .withoutOverwriting) } catch { schreibFehler = error }
    }
    if let f = koordFehler ?? schreibFehler { throw f }
    var antwort: [String: Any] = ["name": ziel.lastPathComponent]
    if veraltet, let neu = try? ordner.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) { antwort["bookmark"] = FlutterStandardTypedData(bytes: neu) }
    return antwort
  }
}

extension AppDelegate {
  /// oberste sichtbare Ansicht (für die Ordnerwahl)
  func obersteAnsicht() -> UIViewController? {
    let fenster = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.windows.first { $0.isKeyWindow } }.first
    var vc = fenster?.rootViewController
    while let weiter = vc?.presentedViewController { vc = weiter }
    return vc
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
