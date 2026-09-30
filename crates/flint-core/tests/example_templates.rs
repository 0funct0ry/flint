//! Every file in `examples/templates/` must render without a warning (M10.29).

use flint_core::{
    parse_front_matter, render_template_checked, resolve_variables, NoteLookup, RedbSequenceStore,
    TemplateContext, TemplateVariableDef, TemplateVariableKind, TEMPLATE_VARIABLES_FIELD,
};
use std::collections::HashMap;
use std::sync::Arc;

struct Lookup;
impl NoteLookup for Lookup {
    fn title(&self, _: &str) -> Option<String> {
        None
    }
    fn frontmatter(&self, _: &str, _: &str) -> Option<String> {
        None
    }
    fn workspace_name(&self) -> String {
        "demo".into()
    }
}

#[test]
fn example_templates_render_cleanly() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples/templates");
    let ws = tempfile::tempdir().unwrap();
    let mut count = 0;
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.file_name().is_some_and(|n| n == "README.md") {
            continue;
        }
        let raw = std::fs::read_to_string(&path).unwrap();
        let (_, body, _, fields) = parse_front_matter(&raw);
        // The templates no longer declare a schema; supply a sample for every `var.<name>` used.
        let mut explicit = HashMap::new();
        for (i, _) in body.match_indices("var.") {
            let name: String = body[i + 4..]
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            let value = match name.as_str() {
                "attendees" => "ada lovelace, alan turing".to_string(),
                "chapters" | "weeks" => "3".to_string(),
                "priority" => "High".to_string(),
                "severity" => "critical".to_string(),
                _ => format!("sample {name}"),
            };
            explicit.insert(name, value);
        }
        let schema: Vec<TemplateVariableDef> = explicit
            .keys()
            .map(|name| TemplateVariableDef {
                name: name.clone(),
                kind: TemplateVariableKind::Text,
                default: String::new(),
                required: false,
                options: Vec::new(),
            })
            .collect();
        let vars = resolve_variables(&schema, &explicit, &HashMap::new(), &HashMap::new());
        let ctx = TemplateContext::new("note", "projects/note.md")
            .with_variables(vars)
            .with_template(Some(path.file_name().unwrap().to_string_lossy().into()))
            .with_sequences(Arc::new(RedbSequenceStore::new(ws.path())))
            .with_lookup(Arc::new(Lookup));
        let out = render_template_checked(body, &ctx);
        assert!(
            out.warning.is_none(),
            "{}: {:?}",
            path.display(),
            out.warning
        );
        assert!(
            !out.text.contains("{{") && !out.text.contains("{%"),
            "{}",
            path.display()
        );
        for (_, v) in fields.iter().filter(|(k, _)| k != TEMPLATE_VARIABLES_FIELD) {
            assert!(render_template_checked(v, &ctx).warning.is_none());
        }
        count += 1;
    }
    assert_eq!(count, 10);
}
