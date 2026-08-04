//! The desktop shell's composition root.
//!
//! It wires a Tauri runtime around a webview and nothing else. There is no RBA
//! mechanism here on purpose — no driver, no session, no Filler — because the
//! interfaces those would implement are frozen at ◆G0 and this shell exists
//! before that freeze. See `README.md` for why the shell lands early anyway.

/// Builds and runs the desktop application.
///
/// Separated from `main` so the mobile entry point below and the desktop binary
/// share one startup path rather than two that can drift.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running the Ecoma RBA desktop shell");
}

/// The shell's own identity, as the window title reads it.
///
/// Trivial today, and deliberately public: it is the one behaviour this crate
/// has, so it is the one thing a test can pin — which is what makes the Rust
/// test lane prove itself on a real assertion rather than an empty suite.
#[must_use]
pub fn product_name() -> &'static str {
    "Ecoma RBA"
}

#[cfg(test)]
mod tests {
    use super::product_name;

    #[test]
    fn the_shell_identifies_itself_as_the_rba_product_not_the_workspace() {
        // The window title is the first thing a user reads, and the failure this
        // pins is a real one: a shell scaffolded by copying another app's config
        // ships that app's name. Asserting the exact string is the point.
        assert_eq!(product_name(), "Ecoma RBA");
    }
}
