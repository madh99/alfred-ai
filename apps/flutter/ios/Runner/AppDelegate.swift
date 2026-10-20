import AVFoundation
import CoreLocation
import CoreMotion
import Flutter
import Network
import PhotosUI
import QuickLook
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
  /// 1.54.2 — offene Foto-/Kamerawahl
  private var fotoWahl: FotoWahl?
  /// 1.54.4 — offene Vorschau (Quick Look hält seine Datenquelle nicht selbst)
  private var vorschauQuelle: Vorschau?
  /// v1522 — Standortzonen; früh angelegt, damit iOS Zonenereignisse auch nach einem Start im Hintergrund zustellt
  let zonen = ZonenWaechter()
  /// v1526 — Bewegung (still, geht, läuft, Rad, Auto)
  let bewegung = BewegungsSinn()
  /// 1.58.0 G1 — Vorlesen in der Unterhaltung, ohne die Audiositzung der Aufnahme anzufassen
  let ton = TonSpieler()

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    UNUserNotificationCenter.current().delegate = self
    zonen.bewegung = bewegung
    zonen.starte()
    bewegung.starte()
    NotificationCenter.default.addObserver(self, selector: #selector(wirdAktiv), name: UIApplication.didBecomeActiveNotification, object: nil) // 1.64.0
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // 1.64.0 — App wird aktiv (Systemnachricht, gilt auch mit Scenes): Fokus mit iOS abgleichen und den Verlauf der Filter-Aufrufe nativ melden (mit Hintergrundzeit,
  // damit es auch klappt, wenn die App nach wenigen Sekunden wieder geschlossen wird)
  @objc private func wirdAktiv() {
    guard #available(iOS 16.0, *) else { return }
    let application = UIApplication.shared
    var aufgabe: UIBackgroundTaskIdentifier = .invalid
    aufgabe = application.beginBackgroundTask(withName: "alfred.fokus") { application.endBackgroundTask(aufgabe); aufgabe = .invalid }
    Task {
      defer { if aufgabe != .invalid { application.endBackgroundTask(aufgabe) } }
      await FokusAbgleich.jetzt()
      await FokusAbgleich.berichte()
    }
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
      // v1526 — Bewegung gewechselt (z. B. ins Auto): sofort an Dart (Vorlese-Symbol, Sinne)
      bewegung.beiWechsel = { [weak self] art in self?.netzKanal?.invokeMethod("bewegung", arguments: ["bewegung": art]) }
      // 1.54.3 — Audio-Ausgang gewechselt (AirPods, Auto …): sofort an Dart, damit das Vorlese-Symbol stimmt
      NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] _ in
        guard let self = self else { return }
        self.netzKanal?.invokeMethod("audio", arguments: ["audio": self.systemZustand()["audio"] ?? "lautsprecher"])
      }
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
        case "fokusAbgleich":
          // 1.62.0 — aktuellen Fokusfilter von iOS holen und bei Änderung melden (vor dem nächsten „zustand“)
          if #available(iOS 16.0, *) { Task { await FokusAbgleich.jetzt(); ergebnis(true) } } else { ergebnis(false) }
        case "ordnerWaehlen":
          // 1.54.1 — Owner gibt einen Ordner frei (Downloads, iCloud Drive …); iOS liefert eine dauerhafte Freigabe (Bookmark)
          DispatchQueue.main.async {
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.folder])
            let wahl = OrdnerWahl { url in
              self?.ordnerWahl = nil
              guard let url = url else { ergebnis(["abgebrochen": true]); return }
              let zugriff = url.startAccessingSecurityScopedResource()
              defer { if zugriff { url.stopAccessingSecurityScopedResource() } }
              do {
                let b = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
                ergebnis(["name": url.lastPathComponent, "bookmark": FlutterStandardTypedData(bytes: b), "pfad": url.path, "zugriff": zugriff])
              } catch {
                // 1.54.2 — Grund mitliefern (Diagnose Owner-Test 20.10.: Freigabe von Downloads blieb ohne Wirkung)
                ergebnis(FlutterError(code: "bookmark", message: "\(error.localizedDescription) (Pfad \(url.path), Zugriff \(zugriff))", details: nil))
              }
            }
            self?.ordnerWahl = wahl
            picker.delegate = wahl
            picker.allowsMultipleSelection = false
            self?.obersteAnsicht()?.present(picker, animated: true)
          }
        case "fotosWaehlen":
          // 1.54.2 — Fotos aus der Mediathek (PHPicker, ohne Mediathek-Erlaubnis), als JPEG im tmp-Ordner
          DispatchQueue.main.async {
            var konf = PHPickerConfiguration()
            konf.filter = .images
            konf.selectionLimit = 10
            let picker = PHPickerViewController(configuration: konf)
            let wahl = FotoWahl { pfade in self?.fotoWahl = nil; ergebnis(pfade) }
            self?.fotoWahl = wahl
            picker.delegate = wahl
            self?.obersteAnsicht()?.present(picker, animated: true)
          }
        case "kamera":
          DispatchQueue.main.async {
            guard UIImagePickerController.isSourceTypeAvailable(.camera) else { ergebnis(FlutterError(code: "kamera", message: "Keine Kamera verfügbar", details: nil)); return }
            let picker = UIImagePickerController()
            picker.sourceType = .camera
            let wahl = FotoWahl { pfade in self?.fotoWahl = nil; ergebnis(pfade) }
            self?.fotoWahl = wahl
            picker.delegate = wahl
            self?.obersteAnsicht()?.present(picker, animated: true)
          }
        case "zonenKarte":
          // v1526 — Karte mit allen Zonen; Ergebnis die geänderte Liste (nil = abgebrochen)
          let liste = (args["zonen"] as? [[String: Any]]) ?? []
          let zonen = liste.compactMap { z -> ZonenKarte.Zone? in
            guard let n = z["name"] as? String, let b = z["breite"] as? Double, let l = z["laenge"] as? Double else { return nil }
            return ZonenKarte.Zone(name: n, mitte: CLLocationCoordinate2D(latitude: b, longitude: l), radius: (z["radius"] as? Double) ?? 150)
          }
          DispatchQueue.main.async {
            let k = ZonenKarte(zonen: zonen) { neu in
              ergebnis(neu.map { $0.map { ["name": $0.name, "breite": $0.mitte.latitude, "laenge": $0.mitte.longitude, "radius": $0.radius] } })
            }
            let nav = UINavigationController(rootViewController: k)
            nav.modalPresentationStyle = .fullScreen
            self?.obersteAnsicht()?.present(nav, animated: true)
          }
        case "bewegungErlaubnis":
          self?.bewegung.erlaubnis { ergebnis($0) }
        case "bewegungStatus":
          ergebnis(BewegungsSinn.status())
        case "zonenSetzen":
          // v1522 — Zonen aus den App-Einstellungen [{name, breite, laenge, radius}]; iOS überwacht sie selbst
          self?.zonen.setze((args["zonen"] as? [[String: Any]]) ?? [])
          ergebnis(true)
        case "zonenErlaubnis":
          self?.zonen.erlaubnis { ergebnis($0) }
        case "zonenStatus":
          ergebnis(self?.zonen.status())
        case "ortJetzt":
          self?.zonen.ortJetzt { ergebnis($0) }
        case "vorschau":
          // 1.54.4 — Anhang antippen: iOS-Vorschau (vergrößern, PDF/Office, Teilen/Sichern); Realfall 20.10. 01:29 xdg-open auf iOS
          guard let pfad = args["pfad"] as? String else { ergebnis(false); return }
          DispatchQueue.main.async {
            let quelle = Vorschau(URL(fileURLWithPath: pfad)) { self?.vorschauQuelle = nil }
            self?.vorschauQuelle = quelle
            let ql = QLPreviewController()
            ql.dataSource = quelle
            ql.delegate = quelle
            self?.obersteAnsicht()?.present(ql, animated: true)
            ergebnis(true)
          }
        case "zwischenablageBild":
          // 1.54.2 — Bild aus der Zwischenablage (iOS fragt beim Einsetzen aus einer anderen App selbst nach)
          if UIPasteboard.general.hasImages, let bild = UIPasteboard.general.image, let pfad = Foto.speichere(bild, nr: 0, art: "eingefuegt") { ergebnis(pfad) } else { ergebnis(nil) }
        case "tonSpielen":
          // 1.58.0 G1 — liefert erst am Ende der Wiedergabe (true) oder beim Abbruch (false); Format unlesbar → Fehler, Dart nimmt audioplayers
          guard let d = args["daten"] as? FlutterStandardTypedData else { ergebnis(FlutterError(code: "args", message: "daten", details: nil)); return }
          self?.ton.spiele(d.data) { ok, fehler in
            if let f = fehler { ergebnis(FlutterError(code: "ton", message: f, details: nil)) } else { ergebnis(ok) }
          }
        case "tonStopp":
          self?.ton.stopp()
          ergebnis(true)
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
    if let art = bewegung.aktuell { z["bewegung"] = art } // v1526
    if let f = UserDefaults.standard.dictionary(forKey: "alfred.fokus") { z["fokus"] = f["name"]; z["fokusVorlesen"] = f["vorlesen"]; z["fokusHinweise"] = f["hinweise"] } // v1528
    z["fokusAktiv"] = UserDefaults.standard.dictionary(forKey: "alfred.fokus") != nil // 1.61.0
    if let l = UserDefaults.standard.array(forKey: "alfred.fokus.meldungen") { z["fokusMeldungen"] = l } // 1.63.0 — letzte Aufrufe von Filter und Abgleich
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
/// 1.58.0 G1 — einfache Wiedergabe für die Unterhaltung. AVAudioPlayer spielt in der Kategorie, die die Aufnahme gesetzt hat
/// (playAndRecord, Lautsprecher/Bluetooth), und deaktiviert die Sitzung am Ende nicht — das Mikrofon läuft weiter.
final class TonSpieler: NSObject, AVAudioPlayerDelegate {
  private var spieler: AVAudioPlayer?
  private var fertig: ((Bool, String?) -> Void)?

