// Glimpse native capture sidecar.
//
// Records the main display with ScreenCaptureKit — crucially with
// showsCursor = false, so the pixels never contain the OS cursor — and
// writes an H.264 .mov via AVAssetWriter. Optionally captures system audio.
//
// Protocol:
//   glimpse-capture <output.mov> [audio 0|1]
//   → prints "FIRST_FRAME_MS <unix-ms>" once the first video frame lands
//     (the parent uses this to align cursor telemetry with the video)
//   → SIGINT finalises the file and exits 0.

import AppKit
import Foundation
import AVFoundation
import CoreMedia
import ScreenCaptureKit

// ScreenCaptureKit / CoreGraphics need a window-server connection. As a plain
// CLI tool we must initialise the Cocoa/CG session first, or CGS calls abort
// with "CGS_REQUIRE_INIT (did_initialize)". Touching NSApplication.shared does
// it; .prohibited keeps us headless (no dock icon).
let nsApp = NSApplication.shared
nsApp.setActivationPolicy(.prohibited)

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write(Data("usage: glimpse-capture <out.mov> [audio 0|1]\n".utf8))
    exit(2)
}
// Fetch shareable content once, synchronously.
func fetchShareable() -> SCShareableContent? {
    var result: SCShareableContent?
    let sem = DispatchSemaphore(value: 0)
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { c, _ in
        result = c
        sem.signal()
    }
    sem.wait()
    return result
}

// `glimpse-capture --list` → print displays + windows as JSON, then exit.
if args[1] == "--list" {
    var displays: [[String: Any]] = []
    var windows: [[String: Any]] = []
    if let content = fetchShareable() {
        for (i, d) in content.displays.enumerated() {
            displays.append([
                "id": d.displayID,
                "label": "Display \(i + 1) — \(d.width)×\(d.height)",
                "width": d.width, "height": d.height,
                "x": d.frame.origin.x, "y": d.frame.origin.y,
            ])
        }
        let systemApps: Set<String> = [
            "Dock", "Notification Centre", "Notification Center", "Window Server",
            "WindowServer", "Control Centre", "Control Center", "Wallpaper",
        ]
        for w in content.windows {
            guard let title = w.title, !title.isEmpty else { continue }
            guard let app = w.owningApplication?.applicationName, !app.isEmpty else { continue }
            if w.windowLayer != 0 { continue } // skip menubar / dock / widgets
            if systemApps.contains(app) { continue }
            if w.frame.width < 80 || w.frame.height < 80 { continue }
            windows.append([
                "id": w.windowID,
                "app": app,
                "title": title,
                "width": w.frame.width, "height": w.frame.height,
                "x": w.frame.origin.x, "y": w.frame.origin.y,
            ])
        }
    }
    let obj: [String: Any] = ["displays": displays, "windows": windows]
    if let data = try? JSONSerialization.data(withJSONObject: obj) {
        FileHandle.standardOutput.write(data)
    }
    exit(0)
}

