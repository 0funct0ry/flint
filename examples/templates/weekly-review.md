# Week review · {{ isoweek() }} {{ date(fmt="YYYY") }}
{# Loop + string concatenation to build date offsets #}
{% if var.theme %}Theme: **{{ var.theme }}**{% endif %}

## The week ahead
{% for i in range(end=7) %}
- {{ weekday(offset="+" ~ i ~ "d") }} {{ date(offset="+" ~ i ~ "d", fmt="MM/DD") }}: 
{%- endfor %}

## Wins
- 

## Lessons
- 

## Next week's commitments
{% for n in range(start=1, end=4) %}
- [ ] Commitment {{ n }}
{%- endfor %}
