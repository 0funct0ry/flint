{% set num = seq(prefix="", width=4) -%}
# ADR-{{ num }}: {{ var.decision }}

- Status: {{ var.status | capitalize }}
- Date: {{ date() }}
- Suggested file: `adr-{{ num }}-{{ var.decision | kebab | truncate(length=40) }}.md`
- Words in title: {{ var.decision | wordcount }}

## Context

## Decision

## Consequences
{% for kind in ["Positive", "Negative", "Neutral"] %}
### {{ kind }}
- 
{% endfor %}
