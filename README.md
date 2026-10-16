# firerow

[![npm](https://img.shields.io/npm/v/firerow)](https://www.npmjs.com/package/firerow)

Edit Firestore collections as CSV files: pull, edit in any spreadsheet or editor, push back.
Pushes are checked field by field for conflicts with other people's changes, and every push can
be undone.

```bash
firerow init              # connect this folder to your Firebase project
firerow pull employees    # → collections/employees/documents.csv
# …edit the CSV…
firerow status            # what you've changed
firerow push employees    # check for conflicts, confirm, write
firerow revert            # undo the latest push
```

## Install

```bash
npm install -g firerow
```

This installs `firerow` and the shorter `fr`. Requires Node.js 18 or later.

You'll need a Firebase **service-account key**: Firebase console → Project settings → Service
accounts → Generate new private key. `firerow init` asks for it. The key grants full admin access
to your project, so keep it out of version control (`init` adds it to `.gitignore`).

## Commands

| Command | |
|---|---|
| `init` | Connect this folder to a Firebase project. |
| `list` | Your collections, with document counts and what you've pulled. |
| `pull` | Download collections to CSV — or [some documents](#pulling-part-of-a-collection). Unpushed edits are kept. |
| `status` | What you've changed (offline). |
| `push` | Write your changes to Firestore, checking for [conflicts](#conflicts). |
| `resolve` | Choose values for conflicts left by a merging pull. |
| `discard` | Throw away unpushed edits (offline). |
| `log` | List recent pushes (offline). |
| `revert` | [Undo](#undoing-a-push) a push — the latest one, or one from `log`. |
| `create` | Start a new collection: `firerow create products "name:string,price:number"`. |
| `edit` | Edit several collections in one sheet: `firerow edit "users/*/orders"`. |
| `export` | Collections as JSON. |
| `untrack` | Stop tracking a collection locally (Firestore isn't touched). |

`firerow <command> --help` lists each command's options.

Commands take one or more collections, separated by spaces (`firerow pull users staff`),
including `*` patterns for subcollections (`"users/*/orders"`). With none, they act on everything
you've pulled.

## Editing the CSV

- `_id` is the document id. Add a row to create a document (leave `_id` blank for an auto id);
  remove a row to delete one. Ids can't be changed.
- **An empty cell means the field isn't there.** Clearing a cell deletes that field; write `""`
  for an empty string.
- Each header carries its column's type: `name:string`, `age:number`, `active:boolean`,
  `createdAt:timestamp` (ISO 8601), `home:geopoint` (`lat, lng`), `owner:reference`
  (`users/abc`), `data:bytes` (base64), `tags:array` / `address:map` (JSON), `x:null`.
- Add a field by adding a column. Without a type, each value is read as what it clearly is
  (`42` a number, `TRUE` a boolean, `2024-05-01` a date) and `status` shows what was guessed.
- Rename or remove a column, and `push` asks whether to rename or delete that field in Firestore.

**Excel** may rewrite values on save (leading zeros, long numbers, dates). Save as "CSV UTF-8",
and check `firerow status` before pushing.

## Pulling part of a collection

```bash
firerow pull employees/jim                            # one document (1 read)
firerow pull employees --where "branch == 'Scranton'"  # the ones matching a filter
```

The rows go into the collection's usual CSV as a **partial copy**. Everything works the same,
and `push` only ever touches documents in your copy. If you already have other rows, `pull` asks
whether to add the new ones or replace the copy with just them (`--add` / `--replace` decide
up front). `firerow pull employees` switches back to the whole collection.

### Filters

Filters use Firestore's own operators: `==  !=  <  <=  >  >=  in  not-in  array-contains
array-contains-any`.

```bash
firerow pull employees  --where "branch == 'Scranton' and department == 'Sales'"
firerow pull employees  --where "name in ['Jim Halpert', 'Dwight Schrute']"
firerow pull employees  --where "dundies array-contains 'Hottest in the Office'"
firerow pull complaints --where "filedBy == 'Toby Flenderson' or severity >= 3"
firerow pull employees  --where "(branch == 'Scranton' and department == 'Sales') or salesTotal >= 100000"
firerow pull sales      --where "client == 'Lackawanna County'" --order-by "closedAt desc" --limit 100
```

- **Quoting:** the whole filter in double quotes, text inside it in single quotes. Double an
  apostrophe: `'Pam''s desk'`. This works the same in bash, cmd and PowerShell.
- **and / or** join conditions; mixing them needs parentheses, so `a and b or c` is refused.
  Several `--where`s must all match.
- **Values:** `'text'`, `18`, `true`, `null`, `['a', 'b']`, `Timestamp('2005-03-24')`,
  `ref('employees/michael')`, `GeoPoint(41.41, -75.66)`. `_id` is the document id, and
  `manager.name` reaches into a map.
- **Unquoted values take their column's type**: `extension == 0042` stays text in an
  `extension:string` column. Quoted text is always text.

`pull` counts the matches first and asks before reading more than 1,000. When a query needs an
index, Firestore's error includes the link to create it.

**SDK form.** `--query` takes a query as you'd write it in code, and `--query @<file>` reads it
from a file, where no shell quoting applies:

```js
// top-sellers.txt
where('branch', '==', 'Scranton')
  .where('salesTotal', '>=', 100000)
  .orderBy('salesTotal', 'desc')
  .limit(10)
```

## Conflicts

`push` re-reads only the documents you changed. If someone else changed a field you also
changed, it stops and offers to merge, like `git pull`: their changes come in, yours are
re-applied, and fields changed on both sides are marked in the CSV:

```
<<<<<<< local: 31 | remote: 35 >>>>>>>
```

Run `firerow resolve` to pick a value for each one (or edit the cells by hand), then push again.
Remote changes to *other* fields never conflict: only the fields you changed are written.

## Undoing a push

`firerow log` lists your pushes, each with a short id like a git commit. `firerow revert` undoes
the latest one, or name one: `firerow revert 76562d1`. It shows what it will do and asks first,
and refuses if someone changed those documents since (`-f` overrides). A revert can itself be
reverted.

Only pushes made from this folder are recorded.

## Subcollections

`collections/` mirrors your database: a document's subcollections are folders under its id.

```
collections/
  users/
    documents.csv          ← users
    alice/
      orders/
        documents.csv      ← users/alice/orders
```

```bash
firerow list users/alice          # a document's subcollections
firerow pull "users/*/orders"     # every user's orders, each into its own folder
```

Subcollections aren't pulled with their parent; name them, or use a `*` pattern. Deleting a
document doesn't delete its subcollections (a Firestore rule); `push` warns you first.

## Files

- `firerow.config.json`: the key's path and the database id. Commands work from this folder or
  any folder inside it.
- `collections/`: your CSVs. Committing them is up to you.
- `.firerow/`: snapshots, push history and other local state. Keep it out of version control;
  `init` adds it to `.gitignore`.

## Emulator

Set `FIRESTORE_EMULATOR_HOST` (e.g. `127.0.0.1:8080`) and use a `firerow.config.json` with just a
project id: `{ "projectId": "demo-my-project" }`.

## Development

```bash
git clone https://github.com/headbranch/firerow.git && cd firerow
npm install
npm test       # builds and runs the tests
npm link       # makes your local build available as `firerow`
```

**Releasing:** `npm run release` runs the tests, asks for the version, then commits, tags and
pushes. The tag triggers the [Publish workflow](.github/workflows/publish.yml), which publishes
to npm through trusted publishing (no token needed) and creates the GitHub release. Don't run
`npm publish` yourself.

## License

[MIT](LICENSE)