  func spiele(_ daten: Data, fertig: @escaping (Bool, String?) -> Void) {
    stopp()
    do {
      let s = try AVAudioPlayer(data: daten)
      s.delegate = self
      spieler = s
      self.fertig = fertig
      if !s.play() { beende(false, "Wiedergabe startet nicht") }
    } catch { fertig(false, error.localizedDescription) }
  }

  func stopp() { spieler?.stop(); beende(false, nil) }

  private func beende(_ ok: Bool, _ fehler: String?) { let f = fertig; fertig = nil; spieler = nil; f?(ok, fehler) }

  func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) { beende(flag, nil) }
  func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) { beende(false, error?.localizedDescription ?? "Format") }
}

final class OrdnerWahl: NSObject, UIDocumentPickerDelegate {
  let fertig: (URL?) -> Void
  init(fertig: @escaping (URL?) -> Void) { self.fertig = fertig }
  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { fertig(urls.first) }
  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { fertig(nil) }
}

/// v1522 — Standortzonen: iOS überwacht Kreiszonen (energiesparend, auch bei geschlossener App) und weckt die App beim
/// Betreten/Verlassen kurz im Hintergrund; die Meldung geht nativ an den Server (nur der Zonenname, nie Koordinaten).
final class ZonenWaechter: NSObject, CLLocationManagerDelegate {
  private let ort = CLLocationManager()
  /// v1526 — letzte Bewegung geht mit jeder Zonenmeldung mit
  weak var bewegung: BewegungsSinn?
  private var erlaubnisFertig: ((String) -> Void)?
  private var ortFertig: (([String: Any]?) -> Void)?
  static let schluessel = "alfred.zonen"

