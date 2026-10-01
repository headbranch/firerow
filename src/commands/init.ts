import fs from 'node:fs';
import path from 'node:path';
import { connect, readServiceAccount, type Config } from '../config.js';
import { COLLECTIONS_DIR, CONFIG_FILE, STATE_DIR } from '../paths.js';
import { ask, bold, cmd, confirm, dim, green, yellow } from '../ui.js';

export interface InitOptions { serviceAccount?: string; database?: string; force?: boolean }

const interactive = () => Boolean(process.stdin.isTTY);

export async function init(opts: InitOptions): Promise<void> {
  const root = process.cwd();
  const configFile = path.join(root, CONFIG_FILE);
  if (fs.existsSync(configFile) && !opts.force) {
    if (!interactive() || !(await confirm(`${CONFIG_FILE} already exists here. Overwrite it?`))) {
      throw new Error(`${CONFIG_FILE} already exists here. Use --force to overwrite it.`);
    }
  }
  console.log(bold('Connect firerow to Firestore') + dim('  (press Enter to accept the value in brackets)\n'));

  const keyPath = opts.serviceAccount ?? await promptKey(root, guessServiceAccount(root));
  const key = readServiceAccount(path.resolve(root, keyPath));
  console.log(`  Project: ${bold(key.project_id)}`);

  const databaseId = opts.database ?? await prompt('Firestore database ID', '(default)');

  const config: Config = {
    serviceAccount: path.relative(root, path.resolve(root, keyPath)).replace(/\\/g, '/'),
    databaseId,
  };

  console.log(dim(`\nConnecting to ${key.project_id} / ${config.databaseId} as ${key.client_email}…`));
  const db = connect({ root, config });
  const cols = await db.listCollections();

  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
  fs.mkdirSync(path.join(root, COLLECTIONS_DIR), { recursive: true });
  ignoreKeyAndState(root, config.serviceAccount!);

  console.log();
  console.log(green('✓ Connected.'));
  console.log(green(`✓ Wrote ${CONFIG_FILE}.`));
  if (cols.length) console.log(`\nTop-level collections: ${cols.map((c) => c.id).join(', ')}`);
  console.log('\nNext:');
  console.log(`  ${cmd('firerow pull <collection>')}  ${dim('pull one collection')}${cols.length ? dim(', e.g. ') + cmd(`firerow pull ${cols[0].id}`) : ''}`);
  console.log(`  ${cmd('firerow pull --all')}         ${dim('pull every top-level collection')}`);
}

async function prompt(label: string, fallback = ''): Promise<string> {
  if (!interactive()) return fallback;
  return ask(`${label}${fallback ? dim(` [${fallback}]`) : ''}: `, fallback);
}

/** Ask for the key file until we get one that exists and looks like a service-account key. */
async function promptKey(root: string, fallback?: string): Promise<string> {
  if (!interactive()) {
    if (!fallback) throw new Error('No service-account file found. Pass one with --service-account <file>.');
    return fallback;
  }
  for (;;) {
    const answer = (await prompt('Service-account JSON file name (or path)', fallback)).replace(/^["']|["']$/g, '');
    if (!answer) { console.log(yellow('  A service-account file is required.')); continue; }
    try {
      readServiceAccount(path.resolve(root, answer));
      return answer;
    } catch (e) {
      console.log(yellow(`  ${(e as Error).message}`));
    }
  }
}

function guessServiceAccount(root: string): string {
  return fs.readdirSync(root).find((f) => /(service-?account|firebase-adminsdk).*\.json$/i.test(f)) ?? '';
}

/**
 * Keep the service-account key and firerow's local state (.firerow/: snapshots, push records — copies of
 * your data, specific to this machine) out of git. collections/ is left for you to decide.
 */
export function ignoreKeyAndState(root: string, keyRel: string): void {
  const gi = path.join(root, '.gitignore');
  const text = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const listed = (entry: string) => lines.some((l) => [entry, `/${entry}`, `${entry}/`, `/${entry}/`].includes(l));

  const add: string[] = [];
  const keyIgnored = listed(keyRel) || /service-?account|firebase-adminsdk/i.test(text);
  if (!keyIgnored) add.push('# Firebase admin key — never commit', keyRel);
  if (!listed(STATE_DIR)) add.push('# firerow: local state (copies of your data, specific to this machine)', `${STATE_DIR}/`);
  if (!add.length) return;
  fs.appendFileSync(gi, `${text && !text.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`);
  if (!keyIgnored) console.log(yellow(`Added ${keyRel} to .gitignore — this key grants full admin access to your project.`));
  if (!listed(STATE_DIR)) console.log(dim(`Added ${STATE_DIR}/ to .gitignore — firerow's local state, specific to this machine.`));
}
