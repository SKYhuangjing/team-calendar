import Cocoa
import Darwin
import UniformTypeIdentifiers
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var serverProcess: Process?
    private let defaultPort = Int(ProcessInfo.processInfo.environment["TEAM_CALENDAR_PORT"] ?? "8787") ?? 8787
    private let defaultReadOnlyPort: Int = {
        if let configured = ProcessInfo.processInfo.environment["TEAM_CALENDAR_READONLY_PORT"] {
            return Int(configured) ?? 8788
        }
        let editablePort = Int(ProcessInfo.processInfo.environment["TEAM_CALENDAR_PORT"] ?? "8787") ?? 8787
        return editablePort + 1
    }()
    private var port: Int = 8787
    private var readOnlyPort: Int = 8788

    func applicationDidFinishLaunching(_ notification: Notification) {
        startServer()
        buildWindow()
        loadScheduler()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            showMainWindow()
        }
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        serverProcess?.terminate()
    }

    private func buildWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "teamCalendar")
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Team Calendar"
        window.isReleasedWhenClosed = false
        window.center()
        window.contentView = webView
        if let scrollView = embeddedScrollView(in: webView) {
            scrollView.hasVerticalScroller = false
            scrollView.hasHorizontalScroller = false
            scrollView.verticalScrollElasticity = NSScrollView.Elasticity.none
            scrollView.horizontalScrollElasticity = NSScrollView.Elasticity.none
            scrollView.allowsMagnification = false
        }

        let toolbar = NSToolbar(identifier: "TeamCalendarToolbar")
        toolbar.delegate = self
        toolbar.displayMode = .iconAndLabel
        window.toolbar = toolbar
        showMainWindow()
    }

    private func showMainWindow() {
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    private func embeddedScrollView(in view: NSView) -> NSScrollView? {
        if let scrollView = view as? NSScrollView {
            return scrollView
        }
        for subview in view.subviews {
            if let scrollView = embeddedScrollView(in: subview) {
                return scrollView
            }
        }
        return nil
    }

    private func startServer() {
        guard serverProcess == nil else { return }
        do {
            port = configuredAppPort() ?? randomAvailablePort()
            readOnlyPort = configuredReadOnlyPort() ?? randomAvailablePort(excluding: [port])
            serverProcess = try makeServerProcess(host: "0.0.0.0", port: String(port))
        } catch {
            showAlert(title: "启动服务失败", message: "无法启动内置 Web 服务：\(error.localizedDescription)")
        }
    }

    private func configuredAppPort() -> Int? {
        if ProcessInfo.processInfo.environment["TEAM_CALENDAR_PORT"] == nil {
            return nil
        }
        return firstAvailablePort(startingAt: defaultPort)
    }

    private func configuredReadOnlyPort() -> Int? {
        if ProcessInfo.processInfo.environment["TEAM_CALENDAR_READONLY_PORT"] == nil {
            return nil
        }
        return firstAvailablePort(startingAt: defaultReadOnlyPort, excluding: [port])
    }

    private func makeServerProcess(host: String, port: String) throws -> Process {
        let appDirectory = try bundledAppDirectory()
        let serverURL = appDirectory.appendingPathComponent("server.py")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["python3", serverURL.path]
        process.currentDirectoryURL = appDirectory
        var environment = ProcessInfo.processInfo.environment
        environment["HOST"] = host
        environment["PORT"] = port
        environment["READONLY_PORT"] = String(readOnlyPort)
        let dataDirectory = applicationSupportDirectory().appendingPathComponent("data")
        environment["DATA_DIR"] = dataDirectory.path
        environment["DB_PATH"] = dataDirectory.appendingPathComponent("scheduler.sqlite").path
        environment["CONFIG_DIR"] = appDirectory.appendingPathComponent("config").path
        let shareHost = localIPv4Address()
        if shareHost != "127.0.0.1" {
            environment["SHARE_HOST"] = shareHost
        }
        process.environment = environment
        try process.run()
        return process
    }

    private func bundledAppDirectory() throws -> URL {
        guard let resourceURL = Bundle.main.resourceURL else {
            throw NSError(domain: "team-calendar", code: 1, userInfo: [NSLocalizedDescriptionKey: "无法定位应用资源目录"])
        }
        return resourceURL.appendingPathComponent("app")
    }

    private func applicationSupportDirectory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        let directory = base.appendingPathComponent("TeamCalendar", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: nil)
        return directory
    }

    private func loadScheduler() {
        guard let url = URL(string: "http://127.0.0.1:\(port)") else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            self?.webView.load(URLRequest(url: url))
        }
    }

    @objc private func reloadPage() {
        webView.reload()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "teamCalendar",
              let body = message.body as? [String: Any],
              let action = body["action"] as? String else {
            return
        }
        if action == "exportCsv" {
            exportCsvFromNative()
        } else if action == "importCsv" {
            importCsvFromNative()
        } else if action == "resetData" {
            resetDataFromNative()
        }
    }

    private func schedulerURL(path: String) -> URL? {
        return URL(string: "http://127.0.0.1:\(port)\(path)")
    }

    private func exportCsvFromNative() {
        guard let url = schedulerURL(path: "/api/export.csv") else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, response, error in
            if let error = error {
                DispatchQueue.main.async {
                    self?.showAlert(title: "导出 CSV 失败", message: error.localizedDescription)
                }
                return
            }
            guard let data = data else {
                DispatchQueue.main.async {
                    self?.showAlert(title: "导出 CSV 失败", message: "服务未返回 CSV 数据")
                }
                return
            }
            if let httpResponse = response as? HTTPURLResponse, !(200...299).contains(httpResponse.statusCode) {
                let text = String(data: data, encoding: .utf8) ?? "HTTP \(httpResponse.statusCode)"
                DispatchQueue.main.async {
                    self?.showAlert(title: "导出 CSV 失败", message: text)
                }
                return
            }
            DispatchQueue.main.async {
                self?.presentCsvSavePanel(data: data)
            }
        }.resume()
    }

    private func presentCsvSavePanel(data: Data) {
        let panel = NSSavePanel()
        panel.title = "导出 CSV"
        panel.nameFieldStringValue = "resource-scheduler-export.csv"
        panel.allowedContentTypes = [.commaSeparatedText]
        panel.canCreateDirectories = true

        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            try data.write(to: url, options: .atomic)
            showAlert(title: "导出 CSV 完成", message: url.path)
        } catch {
            showAlert(title: "导出 CSV 失败", message: error.localizedDescription)
        }
    }

    private func importCsvFromNative() {
        let panel = NSOpenPanel()
        panel.title = "导入 CSV"
        panel.allowedContentTypes = [.commaSeparatedText]
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false

        guard panel.runModal() == .OK, let fileURL = panel.url else { return }
        do {
            let data = try Data(contentsOf: fileURL)
            postCsvImport(data)
        } catch {
            showAlert(title: "导入 CSV 失败", message: error.localizedDescription)
        }
    }

    private func postCsvImport(_ data: Data) {
        guard let url = schedulerURL(path: "/api/import.csv") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("text/csv; charset=utf-8", forHTTPHeaderField: "Content-Type")
        request.httpBody = data

        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            if let error = error {
                DispatchQueue.main.async {
                    self?.showAlert(title: "导入 CSV 失败", message: error.localizedDescription)
                }
                return
            }
            let payloadData = data ?? Data()
            if let httpResponse = response as? HTTPURLResponse, !(200...299).contains(httpResponse.statusCode) {
                let text = String(data: payloadData, encoding: .utf8) ?? "HTTP \(httpResponse.statusCode)"
                DispatchQueue.main.async {
                    self?.showAlert(title: "导入 CSV 失败", message: text)
                }
                return
            }

            let payload = (try? JSONSerialization.jsonObject(with: payloadData)) as? [String: Any]
            if let errorMessage = payload?["error"] as? String {
                DispatchQueue.main.async {
                    self?.showAlert(title: "导入 CSV 失败", message: errorMessage)
                }
                return
            }
            let message = self?.csvImportSummary(from: payload) ?? "导入完成"
            DispatchQueue.main.async {
                self?.showAlert(title: "导入 CSV 完成", message: message)
                self?.webView.reload()
            }
        }.resume()
    }

    private func csvImportSummary(from payload: [String: Any]?) -> String {
        guard let payload = payload else { return "导入完成" }
        let assignments = payload["createdAssignments"] as? Int ?? 0
        let mergedAssignments = payload["mergedAssignments"] as? Int ?? 0
        let milestones = payload["createdMilestones"] as? Int ?? 0
        let mergedMilestones = payload["mergedMilestones"] as? Int ?? 0
        let people = payload["createdPeople"] as? Int ?? 0
        let projects = payload["createdProjects"] as? Int ?? 0
        let skipped = payload["skipped"] as? Int ?? 0
        return "排期新增 \(assignments) 条、合并 \(mergedAssignments) 条，里程碑新增 \(milestones) 条、合并 \(mergedMilestones) 条，新增人员 \(people) 个，新增项目 \(projects) 个，跳过 \(skipped) 行"
    }

    private func resetDataFromNative() {
        let alert = NSAlert()
        alert.messageText = "重置数据"
        alert.informativeText = "会清空当前所有人员、项目、排期和里程碑，且不会恢复 Demo 数据。"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "继续")
        alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return }

        let confirmAlert = NSAlert()
        confirmAlert.messageText = "二次确认"
        confirmAlert.informativeText = "请输入 RESET 确认清空数据。"
        confirmAlert.alertStyle = .warning
        confirmAlert.addButton(withTitle: "确认重置")
        confirmAlert.addButton(withTitle: "取消")
        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        confirmAlert.accessoryView = input
        guard confirmAlert.runModal() == .alertFirstButtonReturn else { return }
        guard input.stringValue == "RESET" else {
            showAlert(title: "已取消重置", message: "输入内容不是 RESET")
            return
        }
        postResetRequest()
    }

    private func postResetRequest() {
        guard let url = schedulerURL(path: "/api/reset") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            if let error = error {
                DispatchQueue.main.async {
                    self?.showAlert(title: "重置数据失败", message: error.localizedDescription)
                }
                return
            }
            let payloadData = data ?? Data()
            if let httpResponse = response as? HTTPURLResponse, !(200...299).contains(httpResponse.statusCode) {
                let text = String(data: payloadData, encoding: .utf8) ?? "HTTP \(httpResponse.statusCode)"
                DispatchQueue.main.async {
                    self?.showAlert(title: "重置数据失败", message: text)
                }
                return
            }
            let payload = (try? JSONSerialization.jsonObject(with: payloadData)) as? [String: Any]
            if let errorMessage = payload?["error"] as? String {
                DispatchQueue.main.async {
                    self?.showAlert(title: "重置数据失败", message: errorMessage)
                }
                return
            }
            DispatchQueue.main.async {
                self?.showAlert(title: "重置数据完成", message: "当前数据已清空")
                self?.webView.reload()
            }
        }.resume()
    }

    @objc private func shareReadOnlyAddress(_ sender: AnyObject?) {
        requestReadOnlyShareURL { [weak self] shareURL in
            self?.presentShareURLAfterEditing(shareURL)
        }
    }

    private func requestReadOnlyShareURL(completion: @escaping (String) -> Void) {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/share") else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, error in
            if let error = error {
                DispatchQueue.main.async {
                    self?.showAlert(title: "启动只读分享失败", message: error.localizedDescription)
                }
                return
            }
            guard let data = data else {
                DispatchQueue.main.async {
                    self?.showAlert(title: "启动只读分享失败", message: "服务未返回分享地址")
                }
                return
            }
            guard let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                let text = String(data: data, encoding: .utf8) ?? "无法解析响应"
                DispatchQueue.main.async {
                    self?.showAlert(title: "启动只读分享失败", message: text)
                }
                return
            }
            if let errorMessage = payload["error"] as? String {
                DispatchQueue.main.async {
                    self?.showAlert(title: "启动只读分享失败", message: errorMessage)
                }
                return
            }
            guard let shareURL = payload["url"] as? String else {
                DispatchQueue.main.async {
                    self?.showAlert(title: "启动只读分享失败", message: "响应中缺少 url 字段")
                }
                return
            }
            DispatchQueue.main.async { completion(shareURL) }
        }.resume()
    }

    private func presentShareURLAfterEditing(_ shareURL: String) {
        guard let finalShareURL = editedShareURL(from: shareURL) else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(finalShareURL, forType: .string)

        let picker = NSSharingServicePicker(items: [finalShareURL])
        if let view = window.contentView {
            picker.show(relativeTo: view.bounds, of: view, preferredEdge: .minY)
        } else {
            showAlert(title: "已复制只读访问地址", message: finalShareURL)
        }
    }

    private func editedShareURL(from shareURL: String) -> String? {
        guard var components = URLComponents(string: shareURL) else { return nil }
        let defaultHost = components.host ?? localIPv4Address()

        let alert = NSAlert()
        alert.messageText = "分享只读地址"
        alert.informativeText = "内置服务监听 0.0.0.0。复制前可以把 IP 或域名改成你要发给别人的地址。"
        alert.alertStyle = .informational
        alert.addButton(withTitle: "复制并分享")
        alert.addButton(withTitle: "取消")

        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24))
        input.placeholderString = "例如 10.10.127.147 / 局域网域名 / 公网域名"
        input.stringValue = defaultHost
        alert.accessoryView = input

        let response = alert.runModal()
        guard response == .alertFirstButtonReturn else { return nil }

        let customHost = input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if !customHost.isEmpty {
            components.host = customHost
        }
        return components.string ?? shareURL
    }

    private func localIPv4Address() -> String {
        var privateCandidates: [(priority: Int, address: String)] = []
        var fallbackCandidates: [(priority: Int, address: String)] = []
        var interfaces: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&interfaces) == 0, let first = interfaces else { return "127.0.0.1" }
        defer { freeifaddrs(interfaces) }

        for pointer in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let interface = pointer.pointee
            guard let socketAddress = interface.ifa_addr else { continue }
            let family = socketAddress.pointee.sa_family
            guard family == UInt8(AF_INET) else { continue }
            let flags = Int32(interface.ifa_flags)
            guard (flags & IFF_UP) != 0, (flags & IFF_RUNNING) != 0, (flags & IFF_LOOPBACK) == 0 else { continue }
            let name = String(cString: interface.ifa_name)

            var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            getnameinfo(socketAddress, socklen_t(socketAddress.pointee.sa_len), &hostname, socklen_t(hostname.count), nil, 0, NI_NUMERICHOST)
            let candidate = String(cString: hostname)
            guard !candidate.hasPrefix("127."), !candidate.hasPrefix("169.254.") else { continue }

            let priority = interfacePriority(name)
            if isPrivateIPv4(candidate) {
                privateCandidates.append((priority, candidate))
            } else {
                fallbackCandidates.append((priority, candidate))
            }
        }
        if let best = privateCandidates.sorted(by: compareCandidates).first?.address {
            return best
        }
        if let best = fallbackCandidates.sorted(by: compareCandidates).first?.address {
            return best
        }
        return "127.0.0.1"
    }

    private func firstAvailablePort(startingAt preferredPort: Int, excluding: Set<Int> = []) -> Int {
        for candidate in preferredPort..<(preferredPort + 50) {
            if excluding.contains(candidate) {
                continue
            }
            if canBindPort(candidate) {
                return candidate
            }
        }
        return preferredPort
    }

    private func randomAvailablePort(excluding: Set<Int> = []) -> Int {
        for _ in 0..<100 {
            let candidate = Int.random(in: 49152...65535)
            if excluding.contains(candidate) {
                continue
            }
            if canBindPort(candidate) {
                return candidate
            }
        }
        return firstAvailablePort(startingAt: 49152, excluding: excluding)
    }

    private func canBindPort(_ port: Int) -> Bool {
        let socketFd = socket(AF_INET, SOCK_STREAM, 0)
        if socketFd == -1 {
            return false
        }
        defer { close(socketFd) }

        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = in_port_t(port).bigEndian
        address.sin_addr = in_addr(s_addr: inet_addr("0.0.0.0"))

        return withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                Darwin.bind(socketFd, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0
            }
        }
    }

    private func interfacePriority(_ name: String) -> Int {
        if name == "en0" { return 0 }
        if name == "en1" { return 1 }
        if name.hasPrefix("en") { return 2 }
        if name.hasPrefix("bridge") { return 3 }
        return 4
    }

    private func compareCandidates(_ lhs: (priority: Int, address: String), _ rhs: (priority: Int, address: String)) -> Bool {
        if lhs.priority != rhs.priority {
            return lhs.priority < rhs.priority
        }
        return lhs.address < rhs.address
    }

    private func isPrivateIPv4(_ address: String) -> Bool {
        let parts = address.split(separator: ".")
        guard parts.count == 4, let a = Int(parts[0]), let b = Int(parts[1]) else {
            return false
        }
        if a == 10 || (a == 192 && b == 168) {
            return true
        }
        return a == 172 && (16...31).contains(b)
    }

    private func showAlert(title: String, message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = .informational
        alert.runModal()
    }
}

extension AppDelegate: NSToolbarDelegate {
    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        return [.reloadPage, .shareReadOnly, .flexibleSpace]
    }

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        return [.reloadPage, .flexibleSpace, .shareReadOnly]
    }

    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier itemIdentifier: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        switch itemIdentifier {
        case .reloadPage:
            let item = NSToolbarItem(itemIdentifier: itemIdentifier)
            item.label = "刷新"
            item.paletteLabel = "刷新"
            item.image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: "刷新")
            item.target = self
            item.action = #selector(reloadPage)
            return item
        case .shareReadOnly:
            let item = NSToolbarItem(itemIdentifier: itemIdentifier)
            item.label = "分享只读地址"
            item.paletteLabel = "分享只读地址"
            item.image = NSImage(systemSymbolName: "square.and.arrow.up", accessibilityDescription: "分享只读地址")
            item.target = self
            item.action = #selector(shareReadOnlyAddress(_:))
            return item
        default:
            return nil
        }
    }
}

private extension NSToolbarItem.Identifier {
    static let reloadPage = NSToolbarItem.Identifier("ReloadPage")
    static let shareReadOnly = NSToolbarItem.Identifier("ShareReadOnly")
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.activate(ignoringOtherApps: true)
app.run()
