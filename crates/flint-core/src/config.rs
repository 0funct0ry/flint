//! Per-workspace Flint configuration store (SPEC §11 `config_get`/`config_set`, M10.09).
//!
//! Flint's own durable state is limited to `<workspace>/.flint/config.json` — a flat
//! key/value map, read on demand and written atomically (temp file + fsync + rename,
//! matching `write_note_atomic`'s invariant). There is no in-memory cache: each call
//! reads or writes the file directly, since config reads/writes are rare compared to
//! note edits.

use crate::NoteError;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

fn config_path(root: &Path) -> std::path::PathBuf {
    root.join(".flint").join("config.json")
}

fn read_config_map(root: &Path) -> Result<HashMap<String, Value>, NoteError> {
    let path = config_path(root);
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let bytes = fs::read(&path).map_err(|e| NoteError::Io(e.to_string()))?;
    if bytes.is_empty() {
        return Ok(HashMap::new());
    }
    serde_json::from_slice(&bytes).map_err(|e| NoteError::Io(e.to_string()))
}

fn write_config_map(root: &Path, map: &HashMap<String, Value>) -> Result<(), NoteError> {
    let dir = root.join(".flint");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| NoteError::Io(e.to_string()))?;
    }

    let target_path = config_path(root);
    let temp_path = dir.join("config.json.flint-tmp");
    let serialized = serde_json::to_vec_pretty(map).map_err(|e| NoteError::Io(e.to_string()))?;

    {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&temp_path)
            .map_err(|e| NoteError::Io(e.to_string()))?;
        file.write_all(&serialized)
            .map_err(|e| NoteError::Io(e.to_string()))?;
        file.sync_all().map_err(|e| NoteError::Io(e.to_string()))?;
    }

    fs::rename(&temp_path, &target_path).map_err(|e| {
        let _ = fs::remove_file(&temp_path);
        NoteError::Io(e.to_string())
    })?;

    Ok(())
}

/// Read a single config key, returning `None` if the key (or the config file) doesn't exist.
pub fn config_get(root: &Path, key: &str) -> Result<Option<Value>, NoteError> {
    let map = read_config_map(root)?;
    Ok(map.get(key).cloned())
}

/// Write a single config key, creating `.flint/config.json` if it doesn't exist yet.
pub fn config_set(root: &Path, key: &str, value: Value) -> Result<(), NoteError> {
    let mut map = read_config_map(root)?;
    map.insert(key.to_string(), value);
    write_config_map(root, &map)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn get_missing_key_returns_none() {
        let dir = tempdir().unwrap();
        assert_eq!(
            config_get(dir.path(), "outline.confirmMoveToNewNote").unwrap(),
            None
        );
    }

    #[test]
    fn set_then_get_round_trips() {
        let dir = tempdir().unwrap();
        config_set(
            dir.path(),
            "outline.confirmMoveToNewNote",
            Value::Bool(false),
        )
        .unwrap();
        assert_eq!(
            config_get(dir.path(), "outline.confirmMoveToNewNote").unwrap(),
            Some(Value::Bool(false))
        );
    }

    #[test]
    fn set_preserves_other_keys() {
        let dir = tempdir().unwrap();
        config_set(dir.path(), "a", Value::from(1)).unwrap();
        config_set(dir.path(), "b", Value::from(2)).unwrap();
        assert_eq!(config_get(dir.path(), "a").unwrap(), Some(Value::from(1)));
        assert_eq!(config_get(dir.path(), "b").unwrap(), Some(Value::from(2)));
    }

    #[test]
    fn write_is_atomic_no_leftover_temp_file() {
        let dir = tempdir().unwrap();
        config_set(dir.path(), "k", Value::from("v")).unwrap();
        assert!(!dir
            .path()
            .join(".flint")
            .join("config.json.flint-tmp")
            .exists());
        assert!(dir.path().join(".flint").join("config.json").exists());
    }
}
