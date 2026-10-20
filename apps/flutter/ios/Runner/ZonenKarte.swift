import MapKit
import UIKit

/// v1526 (Owner 20.10.: „Kartenansicht mit Adresseingabe“) — Standortzonen auf der Karte: alle Zonen als Kreise, neue Zone
/// über die Adresssuche oder langes Tippen, Mittelpunkt verschieben (Stecknadel ziehen), Umkreis 100–500 m, umbenennen,
/// löschen. Ergebnis geht an Dart (Einstellungen) und von dort an die Zonenüberwachung; die Zonen bleiben auf dem iPhone.
final class ZonenKarte: UIViewController, MKMapViewDelegate, UISearchBarDelegate {
  struct Zone { var name: String; var mitte: CLLocationCoordinate2D; var radius: Double }

  private let karte = MKMapView()
  private let suche = UISearchBar()
  private let leiste = UIView()
  private let titel = UILabel()
  private let regler = UISlider()
  private let umkreis = UILabel()
  private var zonen: [Zone]
  private var gewaehlt: Int?
  private let fertig: ([Zone]?) -> Void

  init(zonen: [Zone], fertig: @escaping ([Zone]?) -> Void) {
    self.zonen = zonen; self.fertig = fertig
    super.init(nibName: nil, bundle: nil)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) wird nicht genutzt") }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    title = "Standortzonen"
    navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .cancel, target: self, action: #selector(abbrechen))
    navigationItem.rightBarButtonItem = UIBarButtonItem(title: "Fertig", style: .done, target: self, action: #selector(uebernehmen))
    suche.placeholder = "Adresse oder Ort suchen"
    suche.delegate = self
    suche.searchBarStyle = .minimal
    karte.delegate = self
    karte.showsUserLocation = true
    karte.addGestureRecognizer(UILongPressGestureRecognizer(target: self, action: #selector(langGedrueckt(_:))))
    leiste.backgroundColor = .secondarySystemBackground
    leiste.layer.cornerRadius = 14
    leiste.isHidden = true
    titel.font = .preferredFont(forTextStyle: .headline)
    umkreis.font = .preferredFont(forTextStyle: .footnote)
    umkreis.textColor = .secondaryLabel
    regler.minimumValue = 0; regler.maximumValue = 1 // v1527 — logarithmisch 100 m … 3 km (Owner 20.10.)
    regler.addTarget(self, action: #selector(radiusGeaendert), for: .valueChanged)
    let umbenennen = UIButton(type: .system); umbenennen.setTitle("Umbenennen", for: .normal); umbenennen.addTarget(self, action: #selector(umbenennenTippen), for: .touchUpInside)
    let loeschen = UIButton(type: .system); loeschen.setTitle("Löschen", for: .normal); loeschen.setTitleColor(.systemRed, for: .normal); loeschen.addTarget(self, action: #selector(loeschenTippen), for: .touchUpInside)
    let knoepfe = UIStackView(arrangedSubviews: [umbenennen, UIView(), loeschen])
    let spalte = UIStackView(arrangedSubviews: [titel, regler, umkreis, knoepfe])
    spalte.axis = .vertical; spalte.spacing = 8
    let hinweis = UILabel()
    hinweis.text = "Lang tippen legt eine Zone an · Stecknadel ziehen verschiebt sie"
    hinweis.font = .preferredFont(forTextStyle: .caption1); hinweis.textColor = .secondaryLabel; hinweis.numberOfLines = 0
    for v in [suche, karte, leiste, hinweis, spalte] as [UIView] { v.translatesAutoresizingMaskIntoConstraints = false }
    view.addSubview(suche); view.addSubview(karte); view.addSubview(hinweis); view.addSubview(leiste); leiste.addSubview(spalte)
    NSLayoutConstraint.activate([
      suche.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
      suche.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 8),
      suche.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -8),
      hinweis.topAnchor.constraint(equalTo: suche.bottomAnchor),
      hinweis.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
      hinweis.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
      karte.topAnchor.constraint(equalTo: hinweis.bottomAnchor, constant: 6),
      karte.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      karte.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      karte.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      leiste.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
      leiste.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
      leiste.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -12),
      spalte.topAnchor.constraint(equalTo: leiste.topAnchor, constant: 14),
      spalte.leadingAnchor.constraint(equalTo: leiste.leadingAnchor, constant: 16),
      spalte.trailingAnchor.constraint(equalTo: leiste.trailingAnchor, constant: -16),
      spalte.bottomAnchor.constraint(equalTo: leiste.bottomAnchor, constant: -10),
    ])
    zeichnen()
    zeigeAlle()
  }

  // ── Darstellung ──

  private func zeichnen() {
    karte.removeOverlays(karte.overlays)
    karte.removeAnnotations(karte.annotations.filter { !($0 is MKUserLocation) })
    for (i, z) in zonen.enumerated() {
      karte.addOverlay(MKCircle(center: z.mitte, radius: z.radius))
      let a = MKPointAnnotation(); a.coordinate = z.mitte; a.title = z.name; a.subtitle = "\(Int(z.radius)) m"
      karte.addAnnotation(a)
      if gewaehlt == i { karte.selectAnnotation(a, animated: false) }
    }
    leisteZeigen()
  }

  private func zeigeAlle() {
    guard !zonen.isEmpty else {
      if let ort = karte.userLocation.location { karte.setRegion(MKCoordinateRegion(center: ort.coordinate, latitudinalMeters: 2000, longitudinalMeters: 2000), animated: false) }
      return
    }
    var rahmen = MKMapRect.null
    for z in zonen { rahmen = rahmen.union(MKCircle(center: z.mitte, radius: z.radius).boundingMapRect) }
    karte.setVisibleMapRect(rahmen, edgePadding: UIEdgeInsets(top: 60, left: 40, bottom: 220, right: 40), animated: false)
  }

  private func leisteZeigen() {
    guard let i = gewaehlt, i < zonen.count else { leiste.isHidden = true; return }
    leiste.isHidden = false
    titel.text = zonen[i].name
    regler.value = ZonenKarte.reglerWert(zonen[i].radius)
    umkreis.text = umkreisText(zonen[i].radius)
  }

  func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
    let r = MKCircleRenderer(overlay: overlay)
    r.fillColor = UIColor.systemBlue.withAlphaComponent(0.15)
    r.strokeColor = UIColor.systemBlue
    r.lineWidth = 2
    return r
  }

  func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
    if annotation is MKUserLocation { return nil }
    let v = mapView.dequeueReusableAnnotationView(withIdentifier: "zone") as? MKMarkerAnnotationView ?? MKMarkerAnnotationView(annotation: annotation, reuseIdentifier: "zone")
    v.annotation = annotation
    v.isDraggable = true
    v.canShowCallout = true
    return v
  }

