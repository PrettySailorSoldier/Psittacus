//! Auto-capture: Psittacus scrolls the page itself instead of the user.
//!
//! Built for paged web courseware (LabLearning eLabs): each section is one
//! long page with a "Next" control at the bottom. Per section the loop is
//!
//!   1. scroll down by a fraction of the capture region, as real mouse-wheel
//!      input, so consecutive frames always overlap;
//!   2. wait until two screenshots taken `SETTLE_INTERVAL` apart match, and
//!      save only that settled frame — never one taken mid-scroll;
//!   3. stop scrolling when a scroll changes nothing: that is the bottom;
//!   4. OCR the last frame, find a control labelled "Next" (or another
//!      configured label) and click the centre of its box;
//!   5. wait for the page to change and settle again, then start the next
//!      section.
//!
//! Frames are written as PNGs into a temp directory, one list per section,
//! and handed back to the frontend, which runs them through the same OCR,
//! structure and stitching pipeline as a recording.
//!
//! WHY THE MOUSE WHEEL AND NOT PAGE DOWN: Page Down scrolls by the browser's
//! idea of a page (most of the viewport), which has nothing to do with the
//! capture region, so the overlap it leaves cannot be set. It also only works
//! once keyboard focus is inside the page, and getting it there means clicking
//! somewhere on content that may be a link. A wheel notch goes to whatever is
//! under the cursor and moves a fixed distance, which is measured on the first
//! step (see `estimate_shift`) and then used to size every later step.
//!
//! COORDINATES: the process is per-monitor DPI aware (tao sets V2), so GDI
//! capture, `SetCursorPos` and the crop region drawn on a gdigrab recording are
//! all in the same physical pixels.
//!
//! Psittacus' own window is excluded from capture (see `lib.rs`), and while
//! the loop runs it is made click-through and kept on top, so its status stays
//! visible while scrolls and clicks pass through to the browser beneath it.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::windows_ocr::OcrLineBox;

/// Gap between the two screenshots compared to decide the page has stopped
/// moving. Browser smooth scrolling runs ~150–300ms, so two frames this far
/// apart only match once it is over.
const SETTLE_INTERVAL: Duration = Duration::from_millis(200);

/// Longest a scroll is given to come to rest. A blinking or animated element
/// can keep frames from ever matching; past this the latest frame is used.
const SETTLE_TIMEOUT: Duration = Duration::from_secs(6);

/// How long a frame must stay identical to the one before a scroll before it
/// counts as the bottom of the section. Covers a browser that is slow to start
/// moving: two frames taken before the scroll begins also match.
const BOTTOM_CONFIRM: Duration = Duration::from_millis(700);

/// Longest wait for the page to start changing after Next is clicked.
const LOAD_START_TIMEOUT: Duration = Duration::from_secs(15);

/// Longest wait for a newly loaded section to settle.
const LOAD_SETTLE_TIMEOUT: Duration = Duration::from_secs(20);

/// Consecutive matching screenshots required after a section loads. A page
/// that loads in stages can sit still for one interval between them.
const LOAD_STABLE_FRAMES: u32 = 3;

/// A pixel counts as changed when any channel moves by more than this. Keeps
/// sub-pixel font smoothing differences from reading as motion.
const PIXEL_TOLERANCE: u8 = 24;

/// Two screenshots are the same when fewer than this share of pixels changed.
/// 0.05% of a 1600x1800 region is ~1400px: a blinking caret (~40px) passes,
/// a one-pixel scroll of a page of text (every glyph edge moves) does not.
const SAME_FRACTION: f64 = 0.0005;
const SAME_MIN_PIXELS: usize = 64;

/// A newly loaded section whose first frame differs from the previous
/// section's first frame by less than this share of pixels is the same
/// section again: Next did not advance.
const REPEAT_FRACTION: f64 = 0.02;

/// Luminance standard deviation below which a frame is treated as blank — a
/// page that has cleared but not yet drawn its content.
const BLANK_STDDEV: f64 = 3.0;

/// Safety stop for one section, in scroll steps.
const MAX_STEPS_PER_SECTION: u32 = 300;

/// One wheel notch, as Windows defines it.
const WHEEL_DELTA: i32 = 120;

/// Times a step that left no overlap is undone and retried at half size.
const OVERLAP_RETRIES: u32 = 2;

/// Wheel notches per step when returning to the top of a new section. Large,
/// since nothing is captured on the way up.
const TOP_SCROLL_NOTCHES: i32 = 15;

/// Column bands per row in the scroll-shift signature; see `estimate_shift`.
const SIGNATURE_BANDS: usize = 8;

