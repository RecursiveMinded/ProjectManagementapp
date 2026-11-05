# Boardenda

Boardenda is a local-first work management app for Windows. It covers what teams use a hosted work OS for: boards, typed columns, several views of the same data, automations, dashboards and reminders. Everything runs on one PC with no account or server, and the data lives in a single SQLite file.

The feature set was mapped from the public help documentation of a leading hosted work management product. The code, names and visual design are original.

## Features

**Boards, groups and items**
- Workspaces hold boards, optionally in folders. Star boards and dashboards to pin them under Favorites.
- A board holds coloured, collapsible groups, and each group holds items.
- Items can have subitems with their own columns.
- Items and groups can be dragged to reorder or move them, and duplicated, archived, restored or deleted.
- Selecting several items brings up bulk actions: set a value, move, duplicate, archive or delete.
- Each item has an updates feed with replies, pins and @mentions, plus a files tab and a full activity log.

**36 column types**
- Basic values: text, long text, numbers (with unit and summary), checkbox, rating, vote.
- Labels, people and teams: status, priority, dropdown, tags, people, team.
- Dates and time: date, timeline, week, hour, world clock, time tracking.
- Contact and place: link, email, phone, location, country, colour.
- Files and links between items: files, connect boards, mirror (list, sum, average, min, max, count, earliest or latest), dependency.
- Calculated values: formula, progress, auto number, item ID, creation log, last updated, subitem count.
- Button, which runs an automation when clicked.

**Formulas**
- Spreadsheet-style syntax with `{Column}` references and `{Timeline#Start}` / `{Timeline#End}`.
- About 50 functions: logic, maths, text, and dates including `WORKDAYS`, `ADD_DAYS` and `FORMAT_DATE`.
- Errors are reported as you type.

**Dependencies**
- Teams: group people into teams, and add teams outside Boardenda (other departments, vendors). A **Team** column records which team owns an item, or which teams it is waiting on.
- The **Dependencies** page shows who is waiting on whom across every board. It has a team-by-team matrix and a list marked blocked, at risk, waiting or on track. It is a record only: nobody is contacted.
- Link types: finish to start, start to start, finish to finish and start to finish, with optional lag.
- Flexible mode pushes dependent items later only when they would overlap. Strict mode keeps the gap. "None" turns shifting off.

**Views**
- Table: group summaries, column resize and reorder, filters with AND/OR, multi-level sort, hidden columns, group by any column.
- Kanban: lanes by status, people or dropdown.
- Gantt timeline: day, week or month zoom, drag to move or resize, and dependency arrows.
  - Critical path: highlights the chain of linked items that sets the finish date, and shows each item's slack.
  - Baselines: save a snapshot of the plan, then see the original dates under each bar and how many days each item has slipped.
  - Milestones: mark items with a checkbox column and they show as diamonds.
- Conditional colouring: rules such as "Status is Stuck" colour rows, kanban cards and Gantt bars.
- Calendar, chart (bars, columns, pie or donut), and workload by person and week against capacity.
- Form: submissions become items.
- Files gallery.
- Each board can save any number of views.

**Automations**
- Built as "When … if … then …" recipes, either from a gallery or a custom builder.
- 13 triggers, including:
  - status or column changes, item created, person assigned;
  - a date arrives, with an offset;
  - every day, weekday, week or month;
  - a button is clicked, an update is posted, all subitems are done.
- 18 actions, including:
  - set or clear values, move to a group or board, assign;
  - create items or subitems, notify, post an update;
  - start or stop timers, push dates.
- Time-based automations run from the tray and catch up on one missed day.

**Dashboards**
- Combine widgets across boards: numbers, battery (status mix), chart, workload, list, timeline, countdown and notes.

**Personal**
- Home page.
- My work: overdue, today, this week and later, across all boards.
- Calendar: dated work from every board in month, week or agenda form, with drag to reschedule, person and board filters, quick add, and export to `.ics` for Outlook or Google Calendar.
- Inbox for mentions, assignments and automation notices.
- Ctrl+K search and command palette.
- Windows notifications and an optional daily digest.

**Data**
- Import from Excel or CSV. Column types are inferred and new groups are created from a "Group" column.
- Export to Excel or CSV, and to a portable `.board.json` board file.
- Daily automatic backups with one-click restore, and a movable data folder.
- Archive and restore, plus a 30-day trash for deleted boards, groups, columns and items.
- Undo: Ctrl+Z, or the Undo button on the notice after a delete, reverses recent changes made in the session.

**Templates**
- Blank, project plan, team tasks, sales pipeline, bug tracker and content calendar.
- Save any board as your own template, with or without its items, and start new boards from it.
- A sample workspace and dashboard you can explore on first launch.

## Install

Download `Boardenda-Setup-<version>.exe` from [Releases](../../releases) and run it. Installed copies update themselves from GitHub releases.

A portable exe is also published. It does not auto-update.

Data is kept in `%LOCALAPPDATA%\Boardenda`. You can change this in Settings → Data & backups.

## Develop

```bash
npm ci
npm start            # build the UI and run the desktop app
npm run dev:web      # same UI and API in a browser at http://127.0.0.1:5179
npm test             # core engine tests (node:test)
npm run test:ui      # Playwright smoke test of every screen (needs playwright + chromium)
npm run dist         # Windows installer and portable exe in release/
npm run icons        # redraw build/icon.png and build/icon.ico (needs Python + Pillow)
```

### Layout

| Path | What it holds |
| --- | --- |
| `src/core/` | Engine, shared by the desktop app and the dev server: `db.js` (sql.js SQLite, atomic saves), `store.js` (boards, items, values, dependencies, notifications), `columns.js` (column type registry), `formula.js` (parser and evaluator), `automations.js`, `dashboards.js`, `templates.js`, `io.js` (import and export), `api.js` (the API the UI calls) |
| `src/ui/` | Preact + htm interface, bundled by esbuild into `dist/ui` |
| `electron/` | Window, tray, scheduler, Windows notifications, native file dialogs, auto-update |
| `dev/server.js` | The same API over HTTP, for browser testing |
| `.github/workflows/build.yml` | Tests, builds the Windows installer, smoke-tests the packaged exe, and publishes a release when the version in `package.json` changes |

### Releasing

Bump `version` in `package.json` and push to `main`. CI builds, tests and publishes `v<version>`, and installed copies pick it up.
