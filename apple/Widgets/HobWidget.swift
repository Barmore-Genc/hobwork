import AppIntents
import SwiftUI
import WidgetKit

/// A hob's widget: what its widget route answers, fetched through the host.
struct HobWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "dev.bgenc.hobwork.HobWidget", intent: HobWidgetIntent.self, provider: HobWidgetProvider()) { entry in
            HobWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Hob")
        .description("Shows what a hob puts in its widget.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular, .accessoryInline])
    }
}

struct HobWidgetEntry: TimelineEntry {
    enum Content {
        case loaded(WidgetContent)
        case placeholder
        /// Shown in place of content, written for the person looking at the widget.
        case message(String)
    }

    var date: Date
    var hob: String?
    var content: Content

    var link: URL? {
        guard let hob else { return nil }
        if case let .loaded(content) = content { return HobLink(hob: hob, path: content.open)?.url }
        return HobLink(hob: hob, path: nil)?.url
    }
}

struct HobWidgetProvider: AppIntentTimelineProvider {
    /// After a failure the widget tries again sooner than the usual refresh.
    static let retryInterval: TimeInterval = 10 * 60

    func placeholder(in context: Context) -> HobWidgetEntry {
        HobWidgetEntry(date: .now, hob: nil, content: .placeholder)
    }

    func snapshot(for configuration: HobWidgetIntent, in context: Context) async -> HobWidgetEntry {
        if context.isPreview, configuration.hob == nil { return placeholder(in: context) }
        return await entry(for: configuration).entry
    }

    func timeline(for configuration: HobWidgetIntent, in context: Context) async -> Timeline<HobWidgetEntry> {
        let (entry, next) = await entry(for: configuration)
        return Timeline(entries: [entry], policy: .after(next))
    }

    private func entry(for configuration: HobWidgetIntent) async -> (entry: HobWidgetEntry, next: Date) {
        let now = Date.now
        guard let hob = configuration.hob?.id else {
            return (HobWidgetEntry(date: now, hob: nil, content: .message("Edit the widget to choose a hob.")), .distantFuture)
        }
        guard let api = HostAPI.stored else {
            return (HobWidgetEntry(date: now, hob: hob, content: .message("Open Hobwork and connect it to your Hobwork host.")), now.addingTimeInterval(Self.retryInterval))
        }
        do {
            let content = try await api.widget(hob: hob)
            return (HobWidgetEntry(date: now, hob: hob, content: .loaded(content)), content.nextRefresh(after: now))
        } catch HostError.failed(status: 404, _) {
            return (HobWidgetEntry(date: now, hob: hob, content: .message("\(hob) has no widget.")), now.addingTimeInterval(WidgetContent.refreshInterval))
        } catch HostError.unauthorized {
            return (HobWidgetEntry(date: now, hob: hob, content: .message("Open Hobwork and connect it to your Hobwork host.")), now.addingTimeInterval(Self.retryInterval))
        } catch {
            return (HobWidgetEntry(date: now, hob: hob, content: .message("Couldn't load \(hob).")), now.addingTimeInterval(Self.retryInterval))
        }
    }
}

struct HobWidgetView: View {
    let entry: HobWidgetEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        content
            .widgetURL(entry.link)
    }

    @ViewBuilder private var content: some View {
        switch entry.content {
        case let .loaded(content):
            loaded(content)
        case .placeholder:
            loaded(WidgetContent(title: "Spools", subtitle: "3 low", lines: [
                .init(text: "PLA Black", detail: "120 g", swatches: ["#222222"]),
                .init(text: "PETG Blue", detail: "340 g", swatches: ["#2F6FDB"]),
            ]))
            .redacted(reason: .placeholder)
        case let .message(message):
            switch family {
            case .accessoryInline:
                Text(message)
            default:
                VStack(alignment: .leading, spacing: 4) {
                    if let hob = entry.hob {
                        Text(hob).font(.headline)
                    }
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
    }

    @ViewBuilder private func loaded(_ content: WidgetContent) -> some View {
        let lines = content.lines ?? []
        switch family {
        case .accessoryInline:
            Text(content.subtitle.map { "\(content.title): \($0)" } ?? content.title)
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 1) {
                Text(content.title)
                    .font(.headline)
                    .widgetAccentable()
                ForEach(Array(lines.prefix(2).enumerated()), id: \.offset) { _, line in
                    Text(line.detail.map { "\(line.text) \($0)" } ?? line.text)
                }
                if lines.isEmpty, let subtitle = content.subtitle { Text(subtitle) }
            }
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
        default:
            let count = family == .systemSmall ? 3 : 4
            VStack(alignment: .leading, spacing: 4) {
                if let swatches = content.swatches, !swatches.isEmpty {
                    SwatchDots(colors: swatches, size: 12)
                }
                Text(content.title)
                    .font(.headline)
                    .lineLimit(1)
                if let subtitle = content.subtitle {
                    Text(subtitle)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                ForEach(Array(lines.prefix(count).enumerated()), id: \.offset) { _, line in
                    HStack(spacing: 6) {
                        if let swatches = line.swatches, !swatches.isEmpty {
                            SwatchDots(colors: swatches, size: 8)
                        }
                        Text(line.text)
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        if let detail = line.detail {
                            Text(detail)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                    .font(.caption)
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}