/// A capture rectangle in the monitor frame's pixels, as `CropSelector` emits it.
#[derive(serde::Deserialize, Clone, Copy)]
pub struct Region {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoCaptureOptions {
    /// None captures the whole monitor (the crop step was skipped).
    pub region: Option<Region>,
    /// Scroll step as a fraction of the region's height.
    pub step_fraction: f32,
    pub max_sections: u32,
    /// Labels of the control that advances to the next section.
    pub next_labels: Vec<String>,
    /// Also accept a short link followed by an arrow at the bottom right of
    /// the browser window; see `find_arrow_link`.
    pub follow_arrow_links: bool,
    pub countdown_secs: u32,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedSection {
    pub index: u32,
    /// Settled frames, top of the section to bottom.
    pub frames: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoCaptureResult {
    pub sections: Vec<CapturedSection>,
    /// Why the run ended, in words for the user.
    pub stop_reason: String,
    /// Directory holding every frame; the frontend deletes it when done.
    pub frame_dir: String,
}

/// Progress event payload, emitted as `auto-capture-progress`.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    phase: &'static str,
    section: u32,
    frames: u32,
    message: String,
    countdown: Option<u32>,
}

#[derive(Default)]
pub struct AutoCaptureState {
    cancel: Arc<AtomicBool>,
    running: AtomicBool,
}

/// Why the loop stopped early.
enum Halt {
    /// Esc or the Stop button. Frames captured so far are kept.
    Cancelled,
    Failed(String),
}

impl From<String> for Halt {
    fn from(e: String) -> Self {
        Halt::Failed(e)
    }
}

/// One screenshot, 32-bit BGRA, top row first.
#[derive(Clone)]
struct Frame {
    width: u32,
    height: u32,
    bgra: Vec<u8>,
}

// ── Commands ────────────────────────────────────────────────────────────────

/// Screenshot the monitor auto-capture will work on, for the crop step.
///
/// Same monitor and the same pixels as a recording, so a crop region saved
/// from a recording is restored onto this frame as-is.
#[tauri::command]
pub async fn capture_screen_frame(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (x, y, width, height) = monitor_rect(&app)?;
        let frame = platform::grab(x, y, width, height)?;
        let path = app
            .path()
            .temp_dir()
            .map_err(|e| format!("Could not resolve the temp directory: {e}"))?
            .join(format!("psittacus_auto_reference_{}.png", stamp()));
        encode_png(&frame, &path)?;
        Ok(path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn start_auto_capture(
    app: AppHandle,
    state: State<'_, AutoCaptureState>,
    options: AutoCaptureOptions,
) -> Result<AutoCaptureResult, String> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Err("Auto-capture is already running.".to_string());
    }
    state.cancel.store(false, Ordering::SeqCst);
    let cancel = Arc::clone(&state.cancel);

    // Every `.get()`-style wait below blocks its thread, so the whole loop
    // runs on a blocking thread rather than the async runtime.
    let result = tauri::async_runtime::spawn_blocking(move || auto_capture(app, cancel, options))
        .await
        .map_err(|e| format!("Task join error: {e}"));

    state.running.store(false, Ordering::SeqCst);
    result?
}

#[tauri::command]
pub fn stop_auto_capture(state: State<'_, AutoCaptureState>) {
    state.cancel.store(true, Ordering::SeqCst);
}

// ── The loop ────────────────────────────────────────────────────────────────

fn auto_capture(
    app: AppHandle,
    cancel: Arc<AtomicBool>,
    options: AutoCaptureOptions,
) -> Result<AutoCaptureResult, String> {
    let monitor = monitor_rect(&app)?;
    let (x, y, width, height) = screen_region(monitor, options.region)?;

    let dir = app
        .path()
        .temp_dir()
        .map_err(|e| format!("Could not resolve the temp directory: {e}"))?
        .join(format!("psittacus_auto_{}", stamp()));
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;

    // Esc has to work while the app is driving the mouse and the browser has
    // focus, so it is polled from the keyboard state directly rather than
    // waiting on a window event that would never reach this app.
    let finished = Arc::new(AtomicBool::new(false));
    let watcher = {
        let cancel = Arc::clone(&cancel);
        let finished = Arc::clone(&finished);
        std::thread::spawn(move || {
            while !finished.load(Ordering::SeqCst) {
                if platform::escape_down() {
                    cancel.store(true, Ordering::SeqCst);
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        })
    };

    let mut run = Run {
        app: &app,
        cancel: &cancel,
        x,
        y,
        width,
        height,
        monitor,
        dir: dir.clone(),
        sections: Vec::new(),
        frame_total: 0,
    };

    let outcome = run.countdown(options.countdown_secs).and_then(|()| {
        let _session = platform::InputSession::begin(&app);
        run.capture(&options)
    });

    finished.store(true, Ordering::SeqCst);
    let _ = watcher.join();

    let stop_reason = match outcome {
        Ok(reason) => reason,
        Err(Halt::Cancelled) => "Stopped with Esc.".to_string(),
        // Frames already on disk are still worth processing.
        Err(Halt::Failed(e)) if run.frame_total > 0 => format!("Stopped by an error: {e}"),
        Err(Halt::Failed(e)) => return Err(e),
    };
    run.emit("done", stop_reason.clone());

    let sections = std::mem::take(&mut run.sections)
        .into_iter()
        .filter(|s| !s.frames.is_empty())
        .collect();

    Ok(AutoCaptureResult {
        sections,
        stop_reason,
        frame_dir: dir.to_string_lossy().to_string(),
    })
}

struct Run<'a> {
    app: &'a AppHandle,
    cancel: &'a AtomicBool,
    /// Capture rectangle on screen, in physical pixels.
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    monitor: (i32, i32, u32, u32),
    dir: PathBuf,
    sections: Vec<CapturedSection>,
    frame_total: u32,
}

impl Run<'_> {
    fn emit(&self, phase: &'static str, message: String) {
        self.emit_full(phase, message, None);
    }

    fn emit_full(&self, phase: &'static str, message: String, countdown: Option<u32>) {
        let _ = self.app.emit(
            "auto-capture-progress",
            Progress {
                phase,
                section: self.sections.len() as u32,
                frames: self.frame_total,
                message,
                countdown,
            },
        );
    }

    fn check(&self) -> Result<(), Halt> {
        if self.cancel.load(Ordering::SeqCst) {
            Err(Halt::Cancelled)
        } else {
            Ok(())
        }
    }

    /// Sleep in short slices so Esc takes effect within a few dozen ms.
    fn sleep(&self, duration: Duration) -> Result<(), Halt> {
        let end = Instant::now() + duration;
        loop {
            self.check()?;
            let now = Instant::now();
            if now >= end {
                return Ok(());
            }
            std::thread::sleep((end - now).min(Duration::from_millis(25)));
        }
    }

    fn grab(&self) -> Result<Frame, Halt> {
        self.check()?;
        Ok(platform::grab(self.x, self.y, self.width, self.height)?)
    }

    fn countdown(&self, seconds: u32) -> Result<(), Halt> {
        for remaining in (1..=seconds).rev() {
            self.emit_full(
                "countdown",
                format!("Starting in {remaining}… focus the browser window"),
                Some(remaining),
            );
            self.sleep(Duration::from_secs(1))?;
        }
        Ok(())
    }

    /// Wait until `stable_needed` consecutive screenshot pairs match and
    /// `accept` agrees, then return the last screenshot. On timeout the
    /// latest screenshot is returned anyway.
    fn settle(
        &self,
        stable_needed: u32,
        timeout: Duration,
        accept: impl Fn(&Frame, Duration) -> bool,
    ) -> Result<Frame, Halt> {
        let start = Instant::now();
        let mut previous = self.grab()?;
        let mut stable = 0;
        loop {
            self.sleep(SETTLE_INTERVAL)?;
            let current = self.grab()?;
            if same(&previous, &current) {
                stable += 1;
            } else {
                stable = 0;
            }
            let elapsed = start.elapsed();
            if stable >= stable_needed && accept(&current, elapsed) {
                return Ok(current);
            }
            if elapsed >= timeout {
                return Ok(current);
            }
            previous = current;
        }
    }

    /// Settle after a scroll from `before`. An unchanged frame is only
    /// accepted once it has held for `BOTTOM_CONFIRM`.
    fn settle_after_scroll(&self, before: &Frame) -> Result<Frame, Halt> {
        self.settle(1, SETTLE_TIMEOUT, |frame, elapsed| {
            !same(before, frame) || elapsed >= BOTTOM_CONFIRM
        })
    }

    /// Wait for the screen to differ from `before`. False on timeout.
    fn wait_change(&self, before: &Frame, timeout: Duration) -> Result<bool, Halt> {
        let start = Instant::now();
        while start.elapsed() < timeout {
            self.sleep(SETTLE_INTERVAL)?;
            if !same(before, &self.grab()?) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn save(&mut self, frame: &Frame) -> Result<String, Halt> {
        let section = self.sections.last_mut().expect("a section is open");
        let path = self.dir.join(format!(
            "s{:02}_f{:03}.png",
            section.index,
            section.frames.len() + 1
        ));
        encode_png(frame, &path)?;
        let path = path.to_string_lossy().to_string();
        section.frames.push(path.clone());
        self.frame_total += 1;
        Ok(path)
    }

    /// Where the cursor waits between actions: just outside the capture
    /// region, so a hover effect or tooltip never lands in a frame.
    fn park_point(&self) -> (i32, i32) {
        let (mx, _, mw, _) = self.monitor;
        let right = self.x + self.width as i32 + 4;
        let x = if right < mx + mw as i32 { right } else { (self.x - 4).max(mx) };
        (x, self.y + self.height as i32 / 2)
    }

    /// Scroll by `notches` wheel notches; positive scrolls down. The wheel is
    /// delivered at the region's centre, so it reaches whatever scrolls there
    /// (the page, or an iframe holding the content).
    fn scroll(&self, notches: i32) -> Result<(), Halt> {
        self.check()?;
        platform::move_cursor(self.x + self.width as i32 / 2, self.y + self.height as i32 / 2)?;
        self.sleep(Duration::from_millis(40))?;
        for _ in 0..notches.unsigned_abs() {
            platform::wheel(if notches > 0 { -WHEEL_DELTA } else { WHEEL_DELTA })?;
            self.sleep(Duration::from_millis(12))?;
        }
        let (px, py) = self.park_point();
        platform::move_cursor(px, py)?;
        Ok(())
    }

    /// Wait for a newly loaded section to settle with real content on it.
    ///
    /// A settled frame is not enough: LabLearning shows a static "Loading..."
    /// line while a page loads (it ended a manual extraction of this chapter),
    /// which holds still long enough to pass as settled. The settled frame is
    /// OCR'd, and a near-empty one or a short "loading" screen is waited out.
    fn wait_for_content(&self) -> Result<Frame, Halt> {
        let start = Instant::now();
        let probe = self.dir.join("load_probe.png");
        loop {
            let frame = self.settle(LOAD_STABLE_FRAMES, LOAD_SETTLE_TIMEOUT, |f, _| !is_blank(f))?;
            if start.elapsed() >= LOAD_SETTLE_TIMEOUT {
                return Ok(frame);
            }
            encode_png(&frame, &probe)?;
            let ocr = crate::windows_ocr::recognize(&probe.to_string_lossy())?;
            if !looks_like_loading(&ocr.text, ocr.word_count) {
                return Ok(frame);
            }
            self.emit("loading", "Page still loading".to_string());
            self.sleep(Duration::from_millis(500))?;
        }
    }

    /// Scroll to the top of a section, in case the site kept the previous
    /// section's scroll position. Returns the settled frame at the top.
    fn scroll_to_top(&self, mut current: Frame) -> Result<Frame, Halt> {
        for _ in 0..MAX_STEPS_PER_SECTION {
            self.scroll(-TOP_SCROLL_NOTCHES)?;
            let after = self.settle_after_scroll(&current)?;
            if same(&current, &after) {
                break;
            }
            current = after;
        }
        Ok(current)
    }

    /// Find the control that advances to the next section, in screen pixels.
    ///
    /// Looked for first in the last frame, as configured. Failing that, in the
    /// whole browser window: on LabLearning the control sits in a fixed footer
    /// bar beside the page number, outside the content a crop takes in, and
    /// is labelled with the next section's title ("Keeping on Track →")
    /// rather than "Next" — which is what the arrow-link rule is for.
    fn locate_next(&self, last_path: &str, options: &AutoCaptureOptions) -> Result<Option<NextHit>, Halt> {
        let ocr = crate::windows_ocr::recognize(last_path)?;
        if let Some(hit) = find_next_control(&ocr.lines, &options.next_labels) {
            return Ok(Some(hit.offset(self.x, self.y)));
        }

        let (mx, my, mw, mh) = self.monitor;
        let centre = (self.x + self.width as i32 / 2, self.y + self.height as i32 / 2);
        let (wx, wy, ww, wh) = platform::window_rect_at(self.app, centre.0, centre.1)
            .and_then(|(l, t, r, b)| {
                // Clamped to the monitor: a maximised window's frame overhangs it.
                let (l, t) = (l.max(mx), t.max(my));
                let (r, b) = (r.min(mx + mw as i32), b.min(my + mh as i32));
                (r - l >= 16 && b - t >= 16).then(|| (l, t, (r - l) as u32, (b - t) as u32))
            })
            .unwrap_or(self.monitor);

        let window = platform::grab(wx, wy, ww, wh)?;
        let path = self.dir.join(format!("next_search_s{:02}.png", self.sections.len()));
        encode_png(&window, &path)?;
        let ocr = crate::windows_ocr::recognize(&path.to_string_lossy())?;

        let hit = find_next_control(&ocr.lines, &options.next_labels).or_else(|| {
            options
                .follow_arrow_links
                .then(|| find_arrow_link(&ocr.lines, &window))
                .flatten()
        });
        Ok(hit.map(|h| h.offset(wx, wy)))
    }

    /// Click at a point in screen pixels.
    fn click_screen(&self, x: f32, y: f32) -> Result<(), Halt> {
        self.check()?;
        platform::move_cursor(x.round() as i32, y.round() as i32)?;
        // A beat for the page to register the hover before the press.
        self.sleep(Duration::from_millis(80))?;
        platform::left_click()?;
        self.sleep(Duration::from_millis(50))?;
        let (px, py) = self.park_point();
        platform::move_cursor(px, py)?;
        Ok(())
    }

    /// The whole run. Returns why it stopped.
    fn capture(&mut self, options: &AutoCaptureOptions) -> Result<String, Halt> {
        let step_target = self.height as f32 * options.step_fraction.clamp(0.3, 0.9);
        // Physical pixels one wheel notch scrolls. Unknown until measured, so
        // the first step is a single notch.
        let mut px_per_notch: Option<f32> = None;

        self.emit("settling", "Waiting for the page to settle".to_string());
        let mut current = self.settle(1, SETTLE_TIMEOUT, |_, _| true)?;
        let mut previous_first: Option<Frame> = None;

        for section in 1..=options.max_sections.max(1) {
            if let Some(previous) = &previous_first {
                if changed_fraction(previous, &current) < REPEAT_FRACTION {
                    return Ok(format!(
                        "Section {section} matched section {} — Next did not advance.",
                        section - 1
                    ));
                }
            }

            self.sections.push(CapturedSection { index: section, frames: Vec::new() });
            let mut last_path = self.save(&current)?;
            let first = current.clone();
            self.emit("scrolling", format!("Section {section}: capturing"));

            for step in 1..=MAX_STEPS_PER_SECTION {
                let mut notches = px_per_notch
                    .map_or(1, |p| ((step_target / p).floor() as i32).max(1));
                let mut retries = 0;

                let next = loop {
                    self.scroll(notches)?;
                    let after = self.settle_after_scroll(&current)?;
                    if same(&current, &after) {
                        break None; // the bottom of the section
                    }
                    match estimate_shift(&current, &after) {
                        Some(shift) => {
                            // A step cut short by the bottom of the page
                            // measures low; only full steps calibrate.
                            let expected = px_per_notch.map(|p| p * notches as f32);
                            if expected.map_or(true, |e| shift as f32 >= e * 0.8) {
                                px_per_notch = Some(shift as f32 / notches as f32);
                            }
                            break Some(after);
                        }
                        // No overlap found: the step may have jumped past the
                        // whole region and skipped content. Undo it and take a
                        // smaller one.
                        None if notches > 1 && retries < OVERLAP_RETRIES => {
                            retries += 1;
                            self.emit(
                                "scrolling",
                                format!("Section {section}: no overlap after a step, retrying smaller"),
                            );
                            self.scroll(-notches)?;
                            current = self.settle(1, SETTLE_TIMEOUT, |_, _| true)?;
                            notches = (notches / 2).max(1);
                            px_per_notch = px_per_notch.map(|p| p * 2.0);
                        }
                        // Content changed in a way the shift test cannot read
                        // (an animation, a reflow). Keep the frame.
                        None => break Some(after),
                    }
                };

                let Some(frame) = next else { break };
                current = frame;
                last_path = self.save(&current)?;
                self.emit(
                    "scrolling",
                    format!("Section {section}: {} frame(s)", self.sections.last().unwrap().frames.len()),
                );
                if step == MAX_STEPS_PER_SECTION {
                    self.emit(
                        "scrolling",
                        format!("Section {section}: step limit reached, treating as the bottom"),
                    );
                }
            }

            if section == options.max_sections {
                return Ok(format!("Reached the limit of {} section(s).", options.max_sections));
            }

            self.emit("searching", format!("Section {section}: looking for the Next button"));
            let Some(hit) = self.locate_next(&last_path, options)? else {
                return Ok(format!("No Next button found at the end of section {section}."));
            };

            self.emit("clicking", format!("Clicking \"{}\"", hit.label));
            self.click_screen(hit.x, hit.y)?;

            self.emit("loading", format!("Waiting for section {} to load", section + 1));
            if !self.wait_change(&current, LOAD_START_TIMEOUT)? {
                return Ok(format!(
                    "Clicking \"{}\" did not change the page after section {section}.",
                    hit.label
                ));
            }
            current = self.wait_for_content()?;
            current = self.scroll_to_top(current)?;
            previous_first = Some(first);
        }

        Ok(format!("Reached the limit of {} section(s).", options.max_sections))
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn stamp() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn monitor_rect(app: &AppHandle) -> Result<(i32, i32, u32, u32), String> {
    #[cfg(windows)]
    {
        crate::recording::monitor_capture_region(app)
            .ok_or_else(|| "Could not read the monitor's geometry.".to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("Auto-capture is only supported on Windows.".to_string())
    }
}

/// The capture rectangle on screen: `region` (monitor-frame pixels) offset by
/// the monitor's origin and clamped to it.
fn screen_region(
    monitor: (i32, i32, u32, u32),
    region: Option<Region>,
) -> Result<(i32, i32, u32, u32), String> {
    let (mx, my, mw, mh) = monitor;
    let Some(r) = region else { return Ok(monitor) };
    let left = r.x.round().clamp(0.0, mw as f64 - 1.0) as u32;
    let top = r.y.round().clamp(0.0, mh as f64 - 1.0) as u32;
    let width = (r.width.round() as u32).min(mw - left);
    let height = (r.height.round() as u32).min(mh - top);
    if width < 16 || height < 16 {
        return Err("The capture region is too small.".to_string());
    }
    Ok((mx + left as i32, my + top as i32, width, height))
}

fn encode_png(frame: &Frame, path: &Path) -> Result<(), String> {
    let file = std::fs::File::create(path)
        .map_err(|e| format!("Could not create {}: {e}", path.display()))?;
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), frame.width, frame.height);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    // Frames are read back within the minute and then deleted; speed beats size.
    encoder.set_compression(png::Compression::Fast);

    let rgb: Vec<u8> = frame
        .bgra
        .chunks_exact(4)
        .flat_map(|p| [p[2], p[1], p[0]])
        .collect();

    encoder
        .write_header()
        .and_then(|mut w| w.write_image_data(&rgb))
        .map_err(|e| format!("Could not write {}: {e}", path.display()))
}

/// Pixels whose colour moved by more than `PIXEL_TOLERANCE` in any channel.
fn changed_pixels(a: &Frame, b: &Frame) -> usize {
    a.bgra
        .chunks_exact(4)
        .zip(b.bgra.chunks_exact(4))
        .filter(|(p, q)| (0..3).any(|c| p[c].abs_diff(q[c]) > PIXEL_TOLERANCE))
        .count()
}

fn changed_fraction(a: &Frame, b: &Frame) -> f64 {
    if a.width != b.width || a.height != b.height {
        return 1.0;
    }
    let total = (a.width * a.height).max(1) as f64;
    changed_pixels(a, b) as f64 / total
}

/// Whether two screenshots show the same thing, give or take a caret.
fn same(a: &Frame, b: &Frame) -> bool {
    if a.width != b.width || a.height != b.height {
        return false;
    }
    let total = (a.width * a.height) as usize;
    let allowed = SAME_MIN_PIXELS.max((total as f64 * SAME_FRACTION) as usize);
    changed_pixels(a, b) <= allowed
}

fn luma(p: &[u8]) -> f64 {
    0.114 * p[0] as f64 + 0.587 * p[1] as f64 + 0.299 * p[2] as f64
}

fn is_blank(frame: &Frame) -> bool {
    // Every 7th pixel is plenty to tell a blank page from a page of text.
    let samples: Vec<f64> = frame.bgra.chunks_exact(4).step_by(7).map(luma).collect();
    if samples.is_empty() {
        return true;
    }
    let mean = samples.iter().sum::<f64>() / samples.len() as f64;
    let variance = samples.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / samples.len() as f64;
    variance.sqrt() < BLANK_STDDEV
}

/// Whether OCR of a just-loaded page reads as a loading screen rather than
/// content: almost no words, or a few words one of which is "loading".
fn looks_like_loading(text: &str, word_count: usize) -> bool {
    word_count < 3 || (word_count < 12 && text.to_lowercase().contains("loading"))
}

/// Per row, the mean brightness of each of `SIGNATURE_BANDS` column bands.
fn row_signatures(frame: &Frame) -> Vec<[f32; SIGNATURE_BANDS]> {
    let w = frame.width as usize;
    let band_width = (w / SIGNATURE_BANDS).max(1);
    (0..frame.height as usize)
        .map(|y| {
            let row = &frame.bgra[y * w * 4..(y + 1) * w * 4];
            let mut sig = [0f32; SIGNATURE_BANDS];
            for (b, slot) in sig.iter_mut().enumerate() {
                let start = (b * band_width).min(w);
                let end = ((b + 1) * band_width).min(w);
                let (mut sum, mut n) = (0f64, 0u32);
                for x in (start..end).step_by(2) {
                    sum += luma(&row[x * 4..x * 4 + 4]);
                    n += 1;
                }
                *slot = if n > 0 { (sum / n as f64) as f32 } else { 0.0 };
            }
            sig
        })
        .collect()
}

/// Signature difference below which a row counts as unchanged in place.
const STATIC_ROW_ERROR: f32 = 1.0;

/// How far the content moved up between `before` and `after`, in pixels, or
/// None when no shift lines the two up convincingly (no overlap left).
///
/// Each row is reduced to the brightness of a few column bands, and every
/// shift is scored by how well `before`'s rows from that shift on line up with
/// `after`'s rows from the top. A line of text is a different pattern of words
/// in each band, so the true shift scores near zero while shifts by whole
/// lines of text, which share only the line spacing, do not.
///
/// Rows that are identical in place in both frames are left out of every
/// score. Those are blank rows, which match anything blank and so decide
/// nothing, and fixed bars inside the region (the LabLearning title bar, if
/// the crop takes it in), which never scroll and so never line up at the true
/// shift. A fixed bar left in can fill most of a small overlap and push the
/// true shift's score past the threshold.
fn estimate_shift(before: &Frame, after: &Frame) -> Option<u32> {
    if before.width != after.width || before.height != after.height {
        return None;
    }
    let a = row_signatures(before);
    let b = row_signatures(after);
    let h = a.len();
    // At least an eighth of the region must still overlap for a match to mean anything.
    let min_overlap = (h / 8).max(8);
    if h <= min_overlap + 1 {
        return None;
    }

    let row_error = |ra: usize, rb: usize| -> f32 {
        (0..SIGNATURE_BANDS).map(|c| (a[ra][c] - b[rb][c]).abs()).sum()
    };
    let fixed: Vec<bool> = (0..h).map(|r| row_error(r, r) < STATIC_ROW_ERROR).collect();
    let moving = fixed.iter().filter(|f| !**f).count();
    if moving == 0 {
        return None; // nothing moved
    }

    // Mean error over the rows that moved, or None when too few of them
    // overlap at this shift to judge it.
    let error = |shift: usize| -> Option<f32> {
        let (sum, n) = (0..h - shift)
            .filter(|&r| !fixed[r] && !fixed[r + shift])
            .fold((0f32, 0usize), |(s, n), r| (s + row_error(r + shift, r), n + 1));
        (n >= 8 && n * 20 >= moving.min(h - shift)).then(|| sum / n as f32)
    };

    let unshifted = error(0)?;
    let (best_shift, best_error) = (1..=h - min_overlap)
        .filter_map(|s| error(s).map(|e| (s, e)))
        .min_by(|x, y| x.1.total_cmp(&y.1))?;

    // The true shift lines rows up almost exactly; it must also beat
    // assuming no movement at all by a wide margin.
    (best_error < 6.0 && best_error < unshifted * 0.35).then_some(best_shift as u32)
}

/// A control to click, located in the pixels of the image it was found in.
struct NextHit {
    label: String,
    x: f32,
    y: f32,
}

impl NextHit {
    /// Move from image pixels to screen pixels, given the image's screen origin.
    fn offset(self, x: i32, y: i32) -> NextHit {
        NextHit { x: self.x + x as f32, y: self.y + y as f32, ..self }
    }
}

/// Fraction of the window's height, from the bottom, searched for an arrow link.
const ARROW_LINK_BAND: f32 = 0.2;

/// Longest text, in words, an arrow link may carry — a section title.
const ARROW_LINK_MAX_WORDS: usize = 8;

/// Find a "next" link that is a title followed by an arrow, at the bottom
/// right of `window` ("Keeping on Track →").
///
/// Windows OCR drops the arrow (measured on a LabLearning screenshot: the line
/// came back as "Keeping on Track"), so the arrow is checked in the pixels:
/// see `has_trailing_mark`. Text that ends in an arrow-like character is
/// accepted as well, for an engine or font that does keep it.
///
/// The bottom-most such link wins, then the rightmost.
fn find_arrow_link(lines: &[OcrLineBox], window: &Frame) -> Option<NextHit> {
    let band_top = window.height as f32 * (1.0 - ARROW_LINK_BAND);
    let centre = window.width as f32 / 2.0;

    lines
        .iter()
        .filter(|l| l.top >= band_top && l.left >= centre)
        .filter(|l| {
            let words = l.text.split_whitespace().count();
            words <= ARROW_LINK_MAX_WORDS && l.text.chars().any(char::is_alphabetic)
        })
        .filter(|l| {
            l.text.trim_end().ends_with(['→', '›', '»', '>']) || has_trailing_mark(window, l)
        })
        .max_by(|a, b| a.top.total_cmp(&b.top).then(a.left.total_cmp(&b.left)))
        .map(|l| NextHit {
            label: normalise(&l.text),
            x: l.left + l.width / 2.0,
            y: l.top + l.height / 2.0,
        })
}

/// Whether a small mark — an arrow glyph or icon — sits just after `line`
/// with nothing beyond it: ink within `2.5 x` the line's height to its right,
/// clear space after that.
///
/// The second half is what tells an arrow from more words the engine missed,
/// and it rejects a Windows watermark or a status line that merely sits in
/// the corner.
fn has_trailing_mark(frame: &Frame, line: &OcrLineBox) -> bool {
    let h = line.height.max(4.0);
    let top = line.top.max(0.0) as u32;
    let bottom = ((line.top + h) as u32).min(frame.height);
    let start = (line.left + line.width + 2.0) as u32;
    let mark_end = ((line.left + line.width + h * 2.5) as u32).min(frame.width);
    let clear_end = ((line.left + line.width + h * 4.0) as u32).min(frame.width);
    if top >= bottom || start >= mark_end {
        return false;
    }

    let pixel = |x: u32, y: u32| luma(&frame.bgra[((y * frame.width + x) * 4) as usize..][..4]);
    // Background: the row just above the text, across the area searched.
    let above = top.saturating_sub(3);
    let background: f64 = (start..clear_end).map(|x| pixel(x, above)).sum::<f64>()
        / (clear_end - start).max(1) as f64;
    let ink = |from: u32, to: u32| -> u32 {
        (from..to)
            .flat_map(|x| (top..bottom).map(move |y| (x, y)))
            .filter(|&(x, y)| (pixel(x, y) - background).abs() > 60.0)
            .count() as u32
    };

    let mark = ink(start, mark_end);
    let beyond = ink(mark_end, clear_end);
    mark as f32 >= h * 1.5 && beyond as f32 <= h * 0.5
}

/// Lowercase, letters and digits only, single spaces. "Next ›" → "next".
fn normalise(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_alphanumeric() { c.to_ascii_lowercase() } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Find the control to click among a frame's OCR lines.
///
/// A match is a run of words that reads as one of `labels` and stands apart
/// on its line: Windows OCR can return "‹ Previous   Next ›" as one line, and
/// "Next" must still be found there, but not inside a sentence ("the next
/// step"). Words further apart than a word's height are separate controls.
///
/// Longer labels win ("Next Section" over "Next"), then the lowest on the
/// frame — the control at the end of the section, not a link in the text.
fn find_next_control(lines: &[OcrLineBox], labels: &[String]) -> Option<NextHit> {
    let labels: Vec<(String, usize)> = labels
        .iter()
        .map(|l| normalise(l))
        .filter(|l| !l.is_empty())
        .map(|l| {
            let n = l.split(' ').count();
            (l, n)
        })
        .collect();

    let mut best: Option<(usize, f32, NextHit)> = None;

    for line in lines {
        // Arrows and other symbols are not part of any label.
        let words: Vec<_> = line.words.iter().filter(|w| !normalise(&w.text).is_empty()).collect();
        if words.is_empty() {
            continue;
        }
        let mut heights: Vec<f32> = words.iter().map(|w| w.height).collect();
        heights.sort_by(f32::total_cmp);
        let word_height = heights[heights.len() / 2].max(1.0);

        let mut clusters: Vec<Vec<&crate::windows_ocr::OcrWordBox>> = Vec::new();
        for word in words {
            match clusters.last_mut() {
                Some(cluster) => {
                    let prev = cluster.last().unwrap();
                    if word.left - (prev.left + prev.width) > word_height {
                        clusters.push(vec![word]);
                    } else {
                        cluster.push(word);
                    }
                }
                None => clusters.push(vec![word]),
            }
        }

        for cluster in clusters {
            let text = normalise(&cluster.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" "));
            let Some((label, word_count)) = labels.iter().find(|(l, _)| *l == text) else {
                continue;
            };
            let left = cluster.iter().map(|w| w.left).fold(f32::MAX, f32::min);
            let top = cluster.iter().map(|w| w.top).fold(f32::MAX, f32::min);
            let right = cluster.iter().map(|w| w.left + w.width).fold(f32::MIN, f32::max);
            let bottom = cluster.iter().map(|w| w.top + w.height).fold(f32::MIN, f32::max);
            let hit = NextHit {
                label: label.clone(),
                x: (left + right) / 2.0,
                y: (top + bottom) / 2.0,
            };
            let better = match &best {
                None => true,
                Some((n, y, _)) => *word_count > *n || (*word_count == *n && hit.y > *y),
            };
            if better {
                best = Some((*word_count, hit.y, hit));
            }
        }
    }

    best.map(|(_, _, hit)| hit)
}

// ── Platform layer ──────────────────────────────────────────────────────────

#[cfg(windows)]
mod platform {
    use super::Frame;
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        SRCCOPY,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_LEFTDOWN,
        MOUSEEVENTF_LEFTUP, MOUSEEVENTF_WHEEL, MOUSEINPUT, MOUSE_EVENT_FLAGS, VK_ESCAPE,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetCursorPos, GetWindowRect, SetCursorPos, WindowFromPoint, GA_ROOT,
    };

    /// Screen rectangle `(left, top, right, bottom)` of the top-level window
    /// under a point — the browser, beneath the capture region. Psittacus'
    /// own window is click-through while a run is active, so hit-testing
    /// should pass through it; if it does not, None rather than its rectangle.
    pub fn window_rect_at(app: &tauri::AppHandle, x: i32, y: i32) -> Option<(i32, i32, i32, i32)> {
        use tauri::Manager;
        let own = app.get_webview_window("main").and_then(|w| w.hwnd().ok());
        unsafe {
            let hwnd = WindowFromPoint(POINT { x, y });
            if hwnd.is_invalid() {
                return None;
            }
            let root = GetAncestor(hwnd, GA_ROOT);
            let target = if root.is_invalid() { hwnd } else { root };
            if own.is_some_and(|own| own.0 == target.0) {
                return None;
            }
            let mut rect = Default::default();
            GetWindowRect(target, &mut rect).ok()?;
            let rect: windows::Win32::Foundation::RECT = rect;
            Some((rect.left, rect.top, rect.right, rect.bottom))
        }
    }

    /// Copy a screen rectangle (virtual-desktop coordinates) into a `Frame`.
    pub fn grab(x: i32, y: i32, width: u32, height: u32) -> Result<Frame, String> {
        let (w, h) = (width as i32, height as i32);
        unsafe {
            let screen = GetDC(None);
            if screen.is_invalid() {
                return Err("Could not open the screen for capture.".to_string());
            }
            let memory = CreateCompatibleDC(Some(screen));
            let bitmap = CreateCompatibleBitmap(screen, w, h);
            let previous = SelectObject(memory, bitmap.into());
            let copied = BitBlt(memory, 0, 0, w, h, Some(screen), x, y, SRCCOPY);
            // GetDIBits wants the bitmap out of any device context.
            SelectObject(memory, previous);

            let mut info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w,
                    biHeight: -h, // negative: top row first
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bgra = vec![0u8; width as usize * height as usize * 4];
            let rows = GetDIBits(
                screen,
                bitmap,
                0,
                height,
                Some(bgra.as_mut_ptr().cast()),
                &mut info,
                DIB_RGB_COLORS,
            );

            let _ = DeleteObject(bitmap.into());
            let _ = DeleteDC(memory);
            ReleaseDC(None, screen);

            copied.map_err(|e| format!("Screen capture failed: {}", e.message()))?;
            if rows != h {
                return Err(format!("Screen capture returned {rows} of {h} rows."));
            }
            Ok(Frame { width, height, bgra })
        }
    }

    fn send_mouse(flags: MOUSE_EVENT_FLAGS, data: i32) -> Result<(), String> {
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    mouseData: data as u32,
                    dwFlags: flags,
                    ..Default::default()
                },
            },
        };
        let sent = unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
        if sent == 1 {
            Ok(())
        } else {
            // Blocked by UIPI when the target runs elevated and this app does not.
            Err("Windows refused the simulated input. If the browser runs as administrator, \
                 run Psittacus as administrator too."
                .to_string())
        }
    }

