# {{ var.book | titlecase }}

*{{ var.author | default(value="Unknown author") | titlecase }}* ({{ var.author | initials }}) · started {{ date() }}
Tag key: `{{ var.book | snake }}`

## One-line takeaway

## Chapter notes
{% set last = var.chapters | int + 1 %}
{% for c in range(start=1, end=last) %}
### Chapter {{ c | pad(width=2) }}
- 
{% endfor %}
## Quotes
> 

## Will I apply it?
Review on {{ date(offset="+1mo") }}.
