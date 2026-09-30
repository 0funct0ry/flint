# {{ weekday() }}, {{ date(fmt="DD MMM YYYY") | default(value="") }}

{{ quarter() }} · {{ isoweek() }} · [yesterday]({{ date(offset="-1d") }}.md) · [tomorrow]({{ date(offset="+1d") }}.md)

**Mood:** {{ var.mood }}
{% if var.focus %}**Focus today:** {{ var.focus }}{% else %}**Focus today:** _decide over coffee_{% endif %}
{% if var.mood == "Rough" %}
> Rough day ahead: pick one small win and stop there.
{% endif %}
## Top 3
{% for i in range(start=1, end=4) %}
{{ i }}. [ ] 
{%- endfor %}

## Notes

## Gratitude
- 
