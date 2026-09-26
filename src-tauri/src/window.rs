use std::sync::atomic::Ordering;
use tauri::Manager as _;
/* ── Exit guard ──────────────────────────────────────────────────────────────
The video engine runs inside this process, so closing the window ends a
generation outright — and slopfab writes no file of its own, so an unfinished
run leaves nothing behind. The user therefore has to be able to answer the
close request before the window goes away: app.rs puts the question in a native
Windows message box (see `exit_guard_message`), naming the jobs the webview
reported through `set_generation_active`. `answer_app_close` and the
`app-close-requested` event belonged to the old in-page dialog; the command stays
registered so an old frontend build cannot fail on it.

The window is held open ONLY while the frontend has said something is
generating (`set_generation_active`). A webview that never loaded, or one
with nothing to lose, closes on the first click exactly as before: the guard
can never be the reason a user is stuck in a window that will not shut.
-------------------------------------------------------------------------- */

#[derive(Default)]
pub(crate) struct ExitGuard {
    /// Set by the frontend whenever the number of running or queued generations
    /// changes. False means "close without asking".
    pub(crate) generation_active: std::sync::atomic::AtomicBool,
    /// True between putting the question on screen and its answer, so a
    /// second click on the close button does not stack a second dialog.
    pub(crate) asking: std::sync::atomic::AtomicBool,
    /// What the webview last said is running, so the native message box can
    /// name it. Empty when the webview only sent the flag.
    pub(crate) jobs: std::sync::Mutex<Vec<GuardJob>>,
}

/// One generation as the exit question names it.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GuardJob {
    pub(crate) title: String,
    /// Rendering right now, as opposed to waiting in the queue.
    #[serde(default)]
    pub(crate) running: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CloseDecision {
    /// Nothing is generating: let the window close.
    Close,
    /// Hold the window open and ask the webview.
    Ask,
    /// Hold the window open; the question is already on screen.
    Waiting,
}

impl ExitGuard {
    pub(crate) fn on_close_requested(&self) -> CloseDecision {
        if !self.generation_active.load(Ordering::Acquire) {
            return CloseDecision::Close;
        }
        if self.asking.swap(true, Ordering::AcqRel) {
            CloseDecision::Waiting
        } else {
            CloseDecision::Ask
        }
    }

    /// Records the webview's answer. `true` also clears the active flag, so the
    /// close that follows is not stopped by the guard a second time.
    pub(crate) fn answered(&self, confirmed: bool) {
        self.asking.store(false, Ordering::Release);
        if confirmed {
            self.generation_active.store(false, Ordering::Release);
        }
    }
}

/// `jobs` is optional so a caller that only reports the flag keeps working;
/// the question then says "generating" without naming anything.
#[tauri::command]
pub(crate) fn set_generation_active(
    state: tauri::State<'_, ExitGuard>,
    active: bool,
    jobs: Option<Vec<GuardJob>>,
) {
    state.generation_active.store(active, Ordering::Release);
    *state.jobs.lock().unwrap_or_else(|p| p.into_inner()) = if active {
        jobs.unwrap_or_default()
    } else {
        Vec::new()
    };
}

pub(crate) const EXIT_GUARD_TITLE: &str = "Close Slopus and stop generating?";
pub(crate) const EXIT_GUARD_CONFIRM: &str = "Stop and close";
pub(crate) const EXIT_GUARD_CANCEL: &str = "Keep generating";

/// The body of the native exit question. Same claims, in the same words, as
/// src/components/ExitGuardDialog.tsx, which it replaces: a message box is
/// what Windows apps show for a yes/no question like this one.
pub(crate) fn exit_guard_message(jobs: &[GuardJob]) -> String {
    let rendering = jobs.iter().filter(|job| job.running).count();
    let queued = jobs.len() - rendering;
    let count = |n: usize| if n == 1 { "1 shot is".to_string() } else { format!("{n} shots are") };
    let mut parts = Vec::new();
    if rendering > 0 {
        parts.push(format!("{} rendering now", count(rendering)));
    }
    if queued > 0 {
        parts.push(format!("{} waiting in the queue", count(queued)));
    }
    let mut message = if parts.is_empty() {
        "A video is still generating.".to_string()
    } else {
        format!("{}.", parts.join(" and "))
    };
    message.push_str(
        "\n\nThe video engine runs inside Slopus, so closing the window stops it. \
         No video file is written until a shot finishes, and Slopus can't pick an \
         unfinished one back up: it would have to run again from the beginning.",
    );
    if !jobs.is_empty() {
        message.push('\n');
        for job in jobs.iter().take(4) {
            let state = if job.running { "rendering now" } else { "waiting" };
            message.push_str(&format!("\n\u{2022} {} ({state})", job.title));
        }
        if jobs.len() > 4 {
            message.push_str(&format!("\n\u{2022} and {} more", jobs.len() - 4));
        }
    }
    message
}

#[tauri::command]
pub(crate) fn answer_app_close(
    window: tauri::Window,
    state: tauri::State<'_, ExitGuard>,
    confirmed: bool,
) {
    state.answered(confirmed);
    if confirmed {
        let _ = window.destroy();
    }
}

