use assert_cmd::Command;
use predicates::prelude::*;
use std::fs;
use tempfile::tempdir;

#[test]
fn test_cli_search_and_list_and_doctor() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    fs::create_dir_all(root.join("notes/payments")).unwrap();
    fs::write(
        root.join("notes/payments/settlement.md"),
        "# Settlement\nBBPS settles daily at 18:00.\nSee [rails](./rails.md) and [missing](./missing.md).\n",
    )
    .unwrap();
    fs::write(
        root.join("notes/payments/rails.md"),
        "# Rails\nPayment rails overview.\n",
    )
    .unwrap();

    // Test flint list
    let mut cmd_list = Command::cargo_bin("flint").unwrap();
    cmd_list
        .arg("--workspace")
        .arg(root)
        .arg("list")
        .assert()
        .success()
        .stdout(predicate::str::contains("notes/payments/settlement.md"))
        .stdout(predicate::str::contains("notes/payments/rails.md"));

    // Test flint list with folder filter
    let mut cmd_list_folder = Command::cargo_bin("flint").unwrap();
    cmd_list_folder
        .arg("--workspace")
        .arg(root)
        .arg("list")
        .arg("--folder")
        .arg("notes/payments")
        .assert()
        .success()
        .stdout(predicate::str::contains("notes/payments/settlement.md"));

    // Test flint search
    let mut cmd_search = Command::cargo_bin("flint").unwrap();
    cmd_search
        .arg("--workspace")
        .arg(root)
        .arg("search")
        .arg("settles")
        .assert()
        .success()
        .stdout(predicate::str::contains(
            "notes/payments/settlement.md:2:BBPS settles daily at 18:00.",
        ));

    // Test flint search --json
    let mut cmd_search_json = Command::cargo_bin("flint").unwrap();
    cmd_search_json
        .arg("--workspace")
        .arg(root)
        .arg("--json")
        .arg("search")
        .arg("settles")
        .assert()
        .success()
        .stdout(predicate::str::contains(
            "\"path\":\"notes/payments/settlement.md\"",
        ));

    // Test flint doctor
    let mut cmd_doctor = Command::cargo_bin("flint").unwrap();
    cmd_doctor
        .arg("--workspace")
        .arg(root)
        .arg("doctor")
        .assert()
        .success()
        .stdout(predicate::str::contains("1 broken link(s)"))
        .stdout(predicate::str::contains("missing.md"));

    // Test flint doctor --json
    let mut cmd_doctor_json = Command::cargo_bin("flint").unwrap();
    cmd_doctor_json
        .arg("--workspace")
        .arg(root)
        .arg("--json")
        .arg("doctor")
        .assert()
        .success()
        .stdout(predicate::str::contains("\"broken_links\""));

    // Test flint <PATH> --no-open --json resolves explicit subdir
    let mut cmd_open_path = Command::cargo_bin("flint").unwrap();
    cmd_open_path
        .arg(root.join("notes/payments"))
        .arg("--no-open")
        .arg("--json")
        .assert()
        .success()
        .stdout(predicate::str::contains("notes/payments"));

    // Test flint with non-existent path synchronously fails with exit code 3
    let mut cmd_bad_path = Command::cargo_bin("flint").unwrap();
    cmd_bad_path
        .arg(root.join("non_existent_vault_dir"))
        .assert()
        .code(3)
        .stderr(predicate::str::contains("Workspace not found"));

    // Test detached launch: flint <PATH> returns code 0 quickly (< 2s) and prints launch message
    let start = std::time::Instant::now();
    let mut cmd_launch = Command::cargo_bin("flint").unwrap();
    let assert_res = cmd_launch
        .arg(root)
        .assert()
        .success()
        .stdout(predicate::str::contains("Opening workspace at:"));
    let duration = start.elapsed();
    assert!(
        duration < std::time::Duration::from_secs(2),
        "Detached GUI launch took too long: {:?}",
        duration
    );
    drop(assert_res);

    // On Unix, verify that the child process exists, has its own process group / session (no controlling terminal pgid),
    // and then kill it so tests don't leave background processes behind.
    #[cfg(unix)]
    {
        // Give OS a moment to register child process
        std::thread::sleep(std::time::Duration::from_millis(150));

        let canonical_root = root.canonicalize().unwrap();
        let root_str = canonical_root.display().to_string();
        let output = std::process::Command::new("pgrep")
            .arg("-f")
            .arg("--")
            .arg(format!("flint.*{}", root_str))
            .output();

        let mut found = false;
        if let Ok(out) = output {
            let pids_str = String::from_utf8_lossy(&out.stdout);
            for pid_str in pids_str.lines() {
                if let Ok(pid) = pid_str.trim().parse::<i32>() {
                    found = true;
                    // Check process is alive and inspect its pgid / sid
                    unsafe {
                        let pgid = libc::getpgid(pid);
                        assert!(pgid > 0, "Child process group should be valid");
                        let sid = libc::getsid(pid);
                        assert_eq!(pgid, sid, "Child should have setsid called (pgid == sid)");

                        // Assert it is detached from our test runner's process group
                        let my_pgid = libc::getpgrp();
                        assert_ne!(pgid, my_pgid, "Child should not be in test process group");

                        // Clean up child process
                        libc::kill(pid, libc::SIGTERM);
                    }
                }
            }
        }
        assert!(found, "Detached child process was not found by pgrep");
    }
}
