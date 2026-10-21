import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

// 1.72.0 (v1540, Owner 21.10. „Widget vollumfänglich alle Größen und live bei rot mitmachen“) — Lage-Widget für Home-Bildschirm
// (klein, mittel, groß, iPad extragroß), Sperrbildschirm (rund, rechteckig, Zeile), StandBy und die Live-Aktivität bei roter Lage.
// Daten direkt vom Server über die gepinnte Verbindung (Gemeinsam/AlfredNetz.swift); ohne Netz der zuletzt gesehene Stand.

@main
struct AlfredWidgets: WidgetBundle {
  var body: some Widget {
    LageWidget()
    LageLiveAktivitaet()
  }
}

// ── Daten ──────────────────────────────────────────────────────────────────────────────────────────────────────

struct LageEintrag: TimelineEntry {
  let date: Date
  let lage: LageKurz?
  let fehler: String?
}

struct LageQuelle: TimelineProvider {
  func placeholder(in context: Context) -> LageEintrag { LageEintrag(date: Date(), lage: .beispiel, fehler: nil) }

  func getSnapshot(in context: Context, completion: @escaping (LageEintrag) -> Void) {
    if context.isPreview { completion(placeholder(in: context)); return }
    Task { completion(await LageQuelle.lade()) }
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<LageEintrag>) -> Void) {
    Task {
      let e = await LageQuelle.lade()
      // rot: öfter nachsehen; iOS begrenzt die Zahl der Auffrischungen ohnehin (Budget je Tag)
      let abstand: TimeInterval = e.lage?.ampel == "bad" ? 5 * 60 : 15 * 60
      completion(Timeline(entries: [e], policy: .after(Date().addingTimeInterval(abstand))))
    }
  }

  static func lade() async -> LageEintrag {
    do {
      let d = try await Netz(try Kopplung.lade()).daten("/api/geraete/lage")
      let l = try JSONDecoder().decode(LageKurz.self, from: d)
      GemeinsamerSpeicher.schreib("lage_kurz", String(data: d, encoding: .utf8))
      return LageEintrag(date: Date(), lage: l, fehler: nil)
    } catch {
      if let s = GemeinsamerSpeicher.lies("lage_kurz") as? String, let d = s.data(using: .utf8), let l = try? JSONDecoder().decode(LageKurz.self, from: d) {
        return LageEintrag(date: Date(), lage: l, fehler: "nicht erreichbar")
      }
      return LageEintrag(date: Date(), lage: nil, fehler: error.localizedDescription)
    }
  }
}

// ── Knöpfe (iOS 17: interaktiv im Widget) ───────────────────────────────────────────────────────────────────────

@available(iOS 17.0, *)
struct LageAktualisieren: AppIntent {
  static var title: LocalizedStringResource = "Lage aktualisieren"
  static var description = IntentDescription("Holt die Lage von Alfred neu.")
  func perform() async throws -> some IntentResult {
    WidgetCenter.shared.reloadTimelines(ofKind: LageWidget.art)
    return .result()
  }
}

@available(iOS 17.0, *)
struct VorgangSpaeter: AppIntent {
  static var title: LocalizedStringResource = "Vorgang auf morgen"
  static var description = IntentDescription("Stellt den Vorgang bis morgen früh zurück.")
  @Parameter(title: "Vorgang") var id: String
  init() {}
  init(id: String) { self.id = id }
  func perform() async throws -> some IntentResult {
    try await Netz(try Kopplung.lade()).spaeter(vorgang: id)
    WidgetCenter.shared.reloadTimelines(ofKind: LageWidget.art)
    return .result()
  }
}

// ── Darstellung ────────────────────────────────────────────────────────────────────────────────────────────────

enum Stil {
  static func farbe(_ ampel: String) -> Color { ampel == "bad" ? .red : ampel == "warn" ? .orange : .green }
  static func symbol(_ ampel: String) -> String { ampel == "bad" ? "exclamationmark.octagon.fill" : ampel == "warn" ? "exclamationmark.triangle.fill" : "checkmark.seal.fill" }
  static func uhrzeit(_ iso: String) -> String {
    guard let d = ISO8601DateFormatter.mitBruchteil.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return "" }
    let f = DateFormatter(); f.locale = Locale(identifier: "de_AT"); f.dateFormat = "HH:mm"
    return f.string(from: d)
  }
  static func alter(_ iso: String) -> String {
    guard let d = ISO8601DateFormatter.mitBruchteil.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return "" }
    let min = Int(Date().timeIntervalSince(d) / 60)
    if min < 60 { return "\(max(min, 1)) min" }
    let h = min / 60
    return h < 48 ? "\(h) h" : "\(h / 24) T"
  }
  static func kosten(_ k: LageKurz.Kosten) -> String? {
    guard let h = k.heute else { return nil }
    return k.budget.map { String(format: "%.2f $ / %.0f $", h, $0) } ?? String(format: "%.2f $", h)
  }
}

