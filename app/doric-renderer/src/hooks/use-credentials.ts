import {
  type Credential,
  type CredentialCreate,
  type CredentialUpdate,
} from '@/domain/config';
import { messageFrom } from '@/domain/workspace';
import { queryKeys } from '@/queries/keys';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

/**
 * What one credential write answered, so a section can report the host's refusa
l
 * without knowing which route produced it.
 */
export type CredentialWrite =
  | { readonly status: 'saved' }
  | { readonly status: 'failed'; readonly message: string };

export type Credentials = {
  /** The stored credentials, in the order the host lists them. */
  readonly list: readonly Credential[];
  readonly loading: boolean;
  /** The last failure, which the section shows above its list. */
  readonly error?: string;
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
    queryFn: () => window.doric.credentials.list(),
  });
  const [error, setError] = useState<string>();

  // The load and the writes share one error slot: the last failure is what the
  // section shows, and the next success clears it.
  useEffect(() => {
    if (list.isError) setError(messageFrom(list.error));
    else if (list.data !== undefined) setError(undefined);
  }, [list.data, list.error, list.isError]);

  const { mutateAsync: createCredential } = useMutation({
    mutationFn: (input: CredentialCreate) =>
      window.doric.credentials.create(input),
  });
  const { mutateAsync: updateCredential } = useMutation({
    mutationFn: ({ id, input }: { id: string; input: CredentialUpdate }) =>
      window.doric.credentials.update(id, input),
  });
  const { mutateAsync: removeCredential } = useMutation({
    mutationFn: (id: string) => window.doric.credentials.remove(id),
  });

  /**
   * Applies one answered write to the list. A created credential is appended and
   * an updated one replaces its entry, which keeps the list the host's without a
   * second read.
   */
  const settle = useCallback(
    (credential: Credential, replace: boolean): void => {
      setError(undefined);
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

  const failed = useCallback((reason: unknown): CredentialWrite => {
    const message = messageFrom(reason);
    setError(message);
    return { status: 'failed', message };
  }, []);

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
        setError(undefined);
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
    error,
    create,
    update,
    remove,
    reload,
  };
};