  func starte() { ort.delegate = self }

  func status() -> String {
    switch ort.authorizationStatus {
    case .authorizedAlways: return "immer"
    case .authorizedWhenInUse: return "beimBenutzen"
    case .denied, .restricted: return "abgelehnt"
    default: return "offen"
    }
  }

  /// Erst „Beim Verwenden“, danach „Immer“ (iOS fragt in zwei Schritten); Ergebnis wie status()
  func erlaubnis(_ fertig: @escaping (String) -> Void) {
    erlaubnisFertig = fertig
    switch ort.authorizationStatus {
    case .notDetermined: ort.requestWhenInUseAuthorization()
    case .authorizedWhenInUse: ort.requestAlwaysAuthorization()
    default: erlaubnisFertig = nil; fertig(status())
    }
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    if manager.authorizationStatus == .authorizedWhenInUse, erlaubnisFertig != nil { manager.requestAlwaysAuthorization(); return }
    if let f = erlaubnisFertig, manager.authorizationStatus != .notDetermined { erlaubnisFertig = nil; f(status()) }
    if manager.authorizationStatus == .authorizedAlways { pruefeAlle() }
  }

  func setze(_ liste: [[String: Any]]) {
    UserDefaults.standard.set(liste, forKey: ZonenWaechter.schluessel)
    for r in ort.monitoredRegions { ort.stopMonitoring(for: r) }
    for z in liste.prefix(10) {
      guard let name = z["name"] as? String, let b = z["breite"] as? Double, let l = z["laenge"] as? Double else { continue }
      let radius = min(max((z["radius"] as? Double) ?? 150, 100), ort.maximumRegionMonitoringDistance)
      let r = CLCircularRegion(center: CLLocationCoordinate2D(latitude: b, longitude: l), radius: radius, identifier: name)
      r.notifyOnEntry = true; r.notifyOnExit = true
      ort.startMonitoring(for: r)
    }
    if liste.isEmpty { melde(art: "aus", zone: nil) } else { pruefeAlle() } // keine Zonen: Server vergisst die letzte
  }