    /// One wheel event; negative `delta` scrolls down.
    pub fn wheel(delta: i32) -> Result<(), String> {
        send_mouse(MOUSEEVENTF_WHEEL, delta)
    }

    pub fn left_click() -> Result<(), String> {
        send_mouse(MOUSEEVENTF_LEFTDOWN, 0)?;
        std::thread::sleep(std::time::Duration::from_millis(30));
        send_mouse(MOUSEEVENTF_LEFTUP, 0)
    }

    pub fn move_cursor(x: i32, y: i32) -> Result<(), String> {
        unsafe { SetCursorPos(x, y) }.map_err(|e| format!("Could not move the cursor: {}", e.message()))
    }

    pub fn escape_down() -> bool {
        (unsafe { GetAsyncKeyState(VK_ESCAPE.0 as i32) } as u16 & 0x8000) != 0
    }

    /// The app's window state while it drives the mouse: click-through and on
    /// top, so status stays visible and input reaches the browser beneath.
    /// Undone on drop, along with putting the cursor back where it was.
    pub struct InputSession {
        window: Option<tauri::WebviewWindow>,
        cursor: Option<POINT>,
    }

    impl InputSession {
        pub fn begin(app: &tauri::AppHandle) -> Self {
            use tauri::Manager;
            let window = app.get_webview_window("main");
            if let Some(w) = &window {
                let _ = w.set_ignore_cursor_events(true);
                let _ = w.set_always_on_top(true);
            }
            let mut point = POINT::default();
            let cursor = unsafe { GetCursorPos(&mut point) }.ok().map(|_| point);
            InputSession { window, cursor }
        }
    }

