import { cp, mkdir, rm } from 'node:fs/promises';

const webRoot = new URL('../', import.meta.url);
const source = new URL('.next/static/', webRoot);
const targetParent = new URL('.next/standalone/apps/web/.next/', webRoot);
const target = new URL('static/', targetParent);

await mkdir(targetParent, { recursive: true });
await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