  func mapView(_ mapView: MKMapView, didSelect view: MKAnnotationView) {
    guard let a = view.annotation, !(a is MKUserLocation) else { return }
    gewaehlt = zonen.firstIndex { $0.name == a.title ?? "" }
    leisteZeigen()
  }

  func mapView(_ mapView: MKMapView, annotationView view: MKAnnotationView, didChange newState: MKAnnotationView.DragState, fromOldState oldState: MKAnnotationView.DragState) {
    guard newState == .ending, let a = view.annotation, let i = zonen.firstIndex(where: { $0.name == a.title ?? "" }) else { return }
    zonen[i].mitte = a.coordinate
    gewaehlt = i
    zeichnen()
  }

  // ── Bearbeiten ──

  /// v1527 — Umkreis logarithmisch: 100 m … 3 km; unter 500 m in 10-m-, bis 1 km in 50-m-, darüber in 100-m-Schritten.
  /// Untergrenze 100 m: iOS bestimmt den Ort für Zonen auf etwa 50–200 m genau, kleinere Kreise wirken nicht genauer.
  static let minRadius = 100.0, maxRadius = 3000.0
  static func radius(_ wert: Float) -> Double {
    let r = minRadius * pow(maxRadius / minRadius, Double(min(max(wert, 0), 1)))
    let schritt = r < 500 ? 10.0 : r < 1000 ? 50.0 : 100.0
    return min(max((r / schritt).rounded() * schritt, minRadius), maxRadius)
  }
  static func reglerWert(_ radius: Double) -> Float {
    Float(log(min(max(radius, minRadius), maxRadius) / minRadius) / log(maxRadius / minRadius))
  }
  private func umkreisText(_ r: Double) -> String { r >= 1000 ? String(format: "Umkreis %.1f km", r / 1000).replacingOccurrences(of: ".", with: ",") : "Umkreis \(Int(r)) m" }