let outURL = URL(fileURLWithPath: args[1])
let wantAudio = args.count > 2 && args[2] == "1"
// [kind: "display" | "window"] [id]
let targetKind = args.count > 3 ? args[3] : "display"
let targetID: UInt32? = args.count > 4 ? UInt32(args[4]) : nil

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
    let writer: AVAssetWriter
    let videoInput: AVAssetWriterInput
    var audioInput: AVAssetWriterInput?
    private var sessionStarted = false
    private let lock = NSLock()

    init(url: URL, width: Int, height: Int, audio: Bool) throws {
        writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 40_000_000,
                AVVideoExpectedSourceFrameRateKey: 60,
            ],
        ]
        videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        videoInput.expectsMediaDataInRealTime = true
        writer.add(videoInput)
        if audio {
            let audioSettings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48_000,
                AVNumberOfChannelsKey: 2,
                AVEncoderBitRateKey: 256_000,
            ]
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
            input.expectsMediaDataInRealTime = true
            writer.add(input)
            audioInput = input
        }
        super.init()
        writer.startWriting()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard sb.isValid else { return }
        lock.lock()
        defer { lock.unlock() }
        if type == .screen {
            // Only complete frames carry pixels.
            guard
                let attachments = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false)
                    as? [[SCStreamFrameInfo: Any]],
                let statusRaw = attachments.first?[.status] as? Int,
                statusRaw == SCFrameStatus.complete.rawValue
            else { return }
            if !sessionStarted {
                sessionStarted = true
                writer.startSession(atSourceTime: CMSampleBufferGetPresentationTimeStamp(sb))
                let ms = UInt64(Date().timeIntervalSince1970 * 1000)
                print("FIRST_FRAME_MS \(ms)")
                fflush(stdout)
            }
            if videoInput.isReadyForMoreMediaData {
                videoInput.append(sb)
            }
        } else if type == .audio, sessionStarted, let input = audioInput,
                  input.isReadyForMoreMediaData {
            input.append(sb)
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        FileHandle.standardError.write(Data("stream stopped: \(error)\n".utf8))
    }

    func finish() {
        lock.lock()
        videoInput.markAsFinished()
        audioInput?.markAsFinished()
        lock.unlock()
        let sem = DispatchSemaphore(value: 0)
        writer.finishWriting { sem.signal() }
        sem.wait()
    }
}

guard let content = fetchShareable() else {
    FileHandle.standardError.write(
        Data("no shareable content (grant Screen Recording permission?)\n".utf8))
    exit(3)
}

// Build the capture filter for the requested target: a single window, or a
// whole display (default).
let scale = 2 // capture at retina density
let filter: SCContentFilter
var capW = 0
var capH = 0
if targetKind == "window", let id = targetID,
    let win = content.windows.first(where: { $0.windowID == id }) {
    filter = SCContentFilter(desktopIndependentWindow: win)
    capW = Int(win.frame.width) * scale
    capH = Int(win.frame.height) * scale
} else {
    let display =
        (targetKind == "display"
            ? targetID.flatMap { id in content.displays.first { $0.displayID == id } }
            : nil) ?? content.displays.first
    guard let display = display else {
        FileHandle.standardError.write(Data("no display available\n".utf8))
        exit(3)
    }
    filter = SCContentFilter(display: display, excludingWindows: [])
    capW = display.width * scale
    capH = display.height * scale
}

let config = SCStreamConfiguration()
config.width = capW
config.height = capH
config.minimumFrameInterval = CMTime(value: 1, timescale: 60)
config.showsCursor = false // the whole point
config.pixelFormat = kCVPixelFormatType_32BGRA
config.queueDepth = 8
if wantAudio {
    if #available(macOS 13.0, *) {
        config.capturesAudio = true
        config.sampleRate = 48_000
        config.channelCount = 2
    }
}

let recorder: Recorder
do {
    recorder = try Recorder(url: outURL, width: config.width, height: config.height, audio: wantAudio)
} catch {
    FileHandle.standardError.write(Data("writer init failed: \(error)\n".utf8))
    exit(4)
}

let stream = SCStream(filter: filter, configuration: config, delegate: recorder)
let queue = DispatchQueue(label: "glimpse.capture")
do {
    try stream.addStreamOutput(recorder, type: .screen, sampleHandlerQueue: queue)
    if wantAudio, #available(macOS 13.0, *) {
        try stream.addStreamOutput(recorder, type: .audio, sampleHandlerQueue: queue)
    }
} catch {
    FileHandle.standardError.write(Data("output setup failed: \(error)\n".utf8))
    exit(4)
}

var startError: Error?
let startSem = DispatchSemaphore(value: 0)
stream.startCapture { error in
    startError = error
    startSem.signal()
}
startSem.wait()
if let error = startError {
    FileHandle.standardError.write(
        Data("start failed (grant Screen Recording permission?): \(error)\n".utf8))
    exit(5)
}

signal(SIGINT, SIG_IGN)
let sigSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
sigSource.setEventHandler {
    let stopSem = DispatchSemaphore(value: 0)
    stream.stopCapture { _ in stopSem.signal() }
    stopSem.wait()
    recorder.finish()
    exit(0)
}
sigSource.resume()

dispatchMain()
