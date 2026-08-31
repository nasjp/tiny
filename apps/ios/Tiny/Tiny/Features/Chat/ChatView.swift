import Combine
import PhotosUI
import SwiftUI

struct ChatView: View {
    let session: SessionRecord
    @EnvironmentObject var appModel: AppModel
    @StateObject private var model: ChatModelBox = ChatModelBox()
    @State private var draft = ""
    @State private var fileToShow: (id: String, mime: String, name: String)?
    @State private var pickedItems: [PhotosPickerItem] = []
    @State private var showPhotoPicker = false
    @State private var showCamera = false
    @State private var attachments: [(thumbnail: UIImage, attachment: TurnImageAttachment)] = []
    @State private var currentModel = ""
    @State private var currentMode: PermissionMode = .default
    @State private var currentEffort = ""
    @State private var currentTitle = ""
    @State private var showRename = false
    @State private var renameDraft = ""
    @State private var settingsLoaded = false
    /// Profile for this session (source of the model / effort / permission-mode choices).
    /// Until fetched, render with a provisional ProfileInfo built from session.agent
    /// (fixed table for Claude, empty for others)
    @State private var profileInfo: ProfileInfo?
    @State private var showUsage = false
    @State private var showScrollToBottom = false
    /// "Syncing…" pill shown only when a resync drags on (showing it immediately flickers, so wait 0.6s)
    @State private var showSyncPill = false
    @State private var toolSheet: [ToolCall]?
    @State private var viewportHeight: CGFloat = 0
    /// Measured value used to pin the chat body width to the viewport (see frame(width:) below)
    @State private var viewportWidth: CGFloat = 0
    @FocusState private var inputFocused: Bool
    // Under Reduce Motion, drop the movement and blur from the appear effect (keep only opacity)
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    // Sheets do not inherit the parent's .preferredColorScheme, so apply it to each sheet individually
    @AppStorage("appearance") private var appearanceRaw = Appearance.system.rawValue
    /// For DEBUG logging. A class, so mutating it does not trigger a view update
    private final class ScrollDebug { var lastLogged: CGFloat = -10_000 }
    @State private var scrollDebug = ScrollDebug()
    /// Holds a weak reference to the UIScrollView for the ↓ button (a class, so mutating it does not redraw)
    @State private var scrollHolder = ScrollViewHolder()