  @objc private func radiusGeaendert() {
    guard let i = gewaehlt else { return }
    zonen[i].radius = ZonenKarte.radius(regler.value)
    umkreis.text = umkreisText(zonen[i].radius)
    karte.removeOverlays(karte.overlays)
    for z in zonen { karte.addOverlay(MKCircle(center: z.mitte, radius: z.radius)) }
  }

  @objc private func langGedrueckt(_ g: UILongPressGestureRecognizer) {
    guard g.state == .began else { return }
    neueZone(bei: karte.convert(g.location(in: karte), toCoordinateFrom: karte))
  }

  private func vorschlag() -> String {
    let namen = Set(zonen.map { $0.name.lowercased() })
    if !namen.contains("zuhause") { return "Zuhause" }
    if !namen.contains("büro") { return "Büro" }
    return "Zone \(zonen.count + 1)"
  }

  private func neueZone(bei ort: CLLocationCoordinate2D, name: String? = nil) {
    guard zonen.count < 10 else { melde("Höchstens 10 Zonen"); return }
    namensDialog(titel: "Neue Zone", text: name ?? vorschlag()) { [weak self] n in
      guard let self = self else { return }
      self.zonen.removeAll { $0.name.lowercased() == n.lowercased() } // gleichnamige ersetzen (z. B. „Zuhause“ statt Home Assistant)
      self.zonen.append(Zone(name: n, mitte: ort, radius: 150))
      self.gewaehlt = self.zonen.count - 1
      self.zeichnen()
    }
  }

  @objc private func umbenennenTippen() {
    guard let i = gewaehlt else { return }
    namensDialog(titel: "Zone umbenennen", text: zonen[i].name) { [weak self] n in
      guard let self = self else { return }
      if self.zonen.enumerated().contains(where: { $0.offset != i && $0.element.name.lowercased() == n.lowercased() }) { self.melde("Name „\(n)“ gibt es schon"); return }
      self.zonen[i].name = n
      self.zeichnen()
    }
  }

  @objc private func loeschenTippen() {
    guard let i = gewaehlt else { return }
    zonen.remove(at: i)
    gewaehlt = nil
    zeichnen()
  }

  private func namensDialog(titel: String, text: String, fertig: @escaping (String) -> Void) {
    let a = UIAlertController(title: titel, message: nil, preferredStyle: .alert)
    a.addTextField { $0.text = text; $0.clearButtonMode = .whileEditing; $0.autocapitalizationType = .sentences }
    a.addAction(UIAlertAction(title: "Abbrechen", style: .cancel))
    a.addAction(UIAlertAction(title: "OK", style: .default) { _ in
      let n = (a.textFields?.first?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      if !n.isEmpty { fertig(String(n.prefix(40))) }
    })
    present(a, animated: true)
  }

  private func melde(_ text: String) {
    let a = UIAlertController(title: text, message: nil, preferredStyle: .alert)
    a.addAction(UIAlertAction(title: "OK", style: .default))
    present(a, animated: true)
  }

  // ── Adresssuche ──

  func searchBarSearchButtonClicked(_ searchBar: UISearchBar) {
    searchBar.resignFirstResponder()
    guard let text = searchBar.text?.trimmingCharacters(in: .whitespaces), !text.isEmpty else { return }
    let anfrage = MKLocalSearch.Request()
    anfrage.naturalLanguageQuery = text
    anfrage.region = karte.region
    MKLocalSearch(request: anfrage).start { [weak self] antwort, _ in
      guard let self = self else { return }
      guard let treffer = antwort?.mapItems.first else { self.melde("Nichts gefunden: \(text)"); return }
      let ort = treffer.placemark.coordinate
      self.karte.setRegion(MKCoordinateRegion(center: ort, latitudinalMeters: 1200, longitudinalMeters: 1200), animated: true)
      self.neueZone(bei: ort)
    }
  }

  // ── Abschluss ──

  @objc private func abbrechen() { dismiss(animated: true) { self.fertig(nil) } }
  @objc private func uebernehmen() { let z = zonen; dismiss(animated: true) { self.fertig(z) } }
}
