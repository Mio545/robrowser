/**
 * Flow JSON persistence helpers.
 *
 * Flows are plain JSON documents; the loader is deliberately host agnostic so
 * that the CLI, HTTP API and Electron main process can share it.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { assertValidFlow } from './validate.js';
import type { FlowModel } from './schema.js';
import { RoboError } from '../errors.js';
import { setFlowBaseDir } from './url.js';

/**
 * Parse a JSON string into a validated {@link FlowModel}.
 *
 * @param json - Raw JSON text.
 * @returns The validated flow.
 * @throws {RoboError} `VALIDATION_ERROR` when JSON or schema is invalid.
 */
export function parseFlow(json: string): FlowModel {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (error) {
    throw new RoboError('VALIDATION_ERROR', `Flow is not valid JSON: ${(error as Error).message}`, {
      cause: undefined,
    });
  }
  return assertValidFlow(data);
}

/**
 * Read and validate a flow from disk.
 *
 * @param filePath - Path to the `.json` flow file.
 * @returns The validated flow.
 */
export async function loadFlow(filePath: string): Promise<FlowModel> {
  const absolute = resolve(filePath);
  let text: string;
  try {
    text = await readFile(absolute, 'utf8');
  } catch (error) {
    throw new RoboError(
      'FLOW_NOT_FOUND',
      `Unable to read flow file: ${absolute}`,
      {
        path: absolute,
        cause: undefined,
      },
      { cause: error },
    );
  }
  const flow = parseFlow(text);
  // Relative goto URLs are resolved against the flow file's directory so a
  // repository checkout stays portable across CLI, server and desktop hosts.
  setFlowBaseDir(dirname(absolute));
  return flow;
}

/**
 * Serialise and persist a flow to disk. Parent directories are created.
 *
 * @param filePath - Destination path.
 * @param flow - Flow to write.
 */
export async function saveFlow(filePath: string, flow: FlowModel): Promise<void> {
  const absolute = resolve(filePath);
  const validated = assertValidFlow(flow);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
}

/**
 * Convenience: serialise a flow to a pretty-printed JSON string.
 *
 * @param flow - Flow to serialise.
 */
export function stringifyFlow(flow: FlowModel): string {
  return `${JSON.stringify(flow, null, 2)}\n`;
}
