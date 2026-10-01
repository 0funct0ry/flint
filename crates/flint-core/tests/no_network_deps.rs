//! Guard (CLAUDE.md data-safety invariant 5, SPEC §1/§15): no outbound network/HTTP client crate
//! may enter the dependency tree. Two checks: `tera` strictly (M10.29), and every first-party
//! crate workspace-wide (M10.3).
//!
//! Documented exemption: `tauri` itself declares `reqwest` (and so `hyper`, `h2`, ...) on some
//! targets in `Cargo.lock`. Flint never calls it — the updater is off and no Flint code makes a
//! request — so the workspace check treats `tauri` as an opaque leaf. The same exemption lives in
//! `deny.toml` (`bans.deny[].wrappers`).

use std::collections::{HashMap, HashSet};

const BANNED: &[&str] = &[
    "reqwest",
    "ureq",
    "isahc",
    "curl",
    "surf",
    "attohttpc",
    "hyper",
];

/// Extra crates banned for first-party code (beyond Tauri's opaque subtree).
const BANNED_WORKSPACE: &[&str] = &[
    "hyper-util",
    "h2",
    "native-tls",
    "hyper-tls",
    "hyper-rustls",
    "openssl",
    "openssl-sys",
    "tauri-plugin-updater",
    "tauri-plugin-http",
];

const OPAQUE: &[&str] = &["tauri"];
const FIRST_PARTY: &[&str] = &["flint-core", "flint-app", "flint-cli"];

fn dependency_closure(lock: &str, root: &str) -> HashSet<String> {
    closure_with_opaque(lock, root, &[])
}

fn closure_with_opaque(lock: &str, root: &str, opaque: &[&str]) -> HashSet<String> {
    let mut deps: HashMap<String, Vec<String>> = HashMap::new();
    for block in lock.split("[[package]]").skip(1) {
        let mut name = None;
        let mut list = Vec::new();
        let mut in_deps = false;
        for line in block.lines() {
            let line = line.trim();
            if let Some(n) = line.strip_prefix("name = \"") {
                name = Some(n.trim_end_matches('"').to_string());
            } else if line.starts_with("dependencies = [") {
                in_deps = true;
            } else if in_deps && line == "]" {
                in_deps = false;
            } else if in_deps {
                let dep = line.trim_matches(|c| c == '"' || c == ',');
                list.push(dep.split(' ').next().unwrap_or(dep).to_string());
            }
        }
        if let Some(n) = name {
            deps.entry(n).or_default().extend(list);
        }
    }
    let mut seen = HashSet::new();
    let mut stack = vec![root.to_string()];
    while let Some(n) = stack.pop() {
        if seen.insert(n.clone()) && !opaque.contains(&n.as_str()) {
            stack.extend(deps.get(&n).cloned().unwrap_or_default());
        }
    }
    seen
}

#[test]
fn tera_dependency_tree_has_no_network_crate() {
    let lock = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../Cargo.lock"))
        .expect("Cargo.lock");
    let closure = dependency_closure(&lock, "tera");
    assert!(closure.contains("tera") && closure.len() > 5, "{closure:?}");
    for banned in BANNED {
        assert!(!closure.contains(*banned), "tera pulls in `{banned}`");
    }
}

#[test]
fn workspace_dependency_tree_has_no_network_crate() {
    let lock = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../Cargo.lock"))
        .expect("Cargo.lock");
    for root in FIRST_PARTY {
        let closure = closure_with_opaque(&lock, root, OPAQUE);
        assert!(
            closure.contains(*root) && closure.len() > 3,
            "{root}: {closure:?}"
        );
        for banned in BANNED.iter().chain(BANNED_WORKSPACE) {
            assert!(
                !closure.contains(*banned),
                "`{root}` reaches network crate `{banned}` outside Tauri"
            );
        }
    }
}

#[test]
fn tauri_updater_is_not_in_the_lockfile() {
    let lock = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../Cargo.lock"))
        .expect("Cargo.lock");
    for name in ["tauri-plugin-updater", "tauri-plugin-http"] {
        assert!(
            !lock.contains(&format!("name = \"{name}\"")),
            "{name} present"
        );
    }
}