    var body: some View {
        VStack(spacing: 0) {
            if let err = model.inner?.errorBanner {
                Text(err).font(.footnote).foregroundStyle(.white)
                    .frame(maxWidth: .infinity).padding(8).background(Color.tRuby)
            }
            // LazyVStack combined with defaultScrollAnchor(.bottom) and appended events
            // makes ForEach node application loop forever and freezes the main thread
            // (measured on both device and simulator; the hot path in the sample is
            // _LazyLayout_Subviews.applyNodes). Chat history is at most a few hundred
            // rows, so laziness is unnecessary — use a plain VStack.
            // ScrollViewReader + scrollTo causes the same kind of loop, so avoid it too.
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 10) {
                        // Collapse consecutive tool calls into one row, Claude Code app style.
                        // Animate in only rows that just arrived (no effect on bulk history loads)
                        ForEach(buildChatItems(model.inner?.events ?? [])) { item in
                            chatItemView(item)
                                .transition(appearTransition(
                                    isNew: model.inner?.isNewlyArrived(item.id) ?? false))
                        }
                        // Optimistic display right after send (replaced when the real WS event arrives).
                        // Show these instantly with no animation — never delay feedback for the user's own action
                        ForEach(model.inner?.pendingSends ?? []) { send in
                            UserBubble(text: send.text, imageCount: send.thumbnails.count,
                                       time: EventRow.timeText(send.createdAt),
                                       localImages: send.thumbnails)
                        }
                        if model.inner?.isBusy == true {
                            HStack(spacing: 8) {
                                ProgressView()
                                Text("Running…").font(.caption).foregroundStyle(Color.tInkSub)
                                Spacer()
                                Button("Stop") { Task { await model.inner?.interrupt() } }
                                    .font(.caption)
                                    .foregroundStyle(Color.tRuby)
                            }
                            .transition(appearTransition(isNew: true))
                        }
                    }
                    // Animate only event arrival and the Running row appearing/disappearing.
                    // (pendingSends is excluded so the optimistic display is never delayed by even one frame)
                    .animation(appearAnimation, value: model.inner?.events.count ?? 0)
                    .animation(appearAnimation, value: model.inner?.isBusy ?? false)
                    .padding()
                    // Measure the distance from the bottom (used to toggle the ↓ button)
                    .background(GeometryReader { g in
                        Color.clear.preference(key: ChatBottomDistanceKey.self,
                                               value: g.frame(in: .named("chatScroll")).maxY)
                    })
                    // Conduit for the ↓ button to call UIKit's setContentOffset(animated:).
                    // SwiftUI's scrollTo gets canceled by inertia while decelerating (measured on device)
                    .background(ScrollViewGrabber(holder: scrollHolder))
                    // Pin the body width to the viewport. Guards against a device-reported bug
                    // where the whole chat starts dragging sideways the moment a wide table
                    // (containing a horizontal ScrollView) arrives: whatever comes in, the
                    // outer ScrollView's content width must never grow
                    .frame(width: viewportWidth > 0 ? viewportWidth : nil)
                    Color.clear.frame(height: 1).id("chatBottom")
                }
                .coordinateSpace(name: "chatScroll")
                .background(Color.tBg)
                .defaultScrollAnchor(.bottom)
                // Swipe down to dismiss the keyboard (messaging-app convention)
                .scrollDismissesKeyboard(.interactively)
                .background(GeometryReader { g in
                    Color.clear
                        .onAppear { viewportHeight = g.size.height; viewportWidth = g.size.width }
                        .onChange(of: g.size.height) { _, h in viewportHeight = h }
                        .onChange(of: g.size.width) { _, w in viewportWidth = w }
                })
                // Undo residual horizontal offset (if content fits but x≠0, reset to 0)
                .modifier(HorizontalDriftGuard(holder: scrollHolder))
                // On iOS 18+ devices scrolling is offloaded to the render server, and the
                // coordinateSpace + GeometryReader preference does not update while
                // scrolling (measured via device logs). onScrollGeometryChange is the
                // proper approach. On iOS 17 the legacy preference path still works,
                // so keep it as a fallback
                .modifier(ScrollBottomDistanceModifier { dist in
                    updateBottomDistance(dist)
                })
                .onPreferenceChange(ChatBottomDistanceKey.self) { maxY in
                    if #unavailable(iOS 18.0) {
                        updateBottomDistance(maxY - viewportHeight)
                    }
                }
                // Putting the composer in safeAreaInset lets the ScrollView extend behind
                // it, so the chat body flows behind the translucent composer
                // (the look of the official Claude / ChatGPT apps)
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    bottomBar(proxy: proxy)
                }
                // Show a centered loading indicator only on first load with no cache
                // (resyncs while cache is shown are handled by the Syncing pill below)
                .overlay {
                    if model.inner?.isSyncing == true, model.inner?.events.isEmpty != false {
                        ProgressView("Loading conversation…")
                    }
                }
                .overlay(alignment: .top) {
                    if showSyncPill {
                        HStack(spacing: 6) {
                            ProgressView().controlSize(.small)
                            Text("Syncing…").font(.tinyCaption).foregroundStyle(Color.tInkSub)
                        }
                        .padding(.horizontal, 12).padding(.vertical, 6)
                        .background(Capsule().fill(.ultraThinMaterial))
                        .overlay(Capsule().strokeBorder(Color.tLine))
                        .padding(.top, 8)
                        .transition(.opacity)
                    }
                }
                .task(id: isResyncing) {
                    if isResyncing {
                        try? await Task.sleep(nanoseconds: 600_000_000)
                        guard !Task.isCancelled else { return }
                        withAnimation(.easeInOut(duration: 0.15)) { showSyncPill = true }
                    } else {
                        withAnimation(.easeInOut(duration: 0.15)) { showSyncPill = false }
                    }
                }
            }
        }
        .background(Color.tBg.ignoresSafeArea())
        .navigationTitle(session.displayTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // Always show context usage under the title
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text(currentTitle.isEmpty ? session.displayTitle : currentTitle)
                        .font(.headline).lineLimit(1)
                    if let line = contextLine {
                        Text(line).font(.caption2).foregroundStyle(Color.tInkSub)
                    }
                }
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { showUsage = true } label: { Image(systemName: "gauge.with.needle") }
                    .accessibilityIdentifier("chatUsageButton")
                sessionSettingsMenu
            }
        }
        // Mid-session changes take effect from the next turn (no effect on the running turn)
        .onChange(of: currentModel) { _, newValue in
            guard settingsLoaded else { return }
            Task { await applySettings(model: newValue) }
        }
        .onChange(of: currentMode) { _, newValue in
            guard settingsLoaded else { return }
            Task { await applySettings(mode: newValue) }
        }
        .onChange(of: currentEffort) { _, newValue in
            guard settingsLoaded else { return }
            Task { await applySettings(effort: newValue) }
        }
        .alert("Rename Session", isPresented: $showRename) {
            TextField("Name", text: $renameDraft)
            Button("Cancel", role: .cancel) {}
            Button("Rename") {
                let name = renameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !name.isEmpty else { return }
                Task {
                    await applySettings(title: name)
                    currentTitle = name
                }
            }
        } message: {
            Text("Also updates on your Mac (tiny ls)")
        }
        .sheet(isPresented: $showUsage) {
            UsageView(focusProfile: session.profile)
                .preferredColorScheme(Appearance(rawValue: appearanceRaw)?.colorScheme)
        }
        .sheet(isPresented: Binding(get: { toolSheet != nil }, set: { if !$0 { toolSheet = nil } })) {
            if let calls = toolSheet {
                ToolGroupSheet(calls: calls)
                    .preferredColorScheme(Appearance(rawValue: appearanceRaw)?.colorScheme)
            }
        }
        .sheet(isPresented: Binding(get: { fileToShow != nil }, set: { if !$0 { fileToShow = nil } })) {
            if let f = fileToShow, let chat = model.inner {
                FileViewerView(fileId: f.id, mime: f.mime, name: f.name, chat: chat)
                    .preferredColorScheme(Appearance(rawValue: appearanceRaw)?.colorScheme)
            }
        }
        .onAppear {
            // Reuse the AppModel cache. The previous events appear the instant we come
            // back, and start()'s resync runs in the background (anti-flicker)
            if model.inner == nil {
                model.inner = appModel.chatModel(for: session)
            }
            model.inner?.start()
            if !settingsLoaded {
                currentModel = session.model ?? ""
                currentEffort = session.effort ?? ""
                currentTitle = session.displayTitle
                currentMode = session.permissionMode
                // Enable on the next run-loop cycle so onChange does not mistake initialization for a "change" and PATCH
                DispatchQueue.main.async { settingsLoaded = true }
            }
        }
        .task { if profileInfo == nil { await loadProfileInfo() } }
        .onDisappear { model.inner?.stop() }
        // Re-fetch pending on returning to foreground (it may have expired via the 10-minute timeout)
        .onReceive(NotificationCenter.default.publisher(
            for: UIApplication.willEnterForegroundNotification)) { _ in
            Task { await model.inner?.reconcilePending() }
        }
    }

    /// Control area overlapping the ScrollView's bottom edge (CLI banner, permission
    /// banners, composer). So the chat body shows through as it flows, banners get an
    /// opaque background while the area around the composer stays transparent.
    /// The ↓ button floats centered right above this bar
    @ViewBuilder
    private func bottomBar(proxy: ScrollViewProxy) -> some View {
        VStack(spacing: 0) {
            // In use by the CLI (tiny attach). attach does not auto-resume a detached
            // session, so show a button to take it back from the app
            if model.inner?.isDetached == true {
                HStack {
                    Label("In use by CLI", systemImage: "terminal")
                        .font(.callout)
                    Spacer()
                    Button("Resume here") {
                        Task { await model.inner?.resumeFromCLI() }
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("resumeFromCLIButton")
                }
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.tDetached.opacity(0.12))
                .background(Color.tBg)
            }

            // Permission banners (pending is already reconciled with the server's GET /permissions).
            // AskUserQuestion is a question, not a permission, so answer via the choice UI
            ForEach(model.inner?.pending ?? []) { p in
                Group {
                    if p.isQuestion {
                        QuestionBanner(permission: p) { answers in
                            Task {
                                await model.inner?.respond(
                                    reqId: p.id, allow: true,
                                    updatedInput: AskUserQuestion.updatedInput(original: p.input,
                                                                               answers: answers))
                            }
                        } onDismiss: {
                            Task { await model.inner?.respond(reqId: p.id, allow: false) }
                        }
                    } else {
                        PermissionBanner(permission: p) { allow in
                            Task { await model.inner?.respond(reqId: p.id, allow: allow) }
                        }
                    }
                }
                .background(Color.tBg)
            }

            // Hide the composer while an AskUserQuestion answer is pending
            // (keep focus on the answer card; same behavior as the official app)
            if !hasPendingQuestion {
                composer
            }
        }
        // Blur text about to scroll off-screen, like the top navigation bar does
        // (the Claude / ChatGPT look). Fade the material upward and extend it
        // down through the home-indicator area
        .background(alignment: .bottom) {
            Rectangle()
                .fill(.ultraThinMaterial)
                .mask(
                    // Cap the mask at 0.65 to keep it subtle (full strength was too much)
                    LinearGradient(stops: [
                        .init(color: .clear, location: 0),
                        .init(color: .black.opacity(0.65), location: 0.5),
                        .init(color: .black.opacity(0.65), location: 1),
                    ], startPoint: .top, endPoint: .bottom)
                )
                .padding(.top, -16)   // extend above the bar to give the fade a run-up
                .ignoresSafeArea(edges: .bottom)
                .allowsHitTesting(false)
        }
        .overlay(alignment: .top) {
            if showScrollToBottom {
                scrollToBottomButton(proxy: proxy)
                    .offset(y: -44)
                    .transition(.opacity)
            }
        }
    }

    /// ChatGPT-style composer: rounded container with attachment thumbnails + multi-line input + attach button + send button
    private var composer: some View {
        VStack(spacing: 0) {
            if session.isHeldByCLI {
                Text("Open in the CLI — close it there to send from here")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 14).padding(.top, 12)
            }
            if !attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(Array(attachments.enumerated()), id: \.offset) { idx, item in
                            ZStack(alignment: .topTrailing) {
                                Image(uiImage: item.thumbnail)
                                    .resizable().scaledToFill()
                                    .frame(width: 56, height: 56)
                                    .clipShape(RoundedRectangle(cornerRadius: 10))
                                Button {
                                    attachments.remove(at: idx)
                                } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .font(.system(size: 16))
                                        .foregroundStyle(.white, .black.opacity(0.6))
                                }
                                .offset(x: 5, y: -5)
                            }
                        }
                    }
                    .padding(.horizontal, 14).padding(.top, 12)
                }
            }
            HStack(alignment: .bottom, spacing: 4) {
                Menu {
                    Button {
                        showCamera = true
                    } label: {
                        Label("Camera", systemImage: "camera")
                    }
                    .disabled(!UIImagePickerController.isSourceTypeAvailable(.camera))
                    Button {
                        showPhotoPicker = true
                    } label: {
                        Label("Photo Library", systemImage: "photo.on.rectangle")
                    }
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(.primary)
                        .frame(width: 32, height: 32)
                }
                .padding(.leading, 8)
                .padding(.bottom, 6)
                .accessibilityIdentifier("attachMenuButton")
                TextField("Message", text: $draft, axis: .vertical)
                    .lineLimit(1...6)
                    .font(.body)
                    .padding(.trailing, 4)
                    .padding(.vertical, 12)
                    .focused($inputFocused)
                    .disabled(session.isHeldByCLI)
                    .accessibilityIdentifier("chatInput")
                Button {
                    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard canSend, let chat = model.inner else { return }
                    let images = attachments.map(\.attachment)
                    let sentAttachments = attachments
                    let prompt = text.isEmpty ? "(please check the image)" : text
                    draft = ""
                    attachments = []
                    inputFocused = false   // close the keyboard on send
                    // Stack the bubble and Running row in the same frame as the tap.
                    // Going through a Task delays the update by a frame or more, and
                    // overlapping the keyboard-dismiss animation it looks like
                    // "tapping does nothing" (device feedback)
                    let placeholder = chat.beginSend(prompt: prompt,
                                                     thumbnails: sentAttachments.map(\.thumbnail))
                    scrollToBottom()
                    // Once more after the keyboard settles and layout is final.
                    // Without this the Running row stays hidden behind the composer
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { scrollToBottom() }
                    Task {
                        let ok = await chat.deliver(placeholder, prompt: prompt, images: images)
                        // On failure, restore the draft (leave it alone if the user has started typing the next message)
                        if !ok, draft.isEmpty, attachments.isEmpty {
                            draft = text
                            attachments = sentAttachments
                        }
                    }
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(canSend ? .white : Color.tInkSub)
                        .frame(width: 32, height: 32)
                        .background(Circle().fill(canSend ? Color.tTint : Color.tLine))
                }
                .disabled(!canSend)
                .padding(.trailing, 6)
                .padding(.bottom, 6)
                .accessibilityIdentifier("sendButton")
            }
        }
        // Just barely translucent (the official Claude app's texture): dim the base
        // color slightly and lay a thin blur material behind it. Too much
        // translucency hurts legibility, hence 0.8
        .background(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .fill(Color.tCard.opacity(0.8))
                .background(.ultraThinMaterial,
                            in: RoundedRectangle(cornerRadius: 24, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 24, style: .continuous)
                        .strokeBorder(Color.tLine)
                )
        )
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
        .photosPicker(isPresented: $showPhotoPicker, selection: $pickedItems,
                      maxSelectionCount: 4, matching: .images)
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { image in appendAttachment(image) }
                .ignoresSafeArea()
        }
        .onChange(of: pickedItems) {
            let items = pickedItems
            pickedItems = []
            Task { await loadPickedImages(items) }
        }
    }

    /// "Scroll to bottom" button floating centered right above the composer
    private func scrollToBottomButton(proxy: ScrollViewProxy) -> some View {
        Button {
            // Fallback when the UIScrollView has not been captured yet (legacy instant jump)
            if !scrollToBottom() { proxy.scrollTo("chatBottom", anchor: .bottom) }
        } label: {
            // Same design as the send button (circle + bold arrow), just pointing the other way
            Image(systemName: "arrow.down")
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 32, height: 32)
                .background(Circle().fill(Color.tTint))
                .shadow(color: .black.opacity(0.15), radius: 5, y: 2)
        }
        .accessibilityIdentifier("scrollToBottomButton")
    }

    /// View for one chat row (extracted so ForEach can layer a transition on it)
    @ViewBuilder
    private func chatItemView(_ item: ChatItem) -> some View {
        switch item {
        case .event(let ev):
            EventRow(record: ev,
                     loadImage: { id in await model.inner?.attachedImage(fileId: id) },
                     onOpenFile: { id, mime, name in fileToShow = (id, mime, name) })
        case .tools(_, let calls):
            ToolSummaryRow(calls: calls) { toolSheet = calls }
        case .qa(_, let pairs):
            QuestionAnswerCard(pairs: pairs)
        }
    }

    /// Appear effect. Rows that were on screen from the start as history get no effect (.identity)
    private func appearTransition(isNew: Bool) -> AnyTransition {
        guard isNew else { return .identity }
        return reduceMotion ? .tinyAppearReduced : .tinyAppear
    }

    private var appearAnimation: Animation {
        reduceMotion ? .tinyAppearReduced : .tinyAppear
    }

    /// Drive the underlying UIScrollView directly to reach the bottom.
    /// SwiftUI's scrollTo loses to inertia while decelerating, so it is not used.
    /// Returns false = UIScrollView not captured yet (caller falls back to an alternative)
    @discardableResult
    private func scrollToBottom() -> Bool {
        guard let sv = scrollHolder.scrollView else { return false }
        let bottom = max(-sv.adjustedContentInset.top,
                         sv.contentSize.height - sv.bounds.height + sv.adjustedContentInset.bottom)
        sv.setContentOffset(CGPoint(x: 0, y: bottom), animated: true)
        return true
    }

    /// Toggle the ↓ button based on distance from the bottom.
    /// Update state only when crossing the threshold (avoid redrawing on every scroll tick)
    private func updateBottomDistance(_ dist: CGFloat) {
        #if DEBUG
        if abs(dist - scrollDebug.lastLogged) > 200 {
            scrollDebug.lastLogged = dist
            print("[scrollDbg] dist=\(Int(dist))")
        }
        #endif
        let show = dist > 120
        if show != showScrollToBottom {
            withAnimation(.easeInOut(duration: 0.15)) { showScrollToBottom = show }
        }
    }

    /// "Context 42% · 84k". Total input-side tokens of the latest turn ÷ window (200k; 1M for [1m] models)
    private var contextLine: String? {
        guard let tokens = model.inner?.contextTokens else { return nil }
        let window = (currentModel.contains("[1m]") ? 1_000_000 : 200_000)
        let percent = min(999, Int((Double(tokens) / Double(window) * 100).rounded()))
        return "Context \(percent)% · \(tokens / 1000)k"
    }

    /// Push mid-session changes to model / effort / permission mode / title to the server (effective from the next turn)
    private func applySettings(model modelValue: String? = nil, mode: PermissionMode? = nil,
                               effort: String? = nil, title: String? = nil) async {
        guard let backend = appModel.backend else { return }
        do {
            _ = try await backend.updateSession(sessionId: session.id, model: modelValue,
                                                permissionMode: mode, effort: effort, title: title)
        } catch {
            self.model.inner?.errorBanner = "Failed to update settings: \(error.localizedDescription)"
        }
    }

    /// Re-fetching history in the background while showing the cache (condition for the Syncing pill)
    private var isResyncing: Bool {
        model.inner?.isSyncing == true && model.inner?.events.isEmpty == false
    }

    /// Can send if there is either text or an image, and the CLI does not currently hold this session
    private var canSend: Bool {
        (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty)
            && !session.isHeldByCLI
    }

    /// Whether an AskUserQuestion answer is pending (the standard composer is hidden while shown)
    private var hasPendingQuestion: Bool {
        (model.inner?.pending ?? []).contains(where: \.isQuestion)
    }


    /// Top-right slider menu (model / effort / permission mode / Rename).
    /// Extracted because inlining it in body makes type checking never finish
    private var sessionSettingsMenu: some View {
        Menu {
            Picker("Model", selection: $currentModel) {
                Text("Default (follow CLI settings)").tag("")
                ForEach(modelChoices) { (choice: ModelChoice) in
                    Text(choice.displayName).tag(choice.id)
                }
            }
            .pickerStyle(.menu)
            Picker("Effort", selection: $currentEffort) {
                Text("Effort: default").tag("")
                ForEach(effortChoices, id: \.self) { (effort: String) in
                    Text("Effort: \(effort)").tag(effort)
                }
            }
            .pickerStyle(.menu)
            Picker("Permission mode", selection: $currentMode) {
                ForEach(permissionModeChoices) { (choice: PermissionModeChoice) in
                    Text(choice.label).tag(PermissionMode(rawValue: choice.id))
                }
            }
            .pickerStyle(.menu)
            Divider()
            Button {
                renameDraft = currentTitle
                showRename = true
            } label: {
                Label("Rename", systemImage: "pencil.line")
            }
        } label: {
            Image(systemName: "slider.horizontal.3")
        }
        .accessibilityIdentifier("sessionSettingsMenu")
    }

    // MARK: - Choices (from the profile's capabilities; falls back to per-agent defaults)

    private var effectiveProfile: ProfileInfo {
        profileInfo ?? ProfileInfo(name: session.profile, dir: "", loggedIn: true,
                                   agent: session.agent, defaultModel: nil, defaultEffort: nil)
    }

    /// Append the current value so it does not vanish from the Picker even when absent from the choices (old settings, unknown values)
    private var modelChoices: [ModelChoice] {
        var out = effectiveProfile.modelChoices
        if !currentModel.isEmpty, !out.contains(where: { $0.id == currentModel }) {
            out.append(ModelChoice(id: currentModel))
        }
        return out
    }

    private var effortChoices: [String] {
        var out = effectiveProfile.effortChoices
        if !currentEffort.isEmpty, !out.contains(currentEffort) { out.append(currentEffort) }
        return out
    }

    private var permissionModeChoices: [PermissionModeChoice] {
        var out = effectiveProfile.permissionModeChoices
        if !out.contains(where: { $0.id == currentMode.rawValue }) {
            out.append(PermissionModeChoice(id: currentMode.rawValue, label: currentMode.label))
        }
        return out
    }

    private func loadProfileInfo() async {
        guard let backend = appModel.backend,
              let list = try? await backend.profiles() else { return }
        profileInfo = list.first { $0.name == session.profile }
    }

    /// Turn PhotosPicker selections into attachments (downscaling is delegated to appendAttachment)
    private func loadPickedImages(_ items: [PhotosPickerItem]) async {
        for item in items {
            guard attachments.count < 4 else { break }
            guard let data = try? await item.loadTransferable(type: Data.self),
                  let image = UIImage(data: data) else { continue }
            appendAttachment(image)
        }
    }

    /// Downscale the image to 1568px on the long side, JPEG 0.7, and add it as an attachment
    /// (Anthropic's recommended vision size; sending full size runs to tens of MB and gets rejected)
    private func appendAttachment(_ image: UIImage) {
        guard attachments.count < 4 else { return }
        let maxSide: CGFloat = 1568
        let scale = min(1, maxSide / max(image.size.width, image.size.height))
        let target = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let renderer = UIGraphicsImageRenderer(size: target)
        let resized = renderer.image { _ in image.draw(in: CGRect(origin: .zero, size: target)) }
        guard let jpeg = resized.jpegData(compressionQuality: 0.7) else { return }
        attachments.append((thumbnail: resized,
                            attachment: TurnImageAttachment(data: jpeg, mediaType: "image/jpeg")))
    }
}

