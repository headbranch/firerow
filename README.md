# firerow

[![npm](https://img.shields.io/npm/v/firerow)](https://www.npmjs.com/package/firerow)

Edit Firestore collections as CSV files: pull, edit in any spreadsheet or editor, push back.
Pushes are checked field by field for conflicts with other people's changes, and every push can
be undone.

```bash
firerow init                         # asks for your service-account key → firerow.config.json
firerow list                         # your collections, document counts, what you've pulled
firerow pull users                   # → collections/users/documents.csv
firerow pull users/alice             # or just one document (1 read)
# …edit the CSV…
firerow status                       # offline: what you've changed
firerow push users                   # check for conflicts, confirm, write
firerow log                          # recent pushes
firerow revert                       # undo the latest push
```

## Install

```bash
npm install -g firerow
```

This installs the `firerow` command. Requires Node.js 18 or later.

You'll also need a Firebase **service-account key** (Firebase console → Project settings →
Service accounts → Generate new private key). `firerow init` asks for its path. The key grants full
admin access to your project, so keep it out of version control (`init` adds it to `.gitignore`).

## Commands

Commands that take collections accept one or more paths, space- or comma-separated
(`users,staff`), including `*` patterns (`"users/*/orders"`). With none, they act on every
collection you've pulled (except `untrack`, which needs names).

| Command | What it does |
|---|---|
| `init` | Connects this folder to a Firebase project. Asks for the service-account JSON (the project id is read from it) and the database id, checks the connection, and adds the key and `.firerow/` to `.gitignore`. `-k <file>` / `-d <id>` skip the questions; `-f` overwrites an existing config. |
| `list [document]` (or `ls`) | Lists your Firestore collections — or a document's subcollections, e.g. `list users/alice` — with document counts, when you pulled each one, unpushed changes, and the subcollections you've pulled under it. Counting costs 1 read per 1,000 documents; `--no-count` skips it. |
| `pull [collections or documents]` | Downloads collections to CSV — or just specific documents (see [Pulling specific documents](#pulling-specific-documents)). Unpushed edits aren't lost: they're re-applied on top of the fresh data (see [Conflicts](#conflicts)). With nothing named it refreshes what you've pulled — it never fetches the whole database by accident. `--all` also pulls every top-level collection: it shows each one's document count (= reads) and asks first (`-y` skips that). Subcollections aren't discovered automatically; pull them with a pattern like `"users/*/orders"`. |
| `status [collections]` | Offline: what you've changed and what `push` would do. |
| `push [collections]` | Writes your changes to Firestore (see [How push works](#how-push-works)). |
| `edit [collections or documents]` | Edits several collections — or specific documents — in one temporary sheet (see [Bulk editing](#bulk-editing-across-collections)). |
| `resolve [collections]` | Goes through conflicts left by a merging `pull`, one keypress each: use the local value (your CSV), the remote one (Firestore's), or type your own (see [Conflicts](#conflicts)). `--local` / `--remote` decide them all at once. |
| `discard [collections or documents]` | Offline: throws away unpushed edits, restoring the CSVs to what was last pulled or pushed. Name documents (`discard users/alice`) to restore just those rows: an edited row is restored, a deleted one put back, a new one removed. Asks first (`-y` skips that). |
| `log` | Offline: lists recent pushes, newest first (see [Undoing a push](#undoing-a-push)). `--oneline` gives one line per push; `-n <count>` shows more than 20. |
| `revert [push]` | Undoes a push — by default the latest one that hasn't been undone (see [Undoing a push](#undoing-a-push)). |
| `untrack <collections>` | Offline: stops tracking collections and deletes their local CSVs; nothing in Firestore is touched (see [Subcollections](#subcollections)). `-r` includes subcollections; refuses while there are unpushed edits unless `-f`. |

`push` options:

| Option | |
|---|---|
| `-n, --dry-run` | Show the plan without writing anything. |
| `-y, --yes` | Skip the confirmation prompt. Never renames or deletes fields on its own. |
| `-f, --force` | Overwrite fields that someone else changed since you pulled. |
| `-p, --pull` | Re-pull the pushed collections afterwards (one read per document). |
| `--rename-fields` | Answer yes to "rename this field in Firestore?" (see [CSV format](#csv-format)). |
| `--delete-fields` | Answer yes to "delete this removed column's field?". |

## Pulling specific documents

```bash
firerow pull users/alice              # 1 read, instead of the whole collection
firerow pull users/alice,users/bob    # several
```

A path with an even number of parts is a document. Its row goes into the collection's usual
`documents.csv`, which then holds a **partial copy** of the collection; everything else — editing,
`status`, `push`, conflicts, merging — works the same.

- Pulling more documents adds rows; `pull users` switches to the whole collection. Pulling a
  document into a fully pulled collection just refreshes that row.
- Deleting a row only deletes that document — documents you never pulled are never touched.
- A new row whose `_id` already exists in Firestore (just not in your copy) is caught at push
  time, and you're told to pull that document first.
- A bare `pull` refreshes a partial copy's own documents, not the whole collection.
- `list` shows how many documents you have, e.g. `2 documents pulled 1 hour ago`.

## How `push` works

1. `pull` saves a snapshot of exactly what it pulled to `.firerow/snapshots/`.
2. `push` diffs your CSV against that snapshot **field by field** → creates, updates, deletes.
3. It re-reads *only the documents you touched* and does a three-way check: if someone else
   changed a field you also changed (or deleted/recreated a document), it stops and tells you.
   Remote changes to other fields are fine — only your changed fields are written.
4. Writes go in batches of up to 500 changes, each write with an `updateTime` precondition, so a
   change sneaking in between the check and the write fails instead of being overwritten. A push
   of up to 500 changes is all-or-nothing; a bigger one is sent as several batches, and if one
   fails, the earlier ones stay written (`firerow revert` can undo them).
5. It updates the CSV and snapshot locally from what it just read and wrote, without re-reading
   the collection — a push costs reads only for the documents you changed. Other people's changes
   to documents you didn't touch appear on your next `pull` (or use `push --pull`).
6. It records what it wrote, so `firerow revert` can undo it.

With several collections, everything is checked before anything is written: one combined plan,
one confirmation, and if any collection has a conflict, nothing is written anywhere.

## Conflicts

If `push` finds conflicts, it offers to merge for you (or run `firerow pull <collection>`).
Like `git pull`, that fetches the latest data and re-applies your unpushed edits on top:

- Edits that don't clash carry over; other people's changes come in.
- Fields changed on both sides are marked: `<<<<<<< local: 31 | remote: 35 >>>>>>>`. `status` and
  `push` refuse while markers remain. Run `firerow resolve` to go through them, one keypress each:

  ```
  age in users/alice   (1 of 3)
    local:   31
    remote:  35
    [l] use local   [r] use remote   [e] enter your own value   [s] skip   [q] quit
    [L] / [R]  use local / remote for all remaining
  ```

  Skipped conflicts (and the rest, after `q` or Ctrl+C) stay marked for next time; choices
  already made are kept. After a merge, `pull` (and `push`'s merge prompt) offers to do this
  right away. `resolve --local` or `--remote` settles them all without asking. You can also just
  replace a marked cell by hand; `resolve` skips cells you've already fixed.
- A document you edited but someone deleted keeps your row (pushing re-creates it).
- A document you deleted but someone edited comes back (delete the row again if you mean it).

To throw your unpushed edits away instead, use `firerow discard <collection>` (or
`firerow discard users/alice` for one document).

## Undoing a push

Every push is recorded in `.firerow/pushes/`: for each document it wrote, what it looked like
before and after. `firerow log` lists them, newest first:

```
7563bf6  Undid 76562d1 5 minutes ago (Oct 1, 10:21 AM)
  users               1 updated, 1 deleted
  users/alice/orders  1 updated

76562d1  Pushed 6 minutes ago (Oct 1, 10:20 AM) · undone by 7563bf6
  users               1 created, 1 updated
  users/alice/orders  1 updated
```

Each push has a short id, like a git commit, and lists how many documents it created, updated
and deleted in each collection. `firerow log --oneline` fits each push on one line.

`firerow revert` undoes the latest push, or name one: `firerow revert 76562d1` (any unique start of
the id works, like `firerow revert 7656`). Created documents are deleted, deleted ones re-created,
and updated fields put back. It re-reads those documents first (1 read each) and shows what it
will do before asking (`-y` skips that, `-n` shows the plan without writing).

- Someone else's changes to *other* fields of those documents are kept.
- If someone changed a document or field after your push, `revert` refuses and lists them, like
  `push` does; `-f` overwrites them anyway.
- A revert is recorded like a push, so it can be undone too: `firerow revert <its id>` redoes the
  original. Running `firerow revert` again goes back one more push, like an undo stack.
- Afterwards your CSVs are refreshed for just those documents, keeping any unpushed edits.
- A push that failed partway is recorded too; reverting it undoes only what was written.
- Only pushes made with this folder are recorded, and a push can only be reverted from the same
  Firebase project and database.

## Subcollections

The `collections/` folder mirrors your database: every collection is a folder holding its
`documents.csv`, and a document's subcollections are folders under its id.

```
collections/
  users/
    documents.csv          ← users
    alice/
      orders/
        documents.csv      ← users/alice/orders
      posts/
        documents.csv      ← users/alice/posts
    bob/
      orders/
        documents.csv      ← users/bob/orders
```

```bash
firerow list users/alice                 # what subcollections does this document have?
firerow pull users/alice/orders          # one of them
firerow pull "users/*/orders"            # every user's orders, each into its own folder
firerow push "users/*/orders"            # "*" works with every command
```

`*` is only a shortcut for "all of these folders" — the files are ordinary per-collection CSVs.
`pull` fetches them with a single collection-group query; the other commands use the folders
you've already pulled. You can also pass a tab-completed folder or file path, like
`collections/users/alice/orders`.

**Stop tracking a collection** with `firerow untrack users` (patterns work too:
`firerow untrack "users/*/orders"`). It deletes the local CSV, so a bare `pull`/`push`/`status` no
longer includes it. Nothing in Firestore is touched, and `firerow pull <collection>` brings it back.
Subcollections you've pulled stay tracked (it tells you which), like `pull users` doesn't fetch
them; `firerow untrack -r users` untracks `users` and everything under it. If a collection has
unpushed edits, `untrack` refuses until you push or discard them, or pass `-f`/`--force` to lose
them.

Deleting the folder yourself works too: what's in `collections/` is what's tracked. Deleting
`collections/users/` stops tracking `users` and everything pulled under it; deleting only
`collections/users/documents.csv` keeps its subcollections. Unlike `untrack`, nothing checks first:
unpushed edits in a deleted CSV are gone with it.

Deleting a document does not delete its subcollections (a Firestore rule); `push` lists any
that would be left behind before asking you to confirm.

## Bulk editing across collections

```bash
firerow edit "users/*/orders"            # every user's orders in one sheet
```

`edit` combines the matching collection CSVs into one temporary sheet, opens it, and waits.
Each row is identified by `_path`, e.g. `users/alice/orders/o1` (end it with `/` for a new
auto id). Sort, filter, find-and-replace, rename or remove columns, add or delete rows, save,
then press Enter (or `c` to cancel — no Enter needed): the sheet is checked, split back into each
collection's `documents.csv`, and deleted. If something's wrong — a bad value, an unknown
collection, an edited id — it tells you and waits for you to fix the sheet. The folders stay the
only copy of your data; review with `status` and send with `push` as usual (a column renamed or
removed across 40 collections is asked about once).

| Option | |
|---|---|
| `--app <program>` | Open the sheet with a specific program, e.g. `code`. |
| `--no-open` | Just create the sheet and print where it is. |
| `--no-wait` | Return straight away; finish later with `firerow edit --apply` or `--cancel`. |

- Takes any collections, or nothing for everything pulled. A single collection just opens its
  `documents.csv`.
- **Documents:** `firerow edit users/alice` (or several: `users/alice users/bob`) opens a
  sheet with just those rows — handy for one document in a big collection. Change values, clear
  cells, or add, remove and rename columns; it only affects those documents, and every other row
  is left alone. Rows can't be added or removed in a document sheet (do that in the collection's
  CSV). The documents need to be pulled first (`firerow pull users/alice` is enough).
- Only one sheet can be open at a time. While it's open, `pull`, `push` and `discard` leave its
  collections alone, and editing those CSVs directly makes `--apply` stop rather than overwrite.
- `_path` can't be changed to move a document to another collection.
- Offline: no Firestore reads until you `push`.

## CSV format

- The first column, `_id`, is the document id. A blank `_id` on a new row gets an auto id.
- Adding a row creates a document; removing a row deletes it.
- `_id` is read-only: an edited id (a new row identical to a removed one) is rejected, since
  Firestore can't rename documents and subcollections/references would be left behind.
- **Empty cell = field not present.** Write `""` for an empty string.
- **Deleting a field:** clear its cell to delete it from that document. Remove the whole column
  to delete it from every document — `push` asks first (`--delete-fields` answers yes); saying
  no leaves the field alone.
- **Renaming a field:** rename the column header (same values, new name). `push` asks whether to
  rename the field in Firestore — write the new one and delete the old one in the same batch
  (`--rename-fields` answers yes); saying no just adds the new field and keeps the old one.
- Every column's type is in its header: `name:string`, `age:number`, `active:boolean`,
  `createdAt:timestamp` (ISO 8601), `home:geopoint` (`lat, lng`), `owner:reference` (`users/abc`),
  `data:bytes` (base64), `tags:array` / `address:map` (JSON), `x:null`.
  `null` is accepted in any non-string column. Geopoints must be within ±90 / ±180, and references
  must point to a document (an even number of path segments); both are checked before anything
  is pushed. Add a new field by adding a column with a type, like the others.
- A new column *without* a type in its header works like `:any`: each value is saved as what it
  clearly is — true/false (any case, so Excel's `TRUE` works) → boolean, plain numbers → number,
  ISO dates (`2024-05-01`, `2024-05-01T12:00:00Z`) → timestamp, JSON objects/arrays → map/array,
  `null` → null, anything else → text as typed (`0123` and `+8490…` stay text). `status` and `push`
  warn that the type isn't set and show what was guessed, pointing out values that differ from
  the rest. After a push the header gets the real type (`:any` if the values were mixed).
- `:any` columns (fields with mixed types in Firestore) read each value the same way as a column
  with no type: `TRUE` is a boolean, `42` a number, `2024-05-01` a date, `hello` text. Text that
  would otherwise be misread is shown in quotes (`"42"`, `"true"`) so it stays text. Rarer types use
  tagged JSON: `{"$ref": "users/a"}`, `{"$geo": [lat, lng]}`, `{"$bytes": "…"}`.

**Excel caveat:** Excel may rewrite values on save (drops leading zeros, rounds long numbers,
reformats dates) — those show up as changes in `firerow status`, so check the plan. Save as
"CSV UTF-8", not .xlsx.

## Files

| Path | |
|---|---|
| `firerow.config.json` | The service-account key's path and the database id. Commands work from this folder or any folder inside it. |
| `collections/` | Your CSVs — edit these. |
| `.firerow/snapshots/` | What was last pulled or pushed, for working out your changes and conflicts. |
| `.firerow/pushes/` | The record of each push, for `log` and `revert`. |
| `.firerow/conflicts/`, `.firerow/edit/` | Unresolved merge conflicts, and an open `edit` sheet. |

`.firerow/` holds copies of your data, specific to this machine, and the service-account key grants
full admin access to your project: keep both out of version control and anywhere public. `init`
adds both to `.gitignore` for you. Whether to commit `collections/` is up to you.

## Emulator

To work against the Firestore emulator, set `FIRESTORE_EMULATOR_HOST` (e.g. `127.0.0.1:8080`) and
use a `firerow.config.json` with no service account, just the project id:

```json
{ "projectId": "demo-my-project" }
```

Otherwise the project id always comes from the service-account key, so there's nothing to keep
in sync.

## Development

```bash
git clone https://github.com/headbranch/firerow.git && cd firerow
npm install
npm test       # builds and runs the tests
npm link       # makes your local build available as `firerow`
```

## License

[MIT](LICENSE)
