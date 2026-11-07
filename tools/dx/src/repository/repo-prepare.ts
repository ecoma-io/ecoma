import { defineCommand } from 'citty';

import { syncAgentConfig } from './sync-agent-config.js';
import { TOOL_SPECS } from './tool-specs.js';
import { checkTools, warnMissingTools } from './tools.js';
import { runCommand } from '../utils.js';

export default defineCommand({
  meta: {
    name: 'repo-prepare',
    description: 'Prepare repository',
  },

  async run() {
    console.log('Installing git hooks');
    runCommand('pnpm exec lefthook install');

    console.log('Checking required tools');
    const { missing } = checkTools(TOOL_SPECS);
    warnMissingTools(missing);

    console.log('Sync agent configuration');
    await syncAgentConfig();
  },
});
