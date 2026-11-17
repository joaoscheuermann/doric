import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ErrorInfo, errorInfo } from 'desktop/reads';
import { useCallback } from 'react';

import { api } from '../api/settings-api.js';
import type {
  Credential,
  CredentialCreate,
  CredentialUpdate,
} from '../domain/config.js';
import { queryKeys } from '../queries/keys.js';
import { useReadFailure } from './use-read-failure.js';

/**
 * What one credential write answered, so a section can report the host's
 * refusal without knowing which route produced it. `failed` carries the
 * rejection as `ErrorInfo` (`errorInfo` of it, `at` set to when it failed);
 * the write never throws.
 */
export type CredentialWrite =
  | { readonly status: 'saved' }
  | { readonly status: 'failed'; readonly error: ErrorInfo };

export type Credentials = {
  /** The stored credentials, in the order the host lists them. */
  readonly list: readonly Credential[];
  /** True while a read of the list runs, the first one or a `reload`. */
  readonly loading: boolean;
  /**
   * The list read's failure only (`errorInfo` of the query's error, `at` from
   * its `errorUpdatedAt`); absent once a read succeeds. A failed write never
   * sets it: the write's own result carries that failure. A section shows it
   * with `credentials_read_failed` as fallback code (§5.2, D16).
   */
  readonly loadError?: ErrorInfo;
  readonly create: (input: CredentialCreate) => Promise<CredentialWrite>;
  readonly update: (
    id: string,
    input: CredentialUpdate,
  ) => Promise<CredentialWrite>;
  readonly remove: (id: string) => Promise<CredentialWrite>;
  readonly reload: () => void;
};

/**
 * The host's credential store, read once and kept in step by what this hook
 * writes. Credentials outlive the configuration and the window, so the list is
 * loaded when the surface mounts rather than when a dialog opens, and every wri
te
 * replaces the entry it changed from the host's own answer.
 *
 * A failed write is answered rather than thrown, because the section reports it
 * beside the row that caused it and keeps what the user typed.
 */
export const useCredentials = (): Credentials => {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: queryKeys.credentials,
    queryFn: () => api().credentials.list(),
    // A failed list stays failed until a read is asked for, so a section
    // that mounts later shows the same failure rather than reading again.
    retryOnMount: false,
  });
  const loadError = useReadFailure(list);

  const { mutateAsync: createCredential } = useMutation({
    mutationFn: (input: CredentialCreate) => api().credentials.create(input),
  });
  const { mutateAsync: updateCredential } = useMutation({
    mutationFn: ({ id, input }: { id: string; input: CredentialUpdate }) =>
      api().credentials.update(id, input),
  });
  const { mutateAsync: removeCredential } = useMutation({
    mutationFn: (id: string) => api().credentials.remove(id),
  });

  /**
   * Applies one answered write to the list. A created credential is appended and
   * an updated one replaces its entry, which keeps the list the host's without a
   * second read.
   */
  const settle = useCallback(
    (credential: Credential, replace: boolean): void => {
      queryClient.setQueryData(
        queryKeys.credentials,
        (current: readonly Credential[] = []) =>
          replace
            ? current.map((entry) =>
                entry.id === credential.id ? credential : entry,
              )
            : [...current, credential],
      );
    },
    [queryClient],
  );

  const failed = useCallback(
    (reason: unknown): CredentialWrite => ({
      status: 'failed',
      error: errorInfo(reason),
    }),
    [],
  );

  const create = useCallback(
    async (input: CredentialCreate): Promise<CredentialWrite> => {
      try {
        settle(await createCredential(input), false);
        return { status: 'saved' };
      } catch (reason) {
        return failed(reason);
      }
    },
    [createCredential, failed, settle],
  );

  const update = useCallback(
    async (id: string, input: CredentialUpdate): Promise<CredentialWrite> => {
      try {
        settle(await updateCredential({ id, input }), true);
        return { status: 'saved' };
      } catch (reason) {
        return failed(reason);
      }
    },
    [failed, settle, updateCredential],
  );

  const remove = useCallback(
    async (id: string): Promise<CredentialWrite> => {
      try {
        await removeCredential(id);
        queryClient.setQueryData(
          queryKeys.credentials,
          (current: readonly Credential[] = []) =>
            current.filter((credential) => credential.id !== id),
        );
        return { status: 'saved' };
      } catch (reason) {
        return failed(reason);
      }
    },
    [failed, queryClient, removeCredential],
  );

  const reload = useCallback(
    () => void queryClient.refetchQueries({ queryKey: queryKeys.credentials }),
    [queryClient],
  );

  return {
    list: list.data ?? [],
    loading: list.isPending || list.isFetching,
    loadError,
    create,
    update,
    remove,
    reload,
  };
};
