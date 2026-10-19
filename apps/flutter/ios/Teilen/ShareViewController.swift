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
