import SwiftUI
import UserNotifications

struct Destination: Identifiable {
    let id = UUID()
    let desktop: Desktop
    var target: String = ""
}

@MainActor final class DesktopStore: ObservableObject {
    static let shared = DesktopStore()
    @Published var desktops: [Desktop] = []
    @Published var destination: Destination?
    @Published var error: String?
    @Published var pairingURL: URL?
    private var pushToken: String?

    init() {
        do { desktops = try Credentials.load() } catch { self.error = error.localizedDescription }
    }
    func pair(address: String, code: String) async throws {
        let origin = try RemotePolicy.origin(address)
        struct Pair: Decodable { let token: String; let device: Device; let desktopName: String }
        struct Device: Decodable { let deviceId: String }
        let data = try await Gateway.request(origin: origin, path: "api/pair", method: "POST",
                                             body: ["code": code, "name": UIDevice.current.name])
        let result = try JSONDecoder().decode(Pair.self, from: data)
        let desktop = Desktop(origin: origin, deviceId: result.device.deviceId, name: result.desktopName, token: result.token)
        var next = desktops.filter { $0.id != desktop.id }; next.append(desktop)
        try Credentials.save(next); desktops = next
        await refresh()
        await registerPush()
    }
    func refresh() async {
        struct Summary: Decodable { let desktopName: String; let inboxCount: Int }
        for desktop in desktops {
            do {
                let data = try await Gateway.request(origin: desktop.origin, path: "api/summary", token: desktop.token)
                let summary = try JSONDecoder().decode(Summary.self, from: data)
                guard let i = desktops.firstIndex(where: { $0.id == desktop.id }) else { continue }
                desktops[i].name = summary.desktopName; desktops[i].online = true; desktops[i].inboxCount = summary.inboxCount
            } catch {
                if let i = desktops.firstIndex(where: { $0.id == desktop.id }) { desktops[i].online = false }
            }
        }
    }
    func remove(_ desktop: Desktop) async {
        do {
            _ = try await Gateway.request(origin: desktop.origin, path: "api/push", method: "DELETE", token: desktop.token)
            let next = desktops.filter { $0.id != desktop.id }
            try Credentials.save(next); desktops = next
        } catch { self.error = "移除失败：\(error.localizedDescription)" }
    }
    func setPushToken(_ data: Data) async {
        pushToken = data.map { String(format: "%02x", $0) }.joined()
        await registerPush()
    }
    func registerPush() async {
        guard let pushToken else { return }
        #if DEBUG
        let environment = "sandbox"
        #else
        let environment = "production"
        #endif
        for desktop in desktops {
            do {
                _ = try await Gateway.request(origin: desktop.origin, path: "api/push", method: "POST", token: desktop.token,
                    body: ["token": pushToken, "environment": environment])
                if let i = desktops.firstIndex(where: { $0.id == desktop.id }) { desktops[i].pushError = nil }
            } catch {
                if let i = desktops.firstIndex(where: { $0.id == desktop.id }) { desktops[i].pushError = "推送登记失败" }
            }
        }
    }
    func notification(_ info: [AnyHashable: Any]) {
        guard let value = info["desktopUrl"] as? String, let origin = try? RemotePolicy.origin(value),
              let target = info["target"] as? String, RemotePolicy.target(target),
              let desktop = desktops.first(where: { $0.origin == origin }) else {
            error = RemoteError.invalidNotification.localizedDescription; return
        }
        destination = Destination(desktop: desktop, target: target)
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in await DesktopStore.shared.setPushToken(deviceToken) }
    }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in DesktopStore.shared.error = "无法注册推送：\(error.localizedDescription)" }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        Task { @MainActor in
            DesktopStore.shared.notification(response.notification.request.content.userInfo)
            completionHandler()
        }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
}

@main struct VermillionApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var store = DesktopStore.shared
    var body: some Scene {
        WindowGroup {
            DesktopList(store: store).tint(.primary)
                .onOpenURL { store.pairingURL = $0 }
        }
    }
}

