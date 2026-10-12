-- Kind definitions belong to bundles. Preserve existing IDs and ciphertext;
-- the generic credential backend must accept future registered kinds too.
ALTER TABLE "credential" ALTER COLUMN "kind" TYPE TEXT USING "kind"::TEXT;
DROP TYPE "CredentialKind";
