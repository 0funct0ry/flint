# Release {{ nestseq(levels=3, bump=3) }}{% if var.codename %} "{{ var.codename | titlecase }}"{% endif %}

Released {{ date() }} ({{ weekday() }}, {{ quarter() }}) · build `{{ regex(pattern="[a-f0-9]{8}") }}`
Written in `{{ parentfolder() | default(value="root") }}` · [changelog index]({{ relativepath(to="CHANGELOG.md") }})

{% for section in ["Added", "Changed", "Fixed", "Security"] %}
## {{ section }}
- 

{% endfor %}
## Upgrade notes
Previous release date: {{ date(offset="-2w") }}