/// Camera capture (UIImagePickerController). PhotosPicker has no camera mode,
/// so wrap UIKit directly. Returns the single captured photo via onCapture
private struct CameraPicker: UIViewControllerRepresentable {
    let onCapture: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController,
                                   didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage {
                parent.onCapture(image)
            }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}

/// Box holding a weak reference to the UIScrollView backing SwiftUI's ScrollView
final class ScrollViewHolder {
    weak var scrollView: UIScrollView?
}

/// Inserted as a background into the ScrollView's content; walks up superviews to
/// capture the UIScrollView. Used by the ↓ button's setContentOffset(animated:)
/// (SwiftUI has no equivalent way to intervene)
private struct ScrollViewGrabber: UIViewRepresentable {
    let holder: ScrollViewHolder

    func makeUIView(context: Context) -> UIView { UIView() }

    func updateUIView(_ uiView: UIView, context: Context) {
        // Not yet inserted into the view hierarchy at makeUIView time, so walk up on the next run-loop cycle
        DispatchQueue.main.async {
            guard holder.scrollView == nil else { return }
            var v: UIView? = uiView.superview
            while let cur = v, !(cur is UIScrollView) { v = cur.superview }
            holder.scrollView = v as? UIScrollView
            // Also close off, on the UIKit side, any room for the vertical-only chat to move horizontally
            holder.scrollView?.alwaysBounceHorizontal = false
            holder.scrollView?.isDirectionalLockEnabled = true
        }
    }
}