  private func pruefeAlle() { for r in ort.monitoredRegions { ort.requestState(for: r) } }

  func ortJetzt(_ fertig: @escaping ([String: Any]?) -> Void) { ortFertig = fertig; ort.requestLocation() }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard let f = ortFertig, let l = locations.last else { return }
    ortFertig = nil
    f(["breite": l.coordinate.latitude, "laenge": l.coordinate.longitude, "genau": l.horizontalAccuracy])
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) { if let f = ortFertig { ortFertig = nil; f(nil) } }

  func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) { melde(art: "betreten", zone: region.identifier) }
  func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) { melde(art: "verlassen", zone: region.identifier) }
  func locationManager(_ manager: CLLocationManager, didDetermineState state: CLRegionState, for region: CLRegion) {
    if state == .inside { melde(art: "betreten", zone: region.identifier) }
    else if state == .outside { melde(art: "verlassen", zone: region.identifier) }
  }

  /// Meldung mit kurzer Hintergrundzeit (iOS weckt die App nur für Sekunden)
  private func melde(art: String, zone: String?) {
    var aufgabe: UIBackgroundTaskIdentifier = .invalid
    aufgabe = UIApplication.shared.beginBackgroundTask(withName: "alfred.zone") { UIApplication.shared.endBackgroundTask(aufgabe); aufgabe = .invalid }
    Task {
      defer { if aufgabe != .invalid { UIApplication.shared.endBackgroundTask(aufgabe) } }
      guard let k = try? Kopplung.lade() else { return }
      let b = await bewegung?.letzte()
      try? await Netz(k).zone(art: art, zone: zone, bewegung: b)
      if #available(iOS 16.0, *) { await FokusAbgleich.jetzt(); await FokusAbgleich.berichte() } // 1.62.0 — Ausschalten des Fokus ruft den Filter nicht auf
    }
  }
}

/// v1526 — Bewegung über CoreMotion (Erlaubnis „Bewegung & Fitness“). Live nur, solange die App läuft; bei einem Zonenereignis
/// im Hintergrund liefert iOS die Aktivität der letzten Minuten nachträglich (letzte()).
final class BewegungsSinn {
  private let manager = CMMotionActivityManager()
  private(set) var aktuell: String?
  var beiWechsel: ((String) -> Void)?

  static func status() -> String {
    guard CMMotionActivityManager.isActivityAvailable() else { return "nichtVerfuegbar" }
    switch CMMotionActivityManager.authorizationStatus() {
    case .authorized: return "erlaubt"
    case .denied, .restricted: return "abgelehnt"
    default: return "offen"
    }
  }

  static func art(_ a: CMMotionActivity) -> String? {
    if a.confidence == .low { return nil }
    if a.automotive { return "auto" }
    if a.cycling { return "rad" }
    if a.running { return "laeuft" }
    if a.walking { return "geht" }
    if a.stationary { return "still" }
    return nil
  }

  /// Live-Aktualisierung (nur bei Erlaubnis; ohne Erlaubnis kein Dialog beim Start)
  func starte() {
    guard BewegungsSinn.status() == "erlaubt" else { return }
    manager.startActivityUpdates(to: .main) { [weak self] a in
      guard let self = self, let a = a, let neu = BewegungsSinn.art(a), neu != self.aktuell else { return }
      self.aktuell = neu
      self.beiWechsel?(neu)
    }
  }

  /// Erlaubnis anfragen: die erste Abfrage zeigt den iOS-Dialog
  func erlaubnis(_ fertig: @escaping (String) -> Void) {
    manager.queryActivityStarting(from: Date().addingTimeInterval(-60), to: Date(), to: .main) { [weak self] _, _ in
      let s = BewegungsSinn.status()
      if s == "erlaubt" { self?.starte() }
      fertig(s)
    }
  }

