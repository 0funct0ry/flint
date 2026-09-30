# {{ var.topic | titlecase }}

{{ date(fmt="YYYY-MM-DD") }} {{ time() }} · {{ workspacename() }}

## Attendees
{% if var.attendees %}{% for p in var.attendees | split(pat=",") %}
- {{ p | trim | capitalize }} ({{ p | trim | initials }})
{%- endfor %}{% else %}
- _none listed_
{% endif %}

## Agenda
1. 

## Decisions

## Action items
- [ ] @owner — due {{ date(offset="+1w") }}

Follow-up meeting: {{ date(offset="+2w") }} ({{ weekday(offset="+2w") }})