extension ISO8601DateFormatter {
  static let mitBruchteil: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()
}

extension View {
  @ViewBuilder func widgetHintergrund() -> some View {
    if #available(iOS 17.0, *) { containerBackground(for: .widget) { Color(UIColor.systemBackground) } } else { background(Color(UIColor.systemBackground)) }
  }
}

struct LageWidget: Widget {
  static let art = "AlfredLage"
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: LageWidget.art, provider: LageQuelle()) { e in LageAnsicht(e: e) }
      .configurationDisplayName("Lage")
      .description("Zustand von Haus und Systemen, Befunde und was dich braucht.")
      .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .systemExtraLarge, .accessoryCircular, .accessoryRectangular, .accessoryInline])
  }
}

struct LageAnsicht: View {
  @Environment(\.widgetFamily) var familie
  let e: LageEintrag

  var body: some View {
    Group {
      if let l = e.lage {
        switch familie {
        case .accessoryCircular: rund(l)
        case .accessoryRectangular: rechteckig(l)
        case .accessoryInline: Text("Alfred: \(l.text)")
        case .systemSmall: klein(l)
        case .systemMedium: mittel(l)
        default: gross(l)
        }
      } else {
        VStack(alignment: .leading, spacing: 4) {
          Label("Alfred", systemImage: "wifi.slash").font(.headline)
          Text(e.fehler ?? "Noch keine Lage").font(.caption).foregroundStyle(.secondary)
        }
      }
    }
    .widgetHintergrund()
    .widgetURL(URL(string: "alfred://lage"))
  }

  // Sperrbildschirm
  func rund(_ l: LageKurz) -> some View {
    ZStack {
      AccessoryWidgetBackground()
      VStack(spacing: 0) {
        Image(systemName: Stil.symbol(l.ampel)).font(.title3)
        let n = l.braucht + l.bestaetigungen
        if n > 0 { Text("\(n)").font(.caption2).bold() }
      }
    }
  }

  func rechteckig(_ l: LageKurz) -> some View {
    VStack(alignment: .leading, spacing: 1) {
      Label(l.text, systemImage: Stil.symbol(l.ampel)).font(.headline).lineLimit(1)
      if let b = l.befunde.first { Text(b.titel).font(.caption).lineLimit(1).privacySensitive() }
      let n = l.braucht + l.bestaetigungen
      Text(n > 0 ? "\(n) brauchen dich" : "nichts offen").font(.caption2).foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  // Home-Bildschirm
  func kopf(_ l: LageKurz, gross: Bool = false) -> some View {
    HStack(spacing: 6) {
      Image(systemName: Stil.symbol(l.ampel)).foregroundStyle(Stil.farbe(l.ampel)).font(gross ? .title2 : .title3)
      Text(l.text).font(gross ? .title3.bold() : .headline).lineLimit(1).minimumScaleFactor(0.8)
      Spacer(minLength: 0)
      Text(e.fehler != nil ? "offline" : Stil.uhrzeit(l.stand)).font(.caption2).foregroundStyle(e.fehler != nil ? .orange : .secondary)
    }
  }

  func klein(_ l: LageKurz) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Image(systemName: Stil.symbol(l.ampel)).font(.largeTitle).foregroundStyle(Stil.farbe(l.ampel))
      Text(l.text).font(.headline).lineLimit(2).minimumScaleFactor(0.8)
      Spacer(minLength: 0)
      let n = l.braucht + l.bestaetigungen
      Text(n > 0 ? "\(n) brauchen dich" : "nichts offen").font(.caption).foregroundStyle(n > 0 ? .orange : .secondary)
      Text("\(l.geraete.online)/\(l.geraete.gesamt) Geräte · \(e.fehler != nil ? "offline" : Stil.uhrzeit(l.stand))").font(.caption2).foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }

  func mittel(_ l: LageKurz) -> some View {
    VStack(alignment: .leading, spacing: 5) {
      kopf(l)
      if let b = l.befunde.first {
        Link(destination: URL(string: "alfred://befund?id=\(b.id)")!) {
          Label { Text(b.titel).lineLimit(1) } icon: { Image(systemName: "exclamationmark.circle").foregroundStyle(.orange) }.font(.subheadline)
        }
      } else if let z = l.zeilen.first {
        Text(z.stichwort.map { "\($0): \(z.text)" } ?? z.text).font(.subheadline).lineLimit(1)
      }
      Link(destination: URL(string: "alfred://eingang")!) {
        Label("\(l.braucht) Vorgänge · \(l.bestaetigungen) Bestätigungen", systemImage: "hand.raised").font(.caption).foregroundStyle(l.braucht + l.bestaetigungen > 0 ? .orange : .secondary)
      }
      Spacer(minLength: 0)
      HStack {
        Label("\(l.geraete.online)/\(l.geraete.gesamt)", systemImage: "desktopcomputer").font(.caption2)
        if let k = Stil.kosten(l.kosten) { Label(k, systemImage: "dollarsign.circle").font(.caption2) }
        Spacer()
        knopfAktualisieren
      }.foregroundStyle(.secondary)
    }
  }

  func gross(_ l: LageKurz) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      kopf(l, gross: true)
      HStack(spacing: 12) {
        Label("\(l.geraete.online)/\(l.geraete.gesamt) Geräte", systemImage: "desktopcomputer")
        if let k = Stil.kosten(l.kosten) { Label(k, systemImage: "dollarsign.circle") }
        if l.modelleGestoert > 0 { Label("\(l.modelleGestoert) Modell gestört", systemImage: "cpu").foregroundStyle(.red) }
      }.font(.caption).foregroundStyle(.secondary)
      Divider()
      Text("Befunde (\(l.befundeGesamt))").font(.caption.bold()).foregroundStyle(.secondary)
      if l.befunde.isEmpty { Text("keine offenen Befunde").font(.subheadline).foregroundStyle(.secondary) }
      ForEach(Array(l.befunde.prefix(familie == .systemExtraLarge ? 5 : 3).enumerated()), id: \.offset) { _, b in
        Link(destination: URL(string: "alfred://befund?id=\(b.id)")!) {
          HStack {
            Image(systemName: "exclamationmark.circle").foregroundStyle(.orange)
            Text(b.titel).lineLimit(1)
            Spacer(minLength: 4)
            Text(Stil.alter(b.seit)).font(.caption2).foregroundStyle(.secondary)
          }.font(.subheadline)
        }
      }
      Divider()
      if let v = l.vorgang {
        HStack {
          Link(destination: URL(string: "alfred://vorgang?id=\(v.id)")!) {
            Label { Text(v.titel).lineLimit(1) } icon: { Image(systemName: "hand.raised").foregroundStyle(.orange) }.font(.subheadline)
          }
          Spacer(minLength: 4)
          if #available(iOS 17.0, *) {
            Button(intent: VorgangSpaeter(id: v.id)) { Text("Morgen").font(.caption) }.buttonStyle(.bordered)
          }
        }
      }
      Link(destination: URL(string: "alfred://eingang")!) {
        Label("\(l.braucht) Vorgänge · \(l.bestaetigungen) Bestätigungen brauchen dich", systemImage: "tray").font(.caption).foregroundStyle(l.braucht + l.bestaetigungen > 0 ? .orange : .secondary)
      }
      Spacer(minLength: 0)
      HStack { Spacer(); knopfAktualisieren }
    }
  }

  @ViewBuilder var knopfAktualisieren: some View {
    if #available(iOS 17.0, *) {
      Button(intent: LageAktualisieren()) { Image(systemName: "arrow.clockwise") }.buttonStyle(.plain).font(.caption)
    }
  }
}

