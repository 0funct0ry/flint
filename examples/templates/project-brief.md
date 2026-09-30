---
status: proposed
---
# {{ regexseq(pattern="PRJ-\d{3}") }} · {{ var.name }}

Slug: `{{ var.name | slugify }}` · Priority: **{{ var.priority | upper }}**
{% if var.priority == "High" %}
> ⚠ High priority: needs a named sponsor before kickoff.
{% elif var.priority == "Low" %}
> Low priority: schedule only if capacity remains.
{% endif %}
## Goal

## Timeline
{% set total = var.weeks | int + 1 %}
{% for w in range(start=1, end=total) %}
{% set days = (w - 1) * 7 -%}
- Week {{ w }} (starts {{ date(offset="+" ~ days ~ "d") }}): 
{%- endfor %}

## Risks
- 
