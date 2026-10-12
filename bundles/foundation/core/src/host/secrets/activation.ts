import {
  AppHooksV1,
  DoricStartupV1,
  HooksV1,
  SecretsV1,
  type Services,
  StorageBackendV1,
} from 'bundle/contracts';

/**
 * The host's credential activation, as a start step (`onHostStartHook`): the
 * storage backend is connected first, then the stored credentials are read
 * once, so a missing or unusable credential key fails the host here, at the
 * `credential_activation` stage, rather than serving a stored secret as empty.
 * Every read after that is the secrets provider's view.
 */
export const activateCredentials = (services: Pick<Services, 'use'>): void => {
  services
    .use(HooksV1)
    .use(AppHooksV1)
    .onHostStartHook(async (_input, call) => {
      await services.use(StorageBackendV1).connect(call);

      const startup = services.use(DoricStartupV1);

      await startup.stage('credential_activation');
      await startup.log(
        {
          level: 'info',
          fields: {},
          message: 'Activating stored credentials',
        },
        call,
      );
      await services.use(SecretsV1).list(call);
    });
};
