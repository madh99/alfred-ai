import CryptoKit
import Security
import UIKit
import UniformTypeIdentifiers

/// „Teilen an Alfred“ (Owner 20.10.): Fotos, Dateien, Links oder Text aus anderen Apps an Alfred schicken.
/// Eine Share-Erweiterung darf die App nicht zuverlässig öffnen — darum sendet sie selbst: Dateien gehen blockweise in den
/// Dateispeicher des Owners (gleiches Protokoll wie die App, /api/geraete/dateien), die Nachricht mit den Upload-Zeilen ins
/// Hauptgespräch. Die Antwort kommt als Mitteilung „Antwort fertig“ (die App ist dabei nicht verbunden).
/// Kopplung und Server-Schlüssel kommen aus dem gemeinsamen Schlüsselbund der App; der Schlüssel wird fest geprüft (SPKI).
@objc(TeilenEinstieg)
final class TeilenEinstieg: UINavigationController {
  override func viewDidLoad() {
    super.viewDidLoad()
    if viewControllers.isEmpty { setViewControllers([ShareViewController()], animated: false) }
  }
}

final class ShareViewController: UIViewController, UITextViewDelegate {
  /// Der Erweiterungs-Kontext hängt am Einstieg (Navigations-Controller), nicht an dieser Ansicht
  private var kontext: NSExtensionContext? { navigationController?.extensionContext ?? extensionContext }
  private let feld = UITextView()
  private let platzhalter = UILabel()
  private let zeile = UILabel()
  private var senden: UIBarButtonItem!
  private var teile: [Teil] = []
  private var laeuft = false

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    title = "An Alfred"
    navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .cancel, target: self, action: #selector(abbrechen))
    senden = UIBarButtonItem(title: "Senden", style: .done, target: self, action: #selector(sendenTippen))
    navigationItem.rightBarButtonItem = senden
    feld.font = .preferredFont(forTextStyle: .body)
    feld.delegate = self
    feld.layer.cornerRadius = 10
    feld.backgroundColor = .secondarySystemBackground
    feld.textContainerInset = UIEdgeInsets(top: 10, left: 8, bottom: 10, right: 8)
    platzhalter.text = "Was soll Alfred damit tun? (optional)"
    platzhalter.textColor = .placeholderText
    platzhalter.font = feld.font
    zeile.font = .preferredFont(forTextStyle: .footnote)
    zeile.textColor = .secondaryLabel
    zeile.numberOfLines = 0
    zeile.text = "Anhänge werden gelesen …"
    for v in [feld, platzhalter, zeile] { v.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(v) }
    NSLayoutConstraint.activate([
      feld.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
      feld.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
      feld.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
      feld.heightAnchor.constraint(equalToConstant: 140),
      platzhalter.topAnchor.constraint(equalTo: feld.topAnchor, constant: 10),
      platzhalter.leadingAnchor.constraint(equalTo: feld.leadingAnchor, constant: 13),
      zeile.topAnchor.constraint(equalTo: feld.bottomAnchor, constant: 10),
      zeile.leadingAnchor.constraint(equalTo: feld.leadingAnchor),
      zeile.trailingAnchor.constraint(equalTo: feld.trailingAnchor),
    ])
    senden.isEnabled = false
    Task { await anhaengeLesen() }
  }

  func textViewDidChange(_ textView: UITextView) { platzhalter.isHidden = !textView.text.isEmpty }

  @objc private func abbrechen() { kontext?.cancelRequest(withError: NSError(domain: "at.alfred.teilen", code: 0)) }

