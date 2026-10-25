# Backup test setup

MinIO as a local S3 bucket, and Kopia run through Docker, for developing and testing backups without installing Kopia.

```
docker compose -f dev/backups/compose.yaml up -d --wait   # start MinIO
docker compose -f dev/backups/compose.yaml down           # stop and wipe the bucket
```

- S3 endpoint `http://localhost:19000`, bucket `hobwork`, access key `hobwork`, secret key `hobwork-dev-secret`. The MinIO console is at `http://localhost:19001` with the same login.
- `dev/backups/kopia` runs the `kopia/kopia:0.17.0` image (the tested version) as if Kopia were installed. It mounts Kopia's config, cache and log dirs and every absolute path argument at the same path in the container, and passes credentials through by name. Override the image with `HOBWORK_KOPIA_IMAGE`.
- The integration test starts MinIO itself, backs up a data dir twice, checks that the second backup uploads only the change, restores into an empty dir and starts a host on it:

  ```
  HOBWORK_BACKUP_TESTS=1 pnpm --filter @hobwork/server test src/backup
  ```

- To back up a local host to MinIO, start it with:

  ```
  HOBWORK_KOPIA_BIN=dev/backups/kopia
  HOBWORK_BACKUP_S3_ENDPOINT=http://localhost:19000
  HOBWORK_BACKUP_S3_BUCKET=hobwork
  HOBWORK_BACKUP_S3_ACCESS_KEY_ID=hobwork
  HOBWORK_BACKUP_S3_SECRET_ACCESS_KEY=hobwork-dev-secret
  HOBWORK_BACKUP_PASSWORD=dev-password
  ```

  Then `pnpm --filter @hobwork/server backup now` (with the same variables) or "Back up now" in Settings.