// ── Live-Aktivität (Sperrbildschirm, Dynamic Island) ────────────────────────────────────────────────────────────

struct LageLiveAktivitaet: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: LageAttribute.self) { ctx in
      HStack(spacing: 12) {
        Image(systemName: Stil.symbol(ctx.state.ampel)).font(.title).foregroundStyle(Stil.farbe(ctx.state.ampel))
        VStack(alignment: .leading, spacing: 2) {
          Text("Alfred: \(ctx.state.titel)").font(.headline)
          Text(ctx.state.zeile).font(.subheadline).lineLimit(2)
        }
        Spacer()
        Text(ctx.state.stand).font(.caption).foregroundStyle(.secondary)
      }
      .padding()
      .activityBackgroundTint(Stil.farbe(ctx.state.ampel).opacity(0.15))
      .widgetURL(URL(string: "alfred://lage"))
    } dynamicIsland: { ctx in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) { Image(systemName: Stil.symbol(ctx.state.ampel)).font(.title2).foregroundStyle(Stil.farbe(ctx.state.ampel)) }
        DynamicIslandExpandedRegion(.trailing) { Text(ctx.state.stand).font(.caption).foregroundStyle(.secondary) }
        DynamicIslandExpandedRegion(.center) { Text("Alfred: \(ctx.state.titel)").font(.headline) }
        DynamicIslandExpandedRegion(.bottom) { Text(ctx.state.zeile).font(.subheadline).lineLimit(2) }
      } compactLeading: {
        Image(systemName: Stil.symbol(ctx.state.ampel)).foregroundStyle(Stil.farbe(ctx.state.ampel))
      } compactTrailing: {
        Text(ctx.state.anzahl > 0 ? "\(ctx.state.anzahl)" : "✓").font(.caption.bold())
      } minimal: {
        Image(systemName: Stil.symbol(ctx.state.ampel)).foregroundStyle(Stil.farbe(ctx.state.ampel))
      }
      .widgetURL(URL(string: "alfred://lage"))
    }
  }
}