/// Detects the state where content fits the frame but contentOffset.x is nonzero
/// (dragged sideways) and resets it to 0 via the captured UIScrollView.
/// Uses iOS 18+'s onScrollGeometryChange
private struct HorizontalDriftGuard: ViewModifier {
    let holder: ScrollViewHolder

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content
            .onScrollGeometryChange(for: CGFloat.self) { g in
                g.contentSize.width <= g.containerSize.width ? g.contentOffset.x : 0
            } action: { _, x in
                guard x != 0, let sv = holder.scrollView else { return }
                #if DEBUG
                print("[hdrift] residual horizontal offset detected x=\(x) -> resetting to 0")
                #endif
                DispatchQueue.main.async {
                    var offset = sv.contentOffset
                    offset.x = -sv.adjustedContentInset.left
                    sv.setContentOffset(offset, animated: false)
                }
            }
        } else {
            content
        }
    }
}

/// Bottom edge of the scroll content (maxY in the chatScroll coordinate space). Used to toggle the ↓ button (iOS 17)
private struct ChatBottomDistanceKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

/// Reports the distance from the bottom. iOS 18+ uses onScrollGeometryChange (the
/// only proper approach that fires even with offloaded scrolling); iOS 17 does
/// nothing (the preference path handles it)
private struct ScrollBottomDistanceModifier: ViewModifier {
    let onChange: (CGFloat) -> Void

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollGeometryChange(for: CGFloat.self) { g in
                // ScrollGeometry's contentOffset / containerSize are already inset-adjusted,
                // and this bare expression hits 0 at the very bottom (measured on device).
                // Adding contentInsets.bottom stays positive by the safeAreaInset composer's
                // height, leaving the ↓ button stuck visible even at the bottom
                g.contentSize.height - g.containerSize.height - g.contentOffset.y
            } action: { _, dist in
                onChange(dist)
            }
        } else {
            content
        }
    }
}

/// @StateObject cannot take init arguments, so interpose a lazily-populated box
@MainActor
final class ChatModelBox: ObservableObject {
    @Published var inner: ChatModel? {
        didSet { cancellable = inner?.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() } }
    }
    private var cancellable: AnyCancellable?
}

struct PermissionBanner: View {
    let permission: PendingPermission
    let onRespond: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Permission to run \(permission.toolName)", systemImage: "hand.raised.fill")
                .font(.callout.bold())
            Text(permission.input.displayText)
                .font(.caption.monospaced()).lineLimit(4)
                .fontDesign(.monospaced)
                .foregroundStyle(Color.tInkSub)
            HStack {
                Button("Deny", role: .destructive) { onRespond(false) }
                    .buttonStyle(.bordered)
                    .tint(Color.tRuby)
                    .accessibilityIdentifier("denyButton")
                Button("Allow") { onRespond(true) }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.tTint)
                    .accessibilityIdentifier("allowButton")
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.tDetached.opacity(0.12))
    }
}
