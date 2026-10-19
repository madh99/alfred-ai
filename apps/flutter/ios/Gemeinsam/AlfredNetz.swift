import CryptoKit
import Foundation
import Security

// Gemeinsam für App (Runner) und Share-Erweiterung (Teilen): Kopplung aus dem gemeinsamen Schlüsselbund und HTTPS mit
// festem Server-Schlüssel. Die App nutzt es für Meldungen ohne laufendes Flutter (v1522 Standortzonen im Hintergrund).

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

  /// v1522 — Standortzone melden (nur der Name; `null` = unterwegs).
  func zone(art: String, zone: String?) async throws {
    _ = try await json("POST", "/api/geraete/zone", ["art": art, "zone": zone.map { $0 as Any } ?? NSNull()])
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