    impl Drop for InputSession {
        fn drop(&mut self) {
            if let Some(w) = &self.window {
                let _ = w.set_ignore_cursor_events(false);
                let _ = w.set_always_on_top(false);
            }
            if let Some(p) = self.cursor {
                let _ = unsafe { SetCursorPos(p.x, p.y) };
            }
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::Frame;

    const UNSUPPORTED: &str = "Auto-capture is only supported on Windows.";

    pub fn grab(_x: i32, _y: i32, _w: u32, _h: u32) -> Result<Frame, String> {
        Err(UNSUPPORTED.to_string())
    }
    pub fn wheel(_delta: i32) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }
    pub fn left_click() -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }
    pub fn move_cursor(_x: i32, _y: i32) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }
    pub fn escape_down() -> bool {
        false
    }
    pub fn window_rect_at(_app: &tauri::AppHandle, _x: i32, _y: i32) -> Option<(i32, i32, i32, i32)> {
        None
    }
    pub struct InputSession;
    impl InputSession {
        pub fn begin(_app: &tauri::AppHandle) -> Self {
            InputSession
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::windows_ocr::OcrWordBox;

    /// A page of pseudo-text: lines of dark "words" of varying length and
    /// position on a white background. Each 4px "letter" spans its own
    /// height within the line, as ascenders and descenders do, so no two rows
    /// of a line are alike — as with real glyphs.
    fn page(width: u32, height: u32) -> Vec<[u8; 4]> {
        let mut px = vec![[255u8, 255, 255, 255]; (width * height) as usize];
        let mut seed = 12345u32;
        let mut next = move || {
            seed = seed.wrapping_mul(1103515245).wrapping_add(12345);
            seed >> 8
        };
        let mut y = 4;
        while y + 14 < height {
            let mut x = 10;
            while x < width - 10 {
                let len = 10 + next() % 60;
                let gap = 6 + next() % 20;
                for letter in (x..(x + len).min(width - 10)).step_by(4) {
                    let top = y + next() % 5;
                    let bottom = y + 12 - next() % 4;
                    for yy in top..bottom {
                        for xx in letter..(letter + 3).min(width - 10) {
                            px[(yy * width + xx) as usize] = [30, 30, 30, 255];
                        }
                    }
                }
                x += len + gap;
            }
            y += 20;
        }
        px
    }

    /// A `height`-row window onto `content` starting at row `offset`.
    fn view(content: &[[u8; 4]], width: u32, offset: u32, height: u32) -> Frame {
        let start = (offset * width) as usize;
        let end = start + (width * height) as usize;
        Frame { width, height, bgra: content[start..end].iter().flatten().copied().collect() }
    }

    #[test]
    fn same_tolerates_a_caret_but_not_a_scroll() {
        let content = page(400, 1200);
        let a = view(&content, 400, 0, 300);
        let mut caret = a.clone();
        for y in 100..118 {
            let i = (y * 400 + 200) as usize * 4;
            caret.bgra[i..i + 4].copy_from_slice(&[0, 0, 0, 255]);
        }
        assert!(same(&a, &caret));
        assert!(!same(&a, &view(&content, 400, 1, 300)));
    }

    #[test]
    fn estimate_shift_measures_the_scroll() {
        let content = page(400, 1200);
        let before = view(&content, 400, 100, 300);
        for shift in [1, 37, 120, 225] {
            let after = view(&content, 400, 100 + shift, 300);
            assert_eq!(estimate_shift(&before, &after), Some(shift), "shift {shift}");
        }
    }

    #[test]
    fn estimate_shift_ignores_a_fixed_bar() {
        let content = page(400, 1200);
        let with_bar = |offset: u32| {
            let mut f = view(&content, 400, offset, 300);
            for px in f.bgra[..400 * 30 * 4].chunks_exact_mut(4) {
                px.copy_from_slice(&[20, 40, 90, 255]);
            }
            f
        };
        assert_eq!(estimate_shift(&with_bar(100), &with_bar(310)), Some(210));
    }

    #[test]
    fn estimate_shift_rejects_no_overlap() {
        let content = page(400, 1200);
        let before = view(&content, 400, 0, 300);
        let after = view(&content, 400, 700, 300);
        assert_eq!(estimate_shift(&before, &after), None);
    }

    #[test]
    fn loading_screen_is_recognised() {
        assert!(looks_like_loading("Loading...", 1));
        assert!(looks_like_loading("Page 40 Loading... Keeping on Track", 6));
        assert!(!looks_like_loading(
            "Loading dock procedures: check each pallet before signing the delivery receipt today",
            12
        ));
        assert!(!looks_like_loading("Sadie has asked you to provide a list of all unpaid bills.", 12));
    }

    /// Reads a small patch of the real screen; nothing is saved.
    #[cfg(windows)]
    #[test]
    fn grab_reads_the_screen() {
        let frame = platform::grab(0, 0, 64, 48).expect("capture should succeed");
        assert_eq!((frame.width, frame.height, frame.bgra.len()), (64, 48, 64 * 48 * 4));
    }

    #[test]
    fn blank_page_is_blank() {
        let white = Frame { width: 50, height: 50, bgra: vec![255; 50 * 50 * 4] };
        assert!(is_blank(&white));
        assert!(!is_blank(&view(&page(400, 400), 400, 0, 300)));
    }

    fn word(text: &str, left: f32, top: f32, width: f32) -> OcrWordBox {
        OcrWordBox { text: text.to_string(), left, top, width, height: 16.0 }
    }

    fn line(words: Vec<OcrWordBox>) -> OcrLineBox {
        let left = words.first().unwrap().left;
        let right = words.iter().map(|w| w.left + w.width).fold(0.0, f32::max);
        OcrLineBox {
            text: words.iter().map(|w| w.text.clone()).collect::<Vec<_>>().join(" "),
            left,
            top: words[0].top,
            width: right - left,
            height: 16.0,
            words,
        }
    }

    fn labels() -> Vec<String> {
        ["Next", "Next Section", "Next Page", "Continue"].map(String::from).to_vec()
    }

    #[test]
    fn finds_next_beside_previous_on_one_line() {
        let lines = vec![
            line(vec![word("Click", 10.0, 50.0, 40.0), word("next", 55.0, 50.0, 30.0), word("to", 90.0, 50.0, 15.0)]),
            line(vec![
                word("‹", 10.0, 900.0, 8.0),
                word("Previous", 22.0, 900.0, 70.0),
                word("Next", 600.0, 900.0, 40.0),
                word("›", 644.0, 900.0, 8.0),
            ]),
        ];
        let hit = find_next_control(&lines, &labels()).expect("Next found");
        assert_eq!(hit.label, "next");
        assert_eq!((hit.x, hit.y), (620.0, 908.0));
    }

    #[test]
    fn ignores_next_inside_a_sentence() {
        let lines = vec![line(vec![
            word("the", 10.0, 50.0, 25.0),
            word("next", 40.0, 50.0, 30.0),
            word("step", 75.0, 50.0, 30.0),
        ])];
        assert!(find_next_control(&lines, &labels()).is_none());
    }

    #[test]
    fn prefers_the_longer_label() {
        let lines = vec![
            line(vec![word("Next", 10.0, 950.0, 40.0)]),
            line(vec![word("Next", 300.0, 400.0, 40.0), word("Section", 345.0, 400.0, 60.0)]),
        ];
        assert_eq!(find_next_control(&lines, &labels()).unwrap().label, "next section");
    }

    fn decode_png(path: &str) -> Frame {
        let decoder = png::Decoder::new(std::io::BufReader::new(std::fs::File::open(path).unwrap()));
        let mut reader = decoder.read_info().unwrap();
        let mut buf = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut buf).unwrap();
        let channels = info.color_type.samples();
        let bgra = buf[..info.buffer_size()]
            .chunks_exact(channels)
            .flat_map(|p| [p[2], p[1], p[0], 255])
            .collect();
        Frame { width: info.width, height: info.height, bgra }
    }

