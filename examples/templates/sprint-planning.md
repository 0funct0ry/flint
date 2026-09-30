# Sprint {{ nestseq(levels=2, bump=2) }} · {{ var.goal }}
{# nestseq's first level is the year-like major; bump=2 advances the sprint counter #}
Starts {{ date() }} ({{ isoweek() }}), demo {{ date(offset="+2w") }}

## Working days
{% for i in range(end=14) %}
{% set day = weekday(offset="+" ~ i ~ "d") -%}
{% if day not in ["Saturday", "Sunday"] -%}
- {{ day }} {{ date(offset="+" ~ i ~ "d", fmt="MM/DD") }}: 
{% endif -%}
{% endfor %}
## Backlog
- [ ] 

## Definition of done
- Reviewed, tested, documented