/* The window's own ground — what the OS paints before the webview has anything
 * to show. A FIFTH copy of a colour that tokens.css already owns, after
 * tokens.css itself, theme.ts, public/theme-boot.js and the `backgroundColor`
 * in tauri.conf.json; src/lib/theme.test.ts now pins every one of them.
 *
 * Why Rust repaints it at all: tauri.conf.json holds ONE static value, and the
 * appearance preference has three states. Left at the dark ground, a
 * light-theme computer showed a black window for the moment before the webview
 * painted. The preference itself lives in the webview's localStorage — there is
 * nothing here that can read it — so this follows the OS instead, which is
 * exactly what the default "system" choice resolves to, and is right for an
 * explicit choice that agrees with the computer. The one case it still gets
 * wrong is an explicit choice that opposes the OS, and no value obtainable in
 * this process fixes that: it would need the preference duplicated into a
 * second store, which is precisely the drift this comment exists to record.
 * theme-boot.js corrects it on the first frame the webview draws either way.
 *
 * On Windows 11 none of this runs: the window is transparent with Mica behind
 * it (native_shell.rs), and the backdrop takes its tint from the window's
 * theme, which the page keeps in step with the preference via setTheme — so
 * the opposed-choice frame above does not happen there at all. */
pub(crate) const GROUND_DARK: tauri::window::Color = tauri::window::Color(0x08, 0x0a, 0x0f, 0xff);
pub(crate) const GROUND_LIGHT: tauri::window::Color = tauri::window::Color(0xee, 0xf1, 0xf6, 0xff);

pub(crate) fn apply_theme(window: &tauri::WebviewWindow) {
    /* With Mica behind the window there is no ground to paint: an opaque
       colour here would sit on top of the backdrop and hide it. The backdrop
       follows the window's own theme, which the page sets with setTheme. */
    if window.state::<crate::native_shell::Backdrop>().is_mica() {
        return;
    }
    let ground = if matches!(window.theme(), Ok(tauri::Theme::Light)) {
        GROUND_LIGHT
    } else {
        GROUND_DARK
    };
    let _ = window.set_background_color(Some(ground));
}
#[cfg(test)]
mod tests {
    use super::{exit_guard_message, CloseDecision, ExitGuard, GuardJob};
    use std::sync::atomic::Ordering;

    fn generating() -> ExitGuard {
        let guard = ExitGuard::default();
        guard.generation_active.store(true, Ordering::Release);
        guard
    }

    #[test]
    fn a_window_with_nothing_generating_closes_without_asking() {
        let guard = ExitGuard::default();
        assert_eq!(guard.on_close_requested(), CloseDecision::Close);
        // And it keeps closing: the guard must never latch on its own.
        assert_eq!(guard.on_close_requested(), CloseDecision::Close);
    }

    #[test]
    fn a_generation_holds_the_window_and_asks_once() {
        let guard = generating();
        assert_eq!(guard.on_close_requested(), CloseDecision::Ask);
        // Clicking the close button again while the question is on screen must
        // still hold the window, but must not stack a second dialog.
        assert_eq!(guard.on_close_requested(), CloseDecision::Waiting);
    }

    #[test]
    fn keeping_generating_leaves_the_guard_ready_to_ask_again() {
        let guard = generating();
        assert_eq!(guard.on_close_requested(), CloseDecision::Ask);
        guard.answered(false);
        // The run is still going, so the next attempt is a fresh question and
        // not a silent close.
        assert_eq!(guard.on_close_requested(), CloseDecision::Ask);
    }

    #[test]
    fn confirming_lets_the_window_go() {
        let guard = generating();
        assert_eq!(guard.on_close_requested(), CloseDecision::Ask);
        guard.answered(true);
        // destroy() can itself raise a close request; if the flag were still
        // set the guard would ask again and the window would never shut.
        assert_eq!(guard.on_close_requested(), CloseDecision::Close);
    }

    #[test]
    fn the_question_counts_and_names_what_would_be_lost() {
        let jobs = vec![
            GuardJob { title: "Opening shot".into(), running: true },
            GuardJob { title: "Close-up".into(), running: false },
            GuardJob { title: "Wide".into(), running: false },
        ];
        let message = exit_guard_message(&jobs);
        assert!(message.starts_with("1 shot is rendering now and 2 shots are waiting in the queue."));
        assert!(message.contains("\u{2022} Opening shot (rendering now)"));
        assert!(message.contains("\u{2022} Close-up (waiting)"));
    }

    #[test]
    fn the_question_still_reads_when_only_the_flag_arrived() {
        assert!(exit_guard_message(&[]).starts_with("A video is still generating."));
    }

    #[test]
    fn a_long_queue_is_cut_to_four_and_a_count() {
        let jobs: Vec<GuardJob> = (0..6)
            .map(|index| GuardJob { title: format!("Shot {index}"), running: false })
            .collect();
        let message = exit_guard_message(&jobs);
        assert!(message.contains("Shot 3"));
        assert!(!message.contains("Shot 4"));
        assert!(message.ends_with("\u{2022} and 2 more"));
    }

    #[test]
    fn a_run_that_finishes_first_takes_the_guard_back_out_of_the_way() {
        let guard = generating();
        guard.generation_active.store(false, Ordering::Release);
        assert_eq!(guard.on_close_requested(), CloseDecision::Close);
    }
}
