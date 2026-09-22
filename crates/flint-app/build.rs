fn main() {
    let dist = std::path::Path::new("../../dist");
    let has_assets = dist.join("index.html").exists() && dist.join("assets").exists();

    if !has_assets {
        // Attempt to run pnpm build automatically from the root workspace
        let _ = std::process::Command::new("pnpm")
            .arg("build")
            .current_dir("../../")
            .status();
    }

    // Ensure directory exists as a safety fallback
    if !dist.exists() {
        let _ = std::fs::create_dir_all(dist);
    }

    tauri_build::build();
}

