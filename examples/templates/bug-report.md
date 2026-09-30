# {{ seq(prefix="BUG-", width=4, folder=true) }}: {{ var.summary }}

- Reported: {{ date() }} {{ time() }}
- Severity: **{{ var.severity }}**
- Trace ID: `{{ uuid() }}`
- Filed in: {{ folder | default(value="workspace root") }}
{% if var.severity == "critical" %}
> 🚨 Critical: page the on-call and link the incident channel.
{% endif %}
## Steps to reproduce
{% for i in range(start=1, end=4) %}
{{ i }}. 
{%- endfor %}

## Expected

## Actual

## Environment
- OS: 
- Version: 
