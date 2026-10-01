import fs from 'node:fs';
import path from 'node:path';
import { initializeApp, cert, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { CONFIG_FILE } from './paths.js';
import { untrackDeleted } from './targets.js';
import { cmd, dim, yellow } from './ui.js';

export interface Config {
  /** Path to the service-account JSON, relative to the project root. The project id is read from it. */
  serviceAccount?: string;
  /** Firestore database id; "(default)" unless you use named databases. */
  databaseId?: string;
  /** Only for the emulator, where there's no service account to read the project id from. */
  projectId?: string;
}

export interface Workspace { root: string; config: Config }

/** Find the nearest directory (walking up) that contains firerow.config.json. */
export function loadWorkspace(start = process.cwd()): Workspace {
  let dir = path.resolve(start);
  for (;;) {
    const file = path.join(dir, CONFIG_FILE);
    if (fs.existsSync(file)) {
      // Deleting a collection's folder (or its documents.csv) means "stop tracking it".
      for (const name of untrackDeleted(dir)) {
        console.log(yellow(`Stopped tracking ${name}: its CSV was deleted, along with any unpushed edits in it.`)
          + dim(` ${cmd(`firerow pull ${name}`)} brings it back.`));
      }
      return { root: dir, config: JSON.parse(fs.readFileSync(file, 'utf8')) as Config };
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`No ${CONFIG_FILE} found. Run ${cmd('firerow init')} first.`);
    dir = parent;
  }
}

export function readServiceAccount(file: string): { project_id: string; client_email: string } {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Could not read service account "${file}": ${(e as Error).message}`);
  }
  if (json.type !== 'service_account' || typeof json.project_id !== 'string' || typeof json.private_key !== 'string') {
    throw new Error(`"${file}" doesn't look like a service-account key (Firebase console → Project settings → Service accounts → Generate new private key).`);
  }
  return json as { project_id: string; client_email: string };
}

/** The Firebase project: always taken from the service-account key (or, for the emulator, the config). */
export function projectIdOf({ root, config }: Workspace): string {
  if (config.serviceAccount) return readServiceAccount(path.resolve(root, config.serviceAccount)).project_id;
  if (process.env.FIRESTORE_EMULATOR_HOST && config.projectId) return config.projectId;
  throw new Error(`No serviceAccount set in ${CONFIG_FILE}. Run ${cmd('firerow init')} to set one.`);
}

let cached: Firestore | undefined;

export function connect(ws: Workspace): Firestore {
  if (cached) return cached;
  const projectId = projectIdOf(ws);
  const { root, config } = ws;
  const app: App = config.serviceAccount
    ? initializeApp({ credential: cert(path.resolve(root, config.serviceAccount)), projectId }, 'firerow')
    : initializeApp({ projectId }, 'firerow'); // emulator
  cached = config.databaseId && config.databaseId !== '(default)'
    ? getFirestore(app, config.databaseId)
    : getFirestore(app);
  return cached;
}
