// <git-settings-versioning> (stage 10, §3.8): the Versioning section at
// `/settings/git`, drawn over the settings window's one autosave draft
// (`settings.config/v1`, R-9.8) and the stored credentials (`secrets/v1`,
// query `['credentials']`). The section's heading comes from its settings
// link; it shows nothing until the draft loaded. From slice S65c the
// credentials are `SecretsService.List` over Connect.

import { useQuery } from '@tanstack/react-query';
import type { ClientServices, Services } from 'bundle/contracts';
import { SecretsService } from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import { SettingsConfigV1 } from 'settings/contracts';

import { gitKeys } from '../changes/store.js';
import { credentialsFrom } from '../domain/credentials.js';
import { useService, useSubscribed } from '../hooks/use-service.js';
import { SettingsVersioning } from './settings-versioning.js';

export function VersioningView({ services }: { readonly services: Services }) {
  const config = useService(services, SettingsConfigV1);
  const draft = useSubscribed(
    config,
    () => (config as NonNullable<typeof config>).draft(),
    undefined,
  );
  const credentials = useQuery({
    queryKey: gitKeys.credentials,
    queryFn: async () =>
      credentialsFrom(
        (await (services as ClientServices).use(SecretsService).list({}))
          .credentials,
      ),
  });
  if (config === undefined || draft === undefined) return null;
  return (
    <SettingsVersioning
      credentials={credentials.data ?? []}
      draft={draft}
      onChange={(update) => config.setDraft(update)}
    />
  );
}
