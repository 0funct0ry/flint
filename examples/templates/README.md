# Example templates

Ten ready-to-use Flint templates. Copy any of them into a workspace's `.flint/templates/` folder.

Each template reads its inputs from `var.<name>` (for example `{{ var.project }}`). The tables below
list every variable, its type, whether it is required, its default, and the allowed values.

> **Declare the variables in Flint before using a template.** Flint only exposes a variable to a
> template once it is declared for that template (Templates screen → *Edit template variables…*).
> An undeclared `var.<name>` is a render error, so the note is created with the template text
> unchanged and a warning. The front matter that used to declare these was removed from the files;
> re-declare the variables listed below.

## `adr.md`

| Variable   | Type   | Required | Default    | Allowed values                       |
|------------|--------|----------|------------|--------------------------------------|
| `decision` | text   | yes      | —          | any text                             |
| `status`   | choice | no       | `proposed` | `proposed`, `accepted`, `superseded` |

## `book-notes.md`

| Variable   | Type | Required | Default | Allowed values |
|------------|------|----------|---------|----------------|
| `book`     | text | yes      | —       | any text       |
| `author`   | text | no       | —       | any text       |
| `chapters` | text | no       | `8`     | any text       |

## `bug-report.md`

| Variable   | Type   | Required | Default | Allowed values               |
|------------|--------|----------|---------|------------------------------|
| `summary`  | text   | yes      | —       | any text                     |
| `severity` | choice | no       | `minor` | `minor`, `major`, `critical` |

## `daily-journal.md`

| Variable | Type   | Required | Default | Allowed values           |
|----------|--------|----------|---------|--------------------------|
| `mood`   | choice | no       | `Okay`  | `Great`, `Okay`, `Rough` |
| `focus`  | text   | no       | —       | any text                 |

## `meeting-notes.md`

| Variable    | Type | Required | Default | Allowed values |
|-------------|------|----------|---------|----------------|
| `topic`     | text | yes      | —       | any text       |
| `attendees` | text | no       | —       | any text       |

## `project-brief.md`

| Variable   | Type   | Required | Default  | Allowed values          |
|------------|--------|----------|----------|-------------------------|
| `name`     | text   | yes      | —        | any text                |
| `priority` | choice | no       | `Medium` | `Low`, `Medium`, `High` |
| `weeks`    | text   | no       | `4`      | any text                |

## `recipe.md`

| Variable   | Type | Required | Default | Allowed values |
|------------|------|----------|---------|----------------|
| `dish`     | text | yes      | —       | any text       |
| `servings` | text | no       | `4`     | any text       |

## `release-notes.md`

| Variable   | Type | Required | Default | Allowed values |
|------------|------|----------|---------|----------------|
| `codename` | text | no       | —       | any text       |

## `sprint-planning.md`

| Variable | Type | Required | Default | Allowed values |
|----------|------|----------|---------|----------------|
| `goal`   | text | yes      | —       | any text       |

## `weekly-review.md`

| Variable | Type | Required | Default | Allowed values |
|----------|------|----------|---------|----------------|
| `theme`  | text | no       | —       | any text       |

