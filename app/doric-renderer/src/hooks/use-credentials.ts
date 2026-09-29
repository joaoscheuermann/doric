import {
  type Credential,
  type CredentialCreate,
  type CredentialUpdate,
} from '@/domain/config';
import { messageFrom } from '@/domain/workspace';
import { useCallback, useEffect, useState } from 'react';

/**
 * What one credential write answered, so a section can report the host's refusal
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
 * loaded when the surface mounts rather than when a dialog opens, and every write
 * replaces the entry it changed from the host's own answer.
 *
 * A failed write is answered rather than thrown, because the section reports it
 * beside the row that caused it and keeps what the user typed.
 */
export const useCredentials = (): Credentials => {
  const [list, setList] = useState<readonly Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void window.doric.credentials
      .list()
      .then((credentials) => {
        if (!active) return;
        setList(credentials);
        setError(undefined);
      })
      .catch((reason: unknown) => {
        if (active) setError(messageFrom(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [revision]);

  const reload = useCallback(() => setRevision((value) => value + 1), []);

  /**
   * Applies one answered write to the list. A created credential is appended and
   * an updated one replaces its entry, which keeps the list the host's without a
   * second read.
   */
  const settle = useCallback(
    (credential: Credential, replace: boolean): void => {
      setError(undefined);
      setList((current) =>
        replace
          ? current.map((entry) =>
              entry.id === credential.id ? credential : entry,
            )
          : [...current, credential],
      );
    },
    [],
  );

  const failed = useCallback((reason: unknown): CredentialWrite => {
    const message = messageFrom(reason);
    setError(message);
    return { status: 'failed', message };
  }, []);

  const create = useCallback(
    async (input: CredentialCreate): Promise<CredentialWrite> => {
      try {
        settle(await window.doric.credentials.create(input), false);
        return { status: 'saved' };
      } catch (reason) {
        return failed(reason);
      }
    },
    [failed, settle],
  );

  const update = useCallback(
    async (id: string, input: CredentialUpdate): Promise<CredentialWrite> => {
      try {
        settle(await window.doric.credentials.update(id, input), true);
        return { status: 'saved' };
      } catch (reason) {
        return failed(reason);
      }
    },
    [failed, settle],
  );

  const remove = useCallback(
    async (id: string): Promise<CredentialWrite> => {
      try {
        await window.doric.credentials.remove(id);
        setError(undefined);
        setList((current) =>
          current.filter((credential) => credential.id !== id),
        );
        return { status: 'saved' };
      } catch (reason) {
        return failed(reason);
      }
    },
    [failed],
  );

  return { list, loading, error, create, update, remove, reload };
};