struct DesktopList: View {
    @ObservedObject var store: DesktopStore
    @Environment(\.scenePhase) private var phase
    @State private var adding = false
    @State private var removing: Desktop?
    var body: some View {
        NavigationStack {
            List {
                if store.desktops.isEmpty { Text("添加桌面后即可查看会话和 Inbox。").foregroundStyle(.secondary) }
                ForEach(store.desktops) { desktop in
                    Button { store.destination = Destination(desktop: desktop) } label: {
                        HStack {
                            VStack(alignment: .leading) {
                                Text(desktop.name)
                                Text(desktop.online.map { $0 ? "在线" : "离线" } ?? "正在连接").font(.caption).foregroundStyle(.secondary)
                                if let error = desktop.pushError { Text(error).font(.caption).foregroundStyle(.secondary) }
                            }
                            Spacer()
                            Text("Inbox \(desktop.inboxCount)").foregroundStyle(.secondary)
                        }.frame(minHeight: 44)
                    }.swipeActions { Button("移除") { removing = desktop } }
                }
                if let error = store.error { Text(error).foregroundStyle(.secondary) }
                Button("开启通知") {
                    Task {
                        do {
                            if try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) {
                                UIApplication.shared.registerForRemoteNotifications()
                            } else { store.error = "通知已关闭，可在系统设置中开启。" }
                        } catch { store.error = error.localizedDescription }
                    }
                }
            }.navigationTitle("桌面列表")
                .toolbar { Button("添加桌面") { store.pairingURL = nil; adding = true } }
                .refreshable { await store.refresh(); await store.registerPush() }
                .sheet(isPresented: $adding) { PairingView(store: store, initial: store.pairingURL) }
                .onChange(of: store.pairingURL) { _, url in if url != nil { adding = true } }
                .fullScreenCover(item: $store.destination) { destination in
                    DesktopWebScreen(destination: destination) { store.destination = nil }
                        .id(destination.id)
                }
                .confirmationDialog("移除这台桌面？", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })) {
                    Button("移除桌面", role: .destructive) { if let desktop = removing { Task { await store.remove(desktop) } }; removing = nil }
                }
        }.task {
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            if settings.authorizationStatus == .authorized { UIApplication.shared.registerForRemoteNotifications() }
            while !Task.isCancelled {
                if phase == .active { await store.refresh() }
                try? await Task.sleep(for: .seconds(15))
            }
        }.onChange(of: phase) { _, phase in
            if phase == .active { Task { await store.refresh(); await store.registerPush() } }
        }
    }
}

struct PairingView: View {
    @ObservedObject var store: DesktopStore
    let initial: URL?
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var code = ""
    @State private var error: String?
    @State private var busy = false
    @State private var scanning = false
    var body: some View {
        NavigationStack {
            Form {
                TextField("公网地址（https://）", text: $address).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("pair-address")
                TextField("8 位配对码", text: $code).textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("pair-code")
                Button("扫描二维码") { scanning = true }
                if let error { Text(error).foregroundStyle(.secondary) }
                Button(busy ? "正在配对" : "配对") {
                    busy = true; error = nil
                    Task {
                        do { try await store.pair(address: address, code: code); dismiss() }
                        catch { self.error = error.localizedDescription }
                        busy = false
                    }
                }.disabled(busy || address.isEmpty || code.count != 8).accessibilityIdentifier("pair-submit")
            }.navigationTitle("添加桌面")
                .toolbar { Button("取消") { dismiss() } }
                .sheet(isPresented: $scanning) { QRScanner { result in
                    scanning = false
                    switch result { case .success(let url): read(url); case .failure(let failure): error = failure.localizedDescription }
                } }
                .onAppear { if let initial { read(initial) } }
        }
    }
    private func read(_ url: URL) {
        do { let result = try RemotePolicy.pairing(url); address = result.0.absoluteString; code = result.1 }
        catch { self.error = error.localizedDescription }
    }
}
