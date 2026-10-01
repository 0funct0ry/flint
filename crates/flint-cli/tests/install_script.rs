//! Tests for the repo-root `install.sh` (M10.3), run against a local fixture release.

use std::path::PathBuf;
use std::process::{Command, Output};

fn script() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../install.sh")
}

fn sh(env: &[(&str, &str)], args: &[&str]) -> Output {
    Command::new("sh")
        .arg(script())
        .args(args)
        .envs(env.iter().copied())
        .output()
        .unwrap()
}

fn sha256(path: &std::path::Path) -> String {
    let out = Command::new("sh")
        .arg("-c")
        .arg("(sha256sum \"$0\" 2>/dev/null || shasum -a 256 \"$0\") | cut -d' ' -f1")
        .arg(path)
        .output()
        .unwrap();
    String::from_utf8(out.stdout).unwrap().trim().to_string()
}

fn fixture(dir: &std::path::Path, sum_override: Option<&str>) -> String {
    let asset = dir.join("Flint_0.1.0_amd64.AppImage");
    std::fs::write(&asset, "#!/bin/sh\necho flint 0.1.0\n").unwrap();
    let sum = sum_override
        .map(String::from)
        .unwrap_or_else(|| sha256(&asset));
    std::fs::write(
        dir.join("SHA256SUMS"),
        format!("{sum}  Flint_0.1.0_amd64.AppImage\n"),
    )
    .unwrap();
    format!("file://{}", dir.display())
}

#[test]
fn dry_run_changes_nothing_and_succeeds() {
    let out = sh(&[], &["--dry-run"]);
    assert!(out.status.success());
    assert!(String::from_utf8_lossy(&out.stdout).contains("dry run"));
}

#[test]
fn unsupported_platform_fails_loudly() {
    let out = sh(&[("FLINT_TEST_OS", "Windows")], &[]);
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("unsupported platform"));
}

#[test]
fn installs_and_verifies_checksum() {
    let rel = tempfile::tempdir().unwrap();
    let prefix = tempfile::tempdir().unwrap();
    let base = fixture(rel.path(), None);
    let env = [
        ("FLINT_TEST_OS", "Linux"),
        ("FLINT_TEST_ARCH", "x86_64"),
        ("FLINT_RELEASE_BASE", base.as_str()),
    ];
    let out = sh(&env, &["--prefix", prefix.path().to_str().unwrap()]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let bin = prefix.path().join("bin/flint");
    let run = Command::new(&bin).output().unwrap();
    assert!(String::from_utf8_lossy(&run.stdout).contains("flint 0.1.0"));
}

#[test]
fn checksum_mismatch_installs_nothing() {
    let rel = tempfile::tempdir().unwrap();
    let prefix = tempfile::tempdir().unwrap();
    let base = fixture(rel.path(), Some(&"0".repeat(64)));
    let env = [
        ("FLINT_TEST_OS", "Linux"),
        ("FLINT_TEST_ARCH", "x86_64"),
        ("FLINT_RELEASE_BASE", base.as_str()),
    ];
    let out = sh(&env, &["--prefix", prefix.path().to_str().unwrap()]);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("checksum mismatch"));
    assert!(!prefix.path().join("bin/flint").exists());
}