  private func anhaengeLesen() async {
    let anbieter = (kontext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
    var n = 0
    for a in anbieter {
      n += 1
      if let t = await Teil.lade(a, nr: n) { teile.append(t) }
    }
    let dateien = teile.filter { $0.daten != nil }.count, texte = teile.count - dateien
    zeile.text = teile.isEmpty ? "Nichts Lesbares geteilt." : [dateien > 0 ? "\(dateien) \(dateien == 1 ? "Datei" : "Dateien")" : nil, texte > 0 ? "\(texte) \(texte == 1 ? "Link/Text" : "Links/Texte")" : nil].compactMap { $0 }.joined(separator: " · ")
    senden.isEnabled = !teile.isEmpty
    feld.becomeFirstResponder()
  }

  @objc private func sendenTippen() {
    guard !laeuft else { return }
    laeuft = true
    senden.isEnabled = false
    feld.isEditable = false
    let frage = feld.text.trimmingCharacters(in: .whitespacesAndNewlines)
    Task {
      do {
        let k = try Kopplung.lade()
        let netz = Netz(k)
        var zeilen: [String] = []
        for t in teile where t.daten == nil { zeilen.append(t.text) }
        var i = 0
        for t in teile { guard let d = t.daten else { continue }
          i += 1
          await MainActor.run { zeile.text = "Lade \(i) hoch: \(t.name) …" }
          let r = try await netz.hochladen(name: t.name, daten: d)
          zeilen.append("Datei „\(t.name)\" (\(d.count) Bytes, SHA-256 \(r.sha256)) liegt in deinem Dateispeicher, Schlüssel: \(r.key).")
        }
        await MainActor.run { zeile.text = "Sende an Alfred …" }
        let text = ([frage.isEmpty ? "Vom iPhone geteilt:" : frage] + zeilen).joined(separator: "\n")
        try await netz.nachricht(text, chatId: "sitzung:\(k.geraetId):haupt")
        await MainActor.run { zeile.text = "✓ Gesendet — die Antwort kommt als Mitteilung." }
        try? await Task.sleep(nanoseconds: 700_000_000)
        kontext?.completeRequest(returningItems: nil)
      } catch {
        await MainActor.run {
          laeuft = false; senden.isEnabled = true; feld.isEditable = true
          zeile.text = "Nicht gesendet: \(error.localizedDescription)"
        }
      }
    }
  }
}

/// Ein geteilter Inhalt: Datei (Bilder als JPEG) oder Link/Text.
struct Teil {
  let name: String
  let daten: Data?
  let text: String

  static func lade(_ a: NSItemProvider, nr: Int) async -> Teil? {
    if a.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
      if let bild = try? await a.ladeObjekt(UIImage.self), let jpeg = bild.jpegData(compressionQuality: 0.85) {
        let basis = (a.suggestedName ?? "foto-\(nr)").replacingOccurrences(of: "/", with: "_")
        return Teil(name: (basis as NSString).deletingPathExtension + ".jpg", daten: jpeg, text: "")
      }
    }
    if a.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) || (a.hasItemConformingToTypeIdentifier(UTType.data.identifier) && !a.hasItemConformingToTypeIdentifier(UTType.url.identifier)) {
      if let (name, daten) = try? await a.ladeDatei() { return Teil(name: name, daten: daten, text: "") }
    }
    if a.hasItemConformingToTypeIdentifier(UTType.url.identifier), let url = try? await a.ladeElement(UTType.url) as? URL {
      return Teil(name: "", daten: nil, text: "Link: \(url.absoluteString)")
    }
    if a.hasItemConformingToTypeIdentifier(UTType.plainText.identifier), let t = try? await a.ladeElement(UTType.plainText) as? String {
      return Teil(name: "", daten: nil, text: t)
    }
    return nil
  }
}

