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
}
