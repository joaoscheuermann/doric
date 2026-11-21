// `settings.models/v1`, the footer execution picker's data (bundle isolation
// 6(c)). The chat reaches it through `whenAvailable` only, by its id (D32):
// the types come from `settings/contracts` by `import type`, so a composition
// without `settings` still loads the chat, and its footer has no picker.

import { ref } from 'bundle/contracts';
import type { SettingsModels } from 'settings/contracts';

/** `settings.models/v1`, optional, by id (D32). */
export const SettingsModelsV1 = ref<SettingsModels>('settings.models/v1');
