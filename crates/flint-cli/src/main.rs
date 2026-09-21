use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(
    name = "flint",
    version,
    about = "Local-first Markdown knowledge workspace"
)]
pub struct Cli {
    /// Workspace directory to open (default: ".")
    #[arg(value_name = "PATH")]
    pub path: Option<PathBuf>,

    /// Override workspace path resolution
    #[arg(long, value_name = "PATH")]
    pub workspace: Option<PathBuf>,

    /// Do not open the GUI window
    #[arg(long)]
    pub no_open: bool,

    /// Machine-readable JSON output
    #[arg(long)]
    pub json: bool,

    /// Log level filter (error, warn, info, debug, trace)
    #[arg(long, default_value = "info")]
    pub log: String,

    #[command(subcommand)]
    pub command: Option<Commands>,
}

#[derive(Subcommand, Debug)]
pub enum Commands {
    /// Create .flint/ and a starter note, do not open the GUI
    Init {
        #[arg(value_name = "PATH")]
        path: Option<PathBuf>,
    },
    /// Create a note relative to the workspace
    New {
        #[arg(value_name = "NOTE")]
        note: String,
        #[arg(long)]
        open: bool,
    },
    /// Print matching notes to stdout
    Search {
        #[arg(value_name = "QUERY")]
        query: String,
    },
    /// Print note paths, one per line
    List {
        #[arg(long, value_name = "DIR")]
        folder: Option<String>,
    },
    /// Report workspace health: broken links, orphans, unreadable files
    Doctor,
    /// Print workspace path, note count, link count, config location
    Info,
}

fn main() {
    let cli = Cli::parse();
    if cli.json {
        println!("{{\"status\":\"flint-cli initialized\",\"version\":\"0.1.0\"}}");
    } else {
        println!("Flint knowledge workspace v0.1.0 (scaffold)");
        if let Some(cmd) = cli.command {
            println!("Command invoked: {:?}", cmd);
        } else {
            let target = cli.path.unwrap_or_else(|| PathBuf::from("."));
            println!("Opening workspace at: {}", target.display());
        }
    }
}