extension NSItemProvider {
  func ladeObjekt<T: NSItemProviderReading>(_ typ: T.Type) async throws -> T? {
    try await withCheckedThrowingContinuation { f in _ = loadObject(ofClass: typ) { o, e in if let e = e { f.resume(throwing: e) } else { f.resume(returning: o as? T) } } }
  }
  func ladeElement(_ typ: UTType) async throws -> NSSecureCoding? {
    try await withCheckedThrowingContinuation { f in loadItem(forTypeIdentifier: typ.identifier, options: nil) { o, e in if let e = e { f.resume(throwing: e) } else { f.resume(returning: o) } } }
  }
  func ladeDatei() async throws -> (String, Data) {
    try await withCheckedThrowingContinuation { f in
      _ = loadFileRepresentation(forTypeIdentifier: UTType.data.identifier) { url, e in
        guard let url = url else { f.resume(throwing: e ?? NSError(domain: "at.alfred.teilen", code: 1)); return }
        do { f.resume(returning: (self.suggestedName.map { $0 + (url.pathExtension.isEmpty ? "" : ".\(url.pathExtension)") } ?? url.lastPathComponent, try Data(contentsOf: url))) }
        catch { f.resume(throwing: error) }
      }
    }
  }
}

/// Kopplung der App aus dem gemeinsamen Schlüsselbund (lib/handy_verbindung.dart Kopplung.zuJson).
struct Kopplung {
  static let gruppe = "T28LD8TF6X.at.alfred.app.gemeinsam"
  let server: String, geraetId: String, token: String, schluessel: [String]

  static func lade() throws -> Kopplung {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "at.alfred.app", kSecAttrAccount as String: "alfred_kopplung",
                            kSecAttrAccessGroup as String: gruppe, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
    var d: AnyObject?
    guard SecItemCopyMatching(q as CFDictionary, &d) == errSecSuccess, let data = d as? Data,
          let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let server = j["server"] as? String, let id = j["geraetId"] as? String, let token = j["token"] as? String,
          let pins = j["schluessel"] as? [String], !pins.isEmpty else {
      throw NSError(domain: "at.alfred.teilen", code: 2, userInfo: [NSLocalizedDescriptionKey: "Alfred ist nicht gekoppelt — einmal die Alfred-App öffnen"])
    }
    return Kopplung(server: server.trimmingCharacters(in: CharacterSet(charactersIn: "/")), geraetId: id, token: token, schluessel: pins.map { $0.lowercased() })
  }
}

/// HTTPS mit festem Server-Schlüssel (SHA-256 des SubjectPublicKeyInfo, wie lib/spki.dart).
final class Netz: NSObject, URLSessionDelegate {
  private let k: Kopplung
  private lazy var sitzung = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
  init(_ k: Kopplung) { self.k = k }