    /// Against real screenshots and the real OS engine.
    ///
    /// `PSITTACUS_NEXT_SAMPLES` lists `path=expected` pairs separated by `;`,
    /// where `expected` is the label that should be found, or empty for none.
    #[cfg(windows)]
    #[test]
    fn arrow_link_on_real_screenshots() {
        let Ok(spec) = std::env::var("PSITTACUS_NEXT_SAMPLES") else {
            eprintln!("PSITTACUS_NEXT_SAMPLES not set — skipping");
            return;
        };
        for pair in spec.split(';').filter(|p| !p.is_empty()) {
            let (path, expected) = pair.rsplit_once('=').unwrap();
            let ocr = crate::windows_ocr::recognize(path).expect("OCR should succeed");
            let frame = decode_png(path);
            let found = find_next_control(&ocr.lines, &labels())
                .or_else(|| find_arrow_link(&ocr.lines, &frame));
            eprintln!(
                "{path}: {:?}",
                found.as_ref().map(|h| (h.label.clone(), h.x, h.y))
            );
            assert_eq!(found.map(|h| h.label).unwrap_or_default(), expected, "{path}");
        }
    }

    /// A scroll simulated on a real screenshot: two windows onto it, offset
    /// by known amounts. `PSITTACUS_SHIFT_SAMPLE` is the screenshot's path.
    #[test]
    fn estimate_shift_on_a_real_screenshot() {
        let Ok(path) = std::env::var("PSITTACUS_SHIFT_SAMPLE") else {
            eprintln!("PSITTACUS_SHIFT_SAMPLE not set — skipping");
            return;
        };
        let shot = decode_png(&path);
        let pixels: Vec<[u8; 4]> = shot.bgra.chunks_exact(4).map(|p| [p[0], p[1], p[2], p[3]]).collect();
        let height = shot.height / 2;
        let before = view(&pixels, shot.width, 0, height);
        for shift in [7, 120, height * 3 / 4] {
            let after = view(&pixels, shot.width, shift, height);
            assert_eq!(estimate_shift(&before, &after), Some(shift), "shift {shift}");
        }
    }

    #[test]
    fn screen_region_offsets_by_the_monitor() {
        let region = Region { x: 1214.0, y: 167.0, width: 1585.0, height: 1799.0 };
        assert_eq!(
            screen_region((-3840, 0, 3840, 2160), Some(region)).unwrap(),
            (-3840 + 1214, 167, 1585, 1799)
        );
        assert_eq!(screen_region((0, 0, 100, 100), None).unwrap(), (0, 0, 100, 100));
    }
}