  /// Letzte sichere Aktivität der vergangenen 10 Minuten (auch im Hintergrund)
  func letzte() async -> String? {
    guard BewegungsSinn.status() == "erlaubt" else { return aktuell }
    return await withCheckedContinuation { f in
      manager.queryActivityStarting(from: Date().addingTimeInterval(-600), to: Date(), to: OperationQueue()) { liste, _ in
        f.resume(returning: (liste ?? []).reversed().lazy.compactMap(BewegungsSinn.art).first ?? self.aktuell)
      }
    }
  }
}

/// 1.54.4 — Datenquelle der Quick-Look-Vorschau (eine Datei)
final class Vorschau: NSObject, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
  let url: URL
  let fertig: () -> Void
  init(_ url: URL, fertig: @escaping () -> Void) { self.url = url; self.fertig = fertig }
  func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
  func previewControllerDidDismiss(_ controller: QLPreviewController) { fertig() }
}

/// 1.54.2 — Fotos aus Mediathek oder Kamera; Ergebnis: Pfade der JPEG-Dateien im tmp-Ordner (leer = abgebrochen)
final class FotoWahl: NSObject, PHPickerViewControllerDelegate, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
  let fertig: ([String]) -> Void
  init(fertig: @escaping ([String]) -> Void) { self.fertig = fertig }

  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    picker.dismiss(animated: true)
    if results.isEmpty { fertig([]); return }
    let gruppe = DispatchGroup(), sperre = NSLock()
    var pfade = [String?](repeating: nil, count: results.count)
    for (i, r) in results.enumerated() where r.itemProvider.canLoadObject(ofClass: UIImage.self) {
      gruppe.enter()
      r.itemProvider.loadObject(ofClass: UIImage.self) { obj, _ in
        let pfad = (obj as? UIImage).flatMap { Foto.speichere($0, nr: i, art: "foto") }
        sperre.lock(); pfade[i] = pfad; sperre.unlock()
        gruppe.leave()
      }
    }
    gruppe.notify(queue: .main) { self.fertig(pfade.compactMap { $0 }) }
  }

  func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
    picker.dismiss(animated: true)
    if let bild = info[.originalImage] as? UIImage, let pfad = Foto.speichere(bild, nr: 0, art: "kamera") { fertig([pfad]) } else { fertig([]) }
  }

  func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { picker.dismiss(animated: true); fertig([]) }
}

enum Foto {
  static func speichere(_ bild: UIImage, nr: Int, art: String) -> String? {
    guard let daten = bild.jpegData(compressionQuality: 0.85) else { return nil }
    let f = DateFormatter(); f.dateFormat = "yyyyMMdd-HHmmss"
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(art)-\(f.string(from: Date()))-\(nr + 1).jpg")
    do { try daten.write(to: url); return url.path } catch { return nil }
  }
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
  /// 1.54.3 — gemeinsame Gruppe mit der Share-Erweiterung („Teilen an Alfred“ liest die Kopplung mit)
  static let gruppe = "T28LD8TF6X.at.alfred.app.gemeinsam"
  /// bis 1.54.2: Standardgruppe der App (Application-Identifier)
  static let alteGruppe = "T28LD8TF6X.at.alfred.app"

  static func basis(_ schluessel: String, gruppe: String = gruppe) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: dienst, kSecAttrAccount as String: schluessel, kSecAttrAccessGroup as String: gruppe]
  }

  private static func roh(_ q: [String: Any]) -> String? {
    var q = q
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var daten: AnyObject?
    guard SecItemCopyMatching(q as CFDictionary, &daten) == errSecSuccess, let d = daten as? Data else { return nil }
    return String(data: d, encoding: .utf8)
  }

  static func lesen(_ schluessel: String) -> String? {
    if let wert = roh(basis(schluessel)) { return wert }
    // einmaliger Umzug aus der alten Gruppe — die Kopplung bleibt, die Share-Erweiterung sieht sie danach
    guard let alt = roh(basis(schluessel, gruppe: alteGruppe)) else { return nil }
    if schreiben(schluessel, alt) { SecItemDelete(basis(schluessel, gruppe: alteGruppe) as CFDictionary) }
    return alt
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
    SecItemDelete(basis(schluessel, gruppe: alteGruppe) as CFDictionary)
    return s == errSecSuccess || s == errSecItemNotFound
  }
}
