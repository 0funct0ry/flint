//! Guard (CLAUDE.md data-safety invariant 5): the template engine's dependency closure must not
//! contain an outbound network/HTTP client crate. Scoped to `tera` (M10.29); the workspace-wide
//! ban is deferred because Tauri's own tree already pulls in `hyper`.

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

fn dependency_closure(lock: &str, root: &str) -> HashSet<String> {
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
        if seen.insert(n.clone()) {
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
