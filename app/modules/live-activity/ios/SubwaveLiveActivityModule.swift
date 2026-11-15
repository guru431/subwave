import ActivityKit
import ExpoModulesCore
import Foundation

// Starts, updates and ends the on-air Live Activity rendered by the
// live-activity widget target.
//
// This module owns the ActivityKit side and NOTHING else. It does not poll, it
// does not decide when the card should be up, and it never talks to a station:
// the hook (src/hooks/useLiveActivity.ts) drives it from the same feed the
// player already renders, and the heart tap is handed straight back to JS so
// the like goes out through the app's own StationApi client. Keeping the
// station URL and its SecureStore credentials out of native code here is
// deliberate — see LikeTrackIntent.swift.
//
// iOS 17 is the floor for the whole feature even though ActivityKit itself is
// older: the widget target is built at 17.0 (interactive buttons), so on 16.x
// there would be no renderer for an activity this module started. `isSupported`
// is the single gate and the hook refuses to start below it.

/// Immutable per-activity identity. See SubwaveLiveAttributes.
struct LiveActivityConfig: Record {
  @Field var station: String = "SUB/WAVE"
  @Field var accent: String = "#d94b2a"
}

/// One on-air snapshot. Mirrors SubwaveLiveAttributes.ContentState, plus the
/// two artwork fields that never reach the widget: the extension is handed a
/// filename, not a URL (LiveActivityArtwork).
struct LiveActivityState: Record {
  @Field var title: String = ""
  @Field var artist: String = ""
  @Field var show: String? = nil
  /// Stable cache key for the cover — the track's subsonic id.
  @Field var artworkKey: String? = nil
  /// Absolute cover URL, downloaded into the App Group on a background task.
  @Field var artworkUrl: String? = nil
  /// `Authorization: Basic …` for a credentialed station, from the same
  /// accessor the audio stream uses (StationApi.streamHeaders).
  @Field var artworkHeaders: [String: String] = [:]
  /// Epoch MILLISECONDS, in listener-time (already carries the buffer offset).
  @Field var startedAt: Double? = nil
  /// Seconds.
  @Field var duration: Double? = nil
  @Field var talking: Bool = false
  @Field var likeCount: Int = 0
  @Field var liked: Bool = false
  @Field var likeable: Bool = false
}

public class SubwaveLiveActivityModule: Module {
  private var likeObserver: NSObjectProtocol?
  /// The state last pushed, kept so a cover that lands after the fact can be
  /// re-pushed without the hook having to re-send everything.
  @MainActor private var lastState: SubwaveLiveAttributes.ContentState?
  /// The artwork key `lastState` belongs to. A download that completes after
  /// the track has already changed is dropped rather than painting the
  /// previous song's cover over the current one.
  @MainActor private var lastArtworkKey: String?
  @MainActor private var inFlightArtworkKey: String?

  public func definition() -> ModuleDefinition {
    Name("SubwaveLiveActivity")

    // The heart, tapped on the Lock Screen / Dynamic Island / Smart Stack.
    // LikeTrackIntent runs in this process and posts the notification below;
    // all this module does is forward it, so the like itself is performed by
    // useTrackLike exactly as if the listener had tapped it in the app.
    Events("onLikePressed")

    OnStartObserving {
      self.likeObserver = NotificationCenter.default.addObserver(
        forName: Notification.Name("SubwaveLiveActivityLikePressed"),
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.sendEvent("onLikePressed", [:])
      }
    }

    OnStopObserving {
      if let observer = self.likeObserver {
        NotificationCenter.default.removeObserver(observer)
      }
      self.likeObserver = nil
    }

    /// iOS 17+ AND the listener has not switched Live Activities off for this
    /// app in Settings. Both are permanent-ish facts, so the hook checks once.
    Function("isSupported") { () -> Bool in
      guard #available(iOS 17.0, *) else { return false }
      return ActivityAuthorizationInfo().areActivitiesEnabled
    }

    AsyncFunction("start") { (config: LiveActivityConfig, state: LiveActivityState) -> Bool in
      await self.startActivity(config: config, state: state)
    }

    AsyncFunction("update") { (state: LiveActivityState) in
      await self.updateActivity(state)
    }

    AsyncFunction("stop") { () in
      await self.stopActivity()
    }
  }

