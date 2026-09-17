use std::sync::atomic::Ordering;
/* ── Exit guard ──────────────────────────────────────────────────────────────
The video engine runs inside this process, so closing the window ends a
generation outright — and slopfab writes no file of its own, so an unfinished
run leaves nothing behind. The webview therefore has to be able to answer the
close request before the window goes away.

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
    /// True between putting the question to the webview and its answer, so a
    /// second click on the close button does not stack a second dialog.
    pub(crate) asking: std::sync::atomic::AtomicBool,
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

#[tauri::command]
pub(crate) fn set_generation_active(state: tauri::State<'_, ExitGuard>, active: bool) {
    state.generation_active.store(active, Ordering::Release);
}

#[tauri::command]
pub(crate) fn answer_app_close(window: tauri::Window, state: tauri::State<'_, ExitGuard>, confirmed: bool) {
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
 * theme-boot.js corrects it on the first frame the webview draws either way. */
pub(crate) const GROUND_DARK: tauri::window::Color = tauri::window::Color(0x08, 0x0a, 0x0f, 0xff);
pub(crate) const GROUND_LIGHT: tauri::window::Color = tauri::window::Color(0xee, 0xf1, 0xf6, 0xff);
#[cfg(test)]
mod tests {
    use super::{CloseDecision, ExitGuard};
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
    fn a_run_that_finishes_first_takes_the_guard_back_out_of_the_way() {
        let guard = generating();
        guard.generation_active.store(false, Ordering::Release);
        assert_eq!(guard.on_close_requested(), CloseDecision::Close);
    }
}
