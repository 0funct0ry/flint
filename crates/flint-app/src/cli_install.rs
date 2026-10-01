//! macOS first-run `flint` command install (SPEC §15, M10.3).
//!
//! On first launch of the bundled app, Flint *asks* whether to add `/usr/local/bin/flint` — a thin
//! shell shim that calls `open -a Flint.app --args "$@"` (so terminal launches register with
//! LaunchServices, M10.04). It never installs silently; the answer is remembered so it asks once.

use std::path::{Path, PathBuf};

pub const SHIM_PATH: &str = "/usr/local/bin/flint";

/// The shim's contents. `app` is the bundle path the running app lives in.
pub fn shim_script(app: &Path) -> String {
    format!(
        "#!/bin/sh\n\
         # Installed by Flint. Runs the bundled flint binary.\n\
         for app in {app:?} \"/Applications/Flint.app\" \"$HOME/Applications/Flint.app\"; do\n\
         \x20 if [ -d \"$app\" ]; then\n\
         \x20   exec \"$app/Contents/MacOS/flint\" \"$@\"\n\
         \x20 fi\n\
         done\n\
         echo \"flint: Flint.app not found\" >&2\n\
         exit 1\n",
        app = app.display().to_string()
    )
}

/// Marker recording that the user has been asked (and what they said).
pub fn marker_path() -> Option<PathBuf> {
    flint_core::config::get_global_config_path().map(|p| p.with_file_name("cli-install-asked"))
}

/// Whether to show the consent prompt: not already installed and never asked before.
pub fn should_prompt(shim: &Path, marker: Option<&Path>) -> bool {
    !shim.exists() && marker.is_some_and(|m| !m.exists())
}

pub fn record_answer(marker: &Path, accepted: bool) {
    if let Some(dir) = marker.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(marker, if accepted { "accepted\n" } else { "declined\n" });
}

#[cfg(target_os = "macos")]
pub fn install_shim(app: &Path) -> Result<(), String> {
    let tmp = std::env::temp_dir().join(format!("flint-shim-{}", std::process::id()));
    std::fs::write(&tmp, shim_script(app)).map_err(|e| e.to_string())?;
    // Writing /usr/local/bin needs admin rights; macOS shows its own authorization dialog.
    let script = format!(
        "do shell script \"mkdir -p /usr/local/bin && install -m 0755 '{}' {}\" with administrator privileges",
        tmp.display(),
        SHIM_PATH
    );
    let out = std::process::Command::new("osascript")
        .args(["-e", &script])
        .output()
        .map_err(|e| e.to_string());
    let _ = std::fs::remove_file(&tmp);
    let out = out?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Ask once, on first run from an installed bundle, then install on consent.
#[cfg(target_os = "macos")]
pub fn offer_install(app: &tauri::AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    // …/Flint.app/Contents/MacOS/flint — only offer from a real bundle, not a dev build.
    let Some(bundle) = exe
        .ancestors()
        .nth(3)
        .filter(|p| p.extension().is_some_and(|e| e == "app"))
    else {
        return;
    };
    let bundle = bundle.to_path_buf();
    let marker = marker_path();
    if !should_prompt(Path::new(SHIM_PATH), marker.as_deref()) {
        return;
    }
    app.dialog()
        .message("Add the `flint` command to /usr/local/bin so you can open workspaces from a terminal? macOS will ask for your password.")
        .title("Install the flint command")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom("Install".into(), "Not now".into()))
        .show(move |accepted| {
            if let Some(m) = &marker {
                record_answer(m, accepted);
            }
            if accepted {
                if let Err(e) = install_shim(&bundle) {
                    eprintln!("flint: could not install {SHIM_PATH}: {e}");
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shim_execs_the_bundle() {
        let s = shim_script(Path::new("/Applications/Flint.app"));
        assert!(s.starts_with("#!/bin/sh"));
        assert!(
            s.contains("/Applications/Flint.app/Contents/MacOS/flint")
                || s.contains("\"/Applications/Flint.app\"")
        );
    }

    #[test]
    fn prompts_only_once_and_never_when_installed() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("m");
        let shim = dir.path().join("flint");
        assert!(should_prompt(&shim, Some(&marker)));
        record_answer(&marker, false);
        assert!(!should_prompt(&shim, Some(&marker)));
        std::fs::remove_file(&marker).unwrap();
        std::fs::write(&shim, "x").unwrap();
        assert!(!should_prompt(&shim, Some(&marker)));
        assert!(!should_prompt(&dir.path().join("none"), None));
    }
}