  func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust, let trust = challenge.protectionSpace.serverTrust,
          let kette = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let blatt = kette.first,
          let spki = Der.spki([UInt8](SecCertificateCopyData(blatt) as Data)) else { completionHandler(.cancelAuthenticationChallenge, nil); return }
    let fp = SHA256.hash(data: Data(spki)).map { String(format: "%02x", $0) }.joined()
    if k.schluessel.contains(fp) { completionHandler(.useCredential, URLCredential(trust: trust)) } else { completionHandler(.cancelAuthenticationChallenge, nil) }
  }

  private func anfrage(_ methode: String, _ pfad: String, _ body: Data?, typ: String = "application/json") -> URLRequest {
    var r = URLRequest(url: URL(string: k.server + pfad)!)
    r.httpMethod = methode
    r.timeoutInterval = 60
    r.setValue("Bearer \(k.token)", forHTTPHeaderField: "Authorization")
    r.setValue(typ, forHTTPHeaderField: "Content-Type")
    r.httpBody = body
    return r
  }

  private func json(_ methode: String, _ pfad: String, _ body: Any?) async throws -> [String: Any] {
    let (d, res) = try await sitzung.data(for: anfrage(methode, pfad, try body.map { try JSONSerialization.data(withJSONObject: $0) }))
    let j = (try? JSONSerialization.jsonObject(with: d) as? [String: Any]) ?? [:]
    guard (res as? HTTPURLResponse)?.statusCode == 200 else { throw NSError(domain: "at.alfred.teilen", code: 3, userInfo: [NSLocalizedDescriptionKey: "\(j["error"] ?? "HTTP \((res as? HTTPURLResponse)?.statusCode ?? 0)")"]) }
    return j
  }

  /// Blockweise in den Dateispeicher (POST start → PUT Blöcke → POST fertig), wie lib/transfer.dart.
  func hochladen(name: String, daten: Data) async throws -> (key: String, sha256: String) {
    let hash = SHA256.hash(data: daten).map { String(format: "%02x", $0) }.joined()
    let start = try await json("POST", "/api/geraete/dateien", ["name": name, "groesse": daten.count, "sha256": hash])
    guard let id = start["id"] as? String else { throw NSError(domain: "at.alfred.teilen", code: 4, userInfo: [NSLocalizedDescriptionKey: "Upload nicht gestartet"]) }
    let block = (start["blockGroesse"] as? Int) ?? 1024 * 1024
    var offset = 0
    while offset < daten.count {
      let ende = min(offset + block, daten.count)
      let (d, res) = try await sitzung.data(for: anfrage("PUT", "/api/geraete/dateien/\(id)?offset=\(offset)", daten.subdata(in: offset..<ende), typ: "application/octet-stream"))
      let j = (try? JSONSerialization.jsonObject(with: d) as? [String: Any]) ?? [:]
      let status = (res as? HTTPURLResponse)?.statusCode ?? 0
      if status == 409, let e = j["empfangen"] as? Int { offset = e; continue }
      guard status == 200 else { throw NSError(domain: "at.alfred.teilen", code: 5, userInfo: [NSLocalizedDescriptionKey: "\(j["error"] ?? "Block HTTP \(status)")"]) }
      offset = (j["empfangen"] as? Int) ?? ende
    }
    let fertig = try await json("POST", "/api/geraete/dateien/\(id)/fertig", nil)
    guard let key = fertig["key"] as? String else { throw NSError(domain: "at.alfred.teilen", code: 6, userInfo: [NSLocalizedDescriptionKey: "Upload ohne Schlüssel"]) }
    return (key, hash)
  }

  /// Nachricht ins Gespräch; es wird nur auf die Annahme gewartet (die Antwort kommt als Mitteilung).
  func nachricht(_ text: String, chatId: String) async throws {
    let body = try JSONSerialization.data(withJSONObject: ["text": text, "chatId": chatId, "stream": true])
    let (bytes, res) = try await sitzung.bytes(for: anfrage("POST", "/api/message", body))
    let status = (res as? HTTPURLResponse)?.statusCode ?? 0
    bytes.task.cancel()
    guard status == 200 else { throw NSError(domain: "at.alfred.teilen", code: 7, userInfo: [NSLocalizedDescriptionKey: "Nachricht abgelehnt (HTTP \(status))"]) }
  }
}

/// SubjectPublicKeyInfo aus einem X.509-Zertifikat (DER), wie lib/spki.dart.
enum Der {
  static func laenge(_ d: [UInt8], _ i: Int) -> (kopf: Int, inhalt: Int)? {
    guard i + 1 < d.count else { return nil }
    let l = d[i + 1]
    if l < 0x80 { return (2, Int(l)) }
    let n = Int(l & 0x7f)
    guard n > 0, n <= 4, i + 1 + n < d.count else { return nil }
    var v = 0
    for k in 0..<n { v = v << 8 | Int(d[i + 2 + k]) }
    return (2 + n, v)
  }

  static func spki(_ d: [UInt8]) -> [UInt8]? {
    guard let zert = laenge(d, 0), let tbs = laenge(d, zert.kopf) else { return nil }
    var j = zert.kopf + tbs.kopf
    if j < d.count, d[j] == 0xA0 { guard let v = laenge(d, j) else { return nil }; j += v.kopf + v.inhalt } // [0] Version
    for _ in 0..<5 { guard let e = laenge(d, j) else { return nil }; j += e.kopf + e.inhalt } // Serial, Algorithmus, Aussteller, Gültigkeit, Inhaber
    guard let s = laenge(d, j), j + s.kopf + s.inhalt <= d.count else { return nil }
    return Array(d[j..<(j + s.kopf + s.inhalt)])
  }
}