  // MARK: - Internals

  // Expo invokes AsyncFunction off the main actor. Keep every activity-state
  // read/write on the same actor as the artwork completion below.
  @MainActor private func startActivity(config: LiveActivityConfig, state: LiveActivityState) async -> Bool {
    guard #available(iOS 17.0, *) else { return false }
    guard ActivityAuthorizationInfo().areActivitiesEnabled else { return false }
    // Never stack after a station switch, hot reload or an interrupted run.
    await endAll()
    let attributes = SubwaveLiveAttributes(station: config.station, accent: config.accent)
    let content = contentState(from: state)
    do {
      _ = try Activity.request(
        attributes: attributes,
        content: ActivityContent(state: content, staleDate: staleDate(for: content)),
        pushType: nil
      )
    } catch {
      // The system activity limit or revoked permission is not fatal.
      return false
    }
    remember(content, key: state.artworkKey)
    ensureArtwork(state)
    return true
  }

  @MainActor private func updateActivity(_ state: LiveActivityState) async {
    guard #available(iOS 17.0, *) else { return }
    let content = contentState(from: state)
    remember(content, key: state.artworkKey)
    await push(content)
    ensureArtwork(state)
  }

  @MainActor private func stopActivity() async {
    guard #available(iOS 17.0, *) else { return }
    await endAll()
    lastState = nil
    lastArtworkKey = nil
    inFlightArtworkKey = nil
  }

  @MainActor private func remember(_ content: SubwaveLiveAttributes.ContentState, key: String?) {
    lastState = content
    lastArtworkKey = key
  }

  @MainActor private func contentState(from state: LiveActivityState) -> SubwaveLiveAttributes.ContentState {
    SubwaveLiveAttributes.ContentState(
      title: state.title,
      artist: state.artist,
      show: state.show,
      artwork: LiveActivityArtwork.cachedName(for: state.artworkKey),
      startedAt: state.startedAt.map { Date(timeIntervalSince1970: $0 / 1000) },
      duration: state.duration,
      talking: state.talking,
      likeCount: state.likeCount,
      liked: state.liked,
      likeable: state.likeable
    )
  }

  /// When the system should start showing this card as stale. If the app is
  /// killed mid-song the activity survives it, and a card still insisting a
  /// three-minute song is playing an hour later is a lie the OS is willing to
  /// tell on our behalf — so it is given an expiry either way.
  private func staleDate(for content: SubwaveLiveAttributes.ContentState) -> Date {
    if let started = content.startedAt, let duration = content.duration, duration > 1 {
      return started.addingTimeInterval(duration + 60)
    }
    return Date().addingTimeInterval(15 * 60)
  }

  @MainActor private func push(_ content: SubwaveLiveAttributes.ContentState) async {
    guard #available(iOS 17.0, *) else { return }
    let update = ActivityContent(state: content, staleDate: staleDate(for: content))
    for activity in Activity<SubwaveLiveAttributes>.activities {
      await activity.update(update)
    }
  }

  @MainActor private func endAll() async {
    guard #available(iOS 17.0, *) else { return }
    for activity in Activity<SubwaveLiveAttributes>.activities {
      await activity.end(nil, dismissalPolicy: .immediate)
    }
  }

  /// Fetch the cover if this track's is not already on disk, then re-push so it
  /// appears. The activity goes out WITHOUT waiting on this — a card with a
  /// disc mark now beats a correct card after a round trip.
  @MainActor private func ensureArtwork(_ state: LiveActivityState) {
    guard
      let key = state.artworkKey, !key.isEmpty,
      let url = state.artworkUrl, !url.isEmpty,
      LiveActivityArtwork.cachedName(for: key) == nil,
      inFlightArtworkKey != key
    else { return }

    inFlightArtworkKey = key
    LiveActivityArtwork.fetch(key: key, url: url, headers: state.artworkHeaders) {
      [weak self] name in
      guard let self else { return }
      Task { @MainActor in
        if self.inFlightArtworkKey == key { self.inFlightArtworkKey = nil }
        guard let name, self.lastArtworkKey == key, var content = self.lastState else { return }
        guard content.artwork != name else { return }
        content.artwork = name
        self.lastState = content
        await self.push(content)
      }
    }
  }
}
