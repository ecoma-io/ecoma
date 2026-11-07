import { probeDocker } from './harness.ts';

export default async function setup(): Promise<void> {
  await probeDocker();
}
