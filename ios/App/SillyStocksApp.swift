// SillyStocksApp.swift
//
// Vollbild-Anzeige für stockshooter.mjs: lädt die Seite vom Mac in einer
// WebView ohne Statusleiste, blendet den Home-Indikator aus und verhindert
// die automatische Bildschirmsperre, solange die Anzeige läuft.
//
// Lange (1,5 s) auf den Bildschirm drücken, um zur Adresseingabe zurückzukehren.

import SwiftUI
import WebKit

@main
struct SillyStocksApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}

struct RootView: View {
    @AppStorage("serverURL") private var serverURL = ""
    @State private var running = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if running, let url = URL(string: serverURL) {
                ShooterWebView(url: url)
                    .overlay(
                        Color.clear
                            .contentShape(Rectangle())
                            .onLongPressGesture(minimumDuration: 1.5) { running = false }
                    )
                    .ignoresSafeArea()
                    .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
                    .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
            } else {
                SetupView(serverURL: $serverURL) { running = true }
            }
        }
        .statusBarHidden(running)
        .persistentSystemOverlays(running ? .hidden : .automatic)
        .preferredColorScheme(.dark)
    }
}

struct SetupView: View {
    @Binding var serverURL: String
    let start: () -> Void

    private var isValid: Bool {
        guard let scheme = URL(string: serverURL)?.scheme else { return false }
        return scheme == "http" || scheme == "https"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Shooter").font(.largeTitle.bold())
            Text("Adresse, die stockshooter.mjs im Terminal anzeigt:")
                .foregroundStyle(.secondary)
            TextField("http://MacBook.local:8080/", text: $serverURL)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textFieldStyle(.roundedBorder)
                .onSubmit { if isValid { start() } }
            Button("Starten", action: start)
                .buttonStyle(.borderedProminent)
                .disabled(!isValid)
            Text("Zum Beenden der Anzeige 1,5 Sekunden auf den Bildschirm drücken.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding()
    }
}

struct ShooterWebView: UIViewRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    func makeUIView(context: Context) -> WKWebView {
        let webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.navigationDelegate = context.coordinator
        context.coordinator.load(webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    // Lädt die Seite neu, wenn der Mac-Server (noch) nicht erreichbar ist.
    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        let url: URL

        init(url: URL) { self.url = url }

        func load(_ webView: WKWebView) {
            webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            retry(webView, after: error)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            retry(webView, after: error)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            load(webView)
        }

        private func retry(_ webView: WKWebView, after error: Error) {
            if (error as NSError).code == NSURLErrorCancelled { return }
            Task { @MainActor [weak webView] in
                try? await Task.sleep(for: .seconds(2))
                if let webView { self.load(webView) }
            }
        }
    }
}
