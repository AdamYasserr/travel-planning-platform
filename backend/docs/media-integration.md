# Shared media integration contract

`MediaModule` owns upload validation, storage, and media metadata. Blog,
itinerary, and profile features must not write files directly.

## Upload

`POST /api/media` is authenticated and accepts `multipart/form-data`:

- `file`: one JPG, JPEG, or PNG image; maximum 5 MB. Multer rejects
  additional files and oversized multipart payloads before service handling.
  The service also validates the image signature and basic structure, so a
  filename or client MIME type cannot make arbitrary bytes an image.
- `targetType`: `profile`, `post`, `itinerary`, or `comment`.
- `targetId`: a MongoDB ObjectId for content targets. It is optional only for
  `profile`.

The authenticated user's ID is always persisted as `ownerId`. The response
contains a media ID and an API URL, never a local filesystem path or storage
credential.

## Reading

`GET /api/media/:id/content` is authenticated and owner-scoped for profile
media. Cross-user access is rejected and profile media is never public.
Content media upload and retrieval are intentionally not enabled yet:
the current Blog, Itinerary, and Comment schema/service files are empty, so
there is no verified target owner or visibility field to query. Those modules
must provide the following integration contract before attachment routes are
enabled:

1. A target lookup by ObjectId that returns existence, owner ID, and visibility.
2. An authorization method defining who may attach media (normally the target
   owner/author).
3. A read-authorization method defining whether a requester may view the
   target and its media.
4. A delete/rollback hook or transaction strategy for target and media changes.

## Storage configuration

The development provider stores files under `MEDIA_STORAGE_PATH`
(`uploads/media` by default). Production deployments should replace
`LocalMediaStorage` with an implementation of `MediaStorageProvider` backed by
object storage, without changing controllers or consumers.
