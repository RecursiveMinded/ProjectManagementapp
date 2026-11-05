// The built-in knowledge base. Each article is short Markdown:
// "## " subheadings, "- " bullets, "1. " steps, "> " tips, **bold**, `keys`, and [[article-id]] links.
// The Help page searches these, and Export user guide prints them all as one document.

export const TOPICS = [
  ['start', 'Getting started'],
  ['boards', 'Boards, groups and items'],
  ['columns', 'Columns and formulas'],
  ['views', 'Views'],
  ['auto', 'Automations'],
  ['dash', 'Dashboards and reports'],
  ['customers', 'Customers'],
  ['calls', 'Calls and meetings'],
  ['capture', 'Quick capture and AI'],
  ['data', 'Import, export and backups'],
  ['personal', 'My work, calendar and inbox'],
  ['settings', 'Settings and shortcuts'],
];

export const ARTICLES = [
  // Getting started
  { id: 'welcome', topic: 'start', title: 'What Boardenda is', keys: 'overview intro about local offline', body: `
Boardenda is a work management app that runs entirely on this PC. There is no account and no server: everything is saved in one data file on your computer, backed up every day.

## How it is organised
- **Workspaces** hold boards and docs. Use them for a department, a customer or a big project.
- **Boards** are lists of work. Each board has **groups** (sections, such as "This week" or "Done") and **items** (the rows).
- **Columns** describe each item: status, owner, dates, numbers, files and more.
- **Views** show the same board as a table, a kanban, a Gantt timeline, a calendar, a chart and more.
- **Dashboards** pull numbers and lists from several boards onto one page.

> New here? Open the sample workspace from Home to explore a filled-in board before you build your own.` },
  { id: 'first-board', topic: 'start', title: 'Create your first board', keys: 'new board template blank start create', body: `
1. Click **+** next to **Workspaces** in the sidebar, or press \`Ctrl+Shift+B\`.
2. Pick a template (project plan, team tasks, sales pipeline, bug tracker, content calendar) or **Blank board**.
3. Name the board and choose its workspace, then click **Create**.

You can also start from a file: choose **Import a file…** to build a board from an Excel sheet, CSV, Word document, PDF or a picture. See [[import]].

## Make it yours
- Rename groups and columns by clicking their titles.
- Add a column with the **+** at the right end of the column headers. See [[column-types]].
- Save the finished layout as your own template from the board's **⋯** menu, **Save as template…**. See [[templates]].` },
  { id: 'navigate', topic: 'start', title: 'Find your way around', keys: 'sidebar navigation search palette favorites folders', body: `
- The **sidebar** lists Home, My work, Calendar, Customers, Calls and meetings, Dependencies, Portfolio, Timesheets, Inbox and Help, then your workspaces, boards, docs and dashboards.
- **Search** (\`Ctrl+K\`) finds items, updates, boards and docs, and runs commands such as "Go to Calendar". It also finds help articles.
- Star a board or dashboard to pin it under **Favorites**.
- Right-click a workspace to rename it, add a folder or a doc. Collapse workspaces you are not using.
- Press \`?\` anywhere for the list of keyboard shortcuts. See [[shortcuts]].` },
  { id: 'updates-app', topic: 'start', title: 'Get updates', keys: 'update version upgrade install new version restart', body: `
Installed copies check for a new version every hour and download it in the background.

- When the button at the bottom of the sidebar says **Restart to update**, click it to install.
- Click **Check for updates** to check right away. The version you have is shown beside it.
- The portable exe does not update itself. Install with the Setup exe to get updates.

> If a new version does not appear after you close the window, Boardenda may still be running in the tray. Use **Check for updates**, or right-click the tray icon and choose **Quit**.` },

  // Boards
  { id: 'items', topic: 'boards', title: 'Add, edit and move items', keys: 'item row task new duplicate drag reorder rename', body: `
- Click **New item** at the top of a board (or press \`n\`) to add an item to the first group. Type in the empty row at the bottom of any group to add one there.
- Click an item's name to rename it. Click a cell to set its value.
- Drag items by their handle to reorder them or move them to another group.
- Click **Open** on a row to open the item panel with its updates, details, subitems, files, calls and activity log.
- The item panel's **⋯** menu has Duplicate, Repeat…, Save as item template…, Move to another board…, Archive and Delete.` },
  { id: 'groups', topic: 'boards', title: 'Groups', keys: 'group section collapse colour summary', body: `
Groups split a board into sections, for example by week, phase or stage.

- Use the arrow next to **New item** and choose **New group of items**.
- Click a group's title to rename it, and its colour dot to recolour it. Click the arrow to collapse it.
- The group menu has Add item at top, Add group below, Duplicate group, Move up, Move down, Archive group and Delete group.
- The bottom row of each group summarises its columns: a status bar, number totals and date ranges.` },
  { id: 'subitems', topic: 'boards', title: 'Subitems', keys: 'subitem child checklist breakdown', body: `
Break an item into smaller steps with subitems. Each subitem has its own columns.

1. Open the item and go to the **Subitems** tab, or click the subitem count in the table.
2. Type a name and press Enter.
3. Set its owner, status or dates like any item.

The **Subitem count** column shows how many are done, and the automation "When all subitems are done" can close the parent for you.` },
  { id: 'bulk', topic: 'boards', title: 'Change many items at once', keys: 'bulk select multiple batch move archive delete', body: `
1. Tick the checkboxes at the left of the rows (Shift-click selects a range).
2. A bar appears at the bottom of the board.
3. Choose **Set a value**, **Move**, **Duplicate**, **Archive** or **Delete**.

Deleted items go to the trash for 30 days, and \`Ctrl+Z\` undoes the change. See [[trash]].` },
  { id: 'updates-feed', topic: 'boards', title: 'Updates, mentions and files on an item', keys: 'update comment mention reply pin file attachment activity', body: `
- The **Updates** tab is a feed for notes about the item. Type @ and a name to mention someone; they get it in their Inbox.
- Reply to an update, pin the important ones to the top, and edit or delete your own.
- The **Files** tab holds attachments. Drop files onto it; open, save a copy, or show them in their folder.
- The **Activity log** tab shows every change to the item: who changed what, and when.` },
  { id: 'recurring', topic: 'boards', title: 'Repeat an item on a schedule', keys: 'recurring repeat schedule daily weekly monthly routine', body: `
1. Open the item and choose **⋯ › Repeat…**.
2. Pick every N days, weeks (on chosen weekdays) or months, and when to start.
3. Click **Save**.

Each new copy gets its dates moved forward, and its status, checkboxes and timers reset. A ↻ chip at the top of the item shows the schedule and the next date; click it to change or stop it.` },
  { id: 'item-templates', topic: 'boards', title: 'Item templates', keys: 'item template reuse checklist copy', body: `
Save an item you add often, with its values and subitems, and add copies in one click.

1. Open the item and choose **⋯ › Save as item template…**.
2. To use it, click the arrow next to **New item** and pick it under **From an item template**.

Remove templates you no longer need with **Delete an item template…** in the same menu.` },
  { id: 'templates', topic: 'boards', title: 'Board templates', keys: 'board template save reuse share file', body: `
- Start boards from the built-in templates in **New board**.
- Save any board as your own template from the board's **⋯ › Save as template…**, with or without its items.
- Export a template as a file to use on another PC, and bring one in with **Import template…** in **New board**.` },
  { id: 'dependencies', topic: 'boards', title: 'Dependencies and teams', keys: 'dependency blocked waiting team predecessor lag critical', body: `
## Item dependencies
Add a **Dependency** column and pick the items this one depends on. Choose finish to start, start to start, finish to finish or start to finish, with an optional lag.

When a date moves, Boardenda can move the items that depend on it:
- **Flexible** pushes them later only when they would overlap.
- **Strict** keeps the gap the same.
- **None** never moves them.

## Teams
Group people into teams in **Settings › People & teams**, and add outside teams such as vendors or other departments. A **Team** column records which team owns an item or which teams it is waiting on.

The **Dependencies** page shows who is waiting on whom across every board, as a team-by-team matrix and a list marked blocked, at risk, waiting or on track. It is a record only; nobody is contacted.` },

  // Columns
  { id: 'column-types', topic: 'columns', title: 'Column types', keys: 'column type add status people date number dropdown tags', body: `
Add a column with the **+** at the end of the column headers. Boardenda has 37 types:

- **Basic:** text, long text, numbers (with a unit and a summary), checkbox, rating, vote.
- **Labels and people:** status, priority, dropdown, tags, people, team.
- **Dates and time:** date, timeline, week, hour, world clock, time tracking.
- **Contact and place:** link, email, phone, location, country, colour.
- **Docs and files:** doc (a rich doc for each item), files.
- **Links between items:** connect boards, mirror, dependency.
- **Calculated:** formula, progress, auto number, item ID, creation log, last updated, subitem count.
- **Button:** runs an automation when clicked.

Click a column title for its menu: Settings, Rename, sort, group or filter by it, hide it in this view, move it, duplicate or delete it.` },
  { id: 'status-labels', topic: 'columns', title: 'Edit status and dropdown labels', keys: 'status labels colours edit options priority', body: `
1. Click any status cell.
2. Click **Edit labels**.
3. Rename labels, change their colours, add new ones or remove unused ones.

Mark which label means "done" in the column's **Settings** so progress, My work and dashboards count it correctly.` },
  { id: 'formulas', topic: 'columns', title: 'Formulas', keys: 'formula calculate function expression if sum date workdays', body: `
A **Formula** column calculates a value from other columns, like a spreadsheet.

- Refer to columns by name in braces: \`{Budget} - {Spent}\`.
- For a timeline use \`{Timeline#Start}\` and \`{Timeline#End}\`.
- About 50 functions are available, including IF, AND, OR, ROUND, SUM, CONCATENATE, DAYS, WORKDAYS, ADD_DAYS, TODAY and FORMAT_DATE.
- Mistakes are shown as you type, before you save.

Example: \`IF({Status} = "Done", "✓", WORKDAYS(TODAY(), {Due}) & " days left")\`.` },
  { id: 'connect-mirror', topic: 'columns', title: 'Connect boards and mirror columns', keys: 'connect link board mirror lookup rollup sum relate', body: `
- A **Connect boards** column links an item to items on another board, such as a deal to its customer.
- A **Mirror** column then shows a value from the linked items: list them, or sum, average, min, max, count, earliest or latest.

Example: on a Projects board, connect each project to its tasks, then mirror the tasks' hours with **Sum**.` },
  { id: 'time-tracking', topic: 'columns', title: 'Track time', keys: 'time tracking timer hours timesheet log', body: `
Add a **Time tracking** column and click ▶ to start a timer on an item, and again to stop it. You can also log time by hand.

All tracked time shows on the **Timesheets** page by person and week. See [[timesheets]].` },
  { id: 'item-docs', topic: 'columns', title: 'Workdocs and the Doc column', keys: 'doc document notes write rich text page', body: `
- Add a doc to a workspace by right-clicking the workspace and choosing **New doc here**.
- Docs support headings, lists, checklists, quotes, code, links and highlights, and save as you type.
- Shortcuts: type \`#\` for a heading, \`-\` for a list and \`[]\` for a checklist. Ctrl-click opens a link.
- A **Doc** column gives each item its own doc, opened beside the board.
- **Print or PDF** saves a doc as a PDF.` },

  // Views
  { id: 'views', topic: 'views', title: 'Board views', keys: 'view table kanban timeline gantt calendar chart workload form files', body: `
Click **Add view** above the board to see the same items another way. Each board can keep as many views as you like, each with its own filters and sort.

- **Table:** the main grid.
- **Kanban:** cards in lanes by status, person or dropdown. Drag a card to change it.
- **Timeline (Gantt):** bars by date. See [[gantt]].
- **Calendar:** items by date, drag to move.
- **Chart:** bars, columns, pie or donut.
- **Workload:** each person's load by week against their capacity.
- **Form:** a form whose submissions become items.
- **Files:** a gallery of every file on the board.

Right-click a view tab to rename, duplicate, reset or delete it.` },
  { id: 'filter-sort', topic: 'views', title: 'Filter, sort, hide and group', keys: 'filter sort hide group by person search', body: `
The toolbar above the board changes the current view only:

- **Search this board** (\`/\`) narrows by text.
- **Person** shows items assigned to one person.
- **Filter** builds conditions joined by AND or OR.
- **Sort** orders by one or more columns.
- **Hide** chooses which columns this view shows.
- **Group by** groups the table by any column instead of by board groups.` },
  { id: 'colour-rules', topic: 'views', title: 'Colour rows by rules', keys: 'conditional formatting colour color highlight rule', body: `
Click **Colour** in the toolbar and add rules such as "Status is Stuck" or "Due date is overdue". Matching rows, kanban cards and Gantt bars are coloured. Rules belong to the view.` },
  { id: 'gantt', topic: 'views', title: 'Gantt timeline, critical path and baselines', keys: 'gantt timeline critical path baseline milestone slip schedule', body: `
- Zoom by day, week or month. Drag a bar to move it, or its ends to change its length.
- Dependency arrows connect linked items.
- **Critical path** highlights the chain of linked items that sets the finish date, and shows each item's slack.
- **Baselines:** save a snapshot of the plan. The original dates then show under each bar, with how many days each item has slipped.
- **Milestones:** pick a checkbox column, and ticked items show as diamonds.` },
  { id: 'print-board', topic: 'views', title: 'Print or save a board as PDF', keys: 'print pdf export view page', body: `
Press \`Ctrl+P\`, or choose **⋯ › Print or save as PDF** on the board. The current view is saved, with its filters, as a PDF you can send or print.` },

  // Automations
  { id: 'automations', topic: 'auto', title: 'Automate routine steps', keys: 'automation rule when then trigger action recipe', body: `
Automations are recipes: **When** something happens, **if** a condition holds, **then** do something.

1. Click **Automate** at the top of a board.
2. Pick a recipe from the gallery, or build your own.
3. Fill in the blanks and click **Save automation**.

## Triggers
Status or another column changes, an item is created, a person is assigned, a date arrives (with an offset), every day, weekday, week or month, a button is clicked, an update is posted, all subitems are done, and more.

## Actions
Set or clear values, move to a group or board, assign people, create items or subitems, notify someone, post an update, start or stop timers, and push dates.

> Time-based automations run while Boardenda is in the tray, and catch up on one missed day if the PC was off.` },
  { id: 'button-column', topic: 'auto', title: 'Button column', keys: 'button click run automation', body: `
Add a **Button** column, then add an automation that starts with "When a button is clicked" from the **Automate** menu. Clicking the button on a row runs it for that item.` },

  // Dashboards
  { id: 'dashboards', topic: 'dash', title: 'Dashboards', keys: 'dashboard widget chart numbers battery report overview', body: `
1. Click **+** next to **Dashboards** in the sidebar.
2. Choose the boards it covers.
3. Click **Add widget**.

Widgets: numbers, battery (the mix of statuses), chart, workload, item list, table, calendar, timeline, team ownership (who owns what and who is waited on), countdown and notes. Each widget can be small, medium or full width.` },
  { id: 'portfolio', topic: 'dash', title: 'Portfolio', keys: 'portfolio projects health status overview all boards', body: `
The **Portfolio** page lists every board with its owner, progress, dates, overdue and blocked counts, and health. Health is worked out from the board automatically, or you can set it by hand and add a status note.` },
  { id: 'timesheets', topic: 'dash', title: 'Timesheets', keys: 'timesheet hours time week person export csv', body: `
The **Timesheets** page totals time from every Time tracking column by person and week. Add time by hand for work that isn't tracked, and export to CSV for payroll or billing.` },

  // Customers
  { id: 'customers', topic: 'customers', title: 'The customer directory', keys: 'customer account client directory profile company crm', body: `
**Customers** (\`g u\`) is one list of every account you work with. Each customer has a profile with:
- Details: account number, industry, main phone and email, website, address, account owner and tags.
- **Contacts:** names, job titles, emails, phones and mobiles. One is the main contact shown in the list.
- **Devices:** equipment at the customer, with type, model, serial number, location, status and install date.
- **Notes:** rich notes for background, preferences and history.
- **Tasks:** every item assigned to the customer on any board.
- **Calls:** every call and meeting with them.
- **Files:** contracts, site photos, configs and manuals.

Search finds a customer by name, contact, email, phone or device serial number. **Copy card** puts the profile on the clipboard for an email.` },
  { id: 'new-customer', topic: 'customers', title: 'Add a customer', keys: 'new customer add account create contact', body: `
1. Go to **Customers** and click **New customer**. (To fill it in from an email, see [[paste-customer]].)
2. Enter the name, status (prospect, active, on hold or former) and, if you like, the main contact.
3. Click **Create customer**. The profile opens so you can add more contacts, devices and notes.

Customers are also added for you when you type a new name in a Customer column, log a call with a new customer, or import a sheet with a Customer column.` },
  { id: 'paste-customer', topic: 'customers', title: 'Add a customer from an email or signature', keys: 'paste email signature copy create customer contact auto fill outlook', body: `
1. Go to **Customers**. The **Paste an email or signature** box is at the top (click the button of that name if you closed it).
2. Copy an email, a whole thread, or just someone's signature, and paste it into the box. It is read straight away.
3. Check what was picked out: the company, website, address, and each person's name, title, email, phone and mobile. Fix anything, untick people you don't want, and choose the main contact.
4. Click **Create customer**. The new profile opens.

If the company is already in Customers (by name, or by the email domain), you can **Add contacts** to it instead of making a duplicate. Tick **Keep the pasted text in the customer's notes** to save the email too.

> The built-in reader works offline. If an AI model is set up in **Settings › AI** (Ollama, a local server or Claude), it is used for better results. See [[ai-settings]].` },
  { id: 'import-customers', topic: 'customers', title: 'Import customers', keys: 'import customers excel csv vcard vcf outlook contacts list spreadsheet', body: `
1. Go to **Customers** and click **Import**, then **Import customers…**.
2. Choose an Excel (.xlsx), CSV or vCard (.vcf) file. Outlook and most CRMs can export one of these.
3. In the preview, choose what each column holds: customer name, account number, status, phone, website, address, tags, notes, contact name (or first and last name), title, email, phone and mobile, and device name, model, serial number and location.
4. Click **Import**.

Rows with the same customer name add more contacts or devices to that customer. Customers already in Boardenda are updated rather than duplicated, and contacts and devices are matched by email or serial number.

For a ready-made layout, click **Import › Download customer import sheet**. Its EXAMPLE rows are skipped on import.` },
  { id: 'assign-customer', topic: 'customers', title: 'Assign a customer to a task', keys: 'assign customer task item column map link account', body: `
- Add a **Customer** column to a board (the **+** at the end of the column headers), then click a cell and pick the customer. Type a new name to add it to the directory.
- Or open the item and choose **⋯ › Assign customer…**. The board gets a Customer column if it doesn't have one.
- Click a customer in a cell to open their profile. The profile's **Tasks** tab lists everything assigned to them.
- Filter, sort or **Group by** the Customer column to see work per account. In an import, a column headed Customer, Client or Account becomes a Customer column.` },
  { id: 'devices', topic: 'customers', title: 'Track customer devices', keys: 'device equipment serial model asset terminal hardware install repair', body: `
Open a customer and go to the **Devices** tab, then click **Add device**. Record the name, type, model, serial number, location, status (in service, pending install, needs repair, retired), install date and notes.

Click a device to edit it. Search on the Customers page or with \`Ctrl+K\` finds a customer from a serial number.` },

  // Calls
  { id: 'calls', topic: 'calls', title: 'Log a customer call', keys: 'call customer log phone meeting agenda notes recap', body: `
1. Go to **Calls and meetings** (\`g l\`) and click **Log a call** or **New meeting**. You can also open the item the call is about and use its **Calls** tab.
2. Set the date, time, length and where (phone, link or room), the customer, and the deal or item it is about.
3. Add who was there: **our team** (people in Boardenda) and **their side** (outside contacts with company, email and phone).
4. Fill in the **agenda** before the call and the **notes** and **recap** after it. Attach files.

**Copy summary** puts the whole record on the clipboard, ready to paste into an email.` },
  { id: 'meeting-actions', topic: 'calls', title: 'Action items and the next action', keys: 'action item owner due follow up next action task', body: `
Add action items to any call or meeting, each with an owner and a due date.

- Use **Add as an item on…** to put an action on a board. It becomes an item there with the owner and date filled in, so it shows in that person's My work.
- Ticking the action off, or finishing the item, closes it.
- The next open action shows on the item the call is about: a phone tag in the table, and the **Calls** tab in the item panel.` },
  { id: 'recurring-meetings', topic: 'calls', title: 'Recurring meetings', keys: 'recurring meeting series weekly standup repeat', body: `
When you create a meeting, choose how it repeats: daily, weekdays, weekly, every 2 weeks or monthly. Meetings are scheduled about two months ahead.

Every meeting in the series keeps its own notes, recap, actions and files. From a meeting's menu you can:
- **Use this set-up for later meetings** to copy its time, people and agenda forward.
- **Stop repeating after this one.**
- **Log a follow-up call.**
- **Delete this meeting** or **Delete this and later ones**.

Calls and meetings show on the Calendar, where you can drag them, and in the .ics export.` },

  // Capture
  { id: 'quick-capture', topic: 'capture', title: 'Quick capture: turn notes into records', keys: 'quick capture ai notes paste drop ctrl j auto create', body: `
Press \`Ctrl+J\` or click **Quick capture** in the sidebar.

1. Paste rough notes, or drop a file: meeting notes, a to-do list, an email, a Word file, a PDF or a photo of handwriting.
2. Click **Read notes**. Boardenda proposes records: calls and meetings, action items with owners and due dates, new items on the right board and group with columns filled in, and updates on existing items.
3. Check each card. Anything it isn't sure about is highlighted with a question. Change the board, group or fields, or click **Looks right**.
4. Click **Create**. Nothing is created until every highlighted card is confirmed.` },
  { id: 'ai-settings', topic: 'capture', title: 'Choose the AI that reads your notes', keys: 'ai ollama llama local model claude anthropic api key lm studio settings', body: `
Go to **Settings › AI**.

- **Automatic** (the default) uses Claude if an API key is saved, otherwise Ollama on this PC if it is running, otherwise the built-in reader.
- **Ollama on this PC** uses the same local models as LOA Command Center, such as Llama or Gemma. Nothing leaves the PC.
- **Other local server** works with LM Studio or another OpenAI-compatible server on this PC or your network.
- **Claude (online)** needs an Anthropic API key, and can also read photos.
- **Off** always uses the built-in reader, which works offline with no model.

Click **Test connection** to check that Boardenda can reach the model.

> Local models can take up to a minute on a long set of notes.` },

  // Data
  { id: 'import', topic: 'data', title: 'Import from Excel, Word, PDF or a picture', keys: 'import excel csv word pdf picture ocr photo scan file', body: `
Bring items in from Excel, CSV, Word, PDF, plain text or a picture.

- To a new board: **New board › Import a file…**.
- To an existing board: the arrow next to **New item**, then **Import items…**.

Every import opens a preview first. Fix any cell, rename columns, choose each column's type (or which column holds names, groups or parent items), and leave rows out before anything is created.

- Pictures and photos of printed lists are read with OCR on this PC.
- Word tables are used directly; Word lists become items, with headings as groups.

> For the most accurate import, start from the blank import sheet. See [[import-sheet]].` },
  { id: 'import-sheet', topic: 'data', title: 'Blank import sheet', keys: 'import sheet template excel example rows blank', body: `
Download a blank Excel sheet with the right headers, drop-down lists and EXAMPLE rows:
- From **New board › Blank import sheet**, or
- From the arrow next to **New item** on a board, **Download import sheet**, which matches that board's columns.

Fill in your rows. Rows marked EXAMPLE are skipped on import. A **Subitem of** column makes subitems.` },
  { id: 'export', topic: 'data', title: 'Export a board', keys: 'export excel csv json board file share', body: `
From the board's **⋯** menu:
- **Export to Excel** or **Export to CSV**.
- **Save as board file** makes a portable file you can import on another PC.
- **Print or save as PDF**.

The Calendar can also export dated work as an .ics file for Outlook or Google Calendar.` },
  { id: 'backups', topic: 'data', title: 'Backups and restore', keys: 'backup restore data folder move safe', body: `
Boardenda backs up your data every day. In **Settings › Data & backups** you can:
- **Back up now**.
- **Restore** any backup. A backup of the current data is taken first.
- Move the data folder, for example to a synced drive.

Data is kept in \`%LOCALAPPDATA%\\Boardenda\` unless you move it.` },
  { id: 'trash', topic: 'data', title: 'Undo, archive and trash', keys: 'undo trash deleted restore archive recover', body: `
- \`Ctrl+Z\`, or **Undo** on the notice after a delete, reverses recent changes.
- Archived boards, groups and items are kept on the **Archive** page (\`g a\`), where you can restore them.
- Deleted boards, groups, columns, items and docs stay in the **Trash** for 30 days. Restore them, or delete them forever.` },

  // Personal
  { id: 'my-work', topic: 'personal', title: 'My work', keys: 'my work assigned overdue today this week', body: `
**My work** (\`g m\`) collects everything assigned to you across all boards, sorted into overdue, today, this week and later. Click an item to open it.` },
  { id: 'calendar', topic: 'personal', title: 'Calendar', keys: 'calendar month week agenda ics outlook google reschedule', body: `
The **Calendar** (\`g c\`) shows dated work, calls and meetings from every board.

- Switch between month, week and agenda.
- Drag to reschedule. Filter by person or board.
- Quick add creates an item on a day.
- Export to .ics for Outlook or Google Calendar.` },
  { id: 'inbox', topic: 'personal', title: 'Inbox and notifications', keys: 'inbox notification mention assigned digest windows alert', body: `
The **Inbox** (\`g i\`) holds mentions, assignments and automation notices. Windows notifications pop up for new ones.

In **Settings › Notifications** choose what notifies you, and turn on a daily or weekly digest of what is overdue and due today.` },

  // Settings
  { id: 'people', topic: 'settings', title: 'People and teams', keys: 'people person team capacity colour add user', body: `
In **Settings › People & teams**, add the people you assign work to, with their email, team, colour and weekly capacity. Capacity is used by the Workload view. Nobody is invited or contacted; people are a record for assigning work.` },
  { id: 'appearance', topic: 'settings', title: 'Appearance', keys: 'theme dark light compact density look', body: `
In **Settings › Appearance**, choose a light, dark or system theme, and comfortable or compact density.` },
  { id: 'shortcuts', topic: 'settings', title: 'Keyboard shortcuts', keys: 'keyboard shortcut keys hotkey', body: `
- \`Ctrl+K\` search and commands
- \`Ctrl+J\` Quick capture
- \`Ctrl+Z\` undo
- \`Ctrl+P\` print or save as PDF
- \`Ctrl+Shift+B\` new board
- \`n\` new item, \`/\` search this board
- \`g h\` Home, \`g m\` My work, \`g c\` Calendar, \`g u\` Customers, \`g l\` Calls and meetings, \`g d\` Dependencies, \`g p\` Portfolio, \`g t\` Timesheets, \`g i\` Inbox, \`g a\` Archive, \`g s\` Settings
- \`F1\` Help, \`?\` this list in the app
- \`Esc\` closes a panel or dialog` },
  { id: 'smartscreen', topic: 'settings', title: 'Windows blocks the installer', keys: 'smartscreen install blocked unsigned windows protected unblock', body: `
Boardenda isn't code-signed yet, so Windows SmartScreen may block the Setup file. If there is no **Run anyway** option, open PowerShell and run:

\`Unblock-File "$env:USERPROFILE\\Downloads\\Boardenda-Setup-<version>.exe"\`

Then run the Setup file again. After that, updates install by themselves.` },
];
