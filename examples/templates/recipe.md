# {{ var.dish | titlecase }}

Serves {{ var.servings }} · saved {{ date(fmt="DD/MM/YYYY") }}
{% set n = var.servings | int -%}
{% if n > 6 %}_Large batch: use the big pot._{% elif n <= 2 %}_Small batch: halve the pan size._{% endif %}

## Ingredients (per serving × {{ n }})
{% for item in ["Main ingredient", "Aromatics", "Fat", "Seasoning"] %}
- {{ item }}: {{ n }} × 
{%- endfor %}

## Method
{% for step in range(start=1, end=6) %}
{{ step }}. 
{%- endfor %}

## Rating
{% for s in range(end=5) %}☆{% endfor %}
